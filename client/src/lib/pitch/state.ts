import {
  PITCH_BUFFER_SIZE,
  PITCH_DISCONTINUITY_SEC,
  PITCH_FULL_CREDIT_CENTS,
  PITCH_ZERO_CREDIT_CENTS,
  PITCH_WINDOW_SAMPLES,
  PUSH_INTERVAL_SEC,
} from "./constants";
import { createPitchDetector, detectPitchFromSamplesRef } from "./detect";
import type { MelodyMap } from "@/types/MelodyMap";
import type { PerformanceScore, CategoryScore } from "@/types/PerformanceScore";
import type { PitchFrame } from "@/types/PitchFrame";
import type { TargetNote } from "@/types/TargetNote";

export interface PitchSeries {
  refPitches: (number | null)[];
  userPitches: (number | null)[];
  similarities: number[];
  timestamps: number[];
  frames?: (PitchFrame | null)[];
  discontinuities?: boolean[];
}

export function isPitchTimeDiscontinuity(previous: number, current: number): boolean {
  return current < previous - 0.001 || current - previous > PITCH_DISCONTINUITY_SEC;
}

function appendPitchSeriesValue(
  series: PitchSeries,
  refPitch: number | null,
  userPitch: number | null,
  similarity: number,
  time: number,
  frame: PitchFrame | null,
  discontinuity = false,
): void {
  series.refPitches.push(refPitch);
  series.userPitches.push(userPitch);
  series.similarities.push(similarity);
  series.timestamps.push(time);
  series.frames?.push(frame ? { ...frame } : null);
  series.discontinuities?.push(discontinuity);
}

export function pushPitchSeriesFrame(
  series: PitchSeries,
  lastPushRef: { current: number },
  refPitch: number | null,
  userPitch: number | null,
  similarity: number,
  time: number,
  frame: PitchFrame | null,
  minimumIntervalSec = 0.05,
): void {
  series.discontinuities ??= Array.from({ length: series.timestamps.length }, () => false);
  const previousTime = series.timestamps[series.timestamps.length - 1];
  const discontinuity = previousTime != null && isPitchTimeDiscontinuity(previousTime, time);
  if (discontinuity) {
    appendPitchSeriesValue(series, null, null, 0, time, null, true);
  }
  const previousFrame = series.frames?.[series.frames.length - 1] ?? null;
  if (!discontinuity && frame != null && previousFrame?.sample_index === frame.sample_index) {
    return;
  }
  if (!discontinuity && previousTime != null && time - lastPushRef.current < minimumIntervalSec)
    return;
  lastPushRef.current = time;
  appendPitchSeriesValue(series, refPitch, userPitch, similarity, time, frame);
}

export function freqToSemitone(hz: number): number {
  return 12 * Math.log2(hz / 440) + 69;
}

export function pitchSimilarity(refHz: number, userHz: number): number {
  return centsSimilarity((freqToSemitone(userHz) - freqToSemitone(refHz)) * 100);
}

