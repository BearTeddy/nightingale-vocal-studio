import { describe, expect, it } from "vitest";
import type { PitchFrame } from "@/types/PitchFrame";
import {
  adaptExercisePace,
  adaptExerciseToRange,
  analyzeExercise,
  analyzeRhythmTiming,
  createRhythmOnsetExercise,
  exerciseScoringTargetAt,
  exerciseStepAt,
  exerciseTotalSeconds,
  rhythmTargetEventAt,
  type ExerciseFrame,
  type RhythmExerciseDefinition,
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

function rhythmFrames(
  exercise: RhythmExerciseDefinition,
  onsetOffsetSeconds = 0,
  releaseOffsetSeconds = 0,
): ExerciseFrame[] {
  const frames: ExerciseFrame[] = [];
  for (let elapsed = 0; elapsed <= exercise.totalSeconds; elapsed += 0.02) {
    const target = rhythmTargetEventAt(elapsed, exercise.events);
    const voiced = exercise.events.some(
      (event) =>
        elapsed >= event.start_sec + onsetOffsetSeconds &&
        elapsed < event.end_sec + releaseOffsetSeconds,
    );
    frames.push({
      elapsed_sec: elapsed,
      target_midi: target?.target_midi ?? exercise.events[0].target_midi,
      target_active: target != null,
      target_event_id: target?.id,
      target_start_sec: target?.start_sec,
      target_end_sec: target?.end_sec,
      frame: {
        hz: voiced ? 261.63 : null,
        midi: voiced ? exercise.events[0].target_midi : null,
        clarity: voiced ? 0.95 : 0,
        rms: voiced ? 0.08 : 0.002,
        peak: voiced ? 0.16 : 0.004,
        voiced,
        sample_index: elapsed * 48_000,
        sample_rate: 48_000,
        captured_at_ms: elapsed * 1_000,
      },
    });
  }
  return frames;
}

describe("exercise analysis", () => {
  it("scores a centered sustained tone across its own dimensions", () => {
    const frames = Array.from({ length: 100 }, (_, index) => sample(index / 20));
    const result = analyzeExercise("sustain", frames, 5);
    expect(result.overall).toBe(100);
    expect(result.measurable).toBe(true);
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

    const silent = analyzeExercise("sustain", silentFrames, 5);
    expect(silent.measurable).toBe(false);
    expect(silent.measurementMessage).toMatch(/No steady sung note/);
    expect(silent.metrics).toEqual([
      { label: "Sustain", score: 0 },
      { label: "Stability", score: 0 },
      { label: "Pitch", score: 0 },
    ]);
    expect(analyzeExercise("dynamics", silentFrames, 5).overall).toBe(0);
    expect(analyzeExercise("vibrato", silentFrames, 5).overall).toBe(0);
  });

  it("marks heavily clipped input unmeasurable instead of treating it as poor singing", () => {
    const clipped = Array.from({ length: 20 }, (_, index) => sample(index / 20));
    for (const frame of clipped) frame.frame.peak = 1;
    const result = analyzeExercise("center", clipped, 1);
    expect(result.measurable).toBe(false);
    expect(result.measurementMessage).toMatch(/clipped/);
  });

  it("reports vibrato observations without grading one ideal rate or width", () => {
    const frames = Array.from({ length: 120 }, (_, index) =>
      sample(index / 20, 60 + (index >= 60 ? Math.sin(index * 1.7) * 0.2 : 0)),
    );
    const result = analyzeExercise("vibrato", frames, 6);
    expect(result.metrics.map((metric) => metric.label)).toEqual([
      "Straight tone",
      "Pitch center",
      "Continuity",
    ]);
    expect(result.observations[0]).toContain("descriptive");
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

describe("rhythm onset and release training", () => {
  it("builds a count-in exercise with distinct pulses and quiet space", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    expect(exercise.id).toBe("rhythm-onset");
    expect(exercise.events).toHaveLength(4);
    expect(exercise.events[0].start_sec).toBeGreaterThan(0);
    expect(exercise.events[1].start_sec).toBeGreaterThan(exercise.events[0].end_sec);
    expect(rhythmTargetEventAt(exercise.events[0].start_sec, exercise.events)?.id).toBe("pulse-1");
    expect(rhythmTargetEventAt(exercise.events[0].end_sec, exercise.events)).toBeNull();
  });

  it("scores observed starts and releases without conflating them with pitch", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    const frames = rhythmFrames(exercise, 0.02, -0.02);
    const timing = analyzeRhythmTiming(frames, exercise.totalSeconds);
    const result = analyzeExercise(exercise.id, frames, exercise.totalSeconds);

    expect(timing.measurableOnsets).toBe(4);
    expect(timing.measurableReleases).toBe(4);
    expect(timing.onsetScore).toBeGreaterThanOrEqual(95);
    expect(timing.releaseScore).toBeGreaterThanOrEqual(95);
    expect(result.measurable).toBe(true);
    expect(result.metrics.map((metric) => metric.label)).toEqual([
      "Onset timing",
      "Release timing",
      "Pitch",
    ]);
    expect(result.metrics[2].score).toBe(100);
  });

  it("turns consistent late starts and releases into specific timing recommendations", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    const frames = rhythmFrames(exercise, 0.24, 0.28);
    const result = analyzeExercise("rhythm", frames, exercise.totalSeconds);

    expect(result.measurable).toBe(true);
    expect(result.metrics.find((metric) => metric.label === "Onset timing")?.score).toBeLessThan(
      80,
    );
    expect(result.metrics.find((metric) => metric.label === "Release timing")?.score).toBeLessThan(
      80,
    );
    expect(result.recommendations).toEqual([
      expect.stringMatching(/begin a little sooner/),
      expect.stringMatching(/finish a little sooner/),
    ]);
    expect(result.observations).toEqual([
      expect.stringMatching(/Starts averaged about .* late/),
      expect.stringMatching(/Releases averaged about .* late/),
    ]);
  });

  it("declines to score boundaries when the capture lacks surrounding silence", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    const voicedOnly = rhythmFrames(exercise).filter(
      (frame) => frame.target_active && frame.frame.voiced,
    );
    const result = analyzeExercise(exercise.id, voicedOnly, exercise.totalSeconds);

    expect(result.measurable).toBe(false);
    expect(result.metrics.every((metric) => !metric.label.includes("timing"))).toBe(true);
    expect(result.measurementMessage).toMatch(/could not be measured fairly/);
  });

  it("does not mistake a far-away metronome click for the sung rhythm note", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    const clickOnly = rhythmFrames(exercise).map((sample) => ({
      ...sample,
      frame: sample.frame.voiced ? { ...sample.frame, midi: 84, hz: 1_046.5 } : sample.frame,
    }));
    const result = analyzeExercise("rhythm", clickOnly, exercise.totalSeconds);

    expect(result.measurable).toBe(false);
    expect(result.metrics.some((metric) => metric.label === "Onset timing")).toBe(false);
  });

  it("scores measurable onsets without inventing a release score", () => {
    const exercise = createRhythmOnsetExercise(60, 80);
    const frames = exercise.events.slice(0, 2).flatMap((event) =>
      [-0.1, -0.05, 0, 0.05].map((offset) => {
        const voiced = offset >= 0;
        return {
          elapsed_sec: event.start_sec + offset,
          target_midi: event.target_midi,
          target_active: offset >= 0,
          target_event_id: offset >= 0 ? event.id : undefined,
          target_start_sec: offset >= 0 ? event.start_sec : undefined,
          target_end_sec: offset >= 0 ? event.end_sec : undefined,
          frame: {
            hz: voiced ? 261.63 : null,
            midi: voiced ? event.target_midi : null,
            clarity: voiced ? 0.95 : 0,
            rms: voiced ? 0.08 : 0.002,
            peak: voiced ? 0.16 : 0.004,
            voiced,
            sample_index: (event.start_sec + offset) * 48_000,
            sample_rate: 48_000,
            captured_at_ms: (event.start_sec + offset) * 1_000,
          },
        } satisfies ExerciseFrame;
      }),
    );
    const result = analyzeExercise(exercise.id, frames, exercise.totalSeconds);

    expect(result.measurable).toBe(true);
    expect(result.metrics.some((metric) => metric.label === "Onset timing")).toBe(true);
    expect(result.metrics.some((metric) => metric.label === "Release timing")).toBe(false);
    expect(result.observations).toContain(
      "Release timing was not scored because too few note endings had clear voiced-to-unvoiced evidence.",
    );
  });
});

