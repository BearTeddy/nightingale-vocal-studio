import { MIC_RMS_GATE } from "@/lib/pitch/constants";
import { centsSimilarity } from "@/lib/pitch/state";
import type { PitchFrame } from "@/types/PitchFrame";

export interface IntervalChoice {
  semitones: number;
  label: string;
  shortLabel: string;
}

export interface IntervalAnswer {
  expectedSemitones: number;
  selectedSemitones: number;
  correct: boolean;
}

export interface SungPitchAttempt {
  targetMidi: number;
  detectedMidi: number;
  cents: number;
  score: number;
  voicedFrames: number;
  feedback: string;
}

export const INTERVAL_CHOICES: IntervalChoice[] = [
  { semitones: 0, label: "Unison", shortLabel: "Same note" },
  { semitones: 2, label: "Major second", shortLabel: "Major 2nd" },
  { semitones: 3, label: "Minor third", shortLabel: "Minor 3rd" },
  { semitones: 4, label: "Major third", shortLabel: "Major 3rd" },
  { semitones: 5, label: "Perfect fourth", shortLabel: "Perfect 4th" },
  { semitones: 7, label: "Perfect fifth", shortLabel: "Perfect 5th" },
  { semitones: 12, label: "Octave", shortLabel: "Octave" },
];

export function intervalChoice(semitones: number): IntervalChoice {
  return (
    INTERVAL_CHOICES.find((choice) => choice.semitones === semitones) ?? {
      semitones,
      label: `${semitones} semitones`,
      shortLabel: `${semitones} semitones`,
    }
  );
}

export function assessIntervalAnswer(
  expectedSemitones: number,
  selectedSemitones: number,
): IntervalAnswer {
  return {
    expectedSemitones,
    selectedSemitones,
    correct: expectedSemitones === selectedSemitones,
  };
}

export function intervalAccuracy(answers: IntervalAnswer[]): number {
  if (answers.length === 0) return 0;
  return Math.round((answers.filter((answer) => answer.correct).length / answers.length) * 100);
}

export function nextInterval(previousSemitones: number | null, random = Math.random): number {
  const choices = INTERVAL_CHOICES.filter(
    (choice) => INTERVAL_CHOICES.length === 1 || choice.semitones !== previousSemitones,
  );
  const index = Math.min(choices.length - 1, Math.floor(Math.max(0, random()) * choices.length));
  return choices[index].semitones;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function assessSungPitch(
  targetMidi: number,
  frames: PitchFrame[],
): SungPitchAttempt | null {
  const voiced = frames.filter(
    (frame) =>
      frame.voiced &&
      frame.midi != null &&
      Number.isFinite(frame.midi) &&
      frame.rms >= MIC_RMS_GATE &&
      frame.clarity >= 0.4,
  );
  if (voiced.length < 4) return null;

  const detectedMidi = median(voiced.map((frame) => frame.midi as number));
  const cents = Math.round((detectedMidi - targetMidi) * 100);
  const score = Math.round(centsSimilarity(cents) * 100);
  const distance = Math.abs(cents);
  const feedback =
    distance <= 25
      ? "On pitch. Keep that centered placement."
      : distance >= 700
        ? `Wrong octave: sing ${cents < 0 ? "higher" : "lower"}.`
        : `${distance} cents ${cents < 0 ? "low" : "high"}. Sing ${cents < 0 ? "slightly higher" : "slightly lower"}.`;

  return {
    targetMidi,
    detectedMidi,
    cents,
    score,
    voicedFrames: voiced.length,
    feedback,
  };
}
