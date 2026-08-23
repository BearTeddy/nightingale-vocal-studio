export type StudioTab = "learn" | "checkup" | "exercises" | "songs" | "history";

export type StudioNavigationDirection = "up" | "down" | "left" | "right";

export interface StudioNavigationRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface StudioActivityExitPlan {
  changed: boolean;
  cancelCheckup: boolean;
  stopExercise: boolean;
  resetListeningPrompt: boolean;
}

export type StudioBackAction = "cancel-checkup" | "stop-exercise" | "stay" | "leave";

export function planStudioBackAction(
  checkupRunning: boolean,
  runningExercise: string | null,
  exerciseStopping: boolean,
): StudioBackAction {
  if (checkupRunning) return "cancel-checkup";
  if (exerciseStopping) return "stay";
  if (runningExercise != null) return "stop-exercise";
  return "leave";
}

export function planStudioTabChange(
  currentTab: StudioTab,
  nextTab: StudioTab,
  checkupRunning: boolean,
  runningExercise: string | null,
  listeningPromptActive = false,
): StudioActivityExitPlan {
  const changed = currentTab !== nextTab;
  return {
    changed,
    cancelCheckup: changed && checkupRunning,
    stopExercise: changed && runningExercise != null,
    resetListeningPrompt:
      changed && (listeningPromptActive || runningExercise?.startsWith("listening") === true),
  };
}

function center(rect: StudioNavigationRect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function perpendicularGap(
  current: StudioNavigationRect,
  candidate: StudioNavigationRect,
  direction: StudioNavigationDirection,
): number {
  if (direction === "up" || direction === "down") {
    return Math.max(0, candidate.left - current.right, current.left - candidate.right);
  }
  return Math.max(0, candidate.top - current.bottom, current.top - candidate.bottom);
}

export function findStudioNavigationTarget(
  rects: readonly StudioNavigationRect[],
  currentIndex: number,
  direction: StudioNavigationDirection,
): number {
  const current = rects[currentIndex];
  if (!current) return -1;
  const currentCenter = center(current);
  let bestIndex = currentIndex;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 0; index < rects.length; index += 1) {
    if (index === currentIndex) continue;
    const candidate = rects[index];
    const candidateCenter = center(candidate);
    const primaryDelta =
      direction === "up" || direction === "down"
        ? candidateCenter.y - currentCenter.y
        : candidateCenter.x - currentCenter.x;
    const isForward =
      direction === "down" || direction === "right" ? primaryDelta > 1 : primaryDelta < -1;
    if (!isForward) continue;

    const secondaryDelta =
      direction === "up" || direction === "down"
        ? Math.abs(candidateCenter.x - currentCenter.x)
        : Math.abs(candidateCenter.y - currentCenter.y);
    const score =
      Math.abs(primaryDelta) +
      perpendicularGap(current, candidate, direction) * 4 +
      secondaryDelta * 0.1;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}
