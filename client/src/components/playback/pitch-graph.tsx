import { usePlaybackMicState, usePlaybackTransportActions } from "@/contexts/playback";
import type { PitchSeries } from "@/lib/pitch/state";
import { freqToSemitone } from "@/lib/pitch/state";
import type { TargetNote } from "@/types/TargetNote";
import { useEffect, useRef, useState } from "react";

const PAST_SECONDS = 1.5;
const FUTURE_SECONDS = 4.5;
const MIN_SEMITONE_RANGE = 16;
const MAX_SEMITONE_RANGE = 24;
const PLAYHEAD_FRACTION = PAST_SECONDS / (PAST_SECONDS + FUTURE_SECONDS);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

interface PitchGraphProps {
  series: PitchSeries;
  position?: "top" | "bottom";
}

interface Viewport {
  width: number;
  height: number;
  minMidi: number;
  maxMidi: number;
}

function visibleNotes(notes: readonly TargetNote[], time: number): TargetNote[] {
  const start = time - PAST_SECONDS;
  const end = time + FUTURE_SECONDS;
  return notes.filter((note) => note.end >= start && note.start <= end);
}

function pitchViewport(
  notes: readonly TargetNote[],
  width: number,
  height: number,
  userMidi: number | null,
): Viewport {
  const pitches = notes.map((note) => note.midi + note.cents / 100);
  const center =
    pitches.length === 0 ? (userMidi ?? 66) : (Math.min(...pitches) + Math.max(...pitches)) / 2;
  const spread = pitches.length === 0 ? 0 : Math.max(...pitches) - Math.min(...pitches);
  const semitoneRange = Math.min(
    MAX_SEMITONE_RANGE,
    Math.max(MIN_SEMITONE_RANGE, Math.ceil((spread + 4) / 2) * 2),
  );
  const minMidi = Math.floor(center - semitoneRange / 2);
  return {
    width,
    height,
    minMidi,
    maxMidi: minMidi + semitoneRange,
  };
}

function timeToX(time: number, current: number, viewport: Viewport): number {
  const start = current - PAST_SECONDS;
  return ((time - start) / (PAST_SECONDS + FUTURE_SECONDS)) * viewport.width;
}

function midiToY(midi: number, viewport: Viewport): number {
  const normalized = (midi - viewport.minMidi) / (viewport.maxMidi - viewport.minMidi);
  return viewport.height - normalized * viewport.height;
}

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  const ratio = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  const context = canvas.getContext("2d");
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  return context;
}

function midiNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const noteIndex = ((rounded % 12) + 12) % 12;
  return `${NOTE_NAMES[noteIndex]}${Math.floor(rounded / 12) - 1}`;
}

function latestUserPitch(series: PitchSeries): number | null {
  return series.userPitches[series.userPitches.length - 1] ?? null;
}

function drawGrid(context: CanvasRenderingContext2D, viewport: Viewport): void {
  context.fillStyle = "rgba(0,0,0,0.43)";
  context.fillRect(0, 0, viewport.width, viewport.height);
  context.lineWidth = 1;
  context.font = "500 11px system-ui, sans-serif";
  context.textBaseline = "middle";
  for (let midi = viewport.minMidi; midi <= viewport.maxMidi; midi += 1) {
    const y = Math.round(midiToY(midi, viewport)) + 0.5;
    const isC = midi % 12 === 0;
    context.strokeStyle = isC ? "rgba(255,255,255,0.24)" : "rgba(255,255,255,0.11)";
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(viewport.width, y);
    context.stroke();
    if (isC && y >= 8 && y <= viewport.height - 8) {
      context.fillStyle = "rgba(255,255,255,0.58)";
      context.fillText(midiNoteName(midi), 7, y);
    }
  }
}

