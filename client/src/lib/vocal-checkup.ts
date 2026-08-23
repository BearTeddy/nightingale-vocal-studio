import { centsSimilarity } from "@/lib/pitch/state";
import type { PitchFrame } from "@/types/PitchFrame";

export const CHECKUP_DURATION_SECONDS = 30;
export const CHECKUP_COMPLETE_AFTER_SECONDS = 29;
const ECHO_CUE_STARTS = [11, 13, 15] as const;
const ECHO_RESPONSE_DELAY_SECONDS = 0.75;
const ECHO_RESPONSE_END_SECONDS = 1.95;
const SUSTAIN_RESPONSE_START_SECONDS = 17.85;
const RHYTHM_CUE_STARTS = Array.from({ length: 8 }, (_, index) => 23.25 + index * 0.75);

export interface CheckupFrame {
  elapsed_sec: number;
  frame: PitchFrame;
}

export interface VocalCheckupResult {
  lowMidi: number;
  highMidi: number;
  tessituraLowMidi: number;
  tessituraHighMidi: number;
  microphoneScore: number;
  noiseFloorDb: number;
  clippingPercent: number;
  rangeClippingPercent: number;
  rangeVoicedPercent: number;
  rangeCalibrationValid: boolean;
  pitchMatchScore: number;
  intervalMatchScore: number;
  stabilityScore: number;
  sustainScore: number;
  rhythmScore: number;
  recommendations: string[];
  checkedAt: number;
}

export interface CheckupStage {
  label: string;
  instruction: string;
  targetMidi: number | null;
}

export type VocalCheckupScores = Pick<
  VocalCheckupResult,
  | "microphoneScore"
  | "pitchMatchScore"
  | "intervalMatchScore"
  | "stabilityScore"
  | "sustainScore"
  | "rhythmScore"
>;

export function checkupSessionDuration(elapsedSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds)) return CHECKUP_DURATION_SECONDS;
  return Math.max(1, Math.min(CHECKUP_DURATION_SECONDS, Math.ceil(elapsedSeconds)));
}

export function canCompleteVocalCheckup(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= CHECKUP_COMPLETE_AFTER_SECONDS;
}

export function vocalCheckupScore(result: VocalCheckupScores): number {
  return clampScore(
    average([
      result.pitchMatchScore,
      result.intervalMatchScore,
      result.stabilityScore,
      result.sustainScore,
      result.rhythmScore,
    ]),
  );
}

