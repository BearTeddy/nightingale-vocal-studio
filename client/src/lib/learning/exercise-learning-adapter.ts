import type { ExerciseResult } from "@/lib/vocal-exercise";
import type { LearnerProfile } from "@/types/LearnerProfile";
import type { LearnerProgress } from "@/types/LearnerProgress";
import type { LearningAttempt } from "@/types/LearningAttempt";
import type { LearningState } from "@/types/LearningState";
import type { SaveLearningAttemptRequest } from "@/types/SaveLearningAttemptRequest";
import type { TechniquePreference } from "@/types/TechniquePreference";
import { LEARNING_STAGES, STARTER_LESSONS } from "./catalog";
import { createSkillProgress, updateSkillProgress } from "./progress";
import type { TechniqueReflection } from "./technique-coaching";
import type {
  AssistPreset,
  AttemptContext,
  AttemptKind,
  LearningStage,
  MasteryState,
  ReviewSchedule,
  SkillId,
  SkillProgress,
} from "./types";

const CURRICULUM_VERSION = 1;
const PROGRESS_STATE_VERSION = 1;
const MINIMUM_SIGNAL_CONFIDENCE = 0.35;

export interface ExerciseLearningMapping {
  exerciseId: string;
  lessonId: string;
  skillId: SkillId;
  stage: LearningStage;
}

/** Stable bridge from the existing Studio exercise ids into curriculum ids. */
export const EXERCISE_LEARNING_MAP = {
  center: {
    exerciseId: "center",
    lessonId: "center-and-hold.center-the-note",
    skillId: "pitch.centering",
    stage: "center-and-hold",
  },
  listening: {
    exerciseId: "listening",
    lessonId: "pitch-imitation.single-note-echo",
    skillId: "pitch.imitation",
    stage: "pitch-imitation",
  },
  intervals: {
    exerciseId: "intervals",
    lessonId: "move-between-notes.two-note-steps",
    skillId: "pitch.intervals",
    stage: "move-between-notes",
  },
  scale: {
    exerciseId: "scale",
    lessonId: "patterns-and-memory.five-note-echo",
    skillId: "pattern.memory",
    stage: "patterns-and-memory",
  },
  arpeggio: {
    exerciseId: "arpeggio",
    lessonId: "patterns-and-memory.five-note-echo",
    skillId: "pattern.memory",
    stage: "patterns-and-memory",
  },
  sustain: {
    exerciseId: "sustain",
    lessonId: "center-and-hold.steady-sustain",
    skillId: "pitch.sustain",
    stage: "center-and-hold",
  },
  slides: {
    exerciseId: "slides",
    lessonId: "move-between-notes.follow-the-contour",
    skillId: "pitch.contour",
    stage: "move-between-notes",
  },
  rhythm: {
    exerciseId: "rhythm",
    lessonId: "time-and-rhythm.start-on-the-beat",
    skillId: "rhythm.onset",
    stage: "time-and-rhythm",
  },
  dynamics: {
    exerciseId: "dynamics",
    lessonId: "perform-and-express.shape-the-dynamics",
    skillId: "expression.dynamics",
    stage: "perform-and-express",
  },
  vibrato: {
    exerciseId: "vibrato",
    lessonId: "center-and-hold.steady-sustain",
    skillId: "pitch.sustain",
    stage: "center-and-hold",
  },
} as const satisfies Readonly<Record<string, ExerciseLearningMapping>>;

export interface LearnerRangeFields {
  comfortableLowMidi?: number | null;
  comfortableHighMidi?: number | null;
  reliableLowMidi?: number | null;
  reliableHighMidi?: number | null;
  exploredLowMidi?: number | null;
  exploredHighMidi?: number | null;
}

