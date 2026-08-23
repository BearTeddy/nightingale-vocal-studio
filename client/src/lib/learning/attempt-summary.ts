import type { ExerciseResult } from "@/lib/vocal-exercise";

export type AttemptNextAction = "fix-signal" | "repeat" | "continue";

export interface AttemptSummary {
  readonly title: string;
  readonly detail: string;
  readonly nextAction: AttemptNextAction;
}

export function summarizeExerciseAttempt(
  result: ExerciseResult,
  completed: boolean | null,
): AttemptSummary {
  if (!result.measurable) {
    return {
      title: "Let’s get a cleaner take.",
      detail:
        result.measurementMessage ??
        "This attempt did not contain enough reliable microphone evidence to score fairly.",
      nextAction: "fix-signal",
    };
  }

  if (completed === false) {
    return {
      title: "Partial practice saved.",
      detail: "Repeat when you are ready so Nightingale can compare the complete pattern.",
      nextAction: "repeat",
    };
  }

  const ordered = result.metrics.slice().sort((left, right) => right.score - left.score);
  const strongest = ordered[0];
  const focus = ordered[ordered.length - 1];
  const detail = strongest
    ? strongest.label === focus?.label
      ? `${strongest.label} measured ${strongest.score}. Treat this as practice evidence, not a diagnosis.`
      : `Strongest: ${strongest.label} (${strongest.score}). Next focus: ${focus?.label} (${focus?.score}).`
    : "The attempt was measured successfully.";

  if (result.overall >= 85) {
    return { title: "Ready for the next step.", detail, nextAction: "continue" };
  }
  if (result.overall >= 70) {
    return { title: "Good progress—repeat once.", detail, nextAction: "repeat" };
  }
  return {
    title: "Keep the guide on and try once more.",
    detail,
    nextAction: "repeat",
  };
}
