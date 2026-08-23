export type ScoringDifficulty = "easy" | "medium" | "pro";

export interface ScoringDifficultyProfile {
  id: ScoringDifficulty;
  label: string;
  description: string;
  fullCreditCents: number;
  zeroCreditCents: number;
  noteHitThreshold: number;
  timingPenaltyPerSecond: number;
  stabilityPenalty: number;
}

export const SCORING_DIFFICULTY_PROFILES: Record<ScoringDifficulty, ScoringDifficultyProfile> = {
  easy: {
    id: "easy",
    label: "Forgiving",
    description:
      "A wide scoring window for learning the melody. This is score strictness, not singer level.",
    fullCreditCents: 50,
    zeroCreditCents: 150,
    noteHitThreshold: 0.55,
    timingPenaltyPerSecond: 160,
    stabilityPenalty: 0.65,
  },
  medium: {
    id: "medium",
    label: "Balanced",
    description: "Balanced pitch and timing precision for regular practice.",
    fullCreditCents: 25,
    zeroCreditCents: 100,
    noteHitThreshold: 0.75,
    timingPenaltyPerSecond: 250,
    stabilityPenalty: 1,
  },
  pro: {
    id: "pro",
    label: "Precision",
    description: "A tight scoring window for detailed performance work.",
    fullCreditCents: 12,
    zeroCreditCents: 60,
    noteHitThreshold: 0.85,
    timingPenaltyPerSecond: 340,
    stabilityPenalty: 1.35,
  },
};

export const SCORING_DIFFICULTIES: ScoringDifficulty[] = ["easy", "medium", "pro"];

export function scoringDifficulty(value: string | null | undefined): ScoringDifficulty {
  return value === "easy" || value === "pro" ? value : "medium";
}

export function nextScoringDifficulty(current: ScoringDifficulty): ScoringDifficulty {
  const index = SCORING_DIFFICULTIES.indexOf(current);
  return SCORING_DIFFICULTIES[(index + 1) % SCORING_DIFFICULTIES.length];
}

export function scoringDifficultyProfile(difficulty: ScoringDifficulty): ScoringDifficultyProfile {
  return SCORING_DIFFICULTY_PROFILES[difficulty];
}
