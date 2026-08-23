import { describe, expect, it } from "vitest";
import { nextScoringDifficulty, scoringDifficulty, scoringDifficultyProfile } from "./difficulty";

describe("scoring difficulty", () => {
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
