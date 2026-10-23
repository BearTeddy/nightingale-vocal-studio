import { describe, expect, it } from "vitest";
import type { PracticeSession } from "@/types/PracticeSession";
import { buildLearningProgressFromHistory } from "./history-progress";

function session(id: string, exercise: string, score: number, extras = {}): PracticeSession {
  return {
    id,
    profile: "Singer",
    song_hash: null,
    kind: `exercise:${exercise}`,
    started_at: 1_000,
    ended_at: 1_010,
    performance_json: JSON.stringify({ score, completed: true, measurable: true, ...extras }),
    recording_take_id: null,
    transport_segments: [],
  };
}

function karaokeSession(
  id: string,
  startedAt: number,
  songHash: string,
  score: number,
  feedbackMode: "coach" | "game",
  completion: "completed" | "interrupted" = "completed",
  extras: Record<string, unknown> = {},
): PracticeSession {
  return {
    id,
    profile: "Singer",
    song_hash: songHash,
    kind: "karaoke",
    started_at: startedAt,
    ended_at: startedAt + 180,
    performance_json: JSON.stringify({
      overall: score,
      completion,
      feedback_mode: feedbackMode,
      phrases: [{}, {}, {}],
      ...extras,
    }),
    recording_take_id: null,
    transport_segments: [],
  };
}

describe("learning progress from practice history", () => {
  it("keeps forgiving performances as practice instead of independent mastery", () => {
    const progress = buildLearningProgressFromHistory(
      [
        karaokeSession("second", 100_000, "song-b", 99, "game", "completed", {
          pitch_tolerance_factor: 2,
        }),
        karaokeSession("first", 1_000, "song-a", 99, "game", "completed", {
          pitch_tolerance_factor: 2,
        }),
      ],
      true,
    );
    expect(progress.find((item) => item.skillId === "performance.consistency")?.mastery).toBe(
      "practicing",
    );
    expect(progress.find((item) => item.skillId === "song.phrase")?.mastery).toBe("practicing");
  });
  it("uses a completed checkup to finish setup without assigning a voice type", () => {
    const progress = buildLearningProgressFromHistory([], true);
    expect(progress.find((item) => item.skillId === "setup.calibration")?.mastery).toBe(
      "independent",
    );
  });

  it("keeps legacy exercise scores as practice rather than retroactive mastery", () => {
    const progress = buildLearningProgressFromHistory([session("old", "center", 96)], false);
    expect(progress.find((item) => item.skillId === "pitch.centering")?.mastery).toBe("practicing");
  });

  it("allows new guided evidence to reach assisted mastery", () => {
    const learningAttempt = { assistPreset: "guided", validEvidence: true };
    const progress = buildLearningProgressFromHistory(
      [
        session("one", "sustain", 84, { learningAttempt }),
        session("two", "sustain", 88, { learningAttempt }),
      ],
      true,
    );
    expect(progress.find((item) => item.skillId === "pitch.sustain")?.mastery).toBe("assisted");
  });

  it("does not advance from an unmeasurable attempt", () => {
    const progress = buildLearningProgressFromHistory(
      [session("bad", "center", 0, { measurable: false })],
      false,
    );
    expect(progress.find((item) => item.skillId === "pitch.centering")?.mastery).toBe("new");
  });

  it("credits only the curriculum skill selected by a rhythm lesson", () => {
    const progress = buildLearningProgressFromHistory(
      [
        session("duration", "rhythm", 86, {
          learningAttempt: {
            assistPreset: "guided",
            validEvidence: true,
            lessonId: "time-and-rhythm.hold-the-length",
          },
        }),
      ],
      true,
    );
    expect(progress.find((item) => item.skillId === "rhythm.duration")?.mastery).toBe("practicing");
    expect(progress.find((item) => item.skillId === "rhythm.onset")?.mastery).toBe("new");
  });

  it("builds song transfer and performance evidence without requiring a recording", () => {
    const day = 24 * 60 * 60;
    const progress = buildLearningProgressFromHistory(
      [
        karaokeSession("second", 1_000 + day, "song-b", 88, "game"),
        karaokeSession("first", 1_000, "song-a", 84, "game"),
      ],
      true,
    );
    expect(progress.find((item) => item.skillId === "song.phrase")?.mastery).toBe("transferred");
    expect(progress.find((item) => item.skillId === "performance.consistency")?.mastery).toBe(
      "independent",
    );
  });

  it("keeps interrupted song attempts as non-mastery history", () => {
    const progress = buildLearningProgressFromHistory(
      [karaokeSession("partial", 1_000, "song-a", 95, "game", "interrupted")],
      true,
    );
    expect(progress.find((item) => item.skillId === "song.phrase")?.mastery).toBe("new");
  });

  it.each(["mic_disabled", "no_frames", "all_clipped"])(
    "rejects %s karaoke input as learning evidence",
    (status) => {
      const progress = buildLearningProgressFromHistory(
        [
          karaokeSession("invalid", 1_000, "song-a", 95, "game", "completed", {
            pitch_input: { status, valid_learning_evidence: false },
          }),
        ],
        true,
      );
      const phraseProgress = progress.find((item) => item.skillId === "song.phrase");
      expect(phraseProgress).toMatchObject({
        mastery: "new",
        attemptCount: 1,
        validAttemptCount: 0,
      });
    },
  );

  it("keeps healthy captured silence as valid zero-score evidence", () => {
    const progress = buildLearningProgressFromHistory(
      [
        karaokeSession("silent", 1_000, "song-a", 0, "game", "completed", {
          pitch_input: { status: "captured_silence", valid_learning_evidence: true },
        }),
      ],
      true,
    );
    const phraseProgress = progress.find((item) => item.skillId === "song.phrase");
    expect(phraseProgress).toMatchObject({
      mastery: "practicing",
      attemptCount: 1,
      validAttemptCount: 1,
    });
  });

  it("infers invalid input from legacy dense frames when no summary exists", () => {
    const progress = buildLearningProgressFromHistory(
      [
        karaokeSession("missing", 1_000, "song-a", 95, "game", "completed", {
          pitch_series: {
            refPitches: [440, 440],
            userPitches: [null, null],
            similarities: [0, 0],
            timestamps: [0.2, 0.4],
            frames: [null, null],
          },
        }),
      ],
      true,
    );
    expect(progress.find((item) => item.skillId === "song.phrase")).toMatchObject({
      mastery: "new",
      validAttemptCount: 0,
    });
  });
});
