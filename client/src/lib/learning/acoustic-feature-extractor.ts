import type { AcousticFeatureSummary } from "./technique-coaching";

const FFT_SIZE = 4096;
const MIN_ANALYSIS_HZ = 80;
const MAX_ANALYSIS_HZ = 8_000;

export interface AcousticCaptureInput {
  deviceId: string;
  vowel: string;
  samples: readonly number[];
  sampleRate: number;
  pitchHz: readonly number[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  let reversed = 0;
  for (let index = 1; index < size; index += 1) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const half = length >> 1;
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const left = start + offset;
        const right = left + half;
        const productReal = real[right] * twiddleReal - imaginary[right] * twiddleImaginary;
        const productImaginary = real[right] * twiddleImaginary + imaginary[right] * twiddleReal;
        real[right] = real[left] - productReal;
        imaginary[right] = imaginary[left] - productImaginary;
        real[left] += productReal;
        imaginary[left] += productImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

function analysisWindow(samples: readonly number[]): Float64Array {
  const output = new Float64Array(FFT_SIZE);
  if (samples.length === 0) return output;
  const sourceStart = Math.max(0, Math.floor((samples.length - FFT_SIZE) / 2));
  const copyLength = Math.min(FFT_SIZE, samples.length - sourceStart);
  const targetStart = Math.floor((FFT_SIZE - copyLength) / 2);
  for (let index = 0; index < copyLength; index += 1) {
    const phase = (targetStart + index) / Math.max(1, FFT_SIZE - 1);
    const hann = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
    output[targetStart + index] = (samples[sourceStart + index] ?? 0) * hann;
  }
  return output;
}

export function extractAcousticFeatureSummary(
  input: AcousticCaptureInput,
): AcousticFeatureSummary | null {
  if (
    input.sampleRate <= 0 ||
    input.samples.length < FFT_SIZE / 2 ||
    input.deviceId.trim().length === 0 ||
    input.vowel.trim().length === 0
  ) {
    return null;
  }

  let sumSquares = 0;
  let peak = 0;
  for (const sample of input.samples) {
    if (!Number.isFinite(sample)) return null;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sumSquares / input.samples.length);
  if (rms < 0.002 || peak >= 0.995) return null;

  const pitchValues = input.pitchHz.filter(
    (pitch) => Number.isFinite(pitch) && pitch >= 55 && pitch <= 1_500,
  );
  const medianPitchHz = median(pitchValues);
  if (medianPitchHz <= 0) return null;

  const real = analysisWindow(input.samples);
  const imaginary = new Float64Array(FFT_SIZE);
  fftInPlace(real, imaginary);
  const binHz = input.sampleRate / FFT_SIZE;
  const lastBin = Math.min(FFT_SIZE / 2 - 1, Math.floor(MAX_ANALYSIS_HZ / binHz));
  const firstBin = Math.max(1, Math.ceil(MIN_ANALYSIS_HZ / binHz));
  const magnitudes = new Float64Array(lastBin + 1);
  let weightedFrequency = 0;
  let magnitudeTotal = 0;
  const nonzeroMagnitudes: number[] = [];
  for (let bin = firstBin; bin <= lastBin; bin += 1) {
    const magnitude = Math.hypot(real[bin], imaginary[bin]);
    magnitudes[bin] = magnitude;
    weightedFrequency += bin * binHz * magnitude;
    magnitudeTotal += magnitude;
    nonzeroMagnitudes.push(magnitude);
  }
  if (magnitudeTotal <= 1e-6) return null;

  const spectralCentroidHz = weightedFrequency / magnitudeTotal;
  const noiseFloor = median(nonzeroMagnitudes) * 2.5;
  const maximumHarmonic = Math.min(20, Math.floor(5_000 / medianPitchHz));
  let harmonicCount = 0;
  for (let harmonic = 1; harmonic <= maximumHarmonic; harmonic += 1) {
    const centerBin = Math.round((medianPitchHz * harmonic) / binHz);
    const localMagnitude = Math.max(
      magnitudes[Math.max(firstBin, centerBin - 1)] ?? 0,
      magnitudes[centerBin] ?? 0,
      magnitudes[Math.min(lastBin, centerBin + 1)] ?? 0,
    );
    if (localMagnitude > noiseFloor) harmonicCount += 1;
  }

  const pitchCoverage = Math.min(1, pitchValues.length / 8);
  const harmonicConfidence = Math.min(1, harmonicCount / 8);
  const levelConfidence = Math.min(1, Math.max(0, (20 * Math.log10(rms) + 54) / 30));
  const confidence = Math.max(
    0,
    Math.min(1, pitchCoverage * 0.45 + harmonicConfidence * 0.4 + levelConfidence * 0.15),
  );

  return {
    deviceId: input.deviceId,
    vowel: input.vowel,
    medianPitchHz,
    levelDb: 20 * Math.log10(rms),
    spectralCentroidHz,
    harmonicCount,
    confidence,
  };
}

export function encodeMonoWav(samples: readonly number[], sampleRate: number): Blob | null {
  if (samples.length === 0 || sampleRate <= 0) return null;
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
