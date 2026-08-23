import { describe, expect, it } from "vitest";

import { MIC_PITCH_CLARITY_THRESHOLD, PITCH_WINDOW_SAMPLES } from "./constants";
import { createMicPitchDetector, detectMicPitchDetails } from "./detect";

const SAMPLE_RATE = 48_000;

function sineWave(hz: number, amplitude = 0.2): Float32Array {
  return Float32Array.from(
    { length: PITCH_WINDOW_SAMPLES },
    (_, index) => amplitude * Math.sin((Math.PI * 2 * hz * index) / SAMPLE_RATE),
  );
}

describe("browser microphone pitch fallback", () => {
  it.each([65.406, 1_046.502])("detects the Vocal Studio boundary tone %s Hz", (expected) => {
    const frame = detectMicPitchDetails(createMicPitchDetector(), sineWave(expected), SAMPLE_RATE);
    expect(frame.hz).not.toBeNull();
    expect(Math.abs((frame.hz as number) - expected)).toBeLessThan(1);
  });

  it("uses the same explicit clarity floor as native microphone tracking", () => {
    const detector = createMicPitchDetector();
    detector.findPitch = () => [440, MIC_PITCH_CLARITY_THRESHOLD - 0.01];

    const frame = detectMicPitchDetails(detector, sineWave(440), SAMPLE_RATE);

    expect(frame.hz).toBeNull();
    expect(frame.clarity).toBeCloseTo(MIC_PITCH_CLARITY_THRESHOLD - 0.01);
  });

  it("rejects clipped periodic input instead of reporting a false high note", () => {
    const frame = detectMicPitchDetails(createMicPitchDetector(), sineWave(440, 1), SAMPLE_RATE);

    expect(frame.peak).toBeGreaterThanOrEqual(0.985);
    expect(frame.hz).toBeNull();
  });
});