export function centsSimilarity(centsOffset: number): number {
  const distance = Math.abs(centsOffset);
  if (distance <= PITCH_FULL_CREDIT_CENTS) return 1;
  if (distance >= PITCH_ZERO_CREDIT_CENTS) return 0;
  return (
    1 - (distance - PITCH_FULL_CREDIT_CENTS) / (PITCH_ZERO_CREDIT_CENTS - PITCH_FULL_CREDIT_CENTS)
  );
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const VISUAL_PITCH_DROPOUT_FRAMES = 5;
const VISUAL_LARGE_JUMP_SEMITONES = 4;
const VISUAL_JUMP_MATCH_SEMITONES = 1.5;
const VISUAL_JUMP_CONFIRMATION_FRAMES = 3;

/**
 * A causal, display-only pitch tracker. Accepted PitchFrame values still feed
 * scoring and saved takes; this adds extra visual damping for easier steering.
 */
export class VisualPitchTracker {
  private readonly midiHistory: number[] = [];
  private displayedMidi: number | null = null;
  private missingFrames = 0;
  private pendingJumpMidi: number | null = null;
  private pendingJumpFrames = 0;

  update(userPitchHz: number | null): number | null {
    if (userPitchHz == null || !Number.isFinite(userPitchHz) || userPitchHz <= 0) {
      this.missingFrames += 1;
      if (this.missingFrames <= VISUAL_PITCH_DROPOUT_FRAMES) return this.currentHz();
      this.displayedMidi = null;
      this.midiHistory.length = 0;
      this.clearPendingJump();
      return null;
    }

    const missingFrames = this.missingFrames;
    this.missingFrames = 0;
    const currentMidi = freqToSemitone(userPitchHz);

    if (
      this.displayedMidi != null &&
      Math.abs(currentMidi - this.displayedMidi) >= VISUAL_LARGE_JUMP_SEMITONES
    ) {
      // Native tracking emits two gaps before confirming a real large leap.
      // Snap to that confirmed pitch instead of adding another visual delay.
      if (missingFrames >= 2) {
        this.displayedMidi = currentMidi;
        this.midiHistory.splice(0, this.midiHistory.length, currentMidi);
        this.clearPendingJump();
        return this.currentHz();
      }

      if (
        this.pendingJumpMidi != null &&
        Math.abs(currentMidi - this.pendingJumpMidi) <= VISUAL_JUMP_MATCH_SEMITONES
      ) {
        this.pendingJumpFrames += 1;
        this.pendingJumpMidi +=
          (currentMidi - this.pendingJumpMidi) / this.pendingJumpFrames;
      } else {
        this.pendingJumpMidi = currentMidi;
        this.pendingJumpFrames = 1;
      }

      if (this.pendingJumpFrames < VISUAL_JUMP_CONFIRMATION_FRAMES) return this.currentHz();

      this.displayedMidi = this.pendingJumpMidi;
      this.midiHistory.splice(0, this.midiHistory.length, this.displayedMidi);
      this.clearPendingJump();
      return this.currentHz();
    }

    this.clearPendingJump();
    this.midiHistory.push(currentMidi);
    if (this.midiHistory.length > 3) this.midiHistory.shift();

    const candidate = median(this.midiHistory);

    if (this.displayedMidi == null) {
      this.displayedMidi = candidate;
    } else {
      const distance = Math.abs(candidate - this.displayedMidi);
      if (distance > 0.03) {
        const retained = distance <= 0.35 ? 0.82 : distance <= 1.5 ? 0.68 : 0.5;
        this.displayedMidi = this.displayedMidi * retained + candidate * (1 - retained);
      }
    }
    return this.currentHz();
  }

  currentHz(): number | null {
    return this.displayedMidi == null ? null : midiToFreq(this.displayedMidi);
  }

  reset(): void {
    this.midiHistory.length = 0;
    this.displayedMidi = null;
    this.missingFrames = 0;
    this.clearPendingJump();
  }

  private clearPendingJump(): void {
    this.pendingJumpMidi = null;
    this.pendingJumpFrames = 0;
  }
}

export function displayedCentsOffset(
  referencePitchHz: number | null,
  userPitchHz: number | null,
): number | null {
  if (
    referencePitchHz == null ||
    userPitchHz == null ||
    referencePitchHz <= 0 ||
    userPitchHz <= 0
  ) {
    return null;
  }
  return Math.round((freqToSemitone(userPitchHz) - freqToSemitone(referencePitchHz)) * 100);
}

export class PitchStateBuffer {
  refPitches: (number | null)[] = [];
  userPitches: (number | null)[] = [];
  similarities: number[] = [];
  timestamps: number[] = [];
  private smoothedRef: number | null = null;
  private smoothedUser: number | null = null;
  private readonly visualUser = new VisualPitchTracker();
  private lastSampleIndex: number | null = null;
  private lastPushTime = 0;

  private append(
    refPitch: number | null,
    userPitch: number | null,
    similarity: number,
    time: number,
  ): void {
    while (this.refPitches.length >= PITCH_BUFFER_SIZE) {
      this.refPitches.shift();
      this.userPitches.shift();
      this.similarities.shift();
      this.timestamps.shift();
    }
    this.refPitches.push(refPitch);
    this.userPitches.push(userPitch);
    this.similarities.push(similarity);
    this.timestamps.push(time);
  }

  tryPush(
    refPitch: number | null,
    userPitch: number | null,
    similarity: number,
    time: number,
    sampleIndex?: number,
  ): void {
    const previousTime = this.timestamps[this.timestamps.length - 1];
    const discontinuity = previousTime != null && isPitchTimeDiscontinuity(previousTime, time);
    if (discontinuity) {
      this.append(null, null, 0, time);
      this.smoothedRef = null;
      this.smoothedUser = null;
      this.visualUser.reset();
      this.lastSampleIndex = null;
    }

    this.smoothedRef = refPitch;
    if (sampleIndex == null || sampleIndex !== this.lastSampleIndex) {
      this.smoothedUser = this.visualUser.update(userPitch);
      this.lastSampleIndex = sampleIndex ?? null;
    }

    if (!discontinuity && previousTime != null && time - this.lastPushTime < PUSH_INTERVAL_SEC) {
      return;
    }
    this.lastPushTime = time;
    const displaySimilarity =
      this.smoothedRef != null && this.smoothedUser != null
        ? pitchSimilarity(this.smoothedRef, this.smoothedUser)
        : similarity;
    this.append(this.smoothedRef, this.smoothedUser, displaySimilarity, time);
  }

  snapshot(): PitchSeries {
    return {
      refPitches: [...this.refPitches],
      userPitches: [...this.userPitches],
      similarities: [...this.similarities],
      timestamps: [...this.timestamps],
    };
  }

  reset(): void {
    this.refPitches = [];
    this.userPitches = [];
    this.similarities = [];
    this.timestamps = [];
    this.smoothedRef = null;
    this.smoothedUser = null;
    this.visualUser.reset();
    this.lastSampleIndex = null;
    this.lastPushTime = 0;
  }
}

interface NoteStats {
  note: TargetNote;
  samples: number;
  voiced: number;
  similaritySum: number;
  firstVoicedAt: number | null;
  cents: number[];
  dynamics: DynamicsSample[];
  technique: TechniqueSample[];
}

export interface DynamicsSample {
  userRms: number;
  referenceRms: number;
}

export interface TechniqueSample {
  time: number;
  userMidi: number;
  referenceMidi: number;
}

const CATEGORY_WEIGHTS: Record<CategoryScore["key"], number> = {
  pitch: 45,
  timing: 20,
  stability: 15,
  sustain: 10,
  dynamics: 5,
  technique: 5,
};

const CATEGORY_LABELS: Record<CategoryScore["key"], string> = {
  pitch: "Pitch",
  timing: "Timing",
  stability: "Stability",
  sustain: "Sustain",
  dynamics: "Dynamics",
  technique: "Technique",
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function quantile(values: readonly number[], amount: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * amount)));
  return sorted[index];
}

