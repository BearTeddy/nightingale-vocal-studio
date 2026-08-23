import { describe, expect, it } from "vitest";

import { LEARNING_STAGES } from "./catalog";
import { buildDailyPlan } from "./daily-plan";
import { createSkillProgress } from "./progress";
import type { SkillId, SkillProgress } from "./types";

function progress(skillId: SkillId, mastery: SkillProgress["mastery"]): SkillProgress {
  return { ...createSkillProgress(skillId), mastery };
}

describe("daily learning plan", () => {
  it("builds the default ten-minute beginner session", () => {
    const plan = buildDailyPlan({ nowMs: 0, progress: [] });

    expect(plan.stage).toBe("ready");
    expect(plan.totalMinutes).toBe(10);
    expect(plan.items.map((item) => [item.kind, item.minutes])).toEqual([
      ["check-in", 1],
      ["focus", 3],
      ["reinforce", 2],
      ["preview", 3],
      ["reflection", 1],
    ]);
    expect(plan.items[1]).toMatchObject({
      lessonId: "ready.setup-check",
      skillId: "setup.calibration",
      assistPreset: "full",
    });
    expect(plan.items[2]).toMatchObject({
      title: "Repeat once: Set up your voice space",
      lessonId: "ready.setup-check",
    });
    expect(plan.items[3]).toMatchObject({
      title: "Next step: Follow the direction",
      lessonId: "hear-and-explore.direction-glides",
      skillId: "hearing.direction",
    });
  });

  it("advances to the first stage whose core skill is not independent", () => {
    const plan = buildDailyPlan({
      nowMs: 0,
      progress: [
        progress("setup.calibration", "independent"),
        progress("hearing.direction", "assisted"),
      ],
    });

    expect(plan.stage).toBe("hear-and-explore");
    expect(plan.items[1]).toMatchObject({
      skillId: "hearing.direction",
      assistPreset: "guided",
    });
    expect(plan.items[3]).toMatchObject({
      kind: "preview",
      lessonId: "pitch-imitation.single-note-echo",
      skillId: "pitch.imitation",
    });
  });

  it("prioritizes the oldest due review independently of the focus lesson", () => {
    const setup = {
      ...progress("setup.calibration", "independent"),
      validAttemptCount: 2,
      review: { intervalIndex: 1, nextReviewAtMs: 100 },
    };
    const hearing = {
      ...progress("hearing.direction", "assisted"),
      validAttemptCount: 2,
      review: { intervalIndex: 0, nextReviewAtMs: 200 },
    };
    const plan = buildDailyPlan({ nowMs: 500, progress: [hearing, setup] });

    expect(plan.items[2]).toMatchObject({
      kind: "review",
      lessonId: "ready.setup-check",
      skillId: "setup.calibration",
      due: true,
    });
  });

  it("uses the song transfer lesson once its prerequisites stage is reached", () => {
    const completedBeforeSongs = LEARNING_STAGES.slice(0, 7).flatMap((stage) =>
      stage.coreSkills.map((skillId) => progress(skillId, "independent")),
    );
    const plan = buildDailyPlan({ nowMs: 0, progress: completedBeforeSongs });

    expect(plan.stage).toBe("song-phrases");
    expect(plan.items[3]).toMatchObject({
      kind: "transfer",
      lessonId: "song-phrases.short-phrase-transfer",
      skillId: "song.phrase",
    });
  });
});