export interface CompletedExerciseLearningInput {
  exerciseId: string;
  /** Optional curriculum lesson override, for example rhythm.duration practice. */
  lessonId?: string;
  /** Daily-plan context controls review scheduling and transfer evidence. */
  attemptKind?: AttemptKind;
  result: ExerciseResult;
  profile: string;
  startedAtMs: number;
  endedAtMs: number;
  completed: boolean;
  assistPreset: AssistPreset;
  attemptId?: string;
  practiceSessionId?: string | null;
  recordingTakeId?: string | null;
  scoringPolicyId?: string | null;
  signalConfidence?: number | null;
  range?: LearnerRangeFields;
  assistanceOverride?: AssistPreset | null;
  learningState?: LearningState | null;
  techniqueReflections?: readonly TechniqueReflection[];
}

interface PersistedProgressStateV1 {
  version: 1;
  evidence: AttemptContext[];
  review: ReviewSchedule;
}

interface PreferenceDetailsV1 {
  version: 1;
  processedReflectionKeys: string[];
  noChangeCount: number;
  notSureCount: number;
  lastHadStopSignal: boolean;
  lastReflection: TechniqueReflection | null;
}

const STAGE_IDS = new Set<LearningStage>(LEARNING_STAGES.map((stage) => stage.id));
const SKILL_IDS = new Set<SkillId>(LEARNING_STAGES.flatMap((stage) => [...stage.coreSkills]));
const ASSIST_PRESETS = new Set<AssistPreset>(["full", "guided", "independent"]);
const ATTEMPT_KINDS = new Set<AttemptKind>(["lesson", "review", "transfer", "test-out"]);
const MASTERY_STATES = new Set<MasteryState>([
  "new",
  "practicing",
  "assisted",
  "independent",
  "transferred",
]);
const MASTERY_RANK: Record<MasteryState, number> = {
  new: 0,
  practicing: 1,
  assisted: 2,
  independent: 3,
  transferred: 4,
};

function stageForSkill(skillId: SkillId): LearningStage {
  return (
    LEARNING_STAGES.find((stage) => (stage.coreSkills as readonly SkillId[]).includes(skillId))
      ?.id ?? "ready"
  );
}

function laterStage(left: string | null | undefined, right: LearningStage): LearningStage {
  const validLeft = STAGE_IDS.has(left as LearningStage) ? (left as LearningStage) : right;
  const leftOrder = LEARNING_STAGES.find((stage) => stage.id === validLeft)?.order ?? 0;
  const rightOrder = LEARNING_STAGES.find((stage) => stage.id === right)?.order ?? 0;
  return leftOrder >= rightOrder ? validLeft : right;
}

function laterMastery(left: MasteryState, right: MasteryState): MasteryState {
  return MASTERY_RANK[left] >= MASTERY_RANK[right] ? left : right;
}

function assertFiniteTimestamp(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative millisecond timestamp.`);
  }
  return Math.round(value);
}

function validatedSignalConfidence(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("signalConfidence must be between 0 and 1.");
  }
  return value;
}

function checkedMidi(label: string, value: number | null | undefined): number | null | undefined {
  if (value == null) return value;
  if (!Number.isFinite(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be a finite MIDI value from 0 to 127.`);
  }
  return value;
}

function validateRangePair(
  label: string,
  low: number | null | undefined,
  high: number | null | undefined,
): void {
  if (low != null && high != null && low > high) {
    throw new RangeError(`${label} low MIDI cannot exceed high MIDI.`);
  }
}

export function resolveExerciseLearningMapping(
  exerciseId: string,
  lessonId?: string,
): ExerciseLearningMapping {
  const base = EXERCISE_LEARNING_MAP[exerciseId as keyof typeof EXERCISE_LEARNING_MAP];
  if (!base) throw new Error(`No curriculum mapping exists for exercise '${exerciseId}'.`);
  if (!lessonId) return base;

  const lesson = STARTER_LESSONS.find((candidate) => candidate.id === lessonId);
  if (!lesson) throw new Error(`Unknown curriculum lesson '${lessonId}'.`);
  return {
    exerciseId,
    lessonId: lesson.id,
    skillId: lesson.primarySkill,
    stage: lesson.stage,
  };
}

