import { describe, expect, it } from "vitest";
import { encodeMonoWav, extractAcousticFeatureSummary } from "./acoustic-feature-extractor";

const SAMPLE_RATE = 48_000;

function vowelLikeSamples(bright = false): number[] {
  return Array.from({ length: 12_000 }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const fundamental = Math.sin(2 * Math.PI * 220 * time) * 0.1;
    const lowHarmonic = Math.sin(2 * Math.PI * 440 * time) * 0.05;
    const upperHarmonic = Math.sin(2 * Math.PI * 1_760 * time) * (bright ? 0.06 : 0.012);
    return fundamental + lowHarmonic + upperHarmonic;
  });
}

describe("acoustic feature extraction", () => {
  it("extracts comparable within-user summaries", () => {
    const darker = extractAcousticFeatureSummary({
      deviceId: "mic-1",
      vowel: "ah",
      samples: vowelLikeSamples(false),
      sampleRate: SAMPLE_RATE,
      pitchHz: Array.from({ length: 20 }, () => 220),
    });
    const brighter = extractAcousticFeatureSummary({
      deviceId: "mic-1",
      vowel: "ah",
      samples: vowelLikeSamples(true),
      sampleRate: SAMPLE_RATE,
      pitchHz: Array.from({ length: 20 }, () => 220),
    });

    expect(darker).not.toBeNull();
    expect(brighter).not.toBeNull();
    expect(brighter!.spectralCentroidHz).toBeGreaterThan(darker!.spectralCentroidHz);
    expect(brighter!.harmonicCount).toBeGreaterThanOrEqual(5);
  });

  it("refuses silence, clipping, or missing pitch evidence", () => {
    const base = {
      deviceId: "mic-1",
      vowel: "ah",
      sampleRate: SAMPLE_RATE,
    };
    expect(
      extractAcousticFeatureSummary({
        ...base,
        samples: Array.from({ length: 8_000 }, () => 0),
        pitchHz: [220],
      }),
    ).toBeNull();
    expect(
      extractAcousticFeatureSummary({
        ...base,
        samples: Array.from({ length: 8_000 }, () => 1),
        pitchHz: [220],
      }),
    ).toBeNull();
    expect(
      extractAcousticFeatureSummary({
        ...base,
        samples: vowelLikeSamples(),
        pitchHz: [],
      }),
    ).toBeNull();
  });

  it("encodes local captures as a playable mono wav", () => {
    const wav = encodeMonoWav(vowelLikeSamples().slice(0, 1_000), SAMPLE_RATE);
    expect(wav?.type).toBe("audio/wav");
    expect(wav?.size).toBe(2_044);
  });
});
