import { describe, expect, it } from "vitest";

import { adaptOneVariable, DEFAULT_CHALLENGE } from "./adaptation";
import type { AttemptContext, ChallengeSettings } from "./types";

function attempt(id: string, score: number, validEvidence = true): AttemptContext {
  return {
    attemptId: id,
    sessionId: `session-${id}`,
    lessonId: "pitch-imitation.single-note-echo",
    skillId: "pitch.imitation",
    stage: "pitch-imitation",
    kind: "lesson",
    assistPreset: "guided",
    score,
    validEvidence,
    completedAtMs: Number(id) * 1_000,
  };
}

function changedKeys(left: ChallengeSettings, right: ChallengeSettings): string[] {
  return (Object.keys(left) as Array<keyof ChallengeSettings>).filter(
    (key) => left[key] !== right[key],
  );
}

describe("one-variable adaptation", () => {
  it("makes exactly one variable harder after two confident successes", () => {
    const result = adaptOneVariable(DEFAULT_CHALLENGE, [attempt("1", 85), attempt("2", 90)]);

    expect(result).toMatchObject({
      direction: "harder",
      changedVariable: "assistPreset",
      reason: "two-successes",
    });
    expect(result.settings.assistPreset).toBe("guided");
    expect(changedKeys(DEFAULT_CHALLENGE, result.settings)).toEqual(["assistPreset"]);
  });

  it("rotates to the requested variable while still changing only one", () => {
    const result = adaptOneVariable(DEFAULT_CHALLENGE, [attempt("1", 85), attempt("2", 90)], 1);

    expect(result.changedVariable).toBe("tempoRatio");
    expect(result.settings.tempoRatio).toBe(0.85);
    expect(changedKeys(DEFAULT_CHALLENGE, result.settings)).toEqual(["tempoRatio"]);
  });

  it("simplifies one available variable after two confident misses", () => {
    const result = adaptOneVariable(DEFAULT_CHALLENGE, [attempt("1", 45), attempt("2", 55)]);

    expect(result).toMatchObject({
      direction: "easier",
      changedVariable: "intervalSpanSemitones",
      reason: "two-misses",
    });
    expect(result.settings.intervalSpanSemitones).toBe(1);
    expect(changedKeys(DEFAULT_CHALLENGE, result.settings)).toEqual(["intervalSpanSemitones"]);
  });

  it("simplifies when fewer than sixty percent of five attempts succeed", () => {
    const result = adaptOneVariable(DEFAULT_CHALLENGE, [
      attempt("1", 50),
      attempt("2", 80),
      attempt("3", 50),
      attempt("4", 80),
      attempt("5", 65),
    ]);

    expect(result.direction).toBe("easier");
    expect(result.reason).toBe("low-five-attempt-success-rate");
    expect(changedKeys(DEFAULT_CHALLENGE, result.settings)).toHaveLength(1);
  });

  it("ignores invalid attempts and reports when every variable is at its boundary", () => {
    const insufficient = adaptOneVariable(DEFAULT_CHALLENGE, [
      attempt("1", 90),
      attempt("2", 90, false),
    ]);
    expect(insufficient).toMatchObject({
      direction: "none",
      changedVariable: null,
      reason: "insufficient-evidence",
    });

    const maximum: ChallengeSettings = {
      assistPreset: "independent",
      tempoRatio: 1,
      intervalSpanSemitones: 12,
      rangeOffsetSemitones: 12,
      phraseLengthNotes: 16,
      articulation: "mixed",
      lyrics: "lyrics",
      feedback: "results-only",
    };
    const boundary = adaptOneVariable(maximum, [attempt("1", 90), attempt("2", 95)]);
    expect(boundary).toMatchObject({
      settings: maximum,
      direction: "none",
      changedVariable: null,
      reason: "at-boundary",
    });
  });
});
