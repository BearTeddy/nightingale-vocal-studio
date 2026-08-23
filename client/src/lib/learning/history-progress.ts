import type { PracticeSession } from "@/types/PracticeSession";
import { summarizePitchInputEvidence, type PitchSeries } from "@/lib/pitch/state";
import { LEARNING_STAGES, STARTER_LESSONS } from "./catalog";
import { createSkillProgress, updateSkillProgress } from "./progress";
import type { AssistPreset, AttemptContext, SkillId, SkillProgress } from "./types";

const EXERCISE_SKILLS: Record<string, readonly SkillId[]> = {
  listening: ["hearing.direction", "pitch.imitation"],
  intervals: ["pitch.imitation", "pitch.intervals"],
  center: ["pitch.centering"],
  sustain: ["pitch.sustain"],
  slides: ["pitch.contour"],
  rhythm: ["rhythm.onset", "rhythm.duration"],
  scale: ["pattern.memory"],
  arpeggio: ["pattern.memory"],
  dynamics: ["expression.dynamics"],
};

interface ExercisePayload {
  score?: unknown;
  completed?: unknown;
  measurable?: unknown;
  learningAttempt?: {
    assistPreset?: unknown;
    validEvidence?: unknown;
    lessonId?: unknown;
  };
  overall?: unknown;
  completion?: unknown;
  feedback_mode?: unknown;
  phrases?: unknown;
  pitch_input?: {
    status?: unknown;
    valid_learning_evidence?: unknown;
  };
  pitch_series?: unknown;
}

function parsePayload(session: PracticeSession): ExercisePayload | null {
  if (!session.performance_json) return null;
  try {
    const value = JSON.parse(session.performance_json) as unknown;
    return value && typeof value === "object" ? (value as ExercisePayload) : null;
  } catch {
    return null;
  }
}

function validAssistPreset(value: unknown): AssistPreset {
  return value === "full" || value === "independent" ? value : "guided";
}

function persistedPitchSeries(value: unknown): PitchSeries | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PitchSeries>;
  if (!Array.isArray(candidate.frames)) return null;
  return {
    refPitches: Array.isArray(candidate.refPitches) ? candidate.refPitches : [],
    userPitches: Array.isArray(candidate.userPitches) ? candidate.userPitches : [],
    similarities: Array.isArray(candidate.similarities) ? candidate.similarities : [],
    timestamps: Array.isArray(candidate.timestamps) ? candidate.timestamps : [],
    frames: candidate.frames,
    discontinuities: Array.isArray(candidate.discontinuities)
      ? candidate.discontinuities
      : undefined,
  } as PitchSeries;
}

function karaokePitchInputIsValid(payload: ExercisePayload | null): boolean {
  const explicit = payload?.pitch_input?.valid_learning_evidence;
  if (typeof explicit === "boolean") return explicit;

  const status = payload?.pitch_input?.status;
  if (status === "mic_disabled" || status === "no_frames" || status === "all_clipped") {
    return false;
  }
  if (status === "voiced" || status === "captured_silence") return true;

  const series = persistedPitchSeries(payload?.pitch_series);
  // Sessions from before dense input frames were persisted cannot be
  // reclassified safely, so preserve their original history behavior.
  if (!series) return true;
  return summarizePitchInputEvidence(series, true).valid_learning_evidence;
}

function allSkillProgress(): Map<SkillId, SkillProgress> {
  const skills = new Set(LEARNING_STAGES.flatMap((stage) => [...stage.coreSkills]));
  return new Map([...skills].map((skillId) => [skillId, createSkillProgress(skillId)]));
}

export function buildLearningProgressFromHistory(
  sessions: readonly PracticeSession[],
  setupComplete: boolean,
): SkillProgress[] {
  const progress = allSkillProgress();
  const seenSongHashes = new Set<string>();
  if (setupComplete) {
    const current = progress.get("setup.calibration") as SkillProgress;
    progress.set("setup.calibration", {
      ...current,
      mastery: "independent",
      attemptCount: 1,
      validAttemptCount: 1,
      lastAttemptAtMs: Date.now(),
    });
  }

  for (const session of sessions.slice().reverse()) {
    const payload = parsePayload(session);
    let skills: readonly SkillId[];
    let score: number | null;
    let validEvidence: boolean;
    let assistPreset: AssistPreset;
    let lessonId: string;
    let kind: AttemptContext["kind"] = "lesson";
    let unfamiliarTarget = false;
    let targetId: string | undefined;

    if (session.kind.startsWith("exercise:")) {
      const exerciseId = session.kind.slice("exercise:".length);
      const curriculumLesson = STARTER_LESSONS.find(
        (lesson) => lesson.id === payload?.learningAttempt?.lessonId,
      );
      skills = curriculumLesson
        ? [curriculumLesson.primarySkill]
        : (EXERCISE_SKILLS[exerciseId] ?? []);
      score =
        typeof payload?.score === "number" && Number.isFinite(payload.score)
          ? Math.max(0, Math.min(100, payload.score))
          : null;
      validEvidence =
        payload?.completed !== false &&
        payload?.measurable !== false &&
        payload?.learningAttempt?.validEvidence !== false;
      assistPreset = payload?.learningAttempt
        ? validAssistPreset(payload.learningAttempt.assistPreset)
        : "full";
      lessonId = curriculumLesson?.id ?? `legacy:${exerciseId}`;
      targetId = exerciseId;
    } else if (session.kind === "karaoke") {
      skills = ["song.phrase", "performance.consistency"];
      score =
        typeof payload?.overall === "number" && Number.isFinite(payload.overall)
          ? Math.max(0, Math.min(100, payload.overall))
          : null;
      const phraseCount = Array.isArray(payload?.phrases) ? payload.phrases.length : 0;
      validEvidence =
        payload?.completion === "completed" &&
        phraseCount >= 3 &&
        karaokePitchInputIsValid(payload);
      assistPreset = payload?.feedback_mode === "game" ? "independent" : "guided";
      lessonId = "song-phrases.short-phrase-transfer";
      kind = "transfer";
      targetId = session.song_hash ?? undefined;
      unfamiliarTarget = targetId != null && !seenSongHashes.has(targetId);
      if (targetId) seenSongHashes.add(targetId);
    } else {
      continue;
    }

    if (skills.length === 0 || score == null) continue;

    for (const skillId of skills) {
      const skillLessonId =
        skillId === "performance.consistency"
          ? "perform-and-express.consistent-performance"
          : lessonId;
      const attempt: AttemptContext = {
        attemptId: `${session.id}:${skillId}`,
        sessionId: session.id,
        lessonId: skillLessonId,
        skillId,
        stage:
          LEARNING_STAGES.find((stage) =>
            stage.coreSkills.some((candidate) => candidate === skillId),
          )?.id ?? "ready",
        kind: skillId === "performance.consistency" ? "lesson" : kind,
        assistPreset,
        score,
        validEvidence,
        completedAtMs: (session.ended_at ?? session.started_at) * 1_000,
        targetId,
        unfamiliarTarget,
      };
      const current = progress.get(skillId) ?? createSkillProgress(skillId);
      progress.set(skillId, updateSkillProgress(current, attempt));
    }
  }

  return [...progress.values()];
}
