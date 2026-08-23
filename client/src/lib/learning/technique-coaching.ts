/**
 * Pure technique-coaching domain rules. Nothing in this module captures audio,
 * diagnoses vocal function, or treats an acoustic/visual proxy as anatomy.
 */

export type TechniqueDomain =
  | "higher_pitch"
  | "pitch_coordination"
  | "vowel_shape"
  | "tongue_release"
  | "jaw_release"
  | "lip_coordination"
  | "diction"
  | "breath_coordination"
  | "resonance_exploration";

export type TechniqueEvidenceKind =
  | "measured"
  | "acoustic_proxy"
  | "camera_proxy"
  | "self_report"
  | "instructional";

export interface LocalizedTechniqueText {
  en: string;
  ja: string;
}

export type TechniqueReviewSourceId = "nidcd_voice_care" | "nats_science_informed";

export interface TechniqueReviewSource {
  id: TechniqueReviewSourceId;
  label: string;
  url: string;
}

export const TECHNIQUE_REVIEW_SOURCES: readonly TechniqueReviewSource[] = [
  {
    id: "nidcd_voice_care",
    label: "NIDCD: Taking Care of Your Voice",
    url: "https://www.nidcd.nih.gov/health/taking-care-your-voice",
  },
  {
    id: "nats_science_informed",
    label: "NATS: Science-Informed Voice Pedagogy Resources",
    url: "https://www.nats.org/cgi/page.cgi/Science-Informed_Voice_Pedagogy_Resources.html",
  },
] as const;

export interface CoachingCue {
  /** Stable id used by reflection and preference history. */
  id: string;
  domain: TechniqueDomain;
  evidenceKind: TechniqueEvidenceKind;
  /** 0..100; used only as a deterministic default before personal reflections exist. */
  defaultPriority: number;
  title: LocalizedTechniqueText;
  instruction: LocalizedTechniqueText;
  selfCheck: LocalizedTechniqueText;
  safetyNote: LocalizedTechniqueText;
  review: {
    status: "reviewed";
    reviewedAt: string;
    sourceIds: readonly TechniqueReviewSourceId[];
  };
}

export type TechniqueComfortRating = 1 | 2 | 3 | 4 | 5;
export type TechniqueEffortRating = 1 | 2 | 3 | 4 | 5;
export type TechniqueHelpfulness = "helped" | "no_change" | "made_harder" | "not_sure";

export type TechniqueStopSignal =
  | "pain"
  | "rawness"
  | "strain"
  | "hoarseness"
  | "voice_tired"
  | "sudden_range_loss"
  | "dizziness"
  | "difficulty_breathing"
  | "chest_pain";

export interface TechniqueReflection {
  cueId: string;
  recordedAt: number;
  /** 1 = very uncomfortable, 5 = fully comfortable. */
  comfortBefore: TechniqueComfortRating;
  /** 1 = very uncomfortable, 5 = fully comfortable. */
  comfortAfter: TechniqueComfortRating;
  /** Optional when the flow also asks for effort before trying a cue. */
  effortBefore?: TechniqueEffortRating;
  /** 1 = easy, 5 = maximum effort. */
  effortAfter: TechniqueEffortRating;
  helpfulness: TechniqueHelpfulness;
  successfulOutcome: boolean;
  stopSignals: readonly TechniqueStopSignal[];
}

export type TechniqueSafetyAction =
  | "advance"
  | "repeat"
  | "step_down"
  | "end_session"
  | "seek_help";

export type TechniqueSafetyReason =
  | "comfortable_success"
  | "needs_another_easy_attempt"
  | "moderate_effort"
  | "repeated_misses"
  | "uncomfortable_or_high_effort"
  | "stop_signal"
  | "urgent_stop_signal";

export interface TechniqueSafetyDecision {
  action: TechniqueSafetyAction;
  reason: TechniqueSafetyReason;
  mayContinue: boolean;
  mayAdvance: boolean;
  message: LocalizedTechniqueText;
}

