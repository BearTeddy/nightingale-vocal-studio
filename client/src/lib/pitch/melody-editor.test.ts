import { describe, expect, it } from "vitest";
import type { TargetNote } from "@/types/TargetNote";
import {
  cloneTargetNotes,
  mergeTargetNotes,
  splitTargetNote,
  updateTargetNote,
} from "./melody-editor";

const note = (overrides: Partial<TargetNote> = {}): TargetNote => ({
  id: "n1",
  start: 1,
  end: 2,
  midi: 60,
  cents: 0,
  confidence: 0.9,
  eligible: true,
  lyric_word_indices: [1],
  ...overrides,
});

describe("melody editor operations", () => {
  it("deep-clones lyric links for undo snapshots", () => {
    const original = [note()];
    const cloned = cloneTargetNotes(original);
    cloned[0].lyric_word_indices.push(2);
    expect(original[0].lyric_word_indices).toEqual([1]);
  });

  it("splits a note at its midpoint without mutating the source", () => {
    const original = [note()];
    const split = splitTargetNote(original, 0);
    expect(split.map(({ id, start, end }) => ({ id, start, end }))).toEqual([
      { id: "n1a", start: 1, end: 1.5 },
      { id: "n1b", start: 1.5, end: 2 },
    ]);
    expect(original).toEqual([note()]);
  });

  it("keeps notes that are too short to split unchanged", () => {
    const original = [note({ end: 1.1 })];
    expect(splitTargetNote(original, 0)).toBe(original);
  });

  it("merges overlap safely and duration-weights pitch including cents", () => {
    const notes = [
      note({ id: "left", start: 1, end: 3, midi: 60, cents: 25, confidence: 0.8 }),
      note({
        id: "right",
        start: 2,
        end: 2.5,
        midi: 64,
        cents: -25,
        confidence: 0.6,
        eligible: false,
        lyric_word_indices: [2],
      }),
    ];
    const merged = mergeTargetNotes(notes, 0);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "left+right",
      start: 1,
      end: 3,
      midi: 61,
      cents: -5,
      confidence: 0.6,
      eligible: false,
      lyric_word_indices: [1, 2],
    });
  });

  it("updates only the selected note", () => {
    const notes = [note(), note({ id: "n2", midi: 62 })];
    const updated = updateTargetNote(notes, 1, (target) => ({ ...target, midi: 63 }));
    expect(updated.map((target) => target.midi)).toEqual([60, 63]);
    expect(notes.map((target) => target.midi)).toEqual([60, 62]);
  });
});
