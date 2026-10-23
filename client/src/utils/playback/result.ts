import type { MelodyMap } from "@/types/MelodyMap";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { ScoreRecord } from "@/types/ScoreRecord";
import {
  pitchToleranceFactor,
  scoringDifficulty,
  type ScoringDifficulty,
} from "@/lib/pitch/difficulty";

export function matchesScoringSettings(
  record: ScoreRecord,
  difficulty: ScoringDifficulty,
  factor = 1,
): boolean {
  return (
    scoringDifficulty(record.difficulty) === difficulty &&
    pitchToleranceFactor(record.pitch_tolerance_factor) === pitchToleranceFactor(factor)
  );
}

export interface PersonalBestComparison {
  currentScore: number;
  previousScore: number | null;
  delta: number | null;
  isNewBest: boolean;
}

export function strictRawScore(melody: MelodyMap | null, performance: PerformanceScore): number {
  return melody?.strict_scoring_available === true ? performance.legacy_score : 0;
}

export function halfStarUnits(score: number): number {
  return Math.min(10, Math.round(score / 100));
}

export function topScoresForSong(
  records: ScoreRecord[],
  songHash: string,
  limit: number,
  difficulty: ScoringDifficulty = "medium",
  factor = 1,
): Array<{ profile: string; score: number }> {
  const best = new Map<string, number>();

  for (const r of records) {
    if (r.song_hash !== songHash || !matchesScoringSettings(r, difficulty, factor)) {
      continue;
    }

    const prev = best.get(r.profile);
    if (prev === undefined || r.score > prev) {
      best.set(r.profile, r.score);
    }
  }

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([profile, score]) => ({ profile, score }));
}

export function personalBestForRun(
  records: ScoreRecord[],
  songHash: string,
  profile: string,
  currentRawScore: number,
  difficulty: ScoringDifficulty = "medium",
  factor = 1,
): PersonalBestComparison {
  const previousRawScores = records
    .filter(
      (record) =>
        record.song_hash === songHash &&
        record.profile === profile &&
        matchesScoringSettings(record, difficulty, factor),
    )
    .map((record) => record.score);
  const previousRaw = previousRawScores.length === 0 ? null : Math.max(...previousRawScores);
  const currentScore = Math.round(currentRawScore / 10);
  const previousScore = previousRaw == null ? null : Math.round(previousRaw / 10);

  return {
    currentScore,
    previousScore,
    delta: previousScore == null ? null : currentScore - previousScore,
    isNewBest: previousRaw == null || currentRawScore > previousRaw,
  };
}
