import { describe, expect, it } from "vitest";
import type { TechniqueReflection } from "./technique-coaching";
import {
  UPPER_RANGE_EVIDENCE_LIMITS,
  UPPER_RANGE_LADDER_CUE_ID,
  assessUpperRangePitchEvidence,
  clampUpperRangeStart,
  countConsecutiveUnsuccessfulLadderReflections,
  decideUpperRangeStep,
  midiToHz,
  normalizeUpperRangeBounds,
  type UpperRangePitchEvidence,
} from "./upper-range-ladder";

const BOUNDS = { lowMidi: 60, highMidi: 64 } as const;

function evidence(overrides: Partial<UpperRangePitchEvidence> = {}): UpperRangePitchEvidence {
  return {
    targetMidi: 62,
    voicedSampleCount: 20,
    medianMidi: 62,
    medianErrorCents: 0,
    centralSpreadCents: 10,
    inTuneRatio: 1,
    matched: true,
    reason: "matched",
    ...overrides,
  };
}

function reflection(overrides: Partial<TechniqueReflection> = {}): TechniqueReflection {
  return {
    cueId: UPPER_RANGE_LADDER_CUE_ID,
    recordedAt: 1,
    comfortBefore: 4,
    comfortAfter: 5,
    effortAfter: 1,
    helpfulness: "helped",
    successfulOutcome: true,
    stopSignals: [],
    ...overrides,
  };
}

describe("upper-range pitch evidence", () => {
  it("accepts a sufficiently sampled, centered, steady target", () => {
    const samples = Array.from(
      { length: UPPER_RANGE_EVIDENCE_LIMITS.minimumVoicedSamples },
      (_, index) => midiToHz(62 + (index % 3 === 0 ? 0.08 : -0.04)),
    );

    expect(assessUpperRangePitchEvidence(62, samples)).toMatchObject({
      matched: true,
      reason: "matched",
      voicedSampleCount: samples.length,
    });
  });

  it("rejects insufficient, off-target, and unstable evidence", () => {
    expect(assessUpperRangePitchEvidence(62, [midiToHz(62)])).toMatchObject({
      matched: false,
      reason: "not_enough_voiced_samples",
    });

    expect(
      assessUpperRangePitchEvidence(
        62,
        Array.from({ length: 20 }, () => midiToHz(63)),
      ),
    ).toMatchObject({ matched: false, reason: "off_target" });

    const unstable = Array.from({ length: 20 }, (_, index) =>
      midiToHz(index % 3 === 0 ? 61.56 : index % 3 === 1 ? 62 : 62.44),
    );
    expect(assessUpperRangePitchEvidence(62, unstable)).toMatchObject({
      matched: false,
      reason: "unstable",
    });
  });
});

describe("upper-range ladder bounds and reflection decisions", () => {
  it("rejects invalid bounds and clamps the starting target inside valid bounds", () => {
    expect(
      normalizeUpperRangeBounds({ comfortableLowMidi: 65, comfortableHighMidi: 60 }),
    ).toBeNull();
    expect(
      normalizeUpperRangeBounds({ comfortableLowMidi: 60.2, comfortableHighMidi: 64.8 }),
    ).toEqual({ lowMidi: 61, highMidi: 64 });
    expect(clampUpperRangeStart(70, BOUNDS)).toBe(64);
  });

  it("advances exactly one semitone only with pitch evidence and an easy reflection", () => {
    expect(
      decideUpperRangeStep({
        targetMidi: 62,
        bounds: BOUNDS,
        evidence: evidence(),
        reflection: reflection(),
        consecutiveUnsuccessfulAttempts: 0,
      }),
    ).toMatchObject({ action: "advance", nextMidi: 63 });

    expect(
      decideUpperRangeStep({
        targetMidi: 62,
        bounds: BOUNDS,
        evidence: evidence({ matched: false, reason: "off_target" }),
        reflection: reflection(),
        consecutiveUnsuccessfulAttempts: 1,
      }),
    ).toMatchObject({ action: "repeat", nextMidi: 62 });
  });

  it("completes at the saved upper boundary without expanding it", () => {
    expect(
      decideUpperRangeStep({
        targetMidi: BOUNDS.highMidi,
        bounds: BOUNDS,
        evidence: evidence({ targetMidi: BOUNDS.highMidi }),
        reflection: reflection(),
        consecutiveUnsuccessfulAttempts: 0,
      }),
    ).toMatchObject({ action: "complete", nextMidi: BOUNDS.highMidi });
  });

  it("steps down on high effort and stops on a strain signal", () => {
    expect(
      decideUpperRangeStep({
        targetMidi: 62,
        bounds: BOUNDS,
        evidence: evidence(),
        reflection: reflection({ effortAfter: 4 }),
        consecutiveUnsuccessfulAttempts: 0,
      }),
    ).toMatchObject({ action: "step_down", nextMidi: 61 });

    expect(
      decideUpperRangeStep({
        targetMidi: 62,
        bounds: BOUNDS,
        evidence: evidence(),
        reflection: reflection({ stopSignals: ["strain"] }),
        consecutiveUnsuccessfulAttempts: 0,
      }),
    ).toMatchObject({ action: "stop", nextMidi: 62 });
  });

  it("counts only the trailing unsuccessful ladder reflections", () => {
    expect(
      countConsecutiveUnsuccessfulLadderReflections([
        reflection({ successfulOutcome: true }),
        reflection({ cueId: "another-cue", successfulOutcome: false }),
        reflection({ successfulOutcome: false }),
        reflection({ successfulOutcome: false }),
      ]),
    ).toBe(2);
  });
});
