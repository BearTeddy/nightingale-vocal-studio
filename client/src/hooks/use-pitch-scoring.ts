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
  MelodyPerformanceScoring,
  midiToFreq,
  PitchSeries,
  PitchStateBuffer,
  pitchSimilarity,
  pushPitchSeriesFrame,
  sampleAudioBufferRms,
  sampleVocalsWindow,
} from "@/lib/pitch/state";
import type { MelodyMap } from "@/types/MelodyMap";
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
) {
  const bufferRef = useRef(new PitchStateBuffer());
  const melodyScoringRef = useRef<MelodyPerformanceScoring | null>(null);
  const micFrameRef = useRef(micFrame);
  const melodyRef = useRef(melody);
  const latencyRef = useRef(latencyCompensationSec);
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
  const [series, setSeries] = useState<PitchSeries>({
    refPitches: [],
    userPitches: [],
    similarities: [],
    timestamps: [],
  });
  const [score, setScore] = useState(0);
  const [performance, setPerformance] = useState<PerformanceScore>(() => emptyPerformance());

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
    referencePitchRef.current = {
      buffer: null,
      time: Number.NEGATIVE_INFINITY,
      midi: null,
    };

    melodyScoringRef.current = melody?.strict_scoring_available
      ? new MelodyPerformanceScoring(melody)
      : null;

    setSeries(bufferRef.current.snapshot());
    setScore(0);
    setPerformance(emptyPerformance());
  }, [isReady, duration, melody]);

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

      if (melodyScoring && melodyRef.current) {
        const note = findTargetNoteAt(melodyRef.current.notes, scoringTime);
        const refHz = note ? midiToFreq(note.midi + note.cents / 100) : null;
        const sim = refHz != null && mp != null ? pitchSimilarity(refHz, mp) : 0;
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
        bufferRef.current.tryPush(refHz, mp, sim, t, frame?.sample_index);
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
      pushPitchSeriesFrame(denseSeriesRef.current, denseLastPushRef, null, mp, 0, t, frame);
      setSeries(bufferRef.current.snapshot());
      setScore(0);
    };

    return subscribe(run);
  }, [getReferenceBuffer, isReady, subscribe]);

  const getPerformanceSeries = useCallback((): PitchSeries => denseSeriesRef.current, []);

  return { series, score, performance, getPerformanceSeries };
}

function emptyPerformance(): PerformanceScore {
  return {
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