function lessonVersion(lessonId: string): number {
  return STARTER_LESSONS.find((lesson) => lesson.id === lessonId)?.version ?? 1;
}

function validAttemptContext(value: unknown, expectedSkill?: SkillId): AttemptContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Partial<AttemptContext>;
  if (
    typeof context.attemptId !== "string" ||
    context.attemptId.trim() === "" ||
    typeof context.sessionId !== "string" ||
    context.sessionId.trim() === "" ||
    typeof context.lessonId !== "string" ||
    context.lessonId.trim() === "" ||
    !SKILL_IDS.has(context.skillId as SkillId) ||
    (expectedSkill != null && context.skillId !== expectedSkill) ||
    !STAGE_IDS.has(context.stage as LearningStage) ||
    !ATTEMPT_KINDS.has(context.kind as AttemptKind) ||
    !ASSIST_PRESETS.has(context.assistPreset as AssistPreset) ||
    typeof context.score !== "number" ||
    !Number.isFinite(context.score) ||
    typeof context.validEvidence !== "boolean" ||
    typeof context.completedAtMs !== "number" ||
    !Number.isFinite(context.completedAtMs)
  ) {
    return null;
  }
  return context as AttemptContext;
}

function parseProgressState(value: string, skillId: SkillId): PersistedProgressStateV1 | null {
  try {
    const parsed = JSON.parse(value) as Partial<PersistedProgressStateV1>;
    if (parsed.version !== PROGRESS_STATE_VERSION || !Array.isArray(parsed.evidence)) return null;
    const evidence = parsed.evidence
      .map((attempt) => validAttemptContext(attempt, skillId))
      .filter((attempt): attempt is AttemptContext => attempt != null);
    const intervalIndex = parsed.review?.intervalIndex;
    const nextReviewAtMs = parsed.review?.nextReviewAtMs;
    if (
      typeof intervalIndex !== "number" ||
      !Number.isFinite(intervalIndex) ||
      (nextReviewAtMs != null &&
        (typeof nextReviewAtMs !== "number" || !Number.isFinite(nextReviewAtMs)))
    ) {
      return null;
    }
    return {
      version: 1,
      evidence,
      review: { intervalIndex, nextReviewAtMs: nextReviewAtMs ?? null },
    };
  } catch {
    return null;
  }
}

function learningAttemptContext(attempt: LearningAttempt): AttemptContext | null {
  if (!SKILL_IDS.has(attempt.skill_id as SkillId) || !Number.isFinite(attempt.ended_at_ms)) {
    return null;
  }
  const skillId = attempt.skill_id as SkillId;
  const stage = STAGE_IDS.has(attempt.stage as LearningStage)
    ? (attempt.stage as LearningStage)
    : stageForSkill(skillId);
  const kind = ATTEMPT_KINDS.has(attempt.kind as AttemptKind)
    ? (attempt.kind as AttemptKind)
    : "lesson";
  const assistPreset = ASSIST_PRESETS.has(attempt.assist_preset as AssistPreset)
    ? (attempt.assist_preset as AssistPreset)
    : "guided";
  const score = attempt.score != null && Number.isFinite(attempt.score) ? attempt.score : 0;
  return {
    attemptId: attempt.id,
    sessionId: attempt.practice_session_id?.trim() || attempt.id,
    lessonId: attempt.lesson_id,
    skillId,
    stage,
    kind,
    assistPreset,
    score,
    validEvidence: attempt.valid_evidence && attempt.score != null,
    completedAtMs: attempt.ended_at_ms,
    targetId: attempt.target_id ?? undefined,
    unfamiliarTarget: attempt.unfamiliar_target,
  };
}

function progressFromEvidence(
  skillId: SkillId,
  evidence: readonly AttemptContext[],
): SkillProgress {
  return evidence
    .slice()
    .sort((left, right) => left.completedAtMs - right.completedAtMs)
    .reduce(updateSkillProgress, createSkillProgress(skillId));
}

