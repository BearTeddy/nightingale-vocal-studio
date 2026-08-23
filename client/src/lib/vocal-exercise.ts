import { centsSimilarity } from "@/lib/pitch/state";
import type { PitchFrame } from "@/types/PitchFrame";

export interface ExerciseFrame {
  elapsed_sec: number;
  target_midi: number;
  frame: PitchFrame;
  /** Optional timing metadata. Legacy pitch exercises do not need to provide it. */
  target_active?: boolean;
  target_event_id?: string;
  target_start_sec?: number;
  target_end_sec?: number;
}

export interface ExerciseMetric {
  label: string;
  score: number;
}

export interface ExerciseResult {
  overall: number;
  metrics: ExerciseMetric[];
  recommendations: string[];
  observations: string[];
  measurable: boolean;
  measurementMessage: string | null;
}

export type ExercisePhase = "listen" | "sing" | "complete";

export interface ExerciseStep {
  index: number | null;
  phase: ExercisePhase;
}

export interface AdaptedExercisePattern {
  baseMidi: number;
  pattern: number[];
  rangeLimited: boolean;
}

export interface RhythmTargetEvent {
  readonly id: string;
  readonly start_sec: number;
  readonly end_sec: number;
  readonly target_midi: number;
}

export interface RhythmExerciseDefinition {
  readonly id: "rhythm-onset";
  readonly title: string;
  readonly instruction: string;
  readonly bpm: number;
  readonly totalSeconds: number;
  readonly events: readonly RhythmTargetEvent[];
}

export interface RhythmEventEvidence {
  readonly eventId: string;
  readonly targetStartSec: number;
  readonly targetEndSec: number;
  readonly observedOnsetSec: number | null;
  readonly observedReleaseSec: number | null;
  readonly onsetOffsetMs: number | null;
  readonly releaseOffsetMs: number | null;
}

export interface RhythmTimingAnalysis {
  readonly events: readonly RhythmEventEvidence[];
  readonly onsetScore: number | null;
  readonly releaseScore: number | null;
  readonly measurableOnsets: number;
  readonly measurableReleases: number;
}

const CALL_RESPONSE_SETTLE_SECONDS = 0.12;
const RHYTHM_OBSERVATION_MARGIN_SECONDS = 0.35;
const RHYTHM_STABLE_STATE_GAP_SECONDS = 0.12;
const MIN_MEASURABLE_RHYTHM_EVENTS = 2;

export function createRhythmOnsetExercise(
  targetMidi: number,
  beatsPerMinute = 80,
): RhythmExerciseDefinition {
  const bpm = Math.max(50, Math.min(140, Number.isFinite(beatsPerMinute) ? beatsPerMinute : 80));
  const beatSeconds = 60 / bpm;
  const safeTargetMidi = Number.isFinite(targetMidi) ? targetMidi : 60;
  const eventBeats = [
    [2, 0.75],
    [3.5, 0.5],
    [5, 1],
    [7, 0.75],
  ] as const;
  const events = eventBeats.map(([startBeat, durationBeats], index) => ({
    id: `pulse-${index + 1}`,
    start_sec: startBeat * beatSeconds,
    end_sec: (startBeat + durationBeats) * beatSeconds,
    target_midi: safeTargetMidi,
  }));

  return {
    id: "rhythm-onset",
    title: "Start and release",
    instruction:
      "Match each pulse at an easy volume, then leave a clear space before the next one.",
    bpm,
    totalSeconds: 9 * beatSeconds,
    events,
  };
}

export function rhythmTargetEventAt(
  elapsedSeconds: number,
  events: readonly RhythmTargetEvent[],
): RhythmTargetEvent | null {
  if (!Number.isFinite(elapsedSeconds)) return null;
  return (
    events.find((event) => elapsedSeconds >= event.start_sec && elapsedSeconds < event.end_sec) ??
    null
  );
}

export function adaptExercisePace(secondsPerNote: number, previousScore: number | null): number {
  const base = Math.max(0.35, secondsPerNote);
  if (previousScore == null || !Number.isFinite(previousScore)) return base;
  if (previousScore < 55) return Math.min(3, Number((base * 1.25).toFixed(2)));
  if (previousScore < 75) return Math.min(3, Number((base * 1.1).toFixed(2)));
  if (previousScore >= 90) return Math.max(0.35, Number((base * 0.9).toFixed(2)));
  return base;
}

