import { describe, expect, it } from "vitest";

import { LEARNING_STAGES, STARTER_LESSONS } from "./catalog";

describe("learning catalog", () => {
  it("keeps the nine public stage IDs and their order stable", () => {
    expect(LEARNING_STAGES.map((stage) => stage.id)).toEqual([
      "ready",
      "hear-and-explore",
      "pitch-imitation",
      "center-and-hold",
      "move-between-notes",
      "time-and-rhythm",
      "patterns-and-memory",
      "song-phrases",
      "perform-and-express",
    ]);
    expect(LEARNING_STAGES.map((stage) => stage.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives every core skill a starter lesson with a unique versioned ID", () => {
    const coreSkills = LEARNING_STAGES.flatMap((stage) => stage.coreSkills);
    const lessonIds = STARTER_LESSONS.map((lesson) => lesson.id);
    const primarySkills = new Set(STARTER_LESSONS.map((lesson) => lesson.primarySkill));

    expect(new Set(lessonIds).size).toBe(lessonIds.length);
    expect(STARTER_LESSONS.every((lesson) => lesson.version === 1)).toBe(true);
    expect(coreSkills.every((skillId) => primarySkills.has(skillId))).toBe(true);
  });

  it("uses only prerequisites that exist earlier in the starter path", () => {
    const learned = new Set<string>();
    for (const stage of LEARNING_STAGES) {
      const stageLessons = STARTER_LESSONS.filter((lesson) => lesson.stage === stage.id);
      for (const lesson of stageLessons) {
        expect(lesson.prerequisites.every((skillId) => learned.has(skillId))).toBe(true);
        learned.add(lesson.primarySkill);
      }
    }
  });
});
