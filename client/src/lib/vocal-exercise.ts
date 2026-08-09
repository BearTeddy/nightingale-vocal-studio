import { centsSimilarity } from "@/lib/pitch/state";
import type { PitchFrame } from "@/types/PitchFrame";

export interface ExerciseFrame {
  elapsed_sec: number;
  target_midi: number;
  frame: PitchFrame;
}

export interface ExerciseMetric {
  label: string;
  score: number;
}

export interface ExerciseResult {
  overall: number;
  metrics: ExerciseMetric[];
  recommendations: string[];
}

export type ExercisePhase = "listen" | "sing" | "complete";

export interface ExerciseStep {
  index: number | null;
  phase: ExercisePhase;
}

export interface AdaptedExercisePattern {
  baseMidi: number;
  pattern: number[];
}

const CALL_RESPONSE_SETTLE_SECONDS = 0.12;

export function adaptExercisePace(secondsPerNote: number, previousScore: number | null): number {
  const base = Math.max(0.35, secondsPerNote);
  if (previousScore == null || !Number.isFinite(previousScore)) return base;
  if (previousScore < 55) return Math.min(3, Number((base * 1.25).toFixed(2)));
  if (previousScore < 75) return Math.min(3, Number((base * 1.1).toFixed(2)));
  if (previousScore >= 90) return Math.max(0.35, Number((base * 0.9).toFixed(2)));
  return base;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function score(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)));
}

export function adaptExerciseToRange(
  pattern: number[],
  preferredBaseMidi: number,
  lowMidi: number | null,
  highMidi: number | null,
): AdaptedExercisePattern {
  if (
    pattern.length === 0 ||
    lowMidi == null ||
    highMidi == null ||
    !Number.isFinite(lowMidi) ||
    !Number.isFinite(highMidi) ||
    highMidi < lowMidi
  ) {
    return { baseMidi: Math.round(preferredBaseMidi), pattern: [...pattern] };
  }

  let low = Math.ceil(lowMidi);
  let high = Math.floor(highMidi);
  if (high < low) {
    const center = Math.round((lowMidi + highMidi) / 2);
    low = center;
    high = center;
  }
  const originalMin = Math.min(...pattern);
  const originalMax = Math.max(...pattern);
  const availableSpan = Math.max(0, high - low);
  const originalSpan = originalMax - originalMin;
  const adaptedPattern =
    originalSpan <= availableSpan
      ? [...pattern]
      : pattern.map((offset) =>
          Math.round(originalMin + ((offset - originalMin) / originalSpan) * availableSpan),
        );
  const minOffset = Math.min(...adaptedPattern);
  const maxOffset = Math.max(...adaptedPattern);
  const minimumBase = low - minOffset;
  const maximumBase = high - maxOffset;
  const baseMidi = Math.round(Math.max(minimumBase, Math.min(maximumBase, preferredBaseMidi)));

  return { baseMidi, pattern: adaptedPattern };
}

export function exerciseTotalSeconds(
  noteCount: number,
  secondsPerNote: number,
  callAndResponse = false,
): number {
  return Math.max(0, noteCount) * Math.max(0, secondsPerNote) * (callAndResponse ? 2 : 1);
}

export function exerciseStepAt(
  elapsedSeconds: number,
  noteCount: number,
  secondsPerNote: number,
  callAndResponse = false,
): ExerciseStep {
  if (elapsedSeconds < 0) return { index: 0, phase: callAndResponse ? "listen" : "sing" };
  const safeDuration = Math.max(0.05, secondsPerNote);
  const slot = Math.floor(elapsedSeconds / safeDuration);
  const index = callAndResponse ? Math.floor(slot / 2) : slot;
  if (index >= noteCount) return { index: null, phase: "complete" };
  return {
    index,
    phase: callAndResponse && slot % 2 === 0 ? "listen" : "sing",
  };
}

export function exerciseScoringTargetAt(
  elapsedSeconds: number,
  pattern: number[],
  baseMidi: number,
  secondsPerNote: number,
  callAndResponse = false,
): number | null {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || pattern.length === 0) {
    return null;
  }
  const safeDuration = Math.max(0.05, secondsPerNote);
  const step = exerciseStepAt(elapsedSeconds, pattern.length, safeDuration, callAndResponse);
  if (step.phase !== "sing" || step.index == null) return null;

  if (callAndResponse) {
    const responseStartedAt = (step.index * 2 + 1) * safeDuration;
    const settleSeconds = Math.min(CALL_RESPONSE_SETTLE_SECONDS, safeDuration * 0.35);
    if (elapsedSeconds - responseStartedAt < settleSeconds) return null;
  }

  return baseMidi + pattern[step.index];
}