function correlation(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = average([...left]);
  const rightMean = average([...right]);
  let covariance = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftCentered = left[index] - leftMean;
    const rightCentered = right[index] - rightMean;
    covariance += leftCentered * rightCentered;
    leftEnergy += leftCentered * leftCentered;
    rightEnergy += rightCentered * rightCentered;
  }
  const denominator = Math.sqrt(leftEnergy * rightEnergy);
  return denominator <= 0.000001 ? 0 : covariance / denominator;
}

function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(0.000001, rms));
}

export function scoreDynamics(samples: readonly DynamicsSample[]): number | null {
  const eligible = samples.filter(
    ({ userRms, referenceRms }) =>
      Number.isFinite(userRms) &&
      Number.isFinite(referenceRms) &&
      userRms > 0.0001 &&
      referenceRms > 0.0001,
  );
  if (eligible.length < 20) return null;

  const userDb = eligible.map(({ userRms }) => rmsToDb(userRms));
  const referenceDb = eligible.map(({ referenceRms }) => rmsToDb(referenceRms));
  const referenceSpread = quantile(referenceDb, 0.9) - quantile(referenceDb, 0.1);
  if (referenceSpread < 2.5) return null;

  const userSpread = quantile(userDb, 0.9) - quantile(userDb, 0.1);
  const envelopeCorrelation = correlation(userDb, referenceDb);
  const correlationScore = clampScore(((envelopeCorrelation + 0.15) / 1.05) * 100);
  const rangeScore = clampScore(100 - Math.abs(userSpread - referenceSpread) * 12.5);
  return clampScore(correlationScore * 0.8 + rangeScore * 0.2);
}

function maxLagCorrelation(
  left: readonly number[],
  right: readonly number[],
  maxLag: number,
): number {
  let best = -1;
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    const leftStart = Math.max(0, -lag);
    const rightStart = Math.max(0, lag);
    const count = Math.min(left.length - leftStart, right.length - rightStart);
    if (count < 4) continue;
    best = Math.max(
      best,
      correlation(
        left.slice(leftStart, leftStart + count),
        right.slice(rightStart, rightStart + count),
      ),
    );
  }
  return best;
}

