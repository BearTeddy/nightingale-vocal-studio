import type {
  AttemptContext,
  MasteryState,
  ReviewSchedule,
  SkillId,
  SkillProgress,
  SoftTestOutResult,
} from "./types";

export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_ITEMS = 30;
const ASSISTED_PASS_SCORE = 80;
const INDEPENDENT_PASS_SCORE = 75;
const REVIEW_PASS_SCORE = 75;
const REVIEW_RESET_SCORE = 60;

const MASTERY_RANK: Record<MasteryState, number> = {
  new: 0,
  practicing: 1,
  assisted: 2,
  independent: 3,
  transferred: 4,
};

export function createSkillProgress(skillId: SkillId): SkillProgress {
  return {
    skillId,
    mastery: "new",
    attemptCount: 0,
    validAttemptCount: 0,
    evidence: [],
    review: { intervalIndex: 0, nextReviewAtMs: null },
    lastAttemptAtMs: null,
    reviewRecommended: false,
  };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function normalizeAttempt(attempt: AttemptContext): AttemptContext {
  return {
    ...attempt,
    score: clampScore(attempt.score),
    validEvidence: attempt.validEvidence && Number.isFinite(attempt.completedAtMs),
  };
}

function laterMastery(left: MasteryState, right: MasteryState): MasteryState {
  return MASTERY_RANK[left] >= MASTERY_RANK[right] ? left : right;
}

function orderedValidEvidence(evidence: readonly AttemptContext[]): AttemptContext[] {
  return evidence
    .filter((attempt) => attempt.validEvidence)
    .slice()
    .sort((left, right) => left.completedAtMs - right.completedAtMs);
}

function hasAssistedEvidence(evidence: readonly AttemptContext[]): boolean {
  const lastThreeGuided = orderedValidEvidence(evidence)
    .filter((attempt) => attempt.kind !== "test-out" && attempt.assistPreset === "guided")
    .slice(-3);
  return (
    lastThreeGuided.length >= 2 &&
    lastThreeGuided.filter((attempt) => attempt.score >= ASSISTED_PASS_SCORE).length >= 2
  );
}

function hasIndependentEvidence(evidence: readonly AttemptContext[]): boolean {
  const successes = orderedValidEvidence(evidence).filter(
    (attempt) =>
      attempt.kind !== "test-out" &&
      attempt.assistPreset === "independent" &&
      attempt.score >= INDEPENDENT_PASS_SCORE,
  );

  for (let leftIndex = 0; leftIndex < successes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < successes.length; rightIndex += 1) {
      const left = successes[leftIndex];
      const right = successes[rightIndex];
      if (
        left.sessionId !== right.sessionId &&
        right.completedAtMs - left.completedAtMs >= DAY_MS
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasTransferEvidence(evidence: readonly AttemptContext[]): boolean {
  return orderedValidEvidence(evidence).some(
    (attempt) =>
      attempt.kind === "transfer" &&
      attempt.assistPreset === "independent" &&
      attempt.unfamiliarTarget === true &&
      attempt.score >= INDEPENDENT_PASS_SCORE,
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function needsReview(evidence: readonly AttemptContext[]): boolean {
  const lastFiveIndependent = orderedValidEvidence(evidence)
    .filter((attempt) => attempt.kind !== "test-out" && attempt.assistPreset === "independent")
    .slice(-5);
  return (
    lastFiveIndependent.length === 5 &&
    (median(lastFiveIndependent.map((attempt) => attempt.score)) ?? 100) < REVIEW_RESET_SCORE
  );
}

function boundedIntervalIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(REVIEW_INTERVAL_DAYS.length - 1, Math.round(index)));
}

function scheduleAt(completedAtMs: number, intervalIndex: number): ReviewSchedule {
  const boundedIndex = boundedIntervalIndex(intervalIndex);
  return {
    intervalIndex: boundedIndex,
    nextReviewAtMs: completedAtMs + REVIEW_INTERVAL_DAYS[boundedIndex] * DAY_MS,
  };
}

export function scheduleNextReview(
  current: ReviewSchedule,
  attempt: AttemptContext,
): ReviewSchedule {
  if (!attempt.validEvidence || !Number.isFinite(attempt.completedAtMs)) return current;

  const score = clampScore(attempt.score);
  if (score < REVIEW_RESET_SCORE) return scheduleAt(attempt.completedAtMs, 0);
  if (current.nextReviewAtMs == null) return scheduleAt(attempt.completedAtMs, 0);

  // A learner should get credit when they naturally use a due skill in a
  // lesson, transfer, or song—not only when they entered through the Review
  // button. Early ordinary practice leaves the existing schedule untouched.
  if (attempt.kind !== "review" && attempt.completedAtMs < current.nextReviewAtMs) return current;

  const currentIndex = boundedIntervalIndex(current.intervalIndex);
  const nextIndex = score >= REVIEW_PASS_SCORE ? currentIndex + 1 : currentIndex;
  return scheduleAt(attempt.completedAtMs, nextIndex);
}

export function updateSkillProgress(
  progress: SkillProgress,
  rawAttempt: AttemptContext,
): SkillProgress {
  if (progress.skillId !== rawAttempt.skillId) {
    throw new Error(
      `Attempt for ${rawAttempt.skillId} cannot update progress for ${progress.skillId}.`,
    );
  }
  if (progress.evidence.some((attempt) => attempt.attemptId === rawAttempt.attemptId)) {
    return progress;
  }

  const attempt = normalizeAttempt(rawAttempt);
  const evidence = [...progress.evidence, attempt]
    .sort((left, right) => left.completedAtMs - right.completedAtMs)
    .slice(-MAX_EVIDENCE_ITEMS);

  let mastery = progress.mastery;
  if (attempt.validEvidence) mastery = laterMastery(mastery, "practicing");
  if (hasAssistedEvidence(evidence)) mastery = laterMastery(mastery, "assisted");

  const independent =
    MASTERY_RANK[progress.mastery] >= MASTERY_RANK.independent || hasIndependentEvidence(evidence);
  if (independent) mastery = laterMastery(mastery, "independent");
  if (independent && hasTransferEvidence(evidence)) {
    mastery = laterMastery(mastery, "transferred");
  }

  return {
    ...progress,
    mastery,
    attemptCount: progress.attemptCount + 1,
    validAttemptCount: progress.validAttemptCount + (attempt.validEvidence ? 1 : 0),
    evidence,
    review: scheduleNextReview(progress.review, attempt),
    lastAttemptAtMs:
      progress.lastAttemptAtMs == null
        ? attempt.completedAtMs
        : Math.max(progress.lastAttemptAtMs, attempt.completedAtMs),
    reviewRecommended: needsReview(evidence),
  };
}

export function evaluateSoftTestOut(
  skillId: SkillId,
  attempts: readonly AttemptContext[],
): SoftTestOutResult {
  const candidates = attempts
    .filter(
      (attempt) =>
        attempt.skillId === skillId &&
        attempt.kind === "test-out" &&
        attempt.validEvidence &&
        attempt.assistPreset === "independent" &&
        attempt.unfamiliarTarget === true &&
        typeof attempt.targetId === "string" &&
        attempt.targetId.length > 0,
    )
    .slice()
    .sort((left, right) => right.completedAtMs - left.completedAtMs);

  const latestDistinctTargets: AttemptContext[] = [];
  const seenTargets = new Set<string>();
  for (const attempt of candidates) {
    const targetId = attempt.targetId as string;
    if (seenTargets.has(targetId)) continue;
    seenTargets.add(targetId);
    latestDistinctTargets.push(attempt);
    if (latestDistinctTargets.length === 3) break;
  }

  const ready = latestDistinctTargets.length === 3;
  const medianScore = ready
    ? median(latestDistinctTargets.map((attempt) => clampScore(attempt.score)))
    : null;
  const successfulItems = latestDistinctTargets.filter(
    (attempt) => clampScore(attempt.score) >= ASSISTED_PASS_SCORE,
  ).length;
  const passed = ready && successfulItems >= 2 && (medianScore ?? 0) >= ASSISTED_PASS_SCORE;

  return {
    skillId,
    ready,
    passed,
    successfulItems,
    medianScore,
    awardedMastery: passed ? "independent" : null,
    consideredAttemptIds: latestDistinctTargets.map((attempt) => attempt.attemptId),
  };
}

export function applySoftTestOut(
  progress: SkillProgress,
  result: SoftTestOutResult,
  completedAtMs: number,
): SkillProgress {
  if (
    progress.skillId !== result.skillId ||
    !result.passed ||
    result.awardedMastery !== "independent" ||
    !Number.isFinite(completedAtMs)
  ) {
    return progress;
  }

  return {
    ...progress,
    mastery: laterMastery(progress.mastery, "independent"),
    review: scheduleAt(completedAtMs, 1),
    lastAttemptAtMs:
      progress.lastAttemptAtMs == null
        ? completedAtMs
        : Math.max(progress.lastAttemptAtMs, completedAtMs),
  };
}
