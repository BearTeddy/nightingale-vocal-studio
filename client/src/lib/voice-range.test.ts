import { describe, expect, it } from "vitest";
import {
  VOCAL_RANGE_REFERENCES,
  VOCAL_SCALE_HIGH_MIDI,
  VOCAL_SCALE_LOW_MIDI,
  vocalRangePlacement,
} from "./voice-range";

describe("voice range scale", () => {
  it("includes the common low through high ensemble references", () => {
    expect(VOCAL_RANGE_REFERENCES.map((range) => range.label)).toEqual([
      "Bass",
      "Bass-baritone",
      "Baritone",
      "Tenor",
      "Countertenor",
      "Contralto",
      "Mezzo-soprano",
      "Soprano",
    ]);
    expect(VOCAL_RANGE_REFERENCES[0].lowMidi).toBe(VOCAL_SCALE_LOW_MIDI);
    expect(VOCAL_RANGE_REFERENCES[VOCAL_RANGE_REFERENCES.length - 1]?.highMidi).toBe(
      VOCAL_SCALE_HIGH_MIDI,
    );
  });

  it("places and clamps a measured range on the shared scale", () => {
    expect(vocalRangePlacement(48, 72)).toEqual({ leftPercent: 25, widthPercent: 50 });
    expect(vocalRangePlacement(20, 96)).toEqual({ leftPercent: 0, widthPercent: 100 });
  });
});
