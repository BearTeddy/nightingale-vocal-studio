import { describe, expect, it } from "vitest";
import { noteCelebrationForStreak } from "./note-celebration";

describe("note celebration tiers", () => {
  it.each([
    [1, "NOTE HIT!", "ON PITCH"],
    [2, "NICE!", "2 NOTE COMBO"],
    [3, "GREAT!", "3 NOTE COMBO"],
    [5, "AMAZING!", "5 NOTE COMBO"],
    [10, "SUPERSTAR!", "10 NOTE COMBO"],
    [20, "LEGENDARY!", "20 NOTE COMBO"],
  ])("maps streak %i to the expected milestone", (streak, headline, detail) => {
    expect(noteCelebrationForStreak(streak)).toMatchObject({ headline, detail });
  });

  it("normalizes invalid and fractional streaks", () => {
    expect(noteCelebrationForStreak(-4).detail).toBe("ON PITCH");
    expect(noteCelebrationForStreak(5.9).detail).toBe("5 NOTE COMBO");
  });
});
