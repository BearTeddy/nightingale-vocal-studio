import { describe, expect, it } from "vitest";
import type { MelodyMap } from "@/types/MelodyMap";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { ScoreRecord } from "@/types/ScoreRecord";
import { personalBestForRun, strictRawScore, topScoresForSong } from "./result";

const records: ScoreRecord[] = [
  { profile: "A", song_hash: "song", score: 760, played_at: 1n },
  { profile: "A", song_hash: "song", score: 820, played_at: 2n },
  { profile: "B", song_hash: "song", score: 910, played_at: 3n },
  { profile: "A", song_hash: "other", score: 990, played_at: 4n },
];

describe("playback result", () => {
  it("never awards a fallback score without eligible melody targets", () => {
    const performance = { legacy_score: 860 } as PerformanceScore;
    const unavailable = { strict_scoring_available: false } as MelodyMap;
    const available = { strict_scoring_available: true } as MelodyMap;

    expect(strictRawScore(null, performance)).toBe(0);
    expect(strictRawScore(unavailable, performance)).toBe(0);
    expect(strictRawScore(available, performance)).toBe(860);
  });

  it("compares a run with the active profile's previous best", () => {
    expect(personalBestForRun(records, "song", "A", 850)).toEqual({
      currentScore: 85,
      previousScore: 82,
      delta: 3,
      isNewBest: true,
    });
    expect(personalBestForRun(records, "song", "A", 800)).toMatchObject({
      previousScore: 82,
      delta: -2,
      isNewBest: false,
    });
  });

  it("recognizes the first scored performance", () => {
    expect(personalBestForRun(records, "song", "New singer", 700)).toEqual({
      currentScore: 70,
      previousScore: null,
      delta: null,
      isNewBest: true,
    });
  });

  it("keeps one best raw score per profile on the board", () => {
    expect(topScoresForSong(records, "song", 5)).toEqual([
      { profile: "B", score: 910 },
      { profile: "A", score: 820 },
    ]);
  });
});
