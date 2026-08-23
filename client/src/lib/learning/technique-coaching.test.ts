import { describe, expect, it } from "vitest";
import {
  RELATIVE_BRIGHTNESS_LIMITS,
  STARTER_COACHING_CUES,
  assessTechniqueSafety,
  compareRelativeBrightness,
  rankCoachingCues,
  type AcousticFeatureSummary,
  type TechniqueReflection,
} from "./technique-coaching";

function reflection(overrides: Partial<TechniqueReflection> = {}): TechniqueReflection {
  return {
    cueId: "higher-gentle-siren",
    recordedAt: 1,
    comfortBefore: 4,
    comfortAfter: 4,
    effortAfter: 2,
    helpfulness: "helped",
    successfulOutcome: true,
    stopSignals: [],
    ...overrides,
  };
}

function features(overrides: Partial<AcousticFeatureSummary> = {}): AcousticFeatureSummary {
  return {
    deviceId: "studio-mic-1",
    vowel: "oo",
    medianPitchHz: 220,
    levelDb: -24,
    spectralCentroidHz: 1_800,
    harmonicCount: 10,
    confidence: 0.9,
    ...overrides,
  };
}

describe("technique coaching catalog", () => {
  it("ships stable reviewed English and Japanese starter cues", () => {
    expect(STARTER_COACHING_CUES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(STARTER_COACHING_CUES.map((cue) => cue.id)).size).toBe(
      STARTER_COACHING_CUES.length,
    );

    for (const cue of STARTER_COACHING_CUES) {
      expect(cue.title.en).not.toBe("");
      expect(cue.title.ja).not.toBe("");
      expect(cue.instruction.en).not.toBe("");
      expect(cue.instruction.ja).not.toBe("");
      expect(cue.selfCheck.en).not.toBe("");
      expect(cue.selfCheck.ja).not.toBe("");
      expect(cue.safetyNote.en).not.toBe("");
      expect(cue.safetyNote.ja).not.toBe("");
      expect(cue.review.status).toBe("reviewed");
      expect(cue.review.sourceIds.length).toBeGreaterThan(0);
    }
  });

  it("labels anatomical technique cues as self reports or proxies", () => {
    const anatomicalDomains = new Set(["tongue_release", "jaw_release", "lip_coordination"]);
    for (const cue of STARTER_COACHING_CUES.filter((item) => anatomicalDomains.has(item.domain))) {
      expect(cue.evidenceKind).not.toBe("measured");
    }
  });
});

describe("technique comfort and stop behavior", () => {
  it("allows only a comfortable successful attempt to advance", () => {
    expect(assessTechniqueSafety(reflection())).toMatchObject({
      action: "advance",
      mayContinue: true,
      mayAdvance: true,
    });
    expect(assessTechniqueSafety(reflection({ comfortAfter: 3, effortAfter: 3 }))).toMatchObject({
      action: "repeat",
      mayAdvance: false,
    });
  });

  it("steps down after high effort or repeated misses", () => {
    expect(assessTechniqueSafety(reflection({ effortAfter: 4 }))).toMatchObject({
      action: "step_down",
      reason: "uncomfortable_or_high_effort",
      mayAdvance: false,
    });
    expect(
      assessTechniqueSafety(reflection({ successfulOutcome: false, helpfulness: "no_change" }), 3),
    ).toMatchObject({
      action: "step_down",
      reason: "repeated_misses",
    });
  });

  it("ends for voice warning signals and escalates breathing or chest symptoms", () => {
    expect(assessTechniqueSafety(reflection({ stopSignals: ["strain"] }))).toMatchObject({
      action: "end_session",
      mayContinue: false,
    });
    expect(
      assessTechniqueSafety(reflection({ stopSignals: ["difficulty_breathing"] })),
    ).toMatchObject({
      action: "seek_help",
      mayContinue: false,
    });
  });
});

describe("cue preference ranking", () => {
  it("raises cues that helped and lowers cues that made singing harder", () => {
    const cues = STARTER_COACHING_CUES.slice(0, 2);
    const ranked = rankCoachingCues(cues, [
      reflection({ cueId: cues[0].id, recordedAt: 1, helpfulness: "made_harder" }),
      reflection({
        cueId: cues[1].id,
        recordedAt: 2,
        comfortBefore: 3,
        comfortAfter: 5,
        helpfulness: "helped",
      }),
    ]);

    expect(ranked[0].cue.id).toBe(cues[1].id);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[0].attempts).toBe(1);
  });

  it("suppresses automatic recommendation after the newest reflection has a stop signal", () => {
    const cue = STARTER_COACHING_CUES[0];
    const other = STARTER_COACHING_CUES[1];
    const ranked = rankCoachingCues(
      [cue, other],
      [
        reflection({ cueId: cue.id, recordedAt: 1, stopSignals: [] }),
        reflection({ cueId: cue.id, recordedAt: 2, stopSignals: ["pain"] }),
      ],
    );

    expect(ranked[0].cue.id).toBe(other.id);
    expect(ranked[1]).toMatchObject({ score: 0, safetySuppressed: true });
  });
});

describe("relative acoustic brightness", () => {
  it.each([
    [2_100, "brighter"],
    [1_850, "similar"],
    [1_600, "darker"],
  ] as const)("classifies centroid %s as %s", (spectralCentroidHz, expected) => {
    const result = compareRelativeBrightness(features(), features({ spectralCentroidHz }));

    expect(result.result).toBe(expected);
    expect(result.reason).toBeNull();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("normalizes case and Unicode width when checking the same vowel", () => {
    const result = compareRelativeBrightness(
      features({ vowel: " ＯＯ " }),
      features({ vowel: "oo", spectralCentroidHz: 2_100 }),
    );

    expect(result.result).toBe("brighter");
  });

  it.each([
    [features({ deviceId: "mic-a" }), features({ deviceId: "mic-b" }), "device_mismatch"],
    [features({ vowel: "oo" }), features({ vowel: "ee" }), "vowel_mismatch"],
    [features(), features({ medianPitchHz: 230 }), "pitch_mismatch"],
    [features(), features({ levelDb: -20 }), "level_mismatch"],
    [features(), features({ harmonicCount: 4 }), "insufficient_harmonics"],
    [features(), features({ confidence: 0.2 }), "low_confidence"],
  ] as const)(
    "returns unmeasurable for incomparable summaries: %s",
    (baseline, comparison, reason) => {
      expect(compareRelativeBrightness(baseline, comparison)).toMatchObject({
        result: "unmeasurable",
        confidence: 0,
        reason,
      });
    },
  );

  it("accepts the exact ±35 cent, 3 dB, and minimum-harmonic boundaries", () => {
    const pitchAtLimit =
      220 * 2 ** (RELATIVE_BRIGHTNESS_LIMITS.maximumPitchDifferenceCents / 1_200);
    const result = compareRelativeBrightness(
      features(),
      features({
        medianPitchHz: pitchAtLimit,
        levelDb: -21,
        harmonicCount: RELATIVE_BRIGHTNESS_LIMITS.minimumHarmonicCount,
        spectralCentroidHz: 2_100,
      }),
    );

    expect(result.result).toBe("brighter");
    expect(result.pitchDifferenceCents).toBe(35);
    expect(result.levelDifferenceDb).toBe(3);
  });

  it("rejects invalid numeric features without producing a direction", () => {
    expect(
      compareRelativeBrightness(features(), features({ spectralCentroidHz: Number.NaN })),
    ).toMatchObject({
      result: "unmeasurable",
      reason: "invalid_features",
    });
  });
});
