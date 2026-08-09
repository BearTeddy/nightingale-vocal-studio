import { describe, expect, it } from "vitest";
import type { MelodyMap } from "@/types/MelodyMap";
import { transformMelodyMap } from "./melody";

const melody: MelodyMap = {
  version: 1,
  source: "torchcrepe",
  hop_ms: 10,
  confidence: 0.9,
  strict_scoring_available: true,
  fallback_reason: null,
  notes: [
    {
      id: "note-1",
      start: 4,
      end: 6,
      midi: 60,
      cents: 5,
      confidence: 0.9,
      eligible: true,
      lyric_word_indices: [],
    },
  ],
};

describe("transformMelodyMap", () => {
  it("moves notes with the selected key and tempo", () => {
    const transformed = transformMelodyMap(melody, 2, 2);
    expect(transformed.notes[0]).toMatchObject({ start: 2, end: 3, midi: 62, cents: 5 });
    expect(transformed.hop_ms).toBe(5);
  });

  it("returns the canonical map unchanged at the original key and tempo", () => {
    expect(transformMelodyMap(melody, 0, 1)).toBe(melody);
  });
});
