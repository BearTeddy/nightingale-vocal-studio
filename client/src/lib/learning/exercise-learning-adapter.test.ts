import type { ExerciseResult } from "@/lib/vocal-exercise";
import type { LearningState } from "@/types/LearningState";
import type { SaveLearningAttemptRequest } from "@/types/SaveLearningAttemptRequest";
import { describe, expect, it } from "vitest";
import {
  EXERCISE_LEARNING_MAP,
  aggregateTechniquePreferences,
  buildExerciseLearningAttemptRequest,
  learningStateToSkillProgress,
  resolveExerciseLearningMapping,
} from "./exercise-learning-adapter";
import type { TechniqueReflection } from "./technique-coaching";

function exerciseResult(overrides: Partial<ExerciseResult> = {}): ExerciseResult {
  return {
    overall: 86,
    metrics: [
      { label: "Pitch", score: 88 },
      { label: "Stability", score: 84 },
    ],
    recommendations: ["Repeat once at the same easy level."],
    observations: ["The pitch settled after the onset."],
    measurable: true,
    measurementMessage: null,
    ...overrides,
  };
}

function stateFromRequest(request: SaveLearningAttemptRequest): LearningState {
  return {
    learner_profile: request.learner_profile,
    progress: request.progress_updates,
    technique_preferences: request.technique_preferences,
    recent_attempts: [request.attempt],
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    exerciseId: "center",
    result: exerciseResult(),
    profile: "Singer",
    startedAtMs: 1_750_000_000_123,
    endedAtMs: 1_750_000_004_567,
    completed: true,
    assistPreset: "guided" as const,
    practiceSessionId: "practice-center-1",
    range: {
      comfortableLowMidi: 55,
      comfortableHighMidi: 72,
      reliableLowMidi: 52,
      reliableHighMidi: 76,
      exploredLowMidi: 48,
      exploredHighMidi: 79,
    },
    ...overrides,
  };
}

describe("exercise curriculum mapping", () => {
  it("maps every current exercise id to a stable curriculum lesson", () => {
    expect(EXERCISE_LEARNING_MAP.center).toMatchObject({
      lessonId: "center-and-hold.center-the-note",
      skillId: "pitch.centering",
      stage: "center-and-hold",
    });
    expect(EXERCISE_LEARNING_MAP.rhythm).toMatchObject({
      lessonId: "time-and-rhythm.start-on-the-beat",
      skillId: "rhythm.onset",
      stage: "time-and-rhythm",
    });
    expect(Object.keys(EXERCISE_LEARNING_MAP)).toEqual(
      expect.arrayContaining([
        "center",
        "listening",
        "intervals",
        "scale",
        "arpeggio",
        "sustain",
        "slides",
        "rhythm",
        "dynamics",
        "vibrato",
      ]),
    );
  });

  it("uses a known lesson override to select its skill, stage, and version", () => {
    expect(resolveExerciseLearningMapping("rhythm", "time-and-rhythm.hold-the-length")).toEqual({
      exerciseId: "rhythm",
      lessonId: "time-and-rhythm.hold-the-length",
      skillId: "rhythm.duration",
      stage: "time-and-rhythm",
    });
    expect(() => resolveExerciseLearningMapping("unknown")).toThrow(/No curriculum mapping/);
    expect(() => resolveExerciseLearningMapping("rhythm", "missing-lesson")).toThrow(
      /Unknown curriculum lesson/,
    );
  });
});

