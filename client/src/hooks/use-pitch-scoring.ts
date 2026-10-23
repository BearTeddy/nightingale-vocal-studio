import type { TimeSubscriber } from "@/hooks/use-audio-player";
import {
  DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
  MAX_MIC_LATENCY_COMPENSATION_SEC,
  MIN_MIC_LATENCY_COMPENSATION_SEC,
  PITCH_WINDOW_SAMPLES,
} from "@/lib/pitch/constants";
import { createPitchDetector, detectPitchFromSamplesRef } from "@/lib/pitch/detect";
import {
  displayedCentsOffset,
  findTargetNoteAt,
  isPitchTimeDiscontinuity,
  MelodyPerformanceScoring,
  midiToFreq,
  PitchSeries,
  PitchStateBuffer,
  pitchSimilarity,
  pushPitchSeriesFrame,
  sampleAudioBufferRms,
  sampleVocalsWindow,
  summarizePitchInputEvidence,
} from "@/lib/pitch/state";
import type { MelodyMap } from "@/types/MelodyMap";
import type { ScoringDifficulty } from "@/lib/pitch/difficulty";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { PitchFrame } from "@/types/PitchFrame";
import { useCallback, useEffect, useRef, useState } from "react";

export interface PitchScoringSource {
  isReady: boolean;
  duration: number;
  getReferenceBuffer: () => AudioBuffer | null;
  subscribe: (fn: TimeSubscriber) => () => void;
}