export function analyzeExercise(
  exerciseId: string,
  samples: ExerciseFrame[],
  totalSeconds: number,
): ExerciseResult {
  const voiced = samples.filter(
    ({ frame }) => frame.voiced && frame.midi != null && frame.clarity >= 0.35,
  );
  const cents = voiced.map(
    ({ frame, target_midi }) => ((frame.midi as number) - target_midi) * 100,
  );
  const pitch = score(average(cents.map((offset) => centsSimilarity(offset) * 100)));
  const coverage = score((voiced.length / Math.max(1, samples.length)) * 100);
  const stability = cents.length < 2 ? 0 : score(100 - deviation(cents) * 1.4);

  let metrics: ExerciseMetric[];
  if (exerciseId === "sustain") {
    metrics = [
      { label: "Sustain", score: coverage },
      { label: "Stability", score: stability },
      { label: "Pitch", score: pitch },
    ];
  } else if (exerciseId === "dynamics") {
    const levels = voiced.map(({ frame }) => Math.max(0, frame.rms));
    const maxLevel = Math.max(0.0001, ...levels);
    const envelopeErrors = voiced.map(({ elapsed_sec, frame }) => {
      const progress = Math.max(0, Math.min(1, elapsed_sec / Math.max(0.1, totalSeconds)));
      const expected = 0.3 + 0.7 * (1 - Math.abs(progress * 2 - 1));
      return Math.abs(frame.rms / maxLevel - expected);
    });
    metrics = [
      {
        label: "Dynamic shape",
        score: envelopeErrors.length < 5 ? 0 : score(100 - average(envelopeErrors) * 140),
      },
      { label: "Pitch", score: pitch },
      { label: "Continuity", score: coverage },
    ];
  } else if (exerciseId === "vibrato") {
    const secondHalf = voiced.filter(({ elapsed_sec }) => elapsed_sec >= totalSeconds / 2);
    const secondCents = secondHalf.map(
      ({ frame, target_midi }) => ((frame.midi as number) - target_midi) * 100,
    );
    let crossings = 0;
    const center = average(secondCents);
    for (let index = 1; index < secondCents.length; index += 1) {
      if (Math.sign(secondCents[index - 1] - center) !== Math.sign(secondCents[index] - center)) {
        crossings += 1;
      }
    }
    const vibratoSeconds = Math.max(0.1, totalSeconds / 2);
    const rate = crossings / 2 / vibratoSeconds;
    const rateScore = score(100 - Math.abs(rate - 5.5) * 24);
    const extent = deviation(secondCents);
    const extentScore = score(100 - Math.abs(extent - 28) * 2.2);
    const straightTone = voiced
      .filter(({ elapsed_sec }) => elapsed_sec < totalSeconds / 2)
      .map(({ frame, target_midi }) => ((frame.midi as number) - target_midi) * 100);
    const hasVibratoEvidence = secondCents.length >= 8;
    metrics = [
      {
        label: "Straight tone",
        score: straightTone.length < 5 ? 0 : score(100 - deviation(straightTone) * 1.5),
      },
      { label: "Vibrato rate", score: hasVibratoEvidence ? rateScore : 0 },
      { label: "Vibrato extent", score: hasVibratoEvidence ? extentScore : 0 },
    ];
  } else {
    metrics = [
      { label: "Pitch", score: pitch },
      {
        label: exerciseId === "intervals" ? "Interval landings" : "Note coverage",
        score: coverage,
      },
      { label: "Stability", score: stability },
    ];
  }

  const overall = score(average(metrics.map((metric) => metric.score)));
  const recommendations = metrics
    .filter((metric) => metric.score < 80)
    .sort((left, right) => left.score - right.score)
    .slice(0, 2)
    .map((metric) => {
      if (metric.label === "Pitch" || metric.label === "Interval landings") {
        return "Listen to the reference, breathe, then place the note without sliding into it.";
      }
      if (metric.label === "Sustain" || metric.label === "Continuity") {
        return "Use a softer volume and keep the vowel connected through the full target.";
      }
      if (metric.label.startsWith("Vibrato")) {
        return "Keep the first half straight, then add a small even oscillation without widening it.";
      }
      if (metric.label === "Dynamic shape") {
        return "Grow and release the volume gradually while keeping the pitch centered.";
      }
      return "Repeat at an easier volume and keep the airflow steady.";
    });

  return { overall, metrics, recommendations };
}
