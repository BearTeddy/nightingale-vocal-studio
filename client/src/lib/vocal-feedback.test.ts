import { describe, expect, it } from "vitest";

import type { PitchFrame } from "@/types/PitchFrame";
import { createVocalFeedback } from "./vocal-feedback";

const frame = (overrides: Partial<PitchFrame> = {}): PitchFrame => ({
  hz: 440,
  midi: 69,
  clarity: 0.9,
  rms: 0.1,
  peak: 0.3,
  voiced: true,
  sample_index: 0,
  sample_rate: 48_000,
  captured_at_ms: 0,
  ...overrides,
});

describe("vocal studio feedback", () => {
  it("distinguishes capture startup, quiet input, and unclear pitch", () => {
    expect(createVocalFeedback(null, true, null).state).toBe("waiting");
    expect(createVocalFeedback(frame({ rms: 0.001, peak: 0.002 }), true, null).state).toBe("quiet");
    expect(
      createVocalFeedback(frame({ hz: null, midi: null, voiced: false }), true, null).state,
    ).toBe("unclear");
  });

  it("reports target direction with strict cents accuracy", () => {
    const low = createVocalFeedback(frame({ midi: 68.5 }), true, 69);
    const centered = createVocalFeedback(frame({ midi: 69.2 }), true, 69);
    const high = createVocalFeedback(frame({ midi: 69.6 }), true, 69);

    expect(low.headline).toBe("Raise your pitch");
    expect(low.cents).toBe(-50);
    expect(centered.headline).toBe("On pitch");
    expect(centered.match).toBe(100);
    expect(high.headline).toBe("Lower your pitch");
  });

  it("warns when the input peak clips", () => {
    expect(createVocalFeedback(frame({ peak: 0.99 }), true, 69).state).toBe("clipping");
  });
});
