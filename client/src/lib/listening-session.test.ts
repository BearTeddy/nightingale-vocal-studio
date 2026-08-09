import { describe, expect, it } from "vitest";
import type { IntervalAnswer, SungPitchAttempt } from "./interval-listening";
import { buildListeningSession } from "./listening-session";

describe("Listening practice sessions", () => {
  it("retains the full set, every sung attempt, and the actual time span", () => {
    const answers: IntervalAnswer[] = [
      { expectedSemitones: 0, selectedSemitones: 0, correct: true },
      { expectedSemitones: 7, selectedSemitones: 5, correct: false },
    ];
    const centered: SungPitchAttempt = {
      targetMidi: 60,
      detectedMidi: 60.1,
      cents: 10,
      score: 100,
      voicedFrames: 30,
      feedback: "On pitch.",
    };
    const session = buildListeningSession({
      id: "listening-test",
      profile: "Guest",
      startedAt: 100,
      endedAt: 125,
      answers,
      sungAttempts: [centered, null],
    });
    const performance = JSON.parse(session.performance_json ?? "{}") as Record<string, unknown>;

    expect(session.started_at).toBe(100);
    expect(session.ended_at).toBe(125);
    expect(performance).toMatchObject({
      version: 3,
      score: 75,
      intervalScore: 50,
      pitchScore: 100,
      exercise: "Hear, sing, and name",
      answers,
      sungAttempts: [centered, null],
    });
  });

  it("normalizes an invalid reversed time span", () => {
    const session = buildListeningSession({
      id: "listening-test",
      profile: "Guest",
      startedAt: 200,
      endedAt: 190,
      answers: [],
      sungAttempts: [],
    });

    expect(session.started_at).toBe(190);
    expect(session.ended_at).toBe(190);
  });
});