describe("completed exercise persistence adapter", () => {
  it("builds an atomic request with millisecond times, range, assistance, and valid evidence", () => {
    const request = buildExerciseLearningAttemptRequest(
      baseInput({ signalConfidence: 0.91, recordingTakeId: "take-1" }),
    );

    expect(request.attempt).toMatchObject({
      id: "learning:practice-center-1:pitch.centering",
      profile: "Singer",
      skill_id: "pitch.centering",
      lesson_id: "center-and-hold.center-the-note",
      stage: "center-and-hold",
      assist_preset: "guided",
      started_at_ms: 1_750_000_000_123,
      ended_at_ms: 1_750_000_004_567,
      practice_session_id: "practice-center-1",
      recording_take_id: "take-1",
      valid_evidence: true,
      completion_reason: "completed",
      score: 86,
      signal_confidence: 0.91,
    });
    expect(request.learner_profile).toMatchObject({
      profile: "Singer",
      current_stage: "center-and-hold",
      comfortable_low_midi: 55,
      comfortable_high_midi: 72,
      reliable_low_midi: 52,
      reliable_high_midi: 76,
      explored_low_midi: 48,
      explored_high_midi: 79,
      updated_at_ms: 1_750_000_004_567,
    });
    expect(request.progress_updates[0]).toMatchObject({
      skill_id: "pitch.centering",
      mastery_state: "practicing",
      attempt_count: 1,
      valid_attempt_count: 1,
      rolling_score: 86,
    });
    expect(JSON.parse(request.attempt.evidence_json)).toMatchObject({
      schemaVersion: 1,
      measurable: true,
      validEvidence: true,
    });
  });

  it("keeps interrupted or unreliable attempts without granting mastery evidence", () => {
    const interrupted = buildExerciseLearningAttemptRequest(
      baseInput({ completed: false, signalConfidence: 0.9 }),
    );
    expect(interrupted.attempt).toMatchObject({
      valid_evidence: false,
      completion_reason: "interrupted",
      score: 86,
    });
    expect(interrupted.progress_updates[0]).toMatchObject({
      mastery_state: "new",
      attempt_count: 1,
      valid_attempt_count: 0,
    });

    const lowConfidence = buildExerciseLearningAttemptRequest(baseInput({ signalConfidence: 0.2 }));
    expect(lowConfidence.attempt).toMatchObject({
      valid_evidence: false,
      completion_reason: "low_signal_confidence",
    });

    const unmeasurable = buildExerciseLearningAttemptRequest(
      baseInput({
        result: exerciseResult({ measurable: false, measurementMessage: "Input clipped." }),
      }),
    );
    expect(unmeasurable.attempt).toMatchObject({
      valid_evidence: false,
      completion_reason: "unmeasurable",
      score: null,
    });
  });

  it("uses lesson overrides for duration training rather than relabeling onset evidence", () => {
    const request = buildExerciseLearningAttemptRequest(
      baseInput({
        exerciseId: "rhythm",
        lessonId: "time-and-rhythm.hold-the-length",
        practiceSessionId: "duration-1",
      }),
    );
    expect(request.attempt).toMatchObject({
      lesson_id: "time-and-rhythm.hold-the-length",
      skill_id: "rhythm.duration",
      stage: "time-and-rhythm",
    });
    expect(request.progress_updates[0].skill_id).toBe("rhythm.duration");
  });

  it("applies the curriculum reducer when a later guided success reaches assisted mastery", () => {
    const first = buildExerciseLearningAttemptRequest(baseInput());
    const second = buildExerciseLearningAttemptRequest(
      baseInput({
        startedAtMs: 1_750_000_010_000,
        endedAtMs: 1_750_000_014_000,
        practiceSessionId: "practice-center-2",
        learningState: stateFromRequest(first),
      }),
    );

    expect(second.progress_updates[0]).toMatchObject({
      mastery_state: "assisted",
      attempt_count: 2,
      valid_attempt_count: 2,
    });
    const restored = learningStateToSkillProgress(stateFromRequest(second)).find(
      (progress) => progress.skillId === "pitch.centering",
    );
    expect(restored).toMatchObject({
      mastery: "assisted",
      attemptCount: 2,
      validAttemptCount: 2,
    });
  });

  it("preserves a later current stage while recording an earlier review exercise", () => {
    const state = stateFromRequest(buildExerciseLearningAttemptRequest(baseInput()));
    if (!state.learner_profile) throw new Error("expected learner profile");
    state.learner_profile.current_stage = "song-phrases";
    const request = buildExerciseLearningAttemptRequest(
      baseInput({ learningState: state, practiceSessionId: "review-center" }),
    );
    expect(request.learner_profile?.current_stage).toBe("song-phrases");
  });

  it("persists daily-plan reviews as reviews and advances the spaced interval", () => {
    const first = buildExerciseLearningAttemptRequest(baseInput());
    const reviewStartedAtMs = first.attempt.ended_at_ms + 86_400_000;
    const review = buildExerciseLearningAttemptRequest(
      baseInput({
        attemptKind: "review",
        startedAtMs: reviewStartedAtMs,
        endedAtMs: reviewStartedAtMs + 4_000,
        practiceSessionId: "review-center",
        learningState: stateFromRequest(first),
      }),
    );

    expect(review.attempt).toMatchObject({ kind: "review", intent: "review" });
    expect(JSON.parse(review.attempt.context_json)).toMatchObject({ attemptKind: "review" });
    expect(review.progress_updates[0]).toMatchObject({
      next_review_at_ms: reviewStartedAtMs + 4_000 + 3 * 86_400_000,
    });
    expect(JSON.parse(review.progress_updates[0].state_json).review).toMatchObject({
      intervalIndex: 1,
    });
  });

  it("rejects second-based/invalid chronology and invalid range data before persistence", () => {
    expect(() =>
      buildExerciseLearningAttemptRequest(baseInput({ startedAtMs: 2_000, endedAtMs: 1_000 })),
    ).toThrow(/cannot precede/);
    expect(() =>
      buildExerciseLearningAttemptRequest(
        baseInput({ range: { comfortableLowMidi: 80, comfortableHighMidi: 60 } }),
      ),
    ).toThrow(/low MIDI cannot exceed/);
  });
});

