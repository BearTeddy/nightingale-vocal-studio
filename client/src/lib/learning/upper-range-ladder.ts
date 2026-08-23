import {
  assessTechniqueSafety,
  type TechniqueReflection,
  type TechniqueSafetyDecision,
} from "./technique-coaching";

export const UPPER_RANGE_LADDER_CUE_ID = "higher-semitone-ladder";

export interface UpperRangeBounds {
  comfortableLowMidi: number | null;
  comfortableHighMidi: number | null;
}

export interface NormalizedUpperRangeBounds {
  lowMidi: number;
  highMidi: number;
}

export const UPPER_RANGE_EVIDENCE_LIMITS = {
  minimumVoicedSamples: 12,
  maximumMedianErrorCents: 45,
  minimumInTuneRatio: 0.65,
  maximumCentralSpreadCents: 80,
} as const;

export type UpperRangeEvidenceReason =
  | "matched"
  | "not_enough_voiced_samples"
  | "off_target"
  | "unstable";

export interface UpperRangePitchEvidence {
  targetMidi: number;
  voicedSampleCount: number;
  medianMidi: number | null;
  medianErrorCents: number | null;
  centralSpreadCents: number | null;
  inTuneRatio: number;
  matched: boolean;
  reason: UpperRangeEvidenceReason;
}

export type UpperRangeLadderAction = "advance" | "repeat" | "step_down" | "stop" | "complete";

export interface UpperRangeStepDecision {
  action: UpperRangeLadderAction;
  nextMidi: number;
  reflection: TechniqueReflection;
  safety: TechniqueSafetyDecision;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function quantile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const position = clamp(fraction, 0, 1) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function hzToMidi(hz: number): number | null {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const midi = 69 + 12 * Math.log2(hz / 440);
  return Number.isFinite(midi) && midi >= 0 && midi <= 127 ? midi : null;
}

export function midiNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${noteNames[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

/**
 * Converts a measured comfortable range into whole-semitone practice targets.
 * Reversed, non-finite, or out-of-MIDI bounds are rejected instead of widened.
 */
export function normalizeUpperRangeBounds(
  bounds: UpperRangeBounds,
): NormalizedUpperRangeBounds | null {
  const { comfortableLowMidi, comfortableHighMidi } = bounds;
  if (
    comfortableLowMidi == null ||
    comfortableHighMidi == null ||
    !Number.isFinite(comfortableLowMidi) ||
    !Number.isFinite(comfortableHighMidi) ||
    comfortableLowMidi < 0 ||
    comfortableHighMidi > 127 ||
    comfortableLowMidi > comfortableHighMidi
  ) {
    return null;
  }

  const lowMidi = Math.ceil(comfortableLowMidi);
  const highMidi = Math.floor(comfortableHighMidi);
  return lowMidi <= highMidi ? { lowMidi, highMidi } : null;
}

export function clampUpperRangeStart(
  startMidi: number,
  bounds: NormalizedUpperRangeBounds,
): number {
  const finiteStart = Number.isFinite(startMidi) ? Math.round(startMidi) : bounds.lowMidi;
  return clamp(finiteStart, bounds.lowMidi, bounds.highMidi);
}

/**
 * Scores only observable pitch evidence. Comfort and effort are deliberately
 * absent here and must be supplied separately before a ladder decision.
 */
export function assessUpperRangePitchEvidence(
  targetMidi: number,
  pitchHzSamples: readonly number[],
): UpperRangePitchEvidence {
  const midiSamples = pitchHzSamples
    .map(hzToMidi)
    .filter((midi): midi is number => midi != null)
    .sort((left, right) => left - right);
  const voicedSampleCount = midiSamples.length;

  if (voicedSampleCount < UPPER_RANGE_EVIDENCE_LIMITS.minimumVoicedSamples) {
    return {
      targetMidi,
      voicedSampleCount,
      medianMidi: null,
      medianErrorCents: null,
      centralSpreadCents: null,
      inTuneRatio: 0,
      matched: false,
      reason: "not_enough_voiced_samples",
    };
  }

  const medianMidi = quantile(midiSamples, 0.5);
  const medianErrorCents = (medianMidi - targetMidi) * 100;
  const centralSpreadCents = (quantile(midiSamples, 0.8) - quantile(midiSamples, 0.2)) * 100;
  const inTuneRatio =
    midiSamples.filter(
      (midi) =>
        Math.abs((midi - targetMidi) * 100) <= UPPER_RANGE_EVIDENCE_LIMITS.maximumMedianErrorCents,
    ).length / voicedSampleCount;

  const centered =
    Math.abs(medianErrorCents) <= UPPER_RANGE_EVIDENCE_LIMITS.maximumMedianErrorCents &&
    inTuneRatio >= UPPER_RANGE_EVIDENCE_LIMITS.minimumInTuneRatio;
  const stable = centralSpreadCents <= UPPER_RANGE_EVIDENCE_LIMITS.maximumCentralSpreadCents;
  const matched = centered && stable;

  return {
    targetMidi,
    voicedSampleCount,
    medianMidi,
    medianErrorCents,
    centralSpreadCents,
    inTuneRatio,
    matched,
    reason: matched ? "matched" : centered ? "unstable" : "off_target",
  };
}

export function countConsecutiveUnsuccessfulLadderReflections(
  reflections: readonly TechniqueReflection[],
): number {
  let count = 0;
  for (let index = reflections.length - 1; index >= 0; index -= 1) {
    const reflection = reflections[index];
    if (reflection.cueId !== UPPER_RANGE_LADDER_CUE_ID) continue;
    if (reflection.successfulOutcome || reflection.stopSignals.length > 0) break;
    count += 1;
  }
  return count;
}

/**
 * Combines measured pitch with the singer's explicit reflection. The next
 * target is either unchanged, one semitone lower, or one semitone higher;
 * it can never move outside the passed comfortable bounds.
 */
export function decideUpperRangeStep(input: {
  targetMidi: number;
  bounds: NormalizedUpperRangeBounds;
  evidence: UpperRangePitchEvidence;
  reflection: TechniqueReflection;
  consecutiveUnsuccessfulAttempts: number;
}): UpperRangeStepDecision {
  const targetMidi = clamp(
    Math.round(input.targetMidi),
    input.bounds.lowMidi,
    input.bounds.highMidi,
  );
  const comfortableSuccess =
    input.evidence.matched &&
    input.reflection.comfortAfter >= 4 &&
    input.reflection.effortAfter <= 2 &&
    input.reflection.stopSignals.length === 0;
  const reflection = {
    ...input.reflection,
    successfulOutcome: comfortableSuccess,
  };
  const safety = assessTechniqueSafety(reflection, input.consecutiveUnsuccessfulAttempts);

  if (!safety.mayContinue) {
    return { action: "stop", nextMidi: targetMidi, reflection, safety };
  }
  if (safety.action === "step_down") {
    return {
      action: "step_down",
      nextMidi: Math.max(input.bounds.lowMidi, targetMidi - 1),
      reflection,
      safety,
    };
  }
  if (safety.mayAdvance && input.evidence.matched) {
    if (targetMidi >= input.bounds.highMidi) {
      return { action: "complete", nextMidi: targetMidi, reflection, safety };
    }
    return { action: "advance", nextMidi: targetMidi + 1, reflection, safety };
  }
  return { action: "repeat", nextMidi: targetMidi, reflection, safety };
}