const REVIEWED_AT = "2026-08-23";
const REVIEWED_SOURCES = ["nidcd_voice_care", "nats_science_informed"] as const;

const reviewed = () => ({
  status: "reviewed" as const,
  reviewedAt: REVIEWED_AT,
  sourceIds: REVIEWED_SOURCES,
});

/**
 * Conservative starter material. Instructions describe experiments and
 * self-checks; only directly observable outcomes should be scored elsewhere.
 */
export const STARTER_COACHING_CUES: readonly CoachingCue[] = [
  {
    id: "higher-gentle-siren",
    domain: "higher_pitch",
    evidenceKind: "measured",
    defaultPriority: 92,
    title: { en: "Easy upward siren", ja: "楽な上向きサイレン" },
    instruction: {
      en: "Begin on an easy note. Glide a small distance up and back on “woo” at a comfortable speaking-like volume; stop before it feels like a reach.",
      ja: "楽な音から始め、「ウー」で少しだけ上へ滑らせて戻ります。話し声に近い無理のない音量で、届かせようと頑張る前に止めましょう。",
    },
    selfCheck: {
      en: "Could your jaw and neck stay easy while the pitch moved?",
      ja: "音程が動いている間、あごと首を楽に保てましたか？",
    },
    safetyNote: {
      en: "Do not chase the top note or add volume. Step down if comfort decreases.",
      ja: "最高音を追いかけたり、音量を足したりしないでください。楽さが減ったら音を下げます。",
    },
    review: reviewed(),
  },
  {
    id: "higher-semitone-ladder",
    domain: "higher_pitch",
    evidenceKind: "measured",
    defaultPriority: 88,
    title: { en: "One-step range ladder", ja: "半音ずつの音域ラダー" },
    instruction: {
      en: "Echo one comfortable note, then try the next semitone once. Move upward only after a centered, comfortable response; otherwise repeat or step down.",
      ja: "まず楽な1音をまねし、次の半音を1回だけ試します。音程が安定し、楽に出せたときだけ上へ進み、それ以外は繰り返すか下げます。",
    },
    selfCheck: {
      en: "Did the new note feel as easy as the note below it?",
      ja: "新しい音は、その下の音と同じくらい楽でしたか？",
    },
    safetyNote: {
      en: "A higher detected pitch is not permission to continue through fatigue, hoarseness, or strain.",
      ja: "高い音が検出されても、疲れ・かすれ・力みを感じたまま続けてよいという意味ではありません。",
    },
    review: reviewed(),
  },
  {
    id: "tongue-light-contact",
    domain: "tongue_release",
    evidenceKind: "self_report",
    defaultPriority: 78,
    title: { en: "Let the tongue stay available", ja: "舌を自由にしておく" },
    instruction: {
      en: "On a comfortable vowel, let the tongue tip touch lightly near the lower front teeth while the rest of the tongue remains free to shape the sound. Do not pin it in place.",
      ja: "楽な母音で、舌先を下の前歯付近に軽く触れさせ、舌のほかの部分は音を作るため自由に動かします。舌を固定しないでください。",
    },
    selfCheck: {
      en: "Could you keep the contact light and still move naturally into the next sound?",
      ja: "軽い接触を保ちながら、次の音へ自然に動けましたか？",
    },
    safetyNote: {
      en: "This is an exploration, not one correct tongue position for every vowel, word, language, or style.",
      ja: "これは試すための方法であり、すべての母音・言葉・言語・歌唱スタイルに共通する唯一の正しい舌位置ではありません。",
    },
    review: reviewed(),
  },
  {
    id: "jaw-two-openings",
    domain: "jaw_release",
    evidenceKind: "self_report",
    defaultPriority: 76,
    title: { en: "Compare two easy openings", ja: "2つの楽な口の開きを比べる" },
    instruction: {
      en: "Sing the same easy note with a slightly smaller and slightly larger mouth opening. Keep the change small and choose the version that feels freer and keeps the word clear.",
      ja: "同じ楽な音を、口の開きを少し小さくした場合と少し大きくした場合で歌います。変化は小さくし、より自由で言葉が明瞭な方を選びます。",
    },
    selfCheck: {
      en: "Did the jaw move freely instead of being forced downward or held still?",
      ja: "あごを無理に下げたり固定したりせず、自由に動かせましたか？",
    },
    safetyNote: {
      en: "More opening is not automatically better. Stop if the jaw clicks, hurts, or feels locked.",
      ja: "大きく開けば必ず良いわけではありません。あごに音・痛み・ロック感があれば止めてください。",
    },
    review: reviewed(),
  },
  {
    id: "vowel-small-rounding",
    domain: "vowel_shape",
    evidenceKind: "acoustic_proxy",
    defaultPriority: 74,
    title: { en: "Small vowel-shape experiment", ja: "小さな母音変化の実験" },
    instruction: {
      en: "Repeat one vowel on the same comfortable pitch and volume. On the second try, make one small lip-rounding change while keeping the vowel recognizable.",
      ja: "同じ母音を、同じ楽な音程と音量で繰り返します。2回目は母音として聞き取れる範囲で、唇の丸め方だけを少し変えます。",
    },
    selfCheck: {
      en: "Which version felt easier and still sounded like the intended vowel?",
      ja: "どちらがより楽で、意図した母音として聞こえましたか？",
    },
    safetyNote: {
      en: "Brighter or darker is only a relative acoustic observation, not proof of a correct mouth or tongue position.",
      ja: "明るい・暗いは相対的な音響上の観察にすぎず、口や舌の位置が正しいことの証明ではありません。",
    },
    review: reviewed(),
  },
  {
    id: "lips-oo-ee",
    domain: "lip_coordination",
    evidenceKind: "self_report",
    defaultPriority: 70,
    title: { en: "Free lips: oo to ee", ja: "自由な唇：ウーからイー" },
    instruction: {
      en: "On one easy note, alternate slowly between “oo” and “ee.” Let the lips change without making the jaw rigid.",
      ja: "1つの楽な音で「ウー」と「イー」をゆっくり交互に歌います。あごを固めず、唇が変化できるようにします。",
    },
    selfCheck: {
      en: "Could the lips move while the jaw and pitch stayed steady?",
      ja: "あごと音程を安定させながら、唇を動かせましたか？",
    },
    safetyNote: {
      en: "Use a small motion; do not stretch or press the lips into discomfort.",
      ja: "動きは小さくし、不快になるほど唇を引っ張ったり押し付けたりしないでください。",
    },
    review: reviewed(),
  },
  {
    id: "diction-speak-then-sing",
    domain: "diction",
    evidenceKind: "self_report",
    defaultPriority: 66,
    title: { en: "Speak, then sing", ja: "話してから歌う" },
    instruction: {
      en: "Speak one short lyric naturally, then sing it on one comfortable note. Keep the consonants brief so the vowel carries the pitch.",
      ja: "短い歌詞を自然に話してから、1つの楽な音で歌います。子音は短くし、母音で音程を保ちます。",
    },
    selfCheck: {
      en: "Was the word still clear without squeezing or overworking each consonant?",
      ja: "子音を締め付けたり強く働かせすぎたりせず、言葉を明瞭にできましたか？",
    },
    safetyNote: {
      en: "Nightingale can guide this comparison but does not currently verify tongue placement or live phoneme accuracy.",
      ja: "Nightingaleは比較を案内できますが、現在は舌の位置やリアルタイムの音素精度を確認できません。",
    },
    review: reviewed(),
  },
] as const;

