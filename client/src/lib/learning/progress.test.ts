import { describe, expect, it } from "vitest";

import {
  applySoftTestOut,
  createSkillProgress,
  evaluateSoftTestOut,
  scheduleNextReview,
  updateSkillProgress,
} from "./progress";
import type { AttemptContext, SkillId, SkillProgress } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

function attempt(
  id: string,
  score: number,
  overrides: Partial<AttemptContext> = {},
): AttemptContext {
  return {
    attemptId: id,
    sessionId: `session-${id}`,
    lessonId: "pitch-imitation.single-note-echo",
    skillId: "pitch.imitation",
    stage: "pitch-imitation",
    kind: "lesson",
    assistPreset: "guided",
    score,
    validEvidence: true,
    completedAtMs: Number(id.replace(/\D/g, "")) * 1_000 || 1_000,
    ...overrides,
  };
}

function applyAttempts(skillId: SkillId, attempts: readonly AttemptContext[]): SkillProgress {
  return attempts.reduce(updateSkillProgress, createSkillProgress(skillId));
}

describe("skill progress", () => {
  it("moves to assisted after two of the last three guided attempts pass", () => {
    const progress = applyAttempts("pitch.imitation", [
      attempt("1", 85),
      attempt("2", 70),
      attempt("3", 82),
    ]);

    expect(progress.mastery).toBe("assisted");
    expect(progress.attemptCount).toBe(3);
    expect(progress.validAttemptCount).toBe(3);
  });

  it("requires two successful independent sessions at least a day apart", () => {
    let progress = applyAttempts("pitch.imitation", [attempt("1", 85), attempt("2", 88)]);
    progress = updateSkillProgress(
      progress,
      attempt("3", 78, {
        assistPreset: "independent",
        sessionId: "first-independent",
        completedAtMs: 10_000,
      }),
    );
    progress = updateSkillProgress(
      progress,
      attempt("4", 82, {
        assistPreset: "independent",
        sessionId: "second-independent",
        completedAtMs: 10_000 + DAY_MS - 1,
      }),
    );
    expect(progress.mastery).toBe("assisted");

    progress = updateSkillProgress(
      progress,
      attempt("5", 80, {
        assistPreset: "independent",
        sessionId: "third-independent",
        completedAtMs: 10_000 + DAY_MS,
      }),
    );
    expect(progress.mastery).toBe("independent");
  });

  it("awards transfer only after independent mastery and an unfamiliar transfer", () => {
    let progress = applyAttempts("pitch.imitation", [
      attempt("1", 84, {
        assistPreset: "independent",
        sessionId: "day-one",
        completedAtMs: 1_000,
      }),
      attempt("2", 86, {
        assistPreset: "independent",
        sessionId: "day-two",
        completedAtMs: 1_000 + DAY_MS,
      }),
    ]);
    expect(progress.mastery).toBe("independent");

    progress = updateSkillProgress(
      progress,
      attempt("3", 77, {
        kind: "transfer",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "new-song-phrase",
        completedAtMs: 1_000 + DAY_MS * 2,
      }),
    );
    expect(progress.mastery).toBe("transferred");

    progress = updateSkillProgress(
      progress,
      attempt("4", 20, {
        assistPreset: "independent",
        completedAtMs: 1_000 + DAY_MS * 3,
      }),
    );
    expect(progress.mastery).toBe("transferred");
  });

  it("does not treat invalid evidence as practice or duplicate attempts twice", () => {
    const invalid = attempt("1", 100, { validEvidence: false });
    let progress = updateSkillProgress(createSkillProgress("pitch.imitation"), invalid);
    expect(progress.mastery).toBe("new");
    expect(progress.validAttemptCount).toBe(0);
    expect(progress.review.nextReviewAtMs).toBeNull();

    progress = updateSkillProgress(progress, invalid);
    expect(progress.attemptCount).toBe(1);
  });

  it("recommends review after five weak independent attempts without demoting mastery", () => {
    let progress: SkillProgress = {
      ...createSkillProgress("pitch.imitation"),
      mastery: "independent",
    };
    for (let index = 0; index < 5; index += 1) {
      progress = updateSkillProgress(
        progress,
        attempt(String(index + 1), 50 + index, {
          assistPreset: "independent",
          completedAtMs: index * DAY_MS,
        }),
      );
    }
    expect(progress.mastery).toBe("independent");
    expect(progress.reviewRecommended).toBe(true);
  });
});

describe("review scheduling", () => {
  it("uses 1, 3, 7, and 14 day intervals and caps at fourteen days", () => {
    let review = scheduleNextReview(
      { intervalIndex: 0, nextReviewAtMs: null },
      attempt("1", 80, { completedAtMs: 0 }),
    );
    expect(review).toEqual({ intervalIndex: 0, nextReviewAtMs: DAY_MS });

    for (const [index, days] of [
      [1, 3],
      [2, 7],
      [3, 14],
      [3, 14],
    ] as const) {
      const completedAtMs = review.nextReviewAtMs as number;
      review = scheduleNextReview(
        review,
        attempt(`review-${index}-${days}`, 80, { kind: "review", completedAtMs }),
      );
      expect(review.intervalIndex).toBe(index);
      expect(review.nextReviewAtMs).toBe(completedAtMs + days * DAY_MS);
    }
  });

  it("resets weak evidence, ignores early practice, and credits natural practice once due", () => {
    const existing = { intervalIndex: 2, nextReviewAtMs: 20 * DAY_MS };
    expect(
      scheduleNextReview(existing, attempt("1", 90, { kind: "lesson", completedAtMs: 5 * DAY_MS })),
    ).toEqual(existing);
    expect(
      scheduleNextReview(existing, attempt("2", 40, { kind: "review", completedAtMs: 5 * DAY_MS })),
    ).toEqual({ intervalIndex: 0, nextReviewAtMs: 6 * DAY_MS });
    expect(
      scheduleNextReview(
        existing,
        attempt("3", 90, { kind: "transfer", completedAtMs: 20 * DAY_MS }),
      ),
    ).toEqual({ intervalIndex: 3, nextReviewAtMs: 34 * DAY_MS });
  });
});

describe("soft test-out", () => {
  it("awards independent mastery for two passes and a median of eighty across three targets", () => {
    const attempts = [
      attempt("1", 82, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "a",
      }),
      attempt("2", 79, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "b",
      }),
      attempt("3", 85, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "c",
      }),
    ];
    const result = evaluateSoftTestOut("pitch.imitation", attempts);
    expect(result).toMatchObject({
      ready: true,
      passed: true,
      successfulItems: 2,
      medianScore: 82,
      awardedMastery: "independent",
    });

    const promoted = applySoftTestOut(createSkillProgress("pitch.imitation"), result, DAY_MS);
    expect(promoted.mastery).toBe("independent");
    expect(promoted.review).toEqual({ intervalIndex: 1, nextReviewAtMs: 4 * DAY_MS });
  });

  it("requires three distinct, valid, independent, unfamiliar targets", () => {
    const repeated = [
      attempt("1", 100, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "same",
      }),
      attempt("2", 100, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "same",
      }),
      attempt("3", 100, {
        kind: "test-out",
        assistPreset: "independent",
        unfamiliarTarget: true,
        targetId: "other",
      }),
    ];
    expect(evaluateSoftTestOut("pitch.imitation", repeated)).toMatchObject({
      ready: false,
      passed: false,
      awardedMastery: null,
    });
  });
});