function drawTargets(
  context: CanvasRenderingContext2D,
  notes: readonly TargetNote[],
  time: number,
  viewport: Viewport,
): void {
  for (const note of notes) {
    const x = timeToX(note.start, time, viewport);
    const right = timeToX(note.end, time, viewport);
    const y = midiToY(note.midi + note.cents / 100, viewport);
    const height = Math.max(7, viewport.height / (viewport.maxMidi - viewport.minMidi) - 3);
    context.save();
    context.fillStyle = note.eligible ? "rgba(77,222,235,0.94)" : "rgba(77,222,235,0.45)";
    if (!note.eligible) context.setLineDash([5, 4]);
    context.beginPath();
    context.roundRect(x, y - height / 2, Math.max(3, right - x - 2), height, 2);
    if (note.eligible) {
      context.fill();
    } else {
      context.strokeStyle = "rgba(120,235,245,0.8)";
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.restore();
  }
}

function traceColor(similarity: number): string {
  if (similarity >= 0.8) return "rgba(55,224,111,0.98)";
  if (similarity >= 0.45) return "rgba(250,204,62,0.98)";
  return "rgba(248,90,90,0.96)";
}

function drawSinger(
  context: CanvasRenderingContext2D,
  series: PitchSeries,
  time: number,
  viewport: Viewport,
): void {
  context.save();
  context.lineWidth = 5;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.shadowColor = "rgba(0,0,0,0.75)";
  context.shadowBlur = 4;
  for (let index = 1; index < series.userPitches.length; index += 1) {
    const previous = series.userPitches[index - 1];
    const current = series.userPitches[index];
    const previousTime = series.timestamps[index - 1];
    const currentTime = series.timestamps[index];
    if (previous == null || current == null || previousTime == null || currentTime == null)
      continue;
    if (currentTime < time - PAST_SECONDS || currentTime > time + FUTURE_SECONDS) continue;
    context.strokeStyle = traceColor(series.similarities[index] ?? 0);
    context.beginPath();
    context.moveTo(
      timeToX(previousTime, time, viewport),
      midiToY(freqToSemitone(previous), viewport),
    );
    context.lineTo(
      timeToX(currentTime, time, viewport),
      midiToY(freqToSemitone(current), viewport),
    );
    context.stroke();
  }
  context.restore();
}

function drawPlayhead(context: CanvasRenderingContext2D, viewport: Viewport): void {
  const x = viewport.width * PLAYHEAD_FRACTION;
  context.fillStyle = "rgba(255,64,64,0.96)";
  context.fillRect(x - 1.5, 0, 3, viewport.height);
}

function drawSingerMarker(
  context: CanvasRenderingContext2D,
  series: PitchSeries,
  viewport: Viewport,
): void {
  const pitch = latestUserPitch(series);
  if (pitch == null) return;
  const index = series.userPitches.length - 1;
  const x = viewport.width * PLAYHEAD_FRACTION;
  const rawY = midiToY(freqToSemitone(pitch), viewport);
  const y = Math.max(8, Math.min(viewport.height - 8, rawY));
  context.save();
  context.fillStyle = traceColor(series.similarities[index] ?? 0);
  context.strokeStyle = "rgba(255,255,255,0.95)";
  context.lineWidth = 2;
  context.shadowColor = "rgba(0,0,0,0.8)";
  context.shadowBlur = 6;
  context.beginPath();
  context.arc(x, y, 6, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

export function PitchGraph({ series, position = "top" }: PitchGraphProps) {
  const { micReady, micUserEnabled, latestFrame, melody, performance, feedbackMode } =
    usePlaybackMicState();
  const { subscribe, getCurrentTime } = usePlaybackTransportActions();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  const seriesRef = useRef(series);
  const melodyRef = useRef(melody);
  const viewportSizeRef = useRef({ width: 0, height: 0 });
  const viewportCenterRef = useRef<number | null>(null);
  const drawRef = useRef<(time: number) => void>(() => {});
  const previousStreakRef = useRef(0);
  const [hitFlash, setHitFlash] = useState(false);
  seriesRef.current = series;
  melodyRef.current = melody;
  const guideVisible = melody != null || micUserEnabled;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !guideVisible) return;

    const resize = () => {
      viewportSizeRef.current = {
        width: Math.max(320, canvas.parentElement?.clientWidth ?? window.innerWidth),
        height: Math.max(144, Math.min(220, window.innerHeight * 0.24)),
      };
    };

    const draw = (time: number) => {
      timeRef.current = time;
      const { width, height } = viewportSizeRef.current;
      if (width <= 0 || height <= 0) return;
      const context = setupCanvas(canvas, width, height);
      if (!context) return;
      const notes = visibleNotes(melodyRef.current?.notes ?? [], time);
      const userPitch = latestUserPitch(seriesRef.current);
      const userMidi = userPitch == null ? null : freqToSemitone(userPitch);
      const desired = pitchViewport(notes, width, height, userMidi);
      const desiredCenter = (desired.minMidi + desired.maxMidi) / 2;
      const semitoneRange = desired.maxMidi - desired.minMidi;
      const previousCenter = viewportCenterRef.current;
      if (
        previousCenter == null ||
        desired.minMidi < previousCenter - semitoneRange / 2 + 2 ||
        desired.maxMidi > previousCenter + semitoneRange / 2 - 2
      ) {
        viewportCenterRef.current = desiredCenter;
      }
      const center = viewportCenterRef.current ?? desiredCenter;
      const minMidi = Math.floor(center - semitoneRange / 2);
      const viewport = {
        width,
        height,
        minMidi,
        maxMidi: minMidi + semitoneRange,
      };
      context.clearRect(0, 0, width, height);
      drawGrid(context, viewport);
      drawTargets(context, notes, time, viewport);
      if (micReady) drawSinger(context, seriesRef.current, time, viewport);
      drawPlayhead(context, viewport);
      if (micReady) drawSingerMarker(context, seriesRef.current, viewport);
    };
    drawRef.current = draw;

    resize();
    draw(getCurrentTime());
    const unsubscribe = subscribe(draw);
    const observer = new ResizeObserver(() => {
      resize();
      draw(timeRef.current);
    });
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    window.addEventListener("resize", resize);
    return () => {
      unsubscribe();
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [getCurrentTime, guideVisible, micReady, subscribe]);

  useEffect(() => {
    drawRef.current(timeRef.current);
  }, [melody, micReady, series]);

  useEffect(() => {
    const previous = previousStreakRef.current;
    previousStreakRef.current = performance.streak;
    if (feedbackMode !== "game" || performance.streak <= previous) return;
    setHitFlash(true);
    const timer = window.setTimeout(() => setHitFlash(false), 220);
    return () => window.clearTimeout(timer);
  }, [feedbackMode, performance.streak]);

  if (!guideVisible) return null;

  const cents = performance.cents_offset;
  const pitchMessage =
    cents == null
      ? "Listen for the next note"
      : Math.abs(cents) <= 25
        ? "Centered"
        : cents > 0
          ? `${cents}c high`
          : `${Math.abs(cents)}c low`;
  const gameRating =
    performance.phrase_accuracy === 0
      ? "Ready"
      : performance.phrase_accuracy >= 90
        ? "Perfect"
        : performance.phrase_accuracy >= 75
          ? "Great"
          : performance.phrase_accuracy >= 55
            ? "Good"
            : "Keep going";
  const coachHint = performance.coaching[0] ?? null;
  const clipping =
    latestFrame != null &&
    ((latestFrame.peak ?? latestFrame.rms) >= 0.98 || latestFrame.rms >= 0.7);
  const latestVisualPitch = latestUserPitch(series);
  const inputMidi = latestVisualPitch == null ? null : freqToSemitone(latestVisualPitch);
  const inputNote = inputMidi == null ? null : Math.round(inputMidi);
  const inputCents =
    inputMidi == null || inputNote == null ? null : Math.round((inputMidi - inputNote) * 100);
  const inputLabel =
    inputNote == null
      ? micReady
        ? "Input --"
        : "Mic starting"
      : `Input ${midiNoteName(inputNote)} ${inputCents != null && inputCents >= 0 ? "+" : ""}${inputCents ?? 0}c`;

  return (
    <section
      aria-label="Pitch guide"
      className={`pointer-events-none absolute inset-x-0 z-20 border-y border-white/15 ${
        position === "bottom" ? "bottom-[8rem]" : "top-[8rem]"
      }`}
    >
      <canvas ref={canvasRef} className="block w-full" />
      <div className="absolute left-3 top-2 flex max-w-[35%] flex-col items-start gap-2">
        <div className="bg-black/70 px-2 py-1 text-sm font-semibold text-white tabular-nums">
          {inputLabel}
        </div>
        {clipping && (
          <div className="bg-red-600 px-2 py-1 text-xs font-medium text-white" role="alert">
            Mic clipping - lower the input level
          </div>
        )}
      </div>
      <div
        className={`absolute right-3 top-2 flex max-w-[60%] flex-wrap items-center justify-end gap-x-3 gap-y-1 bg-black/70 px-2 py-1 text-xs text-white transition-transform sm:text-sm ${hitFlash ? "scale-110 bg-cyan-400 text-black" : ""}`}
      >
        <span className="tabular-nums">Pitch {performance.phrase_accuracy}%</span>
        {feedbackMode === "coach" && <span className="text-white/75">{pitchMessage}</span>}
        {feedbackMode === "game" && (
          <>
            <span className={hitFlash ? "text-black" : "text-white/75"}>{gameRating}</span>
            <span className={hitFlash ? "text-black" : "text-white/75"}>
              Streak {performance.streak}
            </span>
          </>
        )}
      </div>
      {feedbackMode === "coach" && coachHint && melody?.strict_scoring_available && (
        <div
          className="absolute bottom-2 right-3 max-w-[65vw] truncate bg-black/55 px-2 py-1 text-xs text-white/75"
          aria-live="polite"
        >
          {coachHint}
        </div>
      )}
      {!melody?.strict_scoring_available && (
        <div className="absolute bottom-2 left-3 bg-black/55 px-2 py-1 text-xs text-white/70">
          Free sing: pitch guide is waiting for melody analysis
        </div>
      )}
    </section>
  );
}