function scoreTechniquePhrase(
  samples: readonly TechniqueSample[],
): { score: number; sampleCount: number } | null {
  const eligible = samples.filter(
    ({ time, userMidi, referenceMidi }) =>
      Number.isFinite(time) && Number.isFinite(userMidi) && Number.isFinite(referenceMidi),
  );
  if (eligible.length < 8) return null;

  const userCents = eligible.map(({ userMidi }) => userMidi * 100);
  const referenceCents = eligible.map(({ referenceMidi }) => referenceMidi * 100);
  const referenceSpread = quantile(referenceCents, 0.9) - quantile(referenceCents, 0.1);
  if (referenceSpread < 35) return null;

  const userSpread = quantile(userCents, 0.9) - quantile(userCents, 0.1);
  const sampleIntervals = eligible
    .slice(1)
    .map((sample, index) => sample.time - eligible[index].time)
    .filter((interval) => interval > 0.001 && interval < 0.2);
  const typicalInterval = quantile(sampleIntervals, 0.5) || 0.05;
  const maxLag = Math.min(
    8,
    Math.max(0, Math.floor(eligible.length / 4)),
    Math.max(1, Math.round(0.1 / typicalInterval)),
  );
  const contourCorrelation = maxLagCorrelation(userCents, referenceCents, maxLag);
  const correlationScore = clampScore(Math.max(0, contourCorrelation) * 100);
  const rangeScore = clampScore(
    100 - (Math.abs(userSpread - referenceSpread) / Math.max(35, referenceSpread)) * 100,
  );

  return {
    score: clampScore(correlationScore * 0.8 + rangeScore * 0.2),
    sampleCount: eligible.length,
  };
}

export function scoreTechnique(phrases: readonly (readonly TechniqueSample[])[]): number | null {
  const scored = phrases
    .map(scoreTechniquePhrase)
    .filter((result): result is NonNullable<typeof result> => result != null);
  const sampleCount = scored.reduce((sum, result) => sum + result.sampleCount, 0);
  if (sampleCount < 20) return null;
  return clampScore(
    scored.reduce((sum, result) => sum + result.score * result.sampleCount, 0) / sampleCount,
  );
}

export function sampleAudioBufferRms(
  buffer: AudioBuffer | null,
  timeSec: number,
  windowSeconds = 0.04,
): number | null {
  if (!buffer || buffer.numberOfChannels <= 0 || buffer.sampleRate <= 0) return null;
  const channelLength = buffer.getChannelData(0).length;
  if (channelLength === 0) return null;
  const center = Math.floor(Math.max(0, timeSec) * buffer.sampleRate);
  const radius = Math.max(1, Math.floor((Math.max(0.002, windowSeconds) * buffer.sampleRate) / 2));
  const start = Math.max(0, Math.min(channelLength, center - radius));
  const end = Math.max(start, Math.min(channelLength, center + radius));
  if (end <= start) return null;

  let energy = 0;
  let count = 0;
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    const channelEnd = Math.min(end, channel.length);
    for (let index = start; index < channelEnd; index += 1) {
      energy += channel[index] * channel[index];
      count += 1;
    }
  }
  return count === 0 ? null : Math.sqrt(energy / count);
}

function clampScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function findTargetNoteAt(notes: readonly TargetNote[], time: number): TargetNote | null {
  let low = 0;
  let high = notes.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const note = notes[middle];
    if (time < note.start) high = middle - 1;
    else if (time > note.end) low = middle + 1;
    else return note;
  }
  return null;
}

export class MelodyPerformanceScoring {
  private readonly notes: TargetNote[];
  private readonly stats = new Map<string, NoteStats>();
  private currentStreak = 0;
  private finalizedThrough = 0;
  private latestCents: number | null = null;
  private lastTime: number | null = null;

  constructor(melody: MelodyMap) {
    this.notes = melody.notes.filter((note) => note.eligible).sort((a, b) => a.start - b.start);
    for (const note of this.notes) {
      this.stats.set(note.id, {
        note,
        samples: 0,
        voiced: 0,
        similaritySum: 0,
        firstVoicedAt: null,
        cents: [],
        dynamics: [],
        technique: [],
      });
    }
  }