export function usePitchScoring(
  { isReady, duration, getReferenceBuffer, subscribe }: PitchScoringSource,
  micFrame: PitchFrame | null,
  melody: MelodyMap | null,
  latencyCompensationSec = DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
  difficulty: ScoringDifficulty = "medium",
  toleranceFactor = 1,
) {
  const bufferRef = useRef(new PitchStateBuffer());
  const melodyScoringRef = useRef<MelodyPerformanceScoring | null>(null);
  const micFrameRef = useRef(micFrame);
  const melodyRef = useRef(melody);
  const latencyRef = useRef(latencyCompensationSec);
  const toleranceRef = useRef(toleranceFactor);
  toleranceRef.current = toleranceFactor;
  const referenceDetectorRef = useRef(createPitchDetector());
  const referenceWindowRef = useRef(new Float32Array(PITCH_WINDOW_SAMPLES));
  const referencePitchRef = useRef<{
    buffer: AudioBuffer | null;
    time: number;
    midi: number | null;
  }>({ buffer: null, time: Number.NEGATIVE_INFINITY, midi: null });
  const denseSeriesRef = useRef<PitchSeries>({
    refPitches: [],
    userPitches: [],
    similarities: [],
    timestamps: [],
    frames: [],
    discontinuities: [],
  });
  const denseLastPushRef = useRef(0);
  const lastProcessedSampleIndexRef = useRef<number | null>(null);
  const lastTransportTimeRef = useRef<number | null>(null);
  const [series, setSeries] = useState<PitchSeries>({
    refPitches: [],
    userPitches: [],
    similarities: [],
    timestamps: [],
  });
  const [score, setScore] = useState(0);
  const [performance, setPerformance] = useState<PerformanceScore>(() =>
    emptyPerformance(difficulty, toleranceFactor),
  );

  micFrameRef.current = micFrame;
  melodyRef.current = melody;
  latencyRef.current = Math.min(
    MAX_MIC_LATENCY_COMPENSATION_SEC,
    Math.max(MIN_MIC_LATENCY_COMPENSATION_SEC, latencyCompensationSec),
  );

  useEffect(() => {
    if (!isReady || duration <= 0) {
      return;
    }
    bufferRef.current.reset();
    denseSeriesRef.current = {
      refPitches: [],
      userPitches: [],
      similarities: [],
      timestamps: [],
      frames: [],
      discontinuities: [],
    };
    denseLastPushRef.current = 0;
    lastProcessedSampleIndexRef.current = null;
    lastTransportTimeRef.current = null;
    referencePitchRef.current = {
      buffer: null,
      time: Number.NEGATIVE_INFINITY,
      midi: null,
    };

    melodyScoringRef.current = melody?.strict_scoring_available
      ? new MelodyPerformanceScoring(melody, difficulty, toleranceRef.current)
      : null;

    setSeries(bufferRef.current.snapshot());
    setScore(0);
    setPerformance(emptyPerformance(difficulty, toleranceRef.current));
  }, [difficulty, duration, isReady, melody]);

  useEffect(() => {
    const scoring = melodyScoringRef.current;
    if (!scoring) return;
    scoring.setPitchToleranceFactor(toleranceFactor);
    const next = scoring.snapshot();
    setPerformance(next);
    setScore(next.legacy_score);
    const dense = denseSeriesRef.current;
    dense.similarities = dense.refPitches.map((reference, index) => {
      const user = dense.userPitches[index];
      return reference != null && user != null
        ? pitchSimilarity(reference, user, difficulty, toleranceFactor)
        : 0;
    });
  }, [difficulty, toleranceFactor]);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    const run = (t: number) => {
      if (t <= 0) {
        return;
      }

      const frame = micFrameRef.current;
      const mp = frame?.hz ?? null;
      const scoringTime = Math.max(0, t - latencyRef.current);
      const melodyScoring = melodyScoringRef.current;
      const previousTransportTime = lastTransportTimeRef.current;
      const transportDiscontinuity =
        previousTransportTime != null &&
        isPitchTimeDiscontinuity(previousTransportTime, scoringTime);
      lastTransportTimeRef.current = scoringTime;
      const shouldProcessFrame =
        frame == null ||
        frame.sample_index !== lastProcessedSampleIndexRef.current ||
        transportDiscontinuity;
      if (shouldProcessFrame) {
        lastProcessedSampleIndexRef.current = frame?.sample_index ?? null;
      }

      if (melodyScoring && melodyRef.current) {
        const note = findTargetNoteAt(melodyRef.current.notes, scoringTime);
        const refHz = note ? midiToFreq(note.midi + note.cents / 100) : null;
        const sim =
          refHz != null && mp != null
            ? pitchSimilarity(refHz, mp, difficulty, toleranceRef.current)
            : 0;
        bufferRef.current.tryPush(refHz, mp, sim, t, frame?.sample_index);
        if (shouldProcessFrame) {
          const referenceBuffer = getReferenceBuffer();
          let referenceMidi: number | undefined;
          if (note && frame?.voiced) {
            const cached = referencePitchRef.current;
            const needsDetection =
              cached.buffer !== referenceBuffer ||
              scoringTime < cached.time ||
              scoringTime - cached.time >= 0.02;
            if (needsDetection) {
              const sampled = sampleVocalsWindow(
                referenceBuffer,
                scoringTime,
                referenceWindowRef.current,
                0,
              );
              const detectedHz = sampled
                ? detectPitchFromSamplesRef(
                    referenceDetectorRef.current,
                    referenceWindowRef.current,
                    referenceBuffer?.sampleRate ?? 0,
                  )
                : null;
              cached.buffer = referenceBuffer;
              cached.time = scoringTime;
              cached.midi = detectedHz == null ? null : 12 * Math.log2(detectedHz / 440) + 69;
            }
            if (cached.midi != null) {
              const targetMidi = note.midi + note.cents / 100;
              const octaveAligned = cached.midi + 12 * Math.round((targetMidi - cached.midi) / 12);
              if (Math.abs(octaveAligned - targetMidi) <= 3.5) referenceMidi = octaveAligned;
            }
          }
          const scoringFrame = frame
            ? {
                ...frame,
                reference_rms: note
                  ? (sampleAudioBufferRms(referenceBuffer, scoringTime) ?? undefined)
                  : undefined,
                reference_midi: referenceMidi,
              }
            : null;
          pushPitchSeriesFrame(
            denseSeriesRef.current,
            denseLastPushRef,
            refHz,
            mp,
            sim,
            t,
            scoringFrame,
          );
          melodyScoring.accumulate(scoringTime, scoringFrame);
        }
        const displaySeries = bufferRef.current.snapshot();
        const latestDisplayPitch =
          displaySeries.userPitches[displaySeries.userPitches.length - 1] ?? null;
        const next = {
          ...melodyScoring.snapshot(),
          cents_offset: displayedCentsOffset(refHz, latestDisplayPitch),
        };
        setSeries(displaySeries);
        setPerformance(next);
        setScore(next.legacy_score);
        return;
      }

      // Keep the live trace in free-sing mode, but do not infer a score from
      // the separated vocal stem. Scores require eligible MelodyMap targets.
      bufferRef.current.tryPush(null, mp, 0, t, frame?.sample_index);
      if (shouldProcessFrame) {
        pushPitchSeriesFrame(denseSeriesRef.current, denseLastPushRef, null, mp, 0, t, frame);
      }
      setSeries(bufferRef.current.snapshot());
      setScore(0);
    };

    return subscribe(run);
  }, [difficulty, getReferenceBuffer, isReady, subscribe]);

  const getPerformanceSeries = useCallback((): PitchSeries => denseSeriesRef.current, []);
  const getPitchInputEvidence = useCallback(
    (micEnabled: boolean) => summarizePitchInputEvidence(denseSeriesRef.current, micEnabled),
    [],
  );

  return { series, score, performance, getPerformanceSeries, getPitchInputEvidence };
}

function emptyPerformance(difficulty: ScoringDifficulty, factor = 1): PerformanceScore {
  return {
    scoring_difficulty: difficulty,
    pitch_tolerance_factor: factor,
    overall: 0,
    legacy_score: 0,
    phrase_accuracy: 0,
    streak: 0,
    cents_offset: null,
    categories: [
      { key: "pitch", label: "Pitch", score: 0, available: false },
      { key: "timing", label: "Timing", score: 0, available: false },
      { key: "stability", label: "Stability", score: 0, available: false },
      { key: "sustain", label: "Sustain", score: 0, available: false },
      { key: "dynamics", label: "Dynamics", score: 0, available: false },
      { key: "technique", label: "Technique", score: 0, available: false },
    ],
    phrases: [],
    coaching: [],
  };
}