const URGENT_STOP_SIGNALS = new Set<TechniqueStopSignal>(["difficulty_breathing", "chest_pain"]);

export function assessTechniqueSafety(
  reflection: TechniqueReflection,
  consecutiveUnsuccessfulAttempts = 0,
): TechniqueSafetyDecision {
  if (reflection.stopSignals.some((signal) => URGENT_STOP_SIGNALS.has(signal))) {
    return {
      action: "seek_help",
      reason: "urgent_stop_signal",
      mayContinue: false,
      mayAdvance: false,
      message: {
        en: "Stop singing now. If chest pain or difficulty breathing continues, seek urgent medical help.",
        ja: "今すぐ歌うのを止めてください。胸の痛みや呼吸困難が続く場合は、緊急の医療支援を受けてください。",
      },
    };
  }

  if (
    reflection.stopSignals.length > 0 ||
    reflection.comfortAfter === 1 ||
    reflection.effortAfter === 5
  ) {
    return {
      action: "end_session",
      reason: "stop_signal",
      mayContinue: false,
      mayAdvance: false,
      message: {
        en: "Stop this session and rest your voice. Persistent pain, hoarseness, strain, or sudden range loss needs qualified professional advice.",
        ja: "このセッションを終了し、声を休めてください。痛み・かすれ・力み・急な音域低下が続く場合は、専門家に相談してください。",
      },
    };
  }

  if (reflection.comfortAfter === 2 || reflection.effortAfter === 4) {
    return {
      action: "step_down",
      reason: "uncomfortable_or_high_effort",
      mayContinue: true,
      mayAdvance: false,
      message: {
        en: "Stop this attempt and return to an easier or lower task. End the session if comfort does not return.",
        ja: "この試行を止め、より簡単または低い課題へ戻ります。楽さが戻らなければセッションを終了してください。",
      },
    };
  }

  if (consecutiveUnsuccessfulAttempts >= 3) {
    return {
      action: "step_down",
      reason: "repeated_misses",
      mayContinue: true,
      mayAdvance: false,
      message: {
        en: "Step down one level, shorten the pattern, or rest before trying again.",
        ja: "1段階下げる、パターンを短くする、または休んでから再試行してください。",
      },
    };
  }

  if (reflection.comfortAfter === 3 || reflection.effortAfter === 3) {
    return {
      action: "repeat",
      reason: "moderate_effort",
      mayContinue: true,
      mayAdvance: false,
      message: {
        en: "Stay here for one more easy attempt; do not raise the pitch or difficulty yet.",
        ja: "もう1回だけ楽に試し、まだ音程や難易度を上げないでください。",
      },
    };
  }

  if (reflection.successfulOutcome) {
    return {
      action: "advance",
      reason: "comfortable_success",
      mayContinue: true,
      mayAdvance: true,
      message: {
        en: "The result was comfortable and controlled. Advance by one small step if you want.",
        ja: "楽にコントロールできました。希望する場合は、小さく1段階だけ進めます。",
      },
    };
  }

  return {
    action: "repeat",
    reason: "needs_another_easy_attempt",
    mayContinue: true,
    mayAdvance: false,
    message: {
      en: "Repeat at the same easy level before changing the pitch or cue.",
      ja: "音程やヒントを変える前に、同じ楽なレベルでもう一度試します。",
    },
  };
}

