import type { MelodyMap } from "@/types/MelodyMap";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { ScoreRecord } from "@/types/ScoreRecord";

export interface PersonalBestComparison {
  currentScore: number;
  previousScore: number | null;
  delta: number | null;
  isNewBest: boolean;
}

export function strictRawScore(
  melody: MelodyMap | null,
  performance: PerformanceScore,
): number {
  return melody?.strict_scoring_available === true ? performance.legacy_score : 0;
}

export function halfStarUnits(score: number): number {
  return Math.min(10, Math.round(score / 100));
}

export function topScoresForSong(
  records: ScoreRecord[],
  songHash: string,
  limit: number,
): Array<{ profile: string; score: number }> {
  const best = new Map<string, number>();

  for (const r of records) {
    if (r.song_hash !== songHash) {
      continue;
    }

    const prev = best.get(r.profile) ?? 0;
    if (r.score > prev) {
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
): PersonalBestComparison {
  const previousRawScores = records
    .filter((record) => record.song_hash === songHash && record.profile === profile)
    .map((record) => record.score);
  const previousRaw =
    previousRawScores.length === 0 ? null : Math.max(...previousRawScores);
  const currentScore = Math.round(currentRawScore / 10);
  const previousScore = previousRaw == null ? null : Math.round(previousRaw / 10);

  return {
    currentScore,
    previousScore,
    delta: previousScore == null ? null : currentScore - previousScore,
    isNewBest: previousRaw == null || currentRawScore > previousRaw,
  };
}