  accumulate(time: number, frame: PitchFrame | null): void {
    if (this.lastTime != null && time < this.lastTime - 0.001) {
      this.currentStreak = 0;
      this.latestCents = null;
      this.finalizedThrough = this.firstUnfinishedNoteAt(time);
    }
    this.lastTime = time;
    this.finalizePassedNotes(time);
    const note = findTargetNoteAt(this.notes, time);
    if (!note) {
      this.latestCents = null;
      return;
    }
    const stats = this.stats.get(note.id);
    if (!stats) return;
    stats.samples += 1;
    if (frame?.voiced && frame.midi != null) {
      const cents = (frame.midi - (note.midi + note.cents / 100)) * 100;
      stats.voiced += 1;
      stats.similaritySum += centsSimilarity(cents);
      stats.firstVoicedAt ??= time;
      stats.cents.push(cents);
      if (frame.rms > 0 && frame.reference_rms != null && frame.reference_rms > 0) {
        stats.dynamics.push({ userRms: frame.rms, referenceRms: frame.reference_rms });
      }
      if (frame.reference_midi != null && Number.isFinite(frame.reference_midi)) {
        stats.technique.push({
          time,
          userMidi: frame.midi,
          referenceMidi: frame.reference_midi,
        });
      }
      this.latestCents = cents;
    } else {
      this.latestCents = null;
    }
  }

  private firstUnfinishedNoteAt(time: number): number {
    let low = 0;
    let high = this.notes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.notes[middle].end < time) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private finalizePassedNotes(time: number): void {
    while (
      this.finalizedThrough < this.notes.length &&
      this.notes[this.finalizedThrough].end < time
    ) {
      const stats = this.stats.get(this.notes[this.finalizedThrough].id);
      const hit = stats != null && stats.samples > 0 && stats.similaritySum / stats.samples >= 0.75;
      this.currentStreak = hit ? this.currentStreak + 1 : 0;
      this.finalizedThrough += 1;
    }
  }

  snapshot(): PerformanceScore {
    const attempted = [...this.stats.values()].filter((stats) => stats.samples > 0);
    const voiced = attempted.filter((stats) => stats.voiced > 0);
    const longNotes = attempted.filter((stats) => stats.note.end - stats.note.start >= 0.7);
    const stableNotes = voiced.filter((stats) => stats.cents.length >= 4);
    const dynamics = scoreDynamics(attempted.flatMap((stats) => stats.dynamics));
    const technique = scoreTechnique(attempted.map((stats) => stats.technique));

    const pitch =
      average(attempted.map((stats) => stats.similaritySum / Math.max(1, stats.samples))) * 100;
    const timing = average(
      attempted.map((stats) => {
        if (stats.firstVoicedAt == null) return 0;
        return Math.max(0, 100 - Math.abs(stats.firstVoicedAt - stats.note.start) * 250);
      }),
    );
    const stability = average(
      stableNotes.map((stats) => Math.max(0, 100 - deviation(stats.cents))),
    );
    const sustain = average(
      longNotes.map((stats) => (stats.voiced / Math.max(1, stats.samples)) * 100),
    );

    const categories: CategoryScore[] = [
      {
        key: "pitch",
        label: CATEGORY_LABELS.pitch,
        score: clampScore(pitch),
        available: attempted.length > 0,
      },
      {
        key: "timing",
        label: CATEGORY_LABELS.timing,
        score: clampScore(timing),
        available: attempted.length > 0,
      },
      {
        key: "stability",
        label: CATEGORY_LABELS.stability,
        score: clampScore(stability),
        available: stableNotes.length > 0,
      },
      {
        key: "sustain",
        label: CATEGORY_LABELS.sustain,
        score: clampScore(sustain),
        available: longNotes.length > 0,
      },
      {
        key: "dynamics",
        label: CATEGORY_LABELS.dynamics,
        score: dynamics ?? 0,
        available: dynamics != null,
      },
      {
        key: "technique",
        label: CATEGORY_LABELS.technique,
        score: technique ?? 0,
        available: technique != null,
      },
    ];
    const available = categories.filter((category) => category.available);
    const totalWeight = available.reduce(
      (sum, category) => sum + CATEGORY_WEIGHTS[category.key],
      0,
    );
    const overall =
      totalWeight === 0
        ? 0
        : available.reduce(
            (sum, category) => sum + category.score * CATEGORY_WEIGHTS[category.key],
            0,
          ) / totalWeight;
    const coaching = available
      .filter((category) => category.score < 85)
      .sort((left, right) => left.score - right.score)
      .slice(0, 3)
      .map((category) => coachingFor(category.key));
    const phrases = attempted.map((stats) => ({
      note_id: stats.note.id,
      start: stats.note.start,
      end: stats.note.end,
      accuracy: clampScore((stats.similaritySum / Math.max(1, stats.samples)) * 100),
    }));

    return {
      overall: clampScore(overall),
      legacy_score: clampScore(overall) * 10,
      phrase_accuracy: clampScore(pitch),
      streak: this.currentStreak,
      cents_offset: this.latestCents == null ? null : Math.round(this.latestCents),
      categories,
      phrases,
      coaching,
    };
  }
}