export interface RankedCoachingCue {
  cue: CoachingCue;
  score: number;
  attempts: number;
  safetySuppressed: boolean;
}

const HELPFULNESS_ADJUSTMENT: Record<TechniqueHelpfulness, number> = {
  helped: 18,
  no_change: 0,
  made_harder: -24,
  not_sure: -4,
};

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Ranks a caller-provided set of contextually relevant cues. The newest
 * reflection carrying a stop signal suppresses automatic recommendation, but
 * the cue remains in the result so the UI can explain the decision.
 */
export function rankCoachingCues(
  cues: readonly CoachingCue[],
  reflections: readonly TechniqueReflection[],
): RankedCoachingCue[] {
  return cues
    .map((cue) => {
      const attempts = reflections
        .filter((reflection) => reflection.cueId === cue.id)
        .sort((left, right) => left.recordedAt - right.recordedAt)
        .slice(-5);
      const adjustment =
        attempts.length === 0
          ? 0
          : attempts.reduce((total, reflection) => {
              const comfortDelta = (reflection.comfortAfter - reflection.comfortBefore) * 4;
              const effortAdjustment =
                reflection.effortAfter <= 2 ? 3 : reflection.effortAfter >= 4 ? -8 : 0;
              const outcomeAdjustment = reflection.successfulOutcome ? 4 : -2;
              return (
                total +
                HELPFULNESS_ADJUSTMENT[reflection.helpfulness] +
                comfortDelta +
                effortAdjustment +
                outcomeAdjustment
              );
            }, 0) / Math.max(1, attempts.length);
      const latest = attempts[attempts.length - 1];
      const safetySuppressed = (latest?.stopSignals.length ?? 0) > 0;
      const score = safetySuppressed ? 0 : clamp(cue.defaultPriority + adjustment, 0, 100);
      return {
        cue,
        score: Math.round(score * 10) / 10,
        attempts: attempts.length,
        safetySuppressed,
      };
    })
    .sort(
      (left, right) =>
        Number(left.safetySuppressed) - Number(right.safetySuppressed) ||
        right.score - left.score ||
        right.cue.defaultPriority - left.cue.defaultPriority ||
        left.cue.id.localeCompare(right.cue.id),
    );
}

