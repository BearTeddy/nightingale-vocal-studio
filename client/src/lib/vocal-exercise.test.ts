import { describe, expect, it } from "vitest";
import type { PitchFrame } from "@/types/PitchFrame";
import {
  adaptExercisePace,
  adaptExerciseToRange,
  analyzeExercise,
  exerciseScoringTargetAt,
  exerciseStepAt,
  exerciseTotalSeconds,
  type ExerciseFrame,
} from "./vocal-exercise";

function sample(elapsed: number, midi = 60, rms = 0.08): ExerciseFrame {
  const frame: PitchFrame = {
    hz: 261.63,
    midi,
    clarity: 0.95,
    rms,
    peak: rms * 2,
    voiced: true,
    sample_index: elapsed * 48_000,
    sample_rate: 48_000,
    captured_at_ms: elapsed * 1000,
  };
  return { elapsed_sec: elapsed, target_midi: 60, frame };
}

describe("exercise analysis", () => {
  it("scores a centered sustained tone across its own dimensions", () => {
    const frames = Array.from({ length: 100 }, (_, index) => sample(index / 20));
    const result = analyzeExercise("sustain", frames, 5);
    expect(result.overall).toBe(100);
    expect(result.metrics.map((metric) => metric.label)).toEqual(["Sustain", "Stability", "Pitch"]);
  });

  it("uses a separate dynamic-shape metric for the dynamics exercise", () => {
    const frames = Array.from({ length: 100 }, (_, index) => {
      const progress = index / 99;
      const rms = 0.03 + 0.07 * (1 - Math.abs(progress * 2 - 1));
      return sample(progress * 5, 60, rms);
    });
    const result = analyzeExercise("dynamics", frames, 5);
    expect(result.metrics[0].label).toBe("Dynamic shape");
    expect(result.metrics[0].score).toBeGreaterThan(80);
  });

  it("does not award stability, dynamics, or vibrato credit for silence", () => {
    const silentFrames = Array.from({ length: 100 }, (_, index) => {
      const frame = sample(index / 20);
      frame.frame.voiced = false;
      frame.frame.midi = null;
      frame.frame.clarity = 0;
      return frame;
    });

    expect(analyzeExercise("sustain", silentFrames, 5).metrics).toEqual([
      { label: "Sustain", score: 0 },
      { label: "Stability", score: 0 },
      { label: "Pitch", score: 0 },
    ]);
    expect(analyzeExercise("dynamics", silentFrames, 5).overall).toBe(0);
    expect(analyzeExercise("vibrato", silentFrames, 5).overall).toBe(0);
  });
});

describe("exercise timeline", () => {
  it("separates listening from scored singing in call-and-response exercises", () => {
    expect(exerciseTotalSeconds(3, 1, true)).toBe(6);
    expect(exerciseStepAt(0.2, 3, 1, true)).toEqual({ index: 0, phase: "listen" });
    expect(exerciseStepAt(1.2, 3, 1, true)).toEqual({ index: 0, phase: "sing" });
    expect(exerciseStepAt(2.2, 3, 1, true)).toEqual({ index: 1, phase: "listen" });
    expect(exerciseStepAt(5.2, 3, 1, true)).toEqual({ index: 2, phase: "sing" });
    expect(exerciseStepAt(6, 3, 1, true)).toEqual({ index: null, phase: "complete" });
  });

  it("scores only the response after reference-tone bleed has settled", () => {
    expect(exerciseScoringTargetAt(-0.1, [0, 4], 60, 1, true)).toBeNull();
    expect(exerciseScoringTargetAt(0.9, [0, 4], 60, 1, true)).toBeNull();
    expect(exerciseScoringTargetAt(1.05, [0, 4], 60, 1, true)).toBeNull();
    expect(exerciseScoringTargetAt(1.12, [0, 4], 60, 1, true)).toBe(60);
    expect(exerciseScoringTargetAt(3.12, [0, 4], 60, 1, true)).toBe(64);
    expect(exerciseScoringTargetAt(4, [0, 4], 60, 1, true)).toBeNull();
  });

  it("scores continuous exercises immediately after their lead-in", () => {
    expect(exerciseScoringTargetAt(0, [0, 2], 60, 1)).toBe(60);
    expect(exerciseScoringTargetAt(1.1, [0, 2], 60, 1)).toBe(62);
  });
});

describe("comfortable-range adaptation", () => {
  it("transposes an exercise without changing intervals when it fits", () => {
    expect(adaptExerciseToRange([0, 4, 7, 12], 60, 55, 69)).toEqual({
      baseMidi: 57,
      pattern: [0, 4, 7, 12],
    });
  });

  it("compresses an exercise only when the measured range is narrower", () => {
    const adapted = adaptExerciseToRange([0, 4, 7, 12], 60, 60, 67);
    const notes = adapted.pattern.map((offset) => adapted.baseMidi + offset);
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...notes)).toBeLessThanOrEqual(67);
    expect(adapted.pattern[0]).toBe(0);
    expect(adapted.pattern[adapted.pattern.length - 1]).toBe(7);
  });

  it("keeps exercises inside a one-note measured range", () => {
    expect(adaptExerciseToRange([0, 4, 7, 12], 60, 58, 58)).toEqual({
      baseMidi: 58,
      pattern: [0, 0, 0, 0],
    });

    const rounded = adaptExerciseToRange([0, 2, 4, 7], 60, 57.6, 57.9);
    expect(rounded.pattern.map((offset) => rounded.baseMidi + offset)).toEqual([58, 58, 58, 58]);
  });
});

describe("attempt-aware pacing", () => {
  it("slows weak attempts, preserves developing attempts, and advances strong attempts", () => {
    expect(adaptExercisePace(1, 40)).toBe(1.25);
    expect(adaptExercisePace(1, 65)).toBe(1.1);
    expect(adaptExercisePace(1, 82)).toBe(1);
    expect(adaptExercisePace(1, 95)).toBe(0.9);
    expect(adaptExercisePace(1, null)).toBe(1);
  });
});
