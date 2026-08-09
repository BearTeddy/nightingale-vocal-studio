import { describe, expect, it } from "vitest";
import {
  findStudioNavigationTarget,
  planStudioBackAction,
  planStudioTabChange,
} from "./studio-navigation";

describe("Vocal Studio navigation", () => {
  const grid = [
    { left: 0, right: 100, top: 0, bottom: 40 },
    { left: 120, right: 220, top: 0, bottom: 40 },
    { left: 0, right: 100, top: 60, bottom: 100 },
    { left: 120, right: 220, top: 60, bottom: 100 },
  ];

  it("moves spatially through the visible control layout", () => {
    expect(findStudioNavigationTarget(grid, 0, "right")).toBe(1);
    expect(findStudioNavigationTarget(grid, 0, "down")).toBe(2);
    expect(findStudioNavigationTarget(grid, 3, "left")).toBe(2);
    expect(findStudioNavigationTarget(grid, 3, "up")).toBe(1);
  });

  it("keeps focus in place at an outer edge", () => {
    expect(findStudioNavigationTarget(grid, 0, "left")).toBe(0);
    expect(findStudioNavigationTarget(grid, 1, "up")).toBe(1);
  });

  it("prefers a directionally aligned control over a nearer diagonal", () => {
    const controls = [
      { left: 0, right: 100, top: 0, bottom: 40 },
      { left: 0, right: 100, top: 100, bottom: 140 },
      { left: 130, right: 230, top: 60, bottom: 100 },
    ];
    expect(findStudioNavigationTarget(controls, 0, "down")).toBe(1);
  });

  it("uses Back to stop active work before leaving the Studio", () => {
    expect(planStudioBackAction(true, null, false)).toBe("cancel-checkup");
    expect(planStudioBackAction(false, "center", false)).toBe("stop-exercise");
    expect(planStudioBackAction(false, "center", true)).toBe("stay");
    expect(planStudioBackAction(false, null, false)).toBe("leave");
  });

  it("leaves the current view and its idle state alone", () => {
    expect(planStudioTabChange("exercises", "exercises", false, null)).toEqual({
      changed: false,
      cancelCheckup: false,
      stopExercise: false,
      resetListeningPrompt: false,
    });
  });

  it("cancels a checkup before showing another view", () => {
    expect(planStudioTabChange("checkup", "history", true, null)).toMatchObject({
      changed: true,
      cancelCheckup: true,
      stopExercise: false,
    });
  });

  it("stops a running exercise without discarding its partial result", () => {
    expect(planStudioTabChange("exercises", "history", false, "steady-sustain")).toMatchObject({
      changed: true,
      stopExercise: true,
      resetListeningPrompt: false,
    });
  });

  it("fully resets a hidden listening capture", () => {
    expect(planStudioTabChange("exercises", "history", false, "listening-sing")).toMatchObject({
      changed: true,
      stopExercise: true,
      resetListeningPrompt: true,
    });
  });

  it("resets an unanswered listening prompt after capture has finished", () => {
    expect(planStudioTabChange("exercises", "history", false, null, true)).toMatchObject({
      changed: true,
      stopExercise: false,
      resetListeningPrompt: true,
    });
  });
});