describe("comfortable-range adaptation", () => {
  it("transposes an exercise without changing intervals when it fits", () => {
    expect(adaptExerciseToRange([0, 4, 7, 12], 60, 55, 69)).toEqual({
      baseMidi: 57,
      pattern: [0, 4, 7, 12],
      rangeLimited: false,
    });
  });

  it("selects a named safe variation instead of changing interval identity", () => {
    const adapted = adaptExerciseToRange([0, 4, 7, 12], 60, 60, 67, [[0, 4, 7, 4, 0]]);
    const notes = adapted.pattern.map((offset) => adapted.baseMidi + offset);
    expect(Math.min(...notes)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...notes)).toBeLessThanOrEqual(67);
    expect(adapted.pattern).toEqual([0, 4, 7, 4, 0]);
    expect(adapted.rangeLimited).toBe(true);
  });

  it("falls back to one comfortable note instead of distorting a pattern", () => {
    expect(adaptExerciseToRange([0, 4, 7, 12], 60, 58, 58)).toEqual({
      baseMidi: 58,
      pattern: [0],
      rangeLimited: true,
    });

    const rounded = adaptExerciseToRange([0, 2, 4, 7], 60, 57.6, 57.9);
    expect(rounded.pattern.map((offset) => rounded.baseMidi + offset)).toEqual([58]);
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
