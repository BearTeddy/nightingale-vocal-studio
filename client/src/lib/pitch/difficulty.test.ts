import { describe, expect, it } from "vitest";
import {
  nextScoringDifficulty,
  pitchToleranceFactor,
  scoringDifficulty,
  scoringDifficultyProfile,
} from "./difficulty";

describe("scoring difficulty", () => {
  it("bounds and quantizes custom forgiveness with safe legacy defaults", () => {
    expect(pitchToleranceFactor(null)).toBe(1);
    expect(pitchToleranceFactor(NaN)).toBe(1);
    expect(pitchToleranceFactor(Infinity)).toBe(1);
    expect(pitchToleranceFactor(-10)).toBe(0.5);
    expect(pitchToleranceFactor(10)).toBe(2);
    expect(pitchToleranceFactor(1.23)).toBe(1.25);
  });

  it("scales only the pitch window and leaves timing and stability honest", () => {
    const hard = scoringDifficultyProfile("medium", 0.5);
    const easy = scoringDifficultyProfile("medium", 2);
    expect(hard.fullCreditCents).toBe(12.5);
    expect(easy.fullCreditCents).toBe(50);
    expect(hard.zeroCreditCents).toBe(50);
    expect(easy.zeroCreditCents).toBe(200);
    expect(hard.timingPenaltyPerSecond).toBe(easy.timingPenaltyPerSecond);
    expect(hard.stabilityPenalty).toBe(easy.stabilityPenalty);
  });
  it("falls back to medium for old or invalid config values", () => {
    expect(scoringDifficulty(null)).toBe("medium");
    expect(scoringDifficulty("unknown")).toBe("medium");
  });

  it("cycles from Easy through Medium and Pro", () => {
    expect(nextScoringDifficulty("easy")).toBe("medium");
    expect(nextScoringDifficulty("medium")).toBe("pro");
    expect(nextScoringDifficulty("pro")).toBe("easy");
  });

  it("tightens pitch, hit, and timing tolerances as difficulty rises", () => {
    const easy = scoringDifficultyProfile("easy");
    const medium = scoringDifficultyProfile("medium");
    const pro = scoringDifficultyProfile("pro");

    expect(easy.fullCreditCents).toBeGreaterThan(medium.fullCreditCents);
    expect(medium.fullCreditCents).toBeGreaterThan(pro.fullCreditCents);
    expect(easy.noteHitThreshold).toBeLessThan(medium.noteHitThreshold);
    expect(medium.noteHitThreshold).toBeLessThan(pro.noteHitThreshold);
    expect(easy.timingPenaltyPerSecond).toBeLessThan(medium.timingPenaltyPerSecond);
    expect(medium.timingPenaltyPerSecond).toBeLessThan(pro.timingPenaltyPerSecond);
    expect(easy.stabilityPenalty).toBeLessThan(medium.stabilityPenalty);
    expect(medium.stabilityPenalty).toBeLessThan(pro.stabilityPenalty);
  });
});
