export const LEARNING_STAGE_IDS = [
  "ready",
  "hear-and-explore",
  "pitch-imitation",
  "center-and-hold",
  "move-between-notes",
  "time-and-rhythm",
  "patterns-and-memory",
  "song-phrases",
  "perform-and-express",
] as const;

export type LearningStage = (typeof LEARNING_STAGE_IDS)[number];

export type LearningStageOrder = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type SkillId =
  | "setup.calibration"
  | "hearing.direction"
  | "pitch.imitation"
  | "pitch.centering"
  | "pitch.sustain"
  | "pitch.intervals"
  | "pitch.contour"
  | "rhythm.onset"
  | "rhythm.duration"
  | "pattern.memory"
  | "song.phrase"
  | "performance.consistency"
  | "expression.dynamics";

export type AssistPreset = "full" | "guided" | "independent";

export type MasteryState = "new" | "practicing" | "assisted" | "independent" | "transferred";

export type AttemptKind = "lesson" | "review" | "transfer" | "test-out";

export interface LearningStageDefinition {
  readonly id: LearningStage;
  readonly order: LearningStageOrder;
  readonly title: string;
  readonly summary: string;
  readonly coreSkills: readonly SkillId[];
}

export type LessonKind = "foundation" | "practice" | "transfer" | "performance";

export interface LessonDefinition {
  readonly id: string;
  readonly version: number;
  readonly stage: LearningStage;
  readonly kind: LessonKind;
  readonly title: string;
  readonly summary: string;
  readonly primarySkill: SkillId;
  readonly supportingSkills: readonly SkillId[];
  readonly prerequisites: readonly SkillId[];
  readonly estimatedMinutes: number;
  readonly availableAssistPresets: readonly AssistPreset[];
  readonly defaultAssistPreset: AssistPreset;
}

export interface AttemptContext {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly lessonId: string;
  readonly skillId: SkillId;
  readonly stage: LearningStage;
  readonly kind: AttemptKind;
  readonly assistPreset: AssistPreset;
  readonly score: number;
  readonly validEvidence: boolean;
  readonly completedAtMs: number;
  readonly targetId?: string;
  readonly unfamiliarTarget?: boolean;
}

export interface ReviewSchedule {
  readonly intervalIndex: number;
  readonly nextReviewAtMs: number | null;
}

export interface SkillProgress {
  readonly skillId: SkillId;
  readonly mastery: MasteryState;
  readonly attemptCount: number;
  readonly validAttemptCount: number;
  readonly evidence: readonly AttemptContext[];
  readonly review: ReviewSchedule;
  readonly lastAttemptAtMs: number | null;
  readonly reviewRecommended: boolean;
}

export type DailyPlanItemKind =
  | "check-in"
  | "focus"
  | "reinforce"
  | "review"
  | "preview"
  | "transfer"
  | "reflection";

export interface DailyPlanItem {
  readonly kind: DailyPlanItemKind;
  readonly minutes: number;
  readonly title: string;
  readonly lessonId?: string;
  readonly skillId?: SkillId;
  readonly assistPreset?: AssistPreset;
  readonly due?: boolean;
}

export interface DailyPlan {
  readonly stage: LearningStage;
  readonly totalMinutes: number;
  readonly items: readonly DailyPlanItem[];
}

export interface BuildDailyPlanOptions {
  readonly nowMs: number;
  readonly progress: readonly SkillProgress[];
  readonly stages?: readonly LearningStageDefinition[];
  readonly lessons?: readonly LessonDefinition[];
}

export type ChallengeArticulation = "legato" | "mixed";
export type ChallengeLyrics = "neutral-syllable" | "lyrics";
export type ChallengeFeedback = "continuous" | "reduced" | "results-only";

export interface ChallengeSettings {
  readonly assistPreset: AssistPreset;
  readonly tempoRatio: number;
  readonly intervalSpanSemitones: number;
  readonly rangeOffsetSemitones: number;
  readonly phraseLengthNotes: number;
  readonly articulation: ChallengeArticulation;
  readonly lyrics: ChallengeLyrics;
  readonly feedback: ChallengeFeedback;
}

export type AdaptationVariable = keyof ChallengeSettings;
export type AdaptationDirection = "harder" | "easier" | "none";
export type AdaptationReason =
  | "two-successes"
  | "two-misses"
  | "low-five-attempt-success-rate"
  | "insufficient-evidence"
  | "at-boundary";

export interface AdaptationResult {
  readonly settings: ChallengeSettings;
  readonly direction: AdaptationDirection;
  readonly changedVariable: AdaptationVariable | null;
  readonly reason: AdaptationReason;
  readonly nextVariableIndex: number;
}

export interface SoftTestOutResult {
  readonly skillId: SkillId;
  readonly ready: boolean;
  readonly passed: boolean;
  readonly successfulItems: number;
  readonly medianScore: number | null;
  readonly awardedMastery: "independent" | null;
  readonly consideredAttemptIds: readonly string[];
}