export interface AcousticFeatureSummary {
  /** Stable capture-device id/name from the same calibrated input path. */
  deviceId: string;
  /** Intended sustained vowel; compared after Unicode/case/space normalization. */
  vowel: string;
  medianPitchHz: number;
  levelDb: number;
  spectralCentroidHz: number;
  /** Median count of resolved harmonics contributing to the feature summary. */
  harmonicCount: number;
  /** Extractor confidence from 0..1. */
  confidence: number;
}

export type RelativeBrightnessClassification = "brighter" | "similar" | "darker" | "unmeasurable";

export type RelativeBrightnessUnmeasurableReason =
  | "invalid_features"
  | "device_mismatch"
  | "vowel_mismatch"
  | "pitch_mismatch"
  | "level_mismatch"
  | "insufficient_harmonics"
  | "low_confidence";

export interface RelativeBrightnessResult {
  result: RelativeBrightnessClassification;
  confidence: number;
  reason: RelativeBrightnessUnmeasurableReason | null;
  pitchDifferenceCents: number | null;
  levelDifferenceDb: number | null;
  brightnessDifferencePercent: number | null;
}

export const RELATIVE_BRIGHTNESS_LIMITS = {
  maximumPitchDifferenceCents: 35,
  maximumLevelDifferenceDb: 3,
  minimumHarmonicCount: 5,
  minimumFeatureConfidence: 0.45,
  similarRatio: 1.08,
} as const;

function normalizedVowel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function unmeasurable(
  reason: RelativeBrightnessUnmeasurableReason,
  pitchDifferenceCents: number | null = null,
  levelDifferenceDb: number | null = null,
): RelativeBrightnessResult {
  return {
    result: "unmeasurable",
    confidence: 0,
    reason,
    pitchDifferenceCents,
    levelDifferenceDb,
    brightnessDifferencePercent: null,
  };
}

/**
 * Compares two already-extracted summaries. This is deliberately relative and
 * refuses comparisons that could be explained by a different device, vowel,
 * pitch, level, or insufficient harmonic evidence.
 */