function persistedMastery(value: string): MasteryState | null {
  return MASTERY_STATES.has(value as MasteryState) ? (value as MasteryState) : null;
}

/** Restores every known curriculum skill, using the same mastery reducer as live attempts. */
export function learningStateToSkillProgress(
  state: LearningState | null | undefined,
): SkillProgress[] {
  const recentBySkill = new Map<SkillId, AttemptContext[]>();
  for (const attempt of state?.recent_attempts ?? []) {
    const context = learningAttemptContext(attempt);
    if (!context) continue;
    const current = recentBySkill.get(context.skillId) ?? [];
    current.push(context);
    recentBySkill.set(context.skillId, current);
  }

  const persistedBySkill = new Map<SkillId, LearnerProgress>();
  for (const row of state?.progress ?? []) {
    if (SKILL_IDS.has(row.skill_id as SkillId)) {
      persistedBySkill.set(row.skill_id as SkillId, row);
    }
  }

  return LEARNING_STAGES.flatMap((stage) => stage.coreSkills).map((skillId) => {
    const row = persistedBySkill.get(skillId);
    const storedState = row ? parseProgressState(row.state_json, skillId) : null;
    const combinedEvidence = [
      ...(storedState?.evidence ?? []),
      ...(recentBySkill.get(skillId) ?? []),
    ];
    const reduced = progressFromEvidence(skillId, combinedEvidence);
    if (!row) return reduced;

    const rowMastery = persistedMastery(row.mastery_state);
    return {
      ...reduced,
      mastery: rowMastery ? laterMastery(reduced.mastery, rowMastery) : reduced.mastery,
      attemptCount: Math.max(reduced.attemptCount, row.attempt_count),
      validAttemptCount: Math.max(reduced.validAttemptCount, row.valid_attempt_count),
      review: {
        intervalIndex: storedState?.review.intervalIndex ?? reduced.review.intervalIndex,
        nextReviewAtMs: row.next_review_at_ms ?? reduced.review.nextReviewAtMs,
      },
      lastAttemptAtMs:
        row.last_attempt_at_ms == null
          ? reduced.lastAttemptAtMs
          : Math.max(reduced.lastAttemptAtMs ?? 0, row.last_attempt_at_ms),
      reviewRecommended: reduced.reviewRecommended || row.review_recommended,
    };
  });
}

function rollingScore(progress: SkillProgress): number | null {
  const scores = progress.evidence
    .filter((attempt) => attempt.validEvidence)
    .slice(-5)
    .map((attempt) => attempt.score);
  if (scores.length === 0) return null;
  return Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10;
}

function learnerProgressRecord(
  profile: string,
  stage: LearningStage,
  progress: SkillProgress,
  updatedAtMs: number,
): LearnerProgress {
  const state: PersistedProgressStateV1 = {
    version: 1,
    evidence: [...progress.evidence],
    review: progress.review,
  };
  return {
    profile,
    skill_id: progress.skillId,
    stage,
    mastery_state: progress.mastery,
    attempt_count: progress.attemptCount,
    valid_attempt_count: progress.validAttemptCount,
    rolling_score: rollingScore(progress),
    next_review_at_ms: progress.review.nextReviewAtMs,
    last_attempt_at_ms: progress.lastAttemptAtMs,
    review_recommended: progress.reviewRecommended,
    state_json: JSON.stringify(state),
    updated_at_ms: updatedAtMs,
  };
}

function defaultPreferenceDetails(): PreferenceDetailsV1 {
  return {
    version: 1,
    processedReflectionKeys: [],
    noChangeCount: 0,
    notSureCount: 0,
    lastHadStopSignal: false,
    lastReflection: null,
  };
}

