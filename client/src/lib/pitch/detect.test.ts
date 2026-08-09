import { describe, expect, it } from "vitest";

import { PITCH_WINDOW_SAMPLES } from "./constants";
import { createMicPitchDetector, detectMicPitchDetails } from "./detect";

const SAMPLE_RATE = 48_000;

function sineWave(hz: number): Float32Array {
  return Float32Array.from({ length: PITCH_WINDOW_SAMPLES }, (_, index) =>
    Math.sin((Math.PI * 2 * hz * index) / SAMPLE_RATE),
  );
}

describe("browser microphone pitch fallback", () => {
  it.each([65.406, 1_046.502])("detects the Vocal Studio boundary tone %s Hz", (expected) => {
    const frame = detectMicPitchDetails(createMicPitchDetector(), sineWave(expected), SAMPLE_RATE);
    expect(frame.hz).not.toBeNull();
    expect(Math.abs((frame.hz as number) - expected)).toBeLessThan(1);
  });
});