export function scorePitchSeries(
  melody: MelodyMap,
  series: PitchSeries,
  latencyCompensationSec = 0,
): PerformanceScore {
  const scoring = new MelodyPerformanceScoring(melody);
  for (let index = 0; index < series.timestamps.length; index += 1) {
    if (series.discontinuities?.[index]) continue;
    const time = Math.max(0, (series.timestamps[index] ?? 0) - latencyCompensationSec);
    let frame: PitchFrame | null;
    if (series.frames) {
      frame = series.frames[index] ?? null;
    } else {
      const hz = series.userPitches[index] ?? null;
      frame =
        hz == null
          ? null
          : {
              hz,
              midi: freqToSemitone(hz),
              clarity: 1,
              rms: 0.1,
              peak: 0.2,
              voiced: true,
              sample_index: Math.round(time * 48_000),
              sample_rate: 48_000,
              captured_at_ms: time * 1000,
            };
    }
    scoring.accumulate(time, frame);
  }
  return scoring.snapshot();
}

function coachingFor(key: CategoryScore["key"]): string {
  switch (key) {
    case "pitch":
      return "Slow the phrase down and center each note before adding expression.";
    case "timing":
      return "Breathe early and place the first consonant just before the target begins.";
    case "stability":
      return "Use steadier airflow and hold the vowel without chasing the pitch line.";
    case "sustain":
      return "Practice the long notes softly first, keeping the airflow even to the end.";
    case "dynamics":
      return "Shape phrases with controlled volume changes instead of sudden level jumps.";
    case "technique":
      return "Keep sustained notes straight before introducing deliberate vibrato or slides.";
  }
}

export class PitchScoring {
  totalSingable: number;
  earned = 0;
  lastTime = 0;

  constructor(totalSingable: number) {
    this.totalSingable = Math.max(0.5, totalSingable);
  }

  accumulate(
    currentTime: number,
    refPitch: number | null,
    userPitch: number | null,
    similarity: number,
  ): void {
    const dt = Math.min(0.1, Math.max(0, currentTime - this.lastTime));
    this.lastTime = currentTime;
    if (refPitch != null && userPitch != null) {
      this.earned += similarity * dt;
    }
  }

  score(): number {
    return Math.round(Math.min(1000, Math.max(0, (this.earned / this.totalSingable) * 1000)));
  }
}

export function computeSingableTime(vocals: AudioBuffer): number {
  const sr = vocals.sampleRate;
  const ch = vocals.numberOfChannels > 0 ? vocals.getChannelData(0) : null;
  if (!ch) return 0;

  const hop = PITCH_WINDOW_SAMPLES / 2;
  const hopSec = hop / sr;
  const detector = createPitchDetector();
  const window = new Float32Array(PITCH_WINDOW_SAMPLES);
  let total = 0;
  let offset = 0;

  while (offset + PITCH_WINDOW_SAMPLES <= ch.length) {
    window.set(ch.subarray(offset, offset + PITCH_WINDOW_SAMPLES));
    if (detectPitchFromSamplesRef(detector, window, sr) != null) {
      total += hopSec;
    }
    offset += hop;
  }

  return total;
}

export function sampleVocalsWindow(
  vocals: AudioBuffer | null,
  timeSec: number,
  out: Float32Array,
  latencyCompensationSec: number,
): boolean {
  if (!vocals || out.length !== PITCH_WINDOW_SAMPLES) {
    return false;
  }
  const sr = vocals.sampleRate;
  const start = Math.floor(Math.max(0, timeSec - latencyCompensationSec) * sr);
  const ch = vocals.numberOfChannels > 0 ? vocals.getChannelData(0) : null;
  if (!ch || start + out.length > ch.length) {
    return false;
  }
  out.set(ch.subarray(start, start + out.length));
  return true;
}