function parsePreferenceDetails(value: string): PreferenceDetailsV1 {
  try {
    const parsed = JSON.parse(value) as Partial<PreferenceDetailsV1>;
    if (parsed.version !== 1) return defaultPreferenceDetails();
    return {
      version: 1,
      processedReflectionKeys: Array.isArray(parsed.processedReflectionKeys)
        ? parsed.processedReflectionKeys.filter((key): key is string => typeof key === "string")
        : [],
      noChangeCount:
        typeof parsed.noChangeCount === "number" ? Math.max(0, parsed.noChangeCount) : 0,
      notSureCount: typeof parsed.notSureCount === "number" ? Math.max(0, parsed.notSureCount) : 0,
      lastHadStopSignal: parsed.lastHadStopSignal === true,
      lastReflection: parsed.lastReflection ?? null,
    };
  } catch {
    return defaultPreferenceDetails();
  }
}

function reflectionKey(reflection: TechniqueReflection): string {
  return JSON.stringify([
    reflection.cueId,
    reflection.recordedAt,
    reflection.helpfulness,
    reflection.comfortBefore,
    reflection.comfortAfter,
    reflection.effortBefore ?? null,
    reflection.effortAfter,
    [...reflection.stopSignals].sort(),
  ]);
}

function preferenceStatus(
  helpfulCount: number,
  unhelpfulCount: number,
  lastHadStopSignal: boolean,
): string {
  if (lastHadStopSignal) return "safety_suppressed";
  if (helpfulCount >= unhelpfulCount + 2) return "preferred";
  if (unhelpfulCount > helpfulCount) return "avoid";
  return "neutral";
}

/** Incrementally aggregates reflections and safely deduplicates already-seen entries. */
export function aggregateTechniquePreferences(
  profile: string,
  reflections: readonly TechniqueReflection[],
  existing: readonly TechniquePreference[] = [],
): TechniquePreference[] {
  const trimmedProfile = profile.trim();
  if (!trimmedProfile) throw new Error("profile cannot be empty.");
  const reflectionByCue = new Map<string, TechniqueReflection[]>();
  for (const reflection of reflections) {
    if (!reflection.cueId.trim() || !Number.isFinite(reflection.recordedAt)) continue;
    const current = reflectionByCue.get(reflection.cueId) ?? [];
    current.push(reflection);
    reflectionByCue.set(reflection.cueId, current);
  }

  const cueIds = new Set([
    ...existing
      .filter((preference) => preference.profile === trimmedProfile)
      .map((item) => item.cue_id),
    ...reflectionByCue.keys(),
  ]);
  return [...cueIds].sort().map((cueId) => {
    const prior = existing.find(
      (preference) => preference.profile === trimmedProfile && preference.cue_id === cueId,
    );
    const details = prior ? parsePreferenceDetails(prior.details_json) : defaultPreferenceDetails();
    const processed = new Set(details.processedReflectionKeys);
    let helpfulCount = Math.max(0, Math.round(prior?.helpful_count ?? 0));
    let unhelpfulCount = Math.max(0, Math.round(prior?.unhelpful_count ?? 0));
    let lastEffortDelta = prior?.last_effort_delta ?? null;
    let updatedAtMs = prior?.updated_at_ms ?? 0;
    let changed = false;

    for (const reflection of (reflectionByCue.get(cueId) ?? [])
      .slice()
      .sort((left, right) => left.recordedAt - right.recordedAt)) {
      const key = reflectionKey(reflection);
      if (processed.has(key)) continue;
      processed.add(key);
      changed = true;
      if (reflection.helpfulness === "helped") helpfulCount += 1;
      if (reflection.helpfulness === "made_harder") unhelpfulCount += 1;
      if (reflection.helpfulness === "no_change") details.noChangeCount += 1;
      if (reflection.helpfulness === "not_sure") details.notSureCount += 1;
      details.lastHadStopSignal = reflection.stopSignals.length > 0;
      details.lastReflection = reflection;
      lastEffortDelta =
        reflection.effortBefore == null ? null : reflection.effortAfter - reflection.effortBefore;
      updatedAtMs = Math.max(updatedAtMs, Math.round(reflection.recordedAt));
    }

    details.processedReflectionKeys = [...processed];
    if (!changed && prior) return prior;
    return {
      profile: trimmedProfile,
      cue_id: cueId,
      status: preferenceStatus(helpfulCount, unhelpfulCount, details.lastHadStopSignal),
      helpful_count: helpfulCount,
      unhelpful_count: unhelpfulCount,
      last_effort_delta: lastEffortDelta,
      details_json: JSON.stringify(details),
      updated_at_ms: updatedAtMs,
    };
  });
}

