import { describe, expect, it } from "vitest";

import { summarizeExerciseAttempt } from "./attempt-summary";

const measured = {
  overall: 88,
  metrics: [
    { label: "Pitch", score: 92 },
    { label: "Stability", score: 76 },
  ],
  recommendations: [],
  observations: [],
  measurable: true,
  measurementMessage: null,
};

describe("exercise attempt summary", () => {
  it("moves a strong complete attempt back toward the learning plan", () => {
    expect(summarizeExerciseAttempt(measured, true)).toEqual({
      title: "Ready for the next step.",
      detail: "Strongest: Pitch (92). Next focus: Stability (76).",
      nextAction: "continue",
    });
  });

  it("asks for a complete repeat after an early stop", () => {
    expect(summarizeExerciseAttempt(measured, false).nextAction).toBe("repeat");
  });

  it("never treats an unreliable take as scored evidence", () => {
    const summary = summarizeExerciseAttempt(
      {
        ...measured,
        measurable: false,
        measurementMessage: "The input clipped too often.",
      },
      true,
    );

    expect(summary).toEqual({
      title: "Let’s get a cleaner take.",
      detail: "The input clipped too often.",
      nextAction: "fix-signal",
    });
  });
});