export function canConfirmComfortableRange(
  result: VocalCheckupResult,
  comfort: number | null,
  effort: number | null,
): boolean {
  return (
    result.rangeCalibrationValid && comfort != null && comfort >= 4 && effort != null && effort <= 2
  );
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function quantile(values: number[], amount: number): number {
  if (values.length === 0) return 60;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

export function adaptiveCheckupBaseMidi(
  rangeMidi: readonly number[],
  fallbackMidi: number,
): number {
  const usable = rangeMidi.filter((midi) => Number.isFinite(midi));
  if (usable.length < 8) return Math.round(fallbackMidi);

  const low = quantile(usable, 0.1);
  const high = quantile(usable, 0.9);
  const preferred = Math.round(quantile(usable, 0.5) - 3);
  const lowestBase = Math.ceil(low);
  const highestBase = Math.floor(high - 7);
  if (lowestBase <= highestBase) {
    return Math.max(lowestBase, Math.min(highestBase, preferred));
  }

  // A narrow glide cannot contain the complete fifth; balance both edges.
  return Math.round((low + high - 7) / 2);
}

function isEchoResponse(elapsedSec: number): boolean {
  return ECHO_CUE_STARTS.some(
    (start) =>
      elapsedSec >= start + ECHO_RESPONSE_DELAY_SECONDS &&
      elapsedSec < start + ECHO_RESPONSE_END_SECONDS,
  );
}

function isRhythmCueBleed(elapsedSec: number): boolean {
  return RHYTHM_CUE_STARTS.some((start) => elapsedSec >= start - 0.03 && elapsedSec < start + 0.17);
}

export function checkupTargetAt(elapsedSec: number, baseMidi: number): number | null {
  if (elapsedSec >= 11 && elapsedSec < 17) {
    return baseMidi + [0, 4, 7][Math.min(2, Math.floor((elapsedSec - 11) / 2))];
  }
  if (elapsedSec >= 17 && elapsedSec < 29) return baseMidi;
  return null;
}

export function checkupStageAt(elapsedSec: number, baseMidi: number): CheckupStage {
  if (elapsedSec < 3) {
    return {
      label: "Room and microphone",
      instruction: "Stay quiet while Nightingale measures the room noise.",
      targetMidi: null,
    };
  }
  if (elapsedSec < 11) {
    return {
      label: "Comfortable range",
      instruction: "Glide gently down, then up. Do not push past an easy note.",
      targetMidi: null,
    };
  }
  if (elapsedSec < 17) {
    return {
      label: "Pitch and intervals",
      instruction: "Echo each reference tone at the same pitch.",
      targetMidi: checkupTargetAt(elapsedSec, baseMidi),
    };
  }
  if (elapsedSec < 23) {
    return {
      label: "Sustain and stability",
      instruction: "Hold one easy ah with steady airflow and volume.",
      targetMidi: baseMidi,
    };
  }
  return {
    label: "Rhythm",
    instruction: "Sing a short ah on each pulse, leaving silence between beats.",
    targetMidi: baseMidi,
  };
}

export function analyzeVocalCheckup(
  samples: CheckupFrame[],
  baseMidi: number,
  checkedAt = Date.now(),
): VocalCheckupResult | null {
  const rangeWindow = samples.filter(({ elapsed_sec }) => elapsed_sec >= 3 && elapsed_sec < 11);
  const voiced = samples.filter(
    ({ frame }) =>
      frame.voiced &&
      frame.midi != null &&
      frame.clarity >= 0.35 &&
      (frame.peak ?? frame.rms) < 0.98,
  );
  const rangeMidi = voiced
    .filter(({ elapsed_sec }) => elapsed_sec >= 3 && elapsed_sec < 11)
    .map(({ frame }) => frame.midi as number);
  if (rangeMidi.length < 15) return null;

  const rangeClippingPercent =
    rangeWindow.length === 0
      ? 100
      : (rangeWindow.filter(({ frame }) => (frame.peak ?? frame.rms) >= 0.98).length /
          rangeWindow.length) *
        100;
  const rangeVoicedPercent = (rangeMidi.length / Math.max(1, rangeWindow.length)) * 100;

  const quietFrames = samples
    .filter(({ elapsed_sec }) => elapsed_sec < 3)
    .map(({ frame }) => frame);
  const noiseRms = average(quietFrames.map((frame) => Math.max(frame.rms, 0.000001)));
  const noiseFloorDb = Math.round(20 * Math.log10(Math.max(noiseRms, 0.000001)));
  const clippingPercent =
    samples.length === 0
      ? 0
      : (samples.filter(({ frame }) => (frame.peak ?? frame.rms) >= 0.98).length / samples.length) *
        100;
  const microphoneScore = clampScore(((-noiseFloorDb - 25) / 35) * 100 - clippingPercent * 4);
  const rangeCalibrationValid =
    rangeClippingPercent <= 5 && rangeVoicedPercent >= 35 && microphoneScore >= 40;

  const matchSamples = voiced.filter(({ elapsed_sec }) => isEchoResponse(elapsed_sec));
  const matchScores = matchSamples.map(({ elapsed_sec, frame }) => {
    const target = checkupTargetAt(elapsed_sec, baseMidi) ?? baseMidi;
    return centsSimilarity(((frame.midi as number) - target) * 100) * 100;
  });
  const pitchMatchScore = clampScore(average(matchScores));
  const intervalScores = [
    matchScores.filter((_, index) => matchSamples[index]?.elapsed_sec < 13),
    matchScores.filter(
      (_, index) =>
        (matchSamples[index]?.elapsed_sec ?? 0) >= 13 &&
        (matchSamples[index]?.elapsed_sec ?? 0) < 15,
    ),
    matchScores.filter((_, index) => (matchSamples[index]?.elapsed_sec ?? 0) >= 15),
  ].map(average);
  const intervalMatchScore = clampScore(average(intervalScores));

  const sustainWindow = samples.filter(
    ({ elapsed_sec }) => elapsed_sec >= SUSTAIN_RESPONSE_START_SECONDS && elapsed_sec < 23,
  );
  const sustainVoiced = sustainWindow.filter(
    ({ frame }) =>
      frame.voiced &&
      frame.midi != null &&
      frame.clarity >= 0.35 &&
      (frame.peak ?? frame.rms) < 0.98,
  );
  const sustainScore = clampScore((sustainVoiced.length / Math.max(1, sustainWindow.length)) * 100);
  const sustainCents = sustainVoiced.map(({ frame }) => ((frame.midi as number) - baseMidi) * 100);
  const sustainCenter = quantile(sustainCents, 0.5);
  const stableSustainCents = sustainCents.filter((cents) => Math.abs(cents - sustainCenter) <= 200);
  const trackingConsistency = stableSustainCents.length / Math.max(1, sustainCents.length);
  const stabilityScore =
    stableSustainCents.length < 5
      ? 0
      : clampScore((100 - deviation(stableSustainCents) * 1.4) * trackingConsistency);

  const rhythmWindow = samples.filter(
    ({ elapsed_sec }) => elapsed_sec >= 23 && elapsed_sec < 29 && !isRhythmCueBleed(elapsed_sec),
  );
  const onsets: number[] = [];
  let previouslyVoiced = false;
  for (const sample of rhythmWindow) {
    const isVoiced =
      sample.frame.voiced &&
      sample.frame.clarity >= 0.35 &&
      (sample.frame.peak ?? sample.frame.rms) < 0.98;
    if (isVoiced && !previouslyVoiced) onsets.push(sample.elapsed_sec);
    previouslyVoiced = isVoiced;
  }
  const expected = RHYTHM_CUE_STARTS.map((cue) => cue + 0.2);
  const rhythmErrors = expected.map((beat) =>
    onsets.length === 0 ? 0.75 : Math.min(...onsets.map((onset) => Math.abs(onset - beat))),
  );
  const rhythmScore = clampScore(100 - (average(rhythmErrors) / 0.375) * 100);

  const recommendations = [
    {
      score: microphoneScore,
      text: "Reduce room noise or move the microphone closer before practice.",
    },
    {
      score: pitchMatchScore,
      text: "Practice slow single-note matching inside your comfortable range.",
    },
    {
      score: stabilityScore,
      text: "Use a softer steady vowel and keep the airflow even through long notes.",
    },
    {
      score: rhythmScore,
      text: "Practice short vowel onsets with the pulse before adding lyrics.",
    },
  ]
    .filter((item) => item.score < 80)
    .sort((left, right) => left.score - right.score)
    .slice(0, 3)
    .map((item) => item.text);

  return {
    lowMidi: Math.round(quantile(rangeMidi, 0.1)),
    highMidi: Math.round(quantile(rangeMidi, 0.9)),
    tessituraLowMidi: Math.round(quantile(rangeMidi, 0.25)),
    tessituraHighMidi: Math.round(quantile(rangeMidi, 0.75)),
    microphoneScore,
    noiseFloorDb,
    clippingPercent: Math.round(clippingPercent),
    rangeClippingPercent: Math.round(rangeClippingPercent),
    rangeVoicedPercent: Math.round(rangeVoicedPercent),
    rangeCalibrationValid,
    pitchMatchScore,
    intervalMatchScore,
    stabilityScore,
    sustainScore,
    rhythmScore,
    recommendations,
    checkedAt,
  };
}