function mergedRange(
  existing: LearnerProfile | null | undefined,
  range: LearnerRangeFields | undefined,
): Required<LearnerRangeFields> {
  const comfortableLowMidi =
    checkedMidi(
      "comfortableLowMidi",
      range?.comfortableLowMidi === undefined
        ? existing?.comfortable_low_midi
        : range.comfortableLowMidi,
    ) ?? null;
  const comfortableHighMidi =
    checkedMidi(
      "comfortableHighMidi",
      range?.comfortableHighMidi === undefined
        ? existing?.comfortable_high_midi
        : range.comfortableHighMidi,
    ) ?? null;
  const reliableLowMidi =
    checkedMidi(
      "reliableLowMidi",
      range?.reliableLowMidi === undefined ? existing?.reliable_low_midi : range.reliableLowMidi,
    ) ?? null;
  const reliableHighMidi =
    checkedMidi(
      "reliableHighMidi",
      range?.reliableHighMidi === undefined ? existing?.reliable_high_midi : range.reliableHighMidi,
    ) ?? null;
  const exploredLowMidi =
    checkedMidi(
      "exploredLowMidi",
      range?.exploredLowMidi === undefined ? existing?.explored_low_midi : range.exploredLowMidi,
    ) ?? null;
  const exploredHighMidi =
    checkedMidi(
      "exploredHighMidi",
      range?.exploredHighMidi === undefined ? existing?.explored_high_midi : range.exploredHighMidi,
    ) ?? null;
  validateRangePair("comfortable range", comfortableLowMidi, comfortableHighMidi);
  validateRangePair("reliable range", reliableLowMidi, reliableHighMidi);
  validateRangePair("explored range", exploredLowMidi, exploredHighMidi);
  return {
    comfortableLowMidi,
    comfortableHighMidi,
    reliableLowMidi,
    reliableHighMidi,
    exploredLowMidi,
    exploredHighMidi,
  };
}

