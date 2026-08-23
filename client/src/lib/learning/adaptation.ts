import type {
  AdaptationDirection,
  AdaptationReason,
  AdaptationResult,
  AdaptationVariable,
  AttemptContext,
  ChallengeSettings,
} from "./types";

const HARDER_ORDER: readonly AdaptationVariable[] = [
  "assistPreset",
  "tempoRatio",
  "phraseLengthNotes",
  "intervalSpanSemitones",
  "rangeOffsetSemitones",
  "articulation",
  "lyrics",
  "feedback",
];

const EASIER_ORDER: readonly AdaptationVariable[] = [
  "feedback",
  "lyrics",
  "articulation",
  "rangeOffsetSemitones",
  "intervalSpanSemitones",
  "phraseLengthNotes",
  "tempoRatio",
  "assistPreset",
];

export const DEFAULT_CHALLENGE: ChallengeSettings = {
  assistPreset: "full",
  tempoRatio: 0.8,
  intervalSpanSemitones: 2,
  rangeOffsetSemitones: 0,
  phraseLengthNotes: 3,
  articulation: "legato",
  lyrics: "neutral-syllable",
  feedback: "continuous",
};

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function roundedRatio(value: number): number {
  return Number(value.toFixed(2));
}

function changeVariable(
  settings: ChallengeSettings,
  variable: AdaptationVariable,
  direction: Exclude<AdaptationDirection, "none">,
): ChallengeSettings | null {
  const harder = direction === "harder";

  if (variable === "assistPreset") {
    const levels = ["full", "guided", "independent"] as const;
    const currentIndex = levels.indexOf(settings.assistPreset);
    const nextIndex = currentIndex + (harder ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= levels.length) return null;
    return { ...settings, assistPreset: levels[nextIndex] };
  }

  if (variable === "tempoRatio") {
    const next = roundedRatio(settings.tempoRatio + (harder ? 0.05 : -0.05));
    if (next < 0.7 || next > 1) return null;
    return { ...settings, tempoRatio: next };
  }

  if (variable === "intervalSpanSemitones") {
    const next = settings.intervalSpanSemitones + (harder ? 1 : -1);
    if (next < 1 || next > 12) return null;
    return { ...settings, intervalSpanSemitones: next };
  }

  if (variable === "rangeOffsetSemitones") {
    const next = settings.rangeOffsetSemitones + (harder ? 1 : -1);
    if (next < 0 || next > 12) return null;
    return { ...settings, rangeOffsetSemitones: next };
  }

  if (variable === "phraseLengthNotes") {
    const next = settings.phraseLengthNotes + (harder ? 1 : -1);
    if (next < 1 || next > 16) return null;
    return { ...settings, phraseLengthNotes: next };
  }

  if (variable === "articulation") {
    if (harder && settings.articulation === "legato") {
      return { ...settings, articulation: "mixed" };
    }
    if (!harder && settings.articulation === "mixed") {
      return { ...settings, articulation: "legato" };
    }
    return null;
  }

  if (variable === "lyrics") {
    if (harder && settings.lyrics === "neutral-syllable") {
      return { ...settings, lyrics: "lyrics" };
    }
    if (!harder && settings.lyrics === "lyrics") {
      return { ...settings, lyrics: "neutral-syllable" };
    }
    return null;
  }

  const levels = ["continuous", "reduced", "results-only"] as const;
  const currentIndex = levels.indexOf(settings.feedback);
  const nextIndex = currentIndex + (harder ? 1 : -1);
  if (nextIndex < 0 || nextIndex >= levels.length) return null;
  return { ...settings, feedback: levels[nextIndex] };
}

function adaptationSignal(attempts: readonly AttemptContext[]): {
  direction: AdaptationDirection;
  reason: AdaptationReason;
} {
  const valid = attempts
    .filter((attempt) => attempt.validEvidence && Number.isFinite(attempt.completedAtMs))
    .slice()
    .sort((left, right) => left.completedAtMs - right.completedAtMs)
    .slice(-5);
  const lastTwo = valid.slice(-2);

  if (lastTwo.length === 2 && lastTwo.every((attempt) => clampScore(attempt.score) >= 80)) {
    return { direction: "harder", reason: "two-successes" };
  }
  if (lastTwo.length === 2 && lastTwo.every((attempt) => clampScore(attempt.score) < 60)) {
    return { direction: "easier", reason: "two-misses" };
  }
  if (
    valid.length === 5 &&
    valid.filter((attempt) => clampScore(attempt.score) >= 75).length / valid.length < 0.6
  ) {
    return { direction: "easier", reason: "low-five-attempt-success-rate" };
  }
  return { direction: "none", reason: "insufficient-evidence" };
}

function normalizedCursor(cursor: number, length: number): number {
  if (!Number.isFinite(cursor)) return 0;
  const rounded = Math.round(cursor);
  return ((rounded % length) + length) % length;
}

export function adaptOneVariable(
  settings: ChallengeSettings,
  recentAttempts: readonly AttemptContext[],
  variableCursor = 0,
): AdaptationResult {
  const signal = adaptationSignal(recentAttempts);
  const order = signal.direction === "easier" ? EASIER_ORDER : HARDER_ORDER;
  const cursor = normalizedCursor(variableCursor, order.length);

  if (signal.direction === "none") {
    return {
      settings,
      direction: "none",
      changedVariable: null,
      reason: signal.reason,
      nextVariableIndex: cursor,
    };
  }

  for (let offset = 0; offset < order.length; offset += 1) {
    const index = (cursor + offset) % order.length;
    const variable = order[index];
    const changed = changeVariable(settings, variable, signal.direction);
    if (!changed) continue;
    return {
      settings: changed,
      direction: signal.direction,
      changedVariable: variable,
      reason: signal.reason,
      nextVariableIndex: (index + 1) % order.length,
    };
  }

  return {
    settings,
    direction: "none",
    changedVariable: null,
    reason: "at-boundary",
    nextVariableIndex: cursor,
  };
}