export function compareRelativeBrightness(
  baseline: AcousticFeatureSummary,
  comparison: AcousticFeatureSummary,
): RelativeBrightnessResult {
  const numericValues = [
    baseline.medianPitchHz,
    comparison.medianPitchHz,
    baseline.levelDb,
    comparison.levelDb,
    baseline.spectralCentroidHz,
    comparison.spectralCentroidHz,
    baseline.harmonicCount,
    comparison.harmonicCount,
    baseline.confidence,
    comparison.confidence,
  ];
  if (
    numericValues.some((value) => !Number.isFinite(value)) ||
    baseline.deviceId.trim() === "" ||
    comparison.deviceId.trim() === "" ||
    baseline.medianPitchHz <= 0 ||
    comparison.medianPitchHz <= 0 ||
    baseline.spectralCentroidHz <= 0 ||
    comparison.spectralCentroidHz <= 0 ||
    normalizedVowel(baseline.vowel) === "" ||
    normalizedVowel(comparison.vowel) === ""
  ) {
    return unmeasurable("invalid_features");
  }

  if (baseline.deviceId.trim() !== comparison.deviceId.trim()) {
    return unmeasurable("device_mismatch");
  }
  if (normalizedVowel(baseline.vowel) !== normalizedVowel(comparison.vowel)) {
    return unmeasurable("vowel_mismatch");
  }

  const pitchDifferenceCents = Math.abs(
    1_200 * Math.log2(comparison.medianPitchHz / baseline.medianPitchHz),
  );
  if (pitchDifferenceCents > RELATIVE_BRIGHTNESS_LIMITS.maximumPitchDifferenceCents + 1e-6) {
    return unmeasurable("pitch_mismatch", pitchDifferenceCents);
  }

  const levelDifferenceDb = Math.abs(comparison.levelDb - baseline.levelDb);
  if (levelDifferenceDb > RELATIVE_BRIGHTNESS_LIMITS.maximumLevelDifferenceDb + 1e-6) {
    return unmeasurable("level_mismatch", pitchDifferenceCents, levelDifferenceDb);
  }

  const harmonicCount = Math.min(baseline.harmonicCount, comparison.harmonicCount);
  if (harmonicCount < RELATIVE_BRIGHTNESS_LIMITS.minimumHarmonicCount) {
    return unmeasurable("insufficient_harmonics", pitchDifferenceCents, levelDifferenceDb);
  }

  const featureConfidence = Math.min(baseline.confidence, comparison.confidence);
  if (featureConfidence < RELATIVE_BRIGHTNESS_LIMITS.minimumFeatureConfidence) {
    return unmeasurable("low_confidence", pitchDifferenceCents, levelDifferenceDb);
  }

  const ratio = comparison.spectralCentroidHz / baseline.spectralCentroidHz;
  const similarRatio = RELATIVE_BRIGHTNESS_LIMITS.similarRatio;
  const result: RelativeBrightnessClassification =
    ratio >= similarRatio ? "brighter" : ratio <= 1 / similarRatio ? "darker" : "similar";
  const brightnessDifferencePercent = (ratio - 1) * 100;

  const pitchComparability =
    0.65 +
    0.35 * (1 - pitchDifferenceCents / RELATIVE_BRIGHTNESS_LIMITS.maximumPitchDifferenceCents);
  const levelComparability =
    0.65 + 0.35 * (1 - levelDifferenceDb / RELATIVE_BRIGHTNESS_LIMITS.maximumLevelDifferenceDb);
  const harmonicSupport = clamp(
    harmonicCount / (RELATIVE_BRIGHTNESS_LIMITS.minimumHarmonicCount * 2),
    0.5,
    1,
  );
  const logDifference = Math.abs(Math.log(ratio));
  const logThreshold = Math.log(similarRatio);
  const classificationSeparation =
    result === "similar"
      ? 0.65 + 0.35 * (1 - clamp(logDifference / logThreshold, 0, 1))
      : 0.65 + 0.35 * clamp((logDifference - logThreshold) / logThreshold, 0, 1);
  const confidence = clamp(
    featureConfidence *
      pitchComparability *
      levelComparability *
      harmonicSupport *
      classificationSeparation,
    0,
    1,
  );

  return {
    result,
    confidence: Math.round(confidence * 1_000) / 1_000,
    reason: null,
    pitchDifferenceCents: Math.round(pitchDifferenceCents * 10) / 10,
    levelDifferenceDb: Math.round(levelDifferenceDb * 10) / 10,
    brightnessDifferencePercent: Math.round(brightnessDifferencePercent * 10) / 10,
  };
}