/** Builds the atomic backend request and the exact curriculum progress update. */
export function buildExerciseLearningAttemptRequest(
  input: CompletedExerciseLearningInput,
): SaveLearningAttemptRequest {
  const profile = input.profile.trim();
  if (!profile) throw new Error("profile cannot be empty.");
  const startedAtMs = assertFiniteTimestamp("startedAtMs", input.startedAtMs);
  const endedAtMs = assertFiniteTimestamp("endedAtMs", input.endedAtMs);
  if (endedAtMs < startedAtMs) throw new RangeError("endedAtMs cannot precede startedAtMs.");
  const signalConfidence = validatedSignalConfidence(input.signalConfidence);
  const attemptKind = input.attemptKind ?? "lesson";
  if (!ATTEMPT_KINDS.has(attemptKind)) throw new Error("attemptKind is not supported.");
  const mapping = resolveExerciseLearningMapping(input.exerciseId, input.lessonId);
  const existingProfile = input.learningState?.learner_profile;
  if (existingProfile && existingProfile.profile !== profile) {
    throw new Error("learningState profile does not match the attempt profile.");
  }
  const range = mergedRange(existingProfile, input.range);
  const practiceSessionId = input.practiceSessionId?.trim() || null;
  const attemptId =
    input.attemptId?.trim() ||
    `learning:${practiceSessionId ?? `${profile}:${input.exerciseId}:${endedAtMs}`}:${mapping.skillId}`;
  const measurableScore =
    input.result.measurable && Number.isFinite(input.result.overall)
      ? Math.max(0, Math.min(100, input.result.overall))
      : null;
  const signalIsValid = signalConfidence == null || signalConfidence >= MINIMUM_SIGNAL_CONFIDENCE;
  const validEvidence = input.completed && measurableScore != null && signalIsValid;
  const completionReason = !input.completed
    ? "interrupted"
    : measurableScore == null
      ? "unmeasurable"
      : !signalIsValid
        ? "low_signal_confidence"
        : "completed";
  const attempt: LearningAttempt = {
    id: attemptId,
    profile,
    skill_id: mapping.skillId,
    lesson_id: mapping.lessonId,
    lesson_version: lessonVersion(mapping.lessonId),
    stage: mapping.stage,
    kind: attemptKind,
    intent: attemptKind === "lesson" ? "learn" : attemptKind,
    assist_preset: input.assistPreset,
    scoring_policy_id: input.scoringPolicyId ?? null,
    song_hash: null,
    practice_session_id: practiceSessionId,
    recording_take_id: input.recordingTakeId?.trim() || null,
    target_id: input.exerciseId,
    unfamiliar_target: false,
    started_at_ms: startedAtMs,
    ended_at_ms: endedAtMs,
    ranked: false,
    valid_evidence: validEvidence,
    completion_reason: completionReason,
    score: measurableScore,
    signal_confidence: signalConfidence,
    evidence_json: JSON.stringify({
      schemaVersion: 1,
      metrics: input.result.metrics,
      observations: input.result.observations,
      recommendations: input.result.recommendations,
      measurementMessage: input.result.measurementMessage,
      measurable: input.result.measurable,
      validEvidence,
    }),
    context_json: JSON.stringify({
      schemaVersion: 1,
      exerciseId: input.exerciseId,
      completed: input.completed,
      assistPreset: input.assistPreset,
      attemptKind,
      range,
    }),
  };

  const currentProgress =
    learningStateToSkillProgress(input.learningState).find(
      (progress) => progress.skillId === mapping.skillId,
    ) ?? createSkillProgress(mapping.skillId);
  const attemptContext: AttemptContext = {
    attemptId,
    sessionId: practiceSessionId ?? attemptId,
    lessonId: mapping.lessonId,
    skillId: mapping.skillId,
    stage: mapping.stage,
    kind: attemptKind,
    assistPreset: input.assistPreset,
    score: measurableScore ?? 0,
    validEvidence,
    completedAtMs: endedAtMs,
    targetId: input.exerciseId,
  };
  const updatedProgress = updateSkillProgress(currentProgress, attemptContext);
  const techniquePreferences = aggregateTechniquePreferences(
    profile,
    input.techniqueReflections ?? [],
    input.learningState?.technique_preferences ?? [],
  );
  const learnerProfile: LearnerProfile = {
    profile,
    curriculum_version: Math.max(
      CURRICULUM_VERSION,
      existingProfile?.curriculum_version ?? CURRICULUM_VERSION,
    ),
    current_stage: laterStage(existingProfile?.current_stage, mapping.stage),
    comfortable_low_midi: range.comfortableLowMidi,
    comfortable_high_midi: range.comfortableHighMidi,
    reliable_low_midi: range.reliableLowMidi,
    reliable_high_midi: range.reliableHighMidi,
    explored_low_midi: range.exploredLowMidi,
    explored_high_midi: range.exploredHighMidi,
    assistance_override:
      input.assistanceOverride === undefined
        ? (existingProfile?.assistance_override ?? null)
        : input.assistanceOverride,
    device_calibration_json: existingProfile?.device_calibration_json ?? null,
    state_json: existingProfile?.state_json ?? "{}",
    updated_at_ms: endedAtMs,
  };

  return {
    attempt,
    learner_profile: learnerProfile,
    progress_updates: [learnerProgressRecord(profile, mapping.stage, updatedProgress, endedAtMs)],
    technique_preferences: techniquePreferences,
  };
}