function average(values: readonly number[]): number {
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
  fallbackPatterns: readonly (readonly number[])[] = [],
): AdaptedExercisePattern {
  if (
    pattern.length === 0 ||
    lowMidi == null ||
    highMidi == null ||
    !Number.isFinite(lowMidi) ||
    !Number.isFinite(highMidi) ||
    highMidi < lowMidi
  ) {
    return {
      baseMidi: Math.round(preferredBaseMidi),
      pattern: [...pattern],
      rangeLimited: false,
    };
  }

  let low = Math.ceil(lowMidi);
  let high = Math.floor(highMidi);
  if (high < low) {
    const center = Math.round((lowMidi + highMidi) / 2);
    low = center;
    high = center;
  }
  const availableSpan = Math.max(0, high - low);
  const candidates = [pattern, ...fallbackPatterns]
    .filter((candidate) => candidate.length > 0)
    .map((candidate) => [...candidate]);
  const adaptedPattern = candidates.find(
    (candidate) => Math.max(...candidate) - Math.min(...candidate) <= availableSpan,
  ) ?? [0];
  const rangeLimited =
    adaptedPattern.length !== pattern.length ||
    adaptedPattern.some((offset, index) => offset !== pattern[index]);
  const minOffset = Math.min(...adaptedPattern);
  const maxOffset = Math.max(...adaptedPattern);
  const minimumBase = low - minOffset;
  const maximumBase = high - maxOffset;
  const baseMidi = Math.round(Math.max(minimumBase, Math.min(maximumBase, preferredBaseMidi)));

  return { baseMidi, pattern: adaptedPattern, rangeLimited };
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

interface TimedVoiceState {
  readonly elapsedSeconds: number;
  readonly voiced: boolean;
}

function usableRhythmFrame(sample: ExerciseFrame): boolean {
  return (
    Number.isFinite(sample.elapsed_sec) &&
    Number.isFinite(sample.frame.peak ?? 0) &&
    (sample.frame.peak ?? 0) < 0.98
  );
}

function rhythmFrameVoiced(sample: ExerciseFrame): boolean {
  return (
    sample.frame.voiced &&
    sample.frame.midi != null &&
    sample.frame.clarity >= 0.35 &&
    Math.abs(sample.frame.midi - sample.target_midi) <= 2
  );
}

function rhythmEventsFromFrames(
  samples: readonly ExerciseFrame[],
  totalSeconds: number,
): RhythmTargetEvent[] {
  const byId = new Map<string, RhythmTargetEvent>();
  for (const sample of samples) {
    if (
      sample.target_active === false ||
      !sample.target_event_id ||
      !Number.isFinite(sample.target_start_sec) ||
      !Number.isFinite(sample.target_end_sec) ||
      (sample.target_start_sec as number) < 0 ||
      (sample.target_end_sec as number) <= (sample.target_start_sec as number) ||
      (sample.target_end_sec as number) > totalSeconds
    ) {
      continue;
    }
    if (!byId.has(sample.target_event_id)) {
      byId.set(sample.target_event_id, {
        id: sample.target_event_id,
        start_sec: sample.target_start_sec as number,
        end_sec: sample.target_end_sec as number,
        target_midi: sample.target_midi,
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.start_sec - right.start_sec);
}

function hasStableStateAt(
  states: readonly TimedVoiceState[],
  index: number,
  voiced: boolean,
): boolean {
  const first = states[index];
  const second = states[index + 1];
  return (
    first?.voiced === voiced &&
    second?.voiced === voiced &&
    second.elapsedSeconds > first.elapsedSeconds &&
    second.elapsedSeconds - first.elapsedSeconds <= RHYTHM_STABLE_STATE_GAP_SECONDS
  );
}

function firstStableStateIndex(
  states: readonly TimedVoiceState[],
  voiced: boolean,
  fromIndex = 0,
): number | null {
  for (let index = Math.max(0, fromIndex); index < states.length - 1; index += 1) {
    if (hasStableStateAt(states, index, voiced)) return index;
  }
  return null;
}

function observedRhythmBoundaries(states: readonly TimedVoiceState[]): {
  onset: number | null;
  release: number | null;
} {
  const onsetIndex = firstStableStateIndex(states, true);
  if (onsetIndex == null) return { onset: null, release: null };

  const hasObservedSilenceBefore = states.some(
    (state, index) => index < onsetIndex && !state.voiced && hasStableStateAt(states, index, false),
  );
  if (!hasObservedSilenceBefore) return { onset: null, release: null };

  const releaseIndex = firstStableStateIndex(states, false, onsetIndex + 2);
  return {
    onset: states[onsetIndex].elapsedSeconds,
    release: releaseIndex == null ? null : states[releaseIndex].elapsedSeconds,
  };
}

function timingAccuracy(offsetMs: number, fullCreditMs: number, zeroCreditMs: number): number {
  const error = Math.abs(offsetMs);
  if (error <= fullCreditMs) return 100;
  if (error >= zeroCreditMs) return 0;
  return score(100 - ((error - fullCreditMs) / (zeroCreditMs - fullCreditMs)) * 100);
}

export function analyzeRhythmTiming(
  samples: readonly ExerciseFrame[],
  totalSeconds: number,
): RhythmTimingAnalysis {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return {
      events: [],
      onsetScore: null,
      releaseScore: null,
      measurableOnsets: 0,
      measurableReleases: 0,
    };
  }

  const usableSamples = samples
    .filter(usableRhythmFrame)
    .slice()
    .sort((left, right) => left.elapsed_sec - right.elapsed_sec);
  const events = rhythmEventsFromFrames(usableSamples, totalSeconds).map((event) => {
    const states = usableSamples
      .filter(
        (sample) =>
          sample.elapsed_sec >= event.start_sec - RHYTHM_OBSERVATION_MARGIN_SECONDS &&
          sample.elapsed_sec <= event.end_sec + RHYTHM_OBSERVATION_MARGIN_SECONDS,
      )
      .map((sample) => ({
        elapsedSeconds: sample.elapsed_sec,
        voiced: rhythmFrameVoiced(sample),
      }));
    const boundaries = observedRhythmBoundaries(states);
    const onsetOffsetMs =
      boundaries.onset == null ? null : (boundaries.onset - event.start_sec) * 1_000;
    const releaseOffsetMs =
      boundaries.release == null ? null : (boundaries.release - event.end_sec) * 1_000;
    return {
      eventId: event.id,
      targetStartSec: event.start_sec,
      targetEndSec: event.end_sec,
      observedOnsetSec: boundaries.onset,
      observedReleaseSec: boundaries.release,
      onsetOffsetMs,
      releaseOffsetMs,
    };
  });

  const measurableOnsets = events.filter((event) => event.onsetOffsetMs != null);
  const measurableReleases = events.filter((event) => event.releaseOffsetMs != null);
  return {
    events,
    onsetScore:
      measurableOnsets.length < MIN_MEASURABLE_RHYTHM_EVENTS
        ? null
        : score(
            average(
              measurableOnsets.map((event) =>
                timingAccuracy(event.onsetOffsetMs as number, 50, 300),
              ),
            ),
          ),
    releaseScore:
      measurableReleases.length < MIN_MEASURABLE_RHYTHM_EVENTS
        ? null
        : score(
            average(
              measurableReleases.map((event) =>
                timingAccuracy(event.releaseOffsetMs as number, 80, 350),
              ),
            ),
          ),
    measurableOnsets: measurableOnsets.length,
    measurableReleases: measurableReleases.length,
  };
}

function timingObservation(label: string, offsetsMs: readonly number[]): string | null {
  if (offsetsMs.length === 0) return null;
  const meanOffset = average(offsetsMs);
  const direction = meanOffset < 0 ? "early" : "late";
  return `${label} averaged about ${Math.round(Math.abs(meanOffset))} ms ${direction} across measurable pulses.`;
}

function analyzeRhythmExercise(samples: ExerciseFrame[], totalSeconds: number): ExerciseResult {
  const clippingRatio =
    samples.length === 0
      ? 0
      : samples.filter((sample) => !usableRhythmFrame(sample)).length / Math.max(1, samples.length);
  const timing = analyzeRhythmTiming(samples, totalSeconds);
  const activeVoiced = samples.filter(
    (sample) =>
      usableRhythmFrame(sample) && sample.target_active === true && rhythmFrameVoiced(sample),
  );
  const pitch = score(
    average(
      activeVoiced.map(({ frame, target_midi }) =>
        centsSimilarity(((frame.midi as number) - target_midi) * 100),
      ),
    ) * 100,
  );
  const metrics: ExerciseMetric[] = [];
  if (timing.onsetScore != null) metrics.push({ label: "Onset timing", score: timing.onsetScore });
  if (timing.releaseScore != null) {
    metrics.push({ label: "Release timing", score: timing.releaseScore });
  }
  if (activeVoiced.length >= 4) metrics.push({ label: "Pitch", score: pitch });

  const measurable = clippingRatio < 0.1 && timing.onsetScore != null;
  const measurementMessage =
    clippingRatio >= 0.1
      ? "The input clipped too often to measure timing fairly. Lower the microphone gain and retry."
      : timing.events.length < MIN_MEASURABLE_RHYTHM_EVENTS
        ? "Not enough complete rhythm targets were captured to assess this attempt."
        : timing.onsetScore == null
          ? "Start timing could not be measured fairly. Keep the microphone running through the quiet space before each pulse."
          : null;
  const onsetOffsets = timing.events
    .map((event) => event.onsetOffsetMs)
    .filter((offset): offset is number => offset != null);
  const releaseOffsets = timing.events
    .map((event) => event.releaseOffsetMs)
    .filter((offset): offset is number => offset != null);
  const observations = [
    timingObservation("Starts", onsetOffsets),
    timingObservation("Releases", releaseOffsets),
    timing.releaseScore == null && measurable
      ? "Release timing was not scored because too few note endings had clear voiced-to-unvoiced evidence."
      : null,
  ].filter((observation): observation is string => observation != null);
  const recommendations: string[] = [];
  const meanOnsetOffset = average(onsetOffsets);
  const meanReleaseOffset = average(releaseOffsets);
  if (timing.onsetScore != null && timing.onsetScore < 80) {
    recommendations.push(
      meanOnsetOffset < 0
        ? "Wait for the pulse before beginning the note."
        : "Prepare during the quiet space and begin a little sooner on the next pulse.",
    );
  }
  if (timing.releaseScore != null && timing.releaseScore < 80) {
    recommendations.push(
      meanReleaseOffset < 0
        ? "Keep the note connected a little longer before the target ends."
        : "Let the note finish a little sooner so the following space stays clear.",
    );
  }
  if (activeVoiced.length >= 4 && pitch < 80) {
    recommendations.push(
      "Keep the pulse on one easy pitch while you focus on the start and release.",
    );
  }

  return {
    overall: metrics.length === 0 ? 0 : score(average(metrics.map((metric) => metric.score))),
    metrics,
    recommendations: measurable
      ? recommendations.slice(0, 2)
      : [measurementMessage ?? "This attempt did not contain enough reliable timing evidence."],
    observations,
    measurable,
    measurementMessage,
  };
}

export function analyzeExercise(
  exerciseId: string,
  samples: ExerciseFrame[],
  totalSeconds: number,
): ExerciseResult {
  if (exerciseId === "rhythm" || exerciseId === "rhythm-onset") {
    return analyzeRhythmExercise(samples, totalSeconds);
  }
  const unclipped = samples.filter(
    ({ frame }) => Number.isFinite(frame.peak ?? 0) && (frame.peak ?? 0) < 0.98,
  );
  const voiced = unclipped.filter(
    ({ frame }) => frame.voiced && frame.midi != null && frame.clarity >= 0.35,
  );
  const clippingRatio =
    samples.length === 0 ? 0 : (samples.length - unclipped.length) / Math.max(1, samples.length);
  const measurable = samples.length >= 4 && voiced.length >= 4 && clippingRatio < 0.1;
  const measurementMessage =
    samples.length < 4
      ? "Not enough microphone evidence was captured. Try the exercise again."
      : clippingRatio >= 0.1
        ? "The input clipped too often to measure fairly. Lower the microphone gain and retry."
        : voiced.length < 4
          ? "No steady sung note was detected. Move closer to the microphone and use an easy vowel."
          : null;
  const cents = voiced.map(
    ({ frame, target_midi }) => ((frame.midi as number) - target_midi) * 100,
  );
  const pitch = score(average(cents.map((offset) => centsSimilarity(offset) * 100)));
  const coverage = score((voiced.length / Math.max(1, unclipped.length)) * 100);
  const stability = cents.length < 2 ? 0 : score(100 - deviation(cents) * 1.4);

  let metrics: ExerciseMetric[];
  const observations: string[] = [];
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
    const extent = deviation(secondCents);
    const straightTone = voiced
      .filter(({ elapsed_sec }) => elapsed_sec < totalSeconds / 2)
      .map(({ frame, target_midi }) => ((frame.midi as number) - target_midi) * 100);
    const hasVibratoEvidence = secondCents.length >= 8;
    metrics = [
      {
        label: "Straight tone",
        score: straightTone.length < 5 ? 0 : score(100 - deviation(straightTone) * 1.5),
      },
      { label: "Pitch center", score: pitch },
      { label: "Continuity", score: coverage },
    ];
    observations.push(
      hasVibratoEvidence && crossings >= 4
        ? `Observed oscillation: ${rate.toFixed(1)} cycles/second with about ${Math.round(extent)} cents of variation. This is descriptive, not a good-or-bad target.`
        : "No clear repeated oscillation was observed. Keep this optional and use an easy, comfortable sound.",
    );
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
      if (metric.label === "Dynamic shape") {
        return "Grow and release the volume gradually while keeping the pitch centered.";
      }
      return "Repeat at an easier volume and keep the airflow steady.";
    });

  return {
    overall,
    metrics,
    recommendations: measurable
      ? recommendations
      : [measurementMessage ?? "This attempt did not contain enough reliable evidence."],
    observations,
    measurable,
    measurementMessage,
  };
}
