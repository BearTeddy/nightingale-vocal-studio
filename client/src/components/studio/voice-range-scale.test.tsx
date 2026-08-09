import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VoiceRangeScale } from "./voice-range-scale";

function midiName(midi: number | null): string {
  return midi == null ? "--" : `M${midi}`;
}

describe("VoiceRangeScale", () => {
  it("always shows the full set of voice range references", () => {
    const markup = renderToStaticMarkup(
      <VoiceRangeScale
        lowMidi={null}
        highMidi={null}
        tessituraLowMidi={null}
        tessituraHighMidi={null}
        midiName={midiName}
      />,
    );

    for (const label of [
      "Bass",
      "Bass-baritone",
      "Baritone",
      "Tenor",
      "Countertenor",
      "Contralto",
      "Mezzo-soprano",
      "Soprano",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).not.toContain("Your range");
  });

  it("adds the measured comfortable range and tessitura when available", () => {
    const markup = renderToStaticMarkup(
      <VoiceRangeScale
        lowMidi={48}
        highMidi={72}
        tessituraLowMidi={52}
        tessituraHighMidi={68}
        midiName={midiName}
      />,
    );

    expect(markup).toContain("Your range");
    expect(markup).toContain("M48-M72");
    expect(markup).toContain("Your tessitura");
    expect(markup).toContain("M52-M68");
  });
});
