import { LEARNING_STAGES, STARTER_LESSONS } from "./catalog";
import type {
  AssistPreset,
  BuildDailyPlanOptions,
  DailyPlan,
  LearningStageDefinition,
  LessonDefinition,
  MasteryState,
  SkillId,
  SkillProgress,
} from "./types";

const MASTERY_RANK: Record<MasteryState, number> = {
  new: 0,
  practicing: 1,
  assisted: 2,
  independent: 3,
  transferred: 4,
};

function progressFor(
  skillId: SkillId,
  progressBySkill: ReadonlyMap<SkillId, SkillProgress>,
): SkillProgress | undefined {
  return progressBySkill.get(skillId);
}

function masteryFor(
  skillId: SkillId,
  progressBySkill: ReadonlyMap<SkillId, SkillProgress>,
): MasteryState {
  return progressFor(skillId, progressBySkill)?.mastery ?? "new";
}

function assistanceFor(mastery: MasteryState): AssistPreset {
  if (mastery === "new" || mastery === "practicing") return "full";
  if (mastery === "assisted") return "guided";
  return "independent";
}

function lessonAssistance(lesson: LessonDefinition, preferred: AssistPreset): AssistPreset {
  return lesson.availableAssistPresets.includes(preferred) ? preferred : lesson.defaultAssistPreset;
}

function findLessonForSkill(
  lessons: readonly LessonDefinition[],
  skillId: SkillId,
): LessonDefinition | undefined {
  return lessons.find((lesson) => lesson.primarySkill === skillId);
}

function currentStage(
  stages: readonly LearningStageDefinition[],
  progressBySkill: ReadonlyMap<SkillId, SkillProgress>,
): LearningStageDefinition {
  return (
    stages.find((stage) =>
      stage.coreSkills.some(
        (skillId) => MASTERY_RANK[masteryFor(skillId, progressBySkill)] < MASTERY_RANK.independent,
      ),
    ) ?? stages[stages.length - 1]
  );
}

function focusSkillForStage(
  stage: LearningStageDefinition,
  progressBySkill: ReadonlyMap<SkillId, SkillProgress>,
): SkillId {
  return (
    stage.coreSkills.find(
      (skillId) => MASTERY_RANK[masteryFor(skillId, progressBySkill)] < MASTERY_RANK.independent,
    ) ?? stage.coreSkills[0]
  );
}

function dueReview(nowMs: number, progress: readonly SkillProgress[]): SkillProgress | undefined {
  return progress
    .filter((item) => item.review.nextReviewAtMs != null && item.review.nextReviewAtMs <= nowMs)
    .slice()
    .sort(
      (left, right) =>
        (left.review.nextReviewAtMs as number) - (right.review.nextReviewAtMs as number),
    )[0];
}

function fallbackReview(
  progress: readonly SkillProgress[],
  lessons: readonly LessonDefinition[],
): SkillProgress | undefined {
  return progress
    .filter((item) => item.validAttemptCount > 0 && findLessonForSkill(lessons, item.skillId))
    .slice()
    .sort((left, right) => {
      const leftDue = left.review.nextReviewAtMs ?? Number.POSITIVE_INFINITY;
      const rightDue = right.review.nextReviewAtMs ?? Number.POSITIVE_INFINITY;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return (left.lastAttemptAtMs ?? 0) - (right.lastAttemptAtMs ?? 0);
    })[0];
}

function previewLessonFor(
  stage: LearningStageDefinition,
  focusLesson: LessonDefinition,
  stages: readonly LearningStageDefinition[],
  lessons: readonly LessonDefinition[],
  progressBySkill: ReadonlyMap<SkillId, SkillProgress>,
): LessonDefinition | undefined {
  const stageOrder = new Map(stages.map((definition) => [definition.id, definition.order]));
  return lessons.find((lesson) => {
    const lessonOrder = stageOrder.get(lesson.stage) ?? Number.POSITIVE_INFINITY;
    if (
      lesson.id === focusLesson.id ||
      lessonOrder < stage.order ||
      lessonOrder > stage.order + 1
    ) {
      return false;
    }
    return lesson.prerequisites.every(
      (skillId) =>
        skillId === focusLesson.primarySkill ||
        MASTERY_RANK[masteryFor(skillId, progressBySkill)] >= MASTERY_RANK.independent,
    );
  });
}

export function buildDailyPlan(options: BuildDailyPlanOptions): DailyPlan {
  const stages = options.stages ?? LEARNING_STAGES;
  const lessons = options.lessons ?? STARTER_LESSONS;
  if (stages.length === 0) throw new Error("A daily plan requires at least one learning stage.");
  if (lessons.length === 0) throw new Error("A daily plan requires at least one lesson.");

  const progressBySkill = new Map(options.progress.map((item) => [item.skillId, item]));
  const stage = currentStage(stages, progressBySkill);
  const focusSkill = focusSkillForStage(stage, progressBySkill);
  const focusLesson =
    findLessonForSkill(lessons, focusSkill) ?? lessons.find((lesson) => lesson.stage === stage.id);
  if (!focusLesson) throw new Error(`No lesson is available for the ${stage.id} stage.`);

  const due = dueReview(options.nowMs, options.progress);
  const fallback = due ? undefined : fallbackReview(options.progress, lessons);
  const reviewProgress = due ?? fallback;
  const reviewSkill = reviewProgress?.skillId ?? focusSkill;
  const reviewLesson = findLessonForSkill(lessons, reviewSkill) ?? focusLesson;

  const stageOrder = new Map(stages.map((definition) => [definition.id, definition.order]));
  const transferLesson =
    lessons.find(
      (lesson) =>
        lesson.kind === "transfer" &&
        (stageOrder.get(lesson.stage) ?? Number.POSITIVE_INFINITY) <= stage.order,
    ) ?? null;
  const previewLesson = previewLessonFor(stage, focusLesson, stages, lessons, progressBySkill);
  const applicationLesson = transferLesson ?? previewLesson ?? focusLesson;

  const items = [
    {
      kind: "check-in",
      minutes: 1,
      title: "Comfort and setup check",
    },
    {
      kind: "focus",
      minutes: 3,
      title: focusLesson.title,
      lessonId: focusLesson.id,
      skillId: focusLesson.primarySkill,
      assistPreset: lessonAssistance(
        focusLesson,
        assistanceFor(masteryFor(focusLesson.primarySkill, progressBySkill)),
      ),
    },
    {
      kind: due ? "review" : "reinforce",
      minutes: 2,
      title: due
        ? `Due review: ${reviewLesson.title}`
        : fallback
          ? `Keep fresh: ${reviewLesson.title}`
          : `Repeat once: ${focusLesson.title}`,
      lessonId: reviewLesson.id,
      skillId: reviewSkill,
      assistPreset: lessonAssistance(
        reviewLesson,
        assistanceFor(masteryFor(reviewSkill, progressBySkill)),
      ),
      due: due != null,
    },
    {
      kind: transferLesson ? "transfer" : "preview",
      minutes: 3,
      title: transferLesson ? transferLesson.title : `Next step: ${applicationLesson.title}`,
      lessonId: applicationLesson.id,
      skillId: applicationLesson.primarySkill,
      assistPreset: lessonAssistance(
        applicationLesson,
        assistanceFor(masteryFor(applicationLesson.primarySkill, progressBySkill)),
      ),
    },
    {
      kind: "reflection",
      minutes: 1,
      title: "Review progress and choose the next step",
    },
  ] as const;

  return {
    stage: stage.id,
    totalMinutes: items.reduce((sum, item) => sum + item.minutes, 0),
    items,
  };
}