describe("persisted learning state conversion", () => {
  it("returns every curriculum skill and tolerates malformed state JSON using recent attempts", () => {
    const request = buildExerciseLearningAttemptRequest(baseInput());
    const state = stateFromRequest(request);
    state.progress[0].state_json = "not-json";
    state.progress[0].mastery_state = "assisted";
    state.progress[0].attempt_count = 7;

    const restored = learningStateToSkillProgress(state);
    const centering = restored.find((progress) => progress.skillId === "pitch.centering");
    expect(restored.length).toBe(13);
    expect(centering).toMatchObject({
      mastery: "assisted",
      attemptCount: 7,
      validAttemptCount: 1,
    });
    expect(restored.find((progress) => progress.skillId === "song.phrase")).toMatchObject({
      mastery: "new",
      attemptCount: 0,
    });
  });
});

describe("technique reflection preference aggregation", () => {
  const cueId = "vowel-small-rounding";
  const reflections: TechniqueReflection[] = [
    {
      cueId,
      recordedAt: 1_750_000_000_000,
      comfortBefore: 3,
      comfortAfter: 5,
      effortBefore: 3,
      effortAfter: 2,
      helpfulness: "helped",
      successfulOutcome: true,
      stopSignals: [],
    },
    {
      cueId,
      recordedAt: 1_750_000_001_000,
      comfortBefore: 4,
      comfortAfter: 5,
      effortAfter: 1,
      helpfulness: "helped",
      successfulOutcome: true,
      stopSignals: [],
    },
  ];

  it("counts helpful/unhelpful responses, records effort delta, and deduplicates replayed history", () => {
    const firstOnly = aggregateTechniquePreferences("Singer", [reflections[0]]);
    expect(firstOnly[0]).toMatchObject({
      cue_id: cueId,
      status: "neutral",
      helpful_count: 1,
      unhelpful_count: 0,
      last_effort_delta: -1,
    });

    const aggregate = aggregateTechniquePreferences("Singer", reflections, firstOnly);
    expect(aggregate[0]).toMatchObject({
      status: "preferred",
      helpful_count: 2,
      unhelpful_count: 0,
      last_effort_delta: null,
      updated_at_ms: 1_750_000_001_000,
    });
    expect(aggregateTechniquePreferences("Singer", reflections, aggregate)[0]).toEqual(
      aggregate[0],
    );
  });

  it("safety-suppresses a cue when its newest reflection contains a stop signal", () => {
    const preference = aggregateTechniquePreferences("Singer", [
      ...reflections,
      {
        ...reflections[1],
        recordedAt: 1_750_000_002_000,
        helpfulness: "made_harder",
        successfulOutcome: false,
        stopSignals: ["strain"],
      },
    ])[0];

    expect(preference).toMatchObject({
      status: "safety_suppressed",
      helpful_count: 2,
      unhelpful_count: 1,
    });
    expect(JSON.parse(preference.details_json)).toMatchObject({
      version: 1,
      lastHadStopSignal: true,
    });
  });
});
