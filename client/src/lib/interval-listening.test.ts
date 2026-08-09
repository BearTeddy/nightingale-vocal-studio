import { describe, expect, it } from "vitest";
import {
  assessIntervalAnswer,
  assessSungPitch,
  intervalAccuracy,
  intervalChoice,
  listeningScores,
  nextInterval,
  shouldAutoStartListeningCapture,
} from "./interval-listening";
import type { PitchFrame } from "@/types/PitchFrame";

function pitchFrame(midi: number | null, overrides: Partial<PitchFrame> = {}): PitchFrame {
  return {
    hz: midi == null ? null : 440 * 2 ** ((midi - 69) / 12),
    midi,
    clarity: midi == null ? 0 : 0.95,
    rms: midi == null ? 0 : 0.08,
    peak: midi == null ? 0 : 0.16,
    voiced: midi != null,
    sample_index: 0,
    sample_rate: 48_000,
    captured_at_ms: 0,
    ...overrides,
  };
}

describe("interval listening", () => {
  it("returns immediate correctness and a running score", () => {
    const answers = [assessIntervalAnswer(4, 4), assessIntervalAnswer(7, 5)];
    expect(answers[0].correct).toBe(true);
    expect(answers[1].correct).toBe(false);
    expect(intervalAccuracy(answers)).toBe(50);
    expect(intervalChoice(7).label).toBe("Perfect fifth");
  });

  it("does not immediately repeat the same interval", () => {
    expect(nextInterval(0, () => 0)).not.toBe(0);
  });

  it("scores a sung response using the correct octave", () => {
    const centered = assessSungPitch(
      64,
      Array.from({ length: 8 }, () => pitchFrame(64.12)),
    );
    const octaveLow = assessSungPitch(
      64,
      Array.from({ length: 8 }, () => pitchFrame(52)),
    );

    expect(centered?.score).toBe(100);
    expect(centered?.feedback).toContain("On pitch");
    expect(octaveLow?.score).toBe(0);
    expect(octaveLow?.feedback).toContain("Wrong octave");
  });

  it("waits for a usable microphone signal", () => {
    expect(
      assessSungPitch(64, [
        pitchFrame(null),
        pitchFrame(64, { rms: 0.0001 }),
        pitchFrame(64, { clarity: 0.2 }),
      ]),
    ).toBeNull();
  });

  it("combines interval and sung-pitch results and redistributes missing pitch", () => {
    const answers = [assessIntervalAnswer(4, 4), assessIntervalAnswer(7, 5)];
    const centered = assessSungPitch(
      64,
      Array.from({ length: 8 }, () => pitchFrame(64.12)),
    );

    expect(listeningScores(answers, [centered, null])).toEqual({
      overall: 75,
      interval: 50,
      pitch: 100,
    });
    expect(listeningScores(answers, [null, null])).toEqual({
      overall: 50,
      interval: 50,
      pitch: null,
    });
  });

  it("auto-starts one voice response only after the tones finish", () => {
    const ready = {
      ready: true,
      microphoneActive: true,
      attempted: false,
      answered: false,
      busy: false,
    };
    expect(shouldAutoStartListeningCapture(ready)).toBe(true);
    expect(shouldAutoStartListeningCapture({ ...ready, ready: false })).toBe(false);
    expect(shouldAutoStartListeningCapture({ ...ready, attempted: true })).toBe(false);
    expect(shouldAutoStartListeningCapture({ ...ready, answered: true })).toBe(false);
    expect(shouldAutoStartListeningCapture({ ...ready, busy: true })).toBe(false);
    expect(shouldAutoStartListeningCapture({ ...ready, microphoneActive: false })).toBe(false);
  });
});
