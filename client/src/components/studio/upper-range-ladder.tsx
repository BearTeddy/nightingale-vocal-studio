import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type {
  TechniqueComfortRating,
  TechniqueEffortRating,
  TechniqueHelpfulness,
  TechniqueReflection,
} from "@/lib/learning/technique-coaching";
import {
  UPPER_RANGE_LADDER_CUE_ID,
  assessUpperRangePitchEvidence,
  clampUpperRangeStart,
  countConsecutiveUnsuccessfulLadderReflections,
  decideUpperRangeStep,
  midiNoteName,
  midiToHz,
  normalizeUpperRangeBounds,
  type UpperRangeBounds,
  type UpperRangePitchEvidence,
} from "@/lib/learning/upper-range-ladder";
import { ArrowDown, Check, Mic2, RotateCcw, ShieldAlert, Volume2 } from "lucide-react";
import type { PitchFrame } from "@/types/PitchFrame";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UpperRangeLadderProps {
  active: boolean;
  microphoneActive: boolean;
  deviceId: string;
  latestPitchFrame: PitchFrame | null;
  startMidi: number;
  bounds: UpperRangeBounds;
  reflections: readonly TechniqueReflection[];
  onReflection: (reflection: TechniqueReflection) => void;
}

type AttemptPhase = "idle" | "capturing" | "reflecting";
type LadderEndReason = "boundary" | "safety";

const CAPTURE_DURATION_MS = 2_000;
const RATINGS = [1, 2, 3, 4, 5] as const;

function playReferenceTone(midi: number): void {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime + 0.04;
  oscillator.type = "sine";
  oscillator.frequency.value = midiToHz(midi);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.12, start + 0.03);
  gain.gain.setValueAtTime(0.12, start + 0.58);
  gain.gain.linearRampToValueAtTime(0, start + 0.72);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.74);
  oscillator.addEventListener("ended", () => void context.close());
}

function evidenceMessage(evidence: UpperRangePitchEvidence): string {
  if (evidence.matched) {
    const error = evidence.medianErrorCents == null ? null : Math.round(evidence.medianErrorCents);
    return error == null
      ? "Pitch evidence was measurable. Now record comfort and effort."
      : `Pitch evidence matched the target (${error > 0 ? "+" : ""}${error}¢ median). Now record comfort and effort.`;
  }
  if (evidence.reason === "not_enough_voiced_samples") {
    return "Not enough steady pitch was detected. Record how it felt, then retry the same note.";
  }
  if (evidence.reason === "unstable") {
    return "The detected pitch moved too much to count as a centered note. Reflect, then retry more gently.";
  }
  return "A pitch was detected, but it was not centered on this target. Reflect before retrying.";
}

function reflectionHelpfulness(
  evidence: UpperRangePitchEvidence,
  comfort: TechniqueComfortRating,
  effort: TechniqueEffortRating,
): TechniqueHelpfulness {
  if (comfort <= 2 || effort >= 4) return "made_harder";
  if (evidence.matched && comfort >= 4 && effort <= 2) return "helped";
  return "no_change";
}

export function UpperRangeLadder({
  active,
  microphoneActive,
  deviceId,
  latestPitchFrame,
  startMidi,
  bounds,
  reflections,
  onReflection,
}: UpperRangeLadderProps) {
  const normalizedBounds = useMemo(
    () => normalizeUpperRangeBounds(bounds),
    [bounds.comfortableHighMidi, bounds.comfortableLowMidi],
  );
  const boundedStart = normalizedBounds
    ? clampUpperRangeStart(startMidi, normalizedBounds)
    : Math.round(startMidi);
  const [targetMidi, setTargetMidi] = useState(boundedStart);
  const [phase, setPhase] = useState<AttemptPhase>("idle");
  const [captureProgress, setCaptureProgress] = useState(0);
  const [evidence, setEvidence] = useState<UpperRangePitchEvidence | null>(null);
  const [comfort, setComfort] = useState<TechniqueComfortRating | null>(null);
  const [effort, setEffort] = useState<TechniqueEffortRating | null>(null);
  const [endReason, setEndReason] = useState<LadderEndReason | null>(null);
  const [status, setStatus] = useState(
    "Play the reference, then sing one easy note at a comfortable volume.",
  );
  const pitchSamplesRef = useRef<number[]>([]);
  const lastPitchSampleIndexRef = useRef<number | null>(null);
  const captureStartedAtRef = useRef(0);
  const safetyStoppedRef = useRef(false);

  const clearAttempt = useCallback(() => {
    pitchSamplesRef.current = [];
    setPhase("idle");
    setCaptureProgress(0);
    setEvidence(null);
    setComfort(null);
    setEffort(null);
  }, []);

  const resetLadder = useCallback(() => {
    if (!normalizedBounds || safetyStoppedRef.current) return;
    clearAttempt();
    setTargetMidi(clampUpperRangeStart(startMidi, normalizedBounds));
    setEndReason(null);
    setStatus("Play the reference, then sing one easy note at a comfortable volume.");
  }, [clearAttempt, normalizedBounds, startMidi]);

  useEffect(() => {
    if (!normalizedBounds || safetyStoppedRef.current) return;
    clearAttempt();
    setTargetMidi(clampUpperRangeStart(startMidi, normalizedBounds));
    setEndReason(null);
    setStatus("The practice target was reset inside your saved comfortable range.");
  }, [clearAttempt, deviceId, normalizedBounds, startMidi]);

  useEffect(() => {
    if (active && microphoneActive) return;
    if (phase === "capturing") {
      clearAttempt();
      setStatus(
        active
          ? "The microphone stopped, so this attempt was not counted."
          : "This ladder is paused.",
      );
    }
  }, [active, clearAttempt, microphoneActive, phase]);

  useEffect(() => {
    if (phase !== "capturing" || !latestPitchFrame) return;
    if (latestPitchFrame.sample_index === lastPitchSampleIndexRef.current) return;
    lastPitchSampleIndexRef.current = latestPitchFrame.sample_index;
    const peak = latestPitchFrame.peak ?? latestPitchFrame.rms;
    if (
      latestPitchFrame.voiced &&
      latestPitchFrame.hz != null &&
      Number.isFinite(latestPitchFrame.hz) &&
      latestPitchFrame.hz > 0 &&
      latestPitchFrame.clarity >= 0.35 &&
      peak < 0.98
    ) {
      pitchSamplesRef.current.push(latestPitchFrame.hz);
    }
  }, [latestPitchFrame, phase]);

  useEffect(() => {
    if (phase !== "capturing") return;
    const progressTimer = window.setInterval(() => {
      const elapsed = performance.now() - captureStartedAtRef.current;
      setCaptureProgress(Math.min(100, (elapsed / CAPTURE_DURATION_MS) * 100));
    }, 50);
    const finishTimer = window.setTimeout(() => {
      const result = assessUpperRangePitchEvidence(targetMidi, pitchSamplesRef.current);
      setEvidence(result);
      setCaptureProgress(100);
      setPhase("reflecting");
      setStatus(evidenceMessage(result));
    }, CAPTURE_DURATION_MS);
    return () => {
      window.clearInterval(progressTimer);
      window.clearTimeout(finishTimer);
    };
  }, [phase, targetMidi]);

  const startAttempt = () => {
    if (
      !normalizedBounds ||
      !active ||
      !microphoneActive ||
      deviceId.trim() === "" ||
      phase !== "idle" ||
      endReason != null
    ) {
      return;
    }
    pitchSamplesRef.current = [];
    lastPitchSampleIndexRef.current = latestPitchFrame?.sample_index ?? null;
    captureStartedAtRef.current = performance.now();
    setEvidence(null);
    setComfort(null);
    setEffort(null);
    setCaptureProgress(0);
    setStatus(`Sing ${midiNoteName(targetMidi)} on a gentle “woo” and let the pitch settle.`);
    setPhase("capturing");
  };

  const previousComfort =
    [...reflections].reverse().find((reflection) => reflection.cueId === UPPER_RANGE_LADDER_CUE_ID)
      ?.comfortAfter ?? 4;

  const applyReflection = (
    comfortAfter: TechniqueComfortRating,
    effortAfter: TechniqueEffortRating,
    stopForStrain = false,
  ) => {
    if (!normalizedBounds) return;
    const measuredEvidence = evidence ?? assessUpperRangePitchEvidence(targetMidi, []);
    const priorMisses = countConsecutiveUnsuccessfulLadderReflections(reflections);
    const reflection: TechniqueReflection = {
      cueId: UPPER_RANGE_LADDER_CUE_ID,
      recordedAt: Date.now(),
      comfortBefore: previousComfort,
      comfortAfter,
      effortAfter,
      helpfulness: stopForStrain
        ? "made_harder"
        : reflectionHelpfulness(measuredEvidence, comfortAfter, effortAfter),
      successfulOutcome: false,
      stopSignals: stopForStrain ? ["strain"] : [],
    };
    const comfortableSuccess =
      measuredEvidence.matched && comfortAfter >= 4 && effortAfter <= 2 && !stopForStrain;
    const decision = decideUpperRangeStep({
      targetMidi,
      bounds: normalizedBounds,
      evidence: measuredEvidence,
      reflection,
      consecutiveUnsuccessfulAttempts: priorMisses + (comfortableSuccess ? 0 : 1),
    });
    onReflection(decision.reflection);
    clearAttempt();
    setTargetMidi(decision.nextMidi);

    if (decision.action === "stop") {
      safetyStoppedRef.current = true;
      setEndReason("safety");
      setStatus(decision.safety.message.en);
      return;
    }
    if (decision.action === "complete") {
      setEndReason("boundary");
      setStatus(
        `You completed ${midiNoteName(decision.nextMidi)} comfortably at the saved upper boundary. The saved range was not changed.`,
      );
      return;
    }
    if (decision.action === "advance") {
      setStatus(
        `Comfort and pitch evidence agreed. The next target is one semitone higher: ${midiNoteName(decision.nextMidi)}.`,
      );
      return;
    }
    if (decision.action === "step_down") {
      setStatus(
        `Step down to ${midiNoteName(decision.nextMidi)}. Keep it easy, or end the session if comfort does not return.`,
      );
      return;
    }
    setStatus(decision.safety.message.en);
  };

  if (!normalizedBounds) {
    return (
      <section className="border-t border-border pt-6" aria-labelledby="upper-range-title">
        <p className="text-xs font-medium text-primary">UPPER-RANGE LADDER</p>
        <h3 id="upper-range-title" className="mt-1 text-xl font-semibold">
          One semitone at a time
        </h3>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Complete a comfortable-range check before using this exercise. Nightingale will not guess
          or widen missing range bounds.
        </p>
      </section>
    );
  }

  const canStart =
    active && microphoneActive && deviceId.trim() !== "" && phase === "idle" && endReason == null;

  return (
    <section className="border-t border-border pt-6" aria-labelledby="upper-range-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-primary">UPPER-RANGE LADDER</p>
          <h3 id="upper-range-title" className="mt-1 text-xl font-semibold">
            One semitone at a time
          </h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Match one gentle reference tone, then report comfort and effort. Pitch detection
            measures only the note—it cannot judge strain or explain what your voice is doing
            internally.
          </p>
        </div>
        <div className="text-right">
          <p className="text-3xl font-semibold tabular-nums">{midiNoteName(targetMidi)}</p>
          <p className="text-xs tabular-nums text-muted-foreground">
            {Math.round(midiToHz(targetMidi))} Hz · saved limit{" "}
            {midiNoteName(normalizedBounds.highMidi)}
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(15rem,20rem)_1fr]">
        <div className="border-y border-border py-4">
          <p className="text-sm font-medium">Safe sequence</p>
          <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
            <li>1. Listen to the reference.</li>
            <li>2. Echo it once on a gentle “woo.”</li>
            <li>3. Rate comfort and effort before moving.</li>
          </ol>
          <p className="mt-4 flex gap-2 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            Do not add volume or chase the note. Pain, strain, rawness, or hoarseness ends the
            ladder.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            This practice never changes or expands your saved comfortable range.
          </p>
        </div>

        <div className="min-w-0">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!active || phase === "capturing" || endReason != null}
              onClick={() => playReferenceTone(targetMidi)}
            >
              <Volume2 className="size-4" /> Play {midiNoteName(targetMidi)}
            </Button>
            <Button type="button" disabled={!canStart} onClick={startAttempt}>
              <Mic2 className="size-4" /> Measure one attempt
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={resetLadder}
              disabled={phase === "capturing" || endReason === "safety"}
            >
              <RotateCcw className="size-4" /> Reset to start
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!active || endReason != null}
              onClick={() => applyReflection(1, 5, true)}
            >
              Stop: pain, strain, or hoarse
            </Button>
          </div>

          {!microphoneActive && (
            <p className="mt-4 text-sm text-destructive">
              Turn on the microphone to measure pitch.
            </p>
          )}
          {microphoneActive && deviceId.trim() === "" && (
            <p className="mt-4 text-sm text-destructive">Choose a microphone before starting.</p>
          )}

          {phase === "capturing" && (
            <div className="mt-5 max-w-xl" aria-live="polite">
              <p className="text-sm text-primary">
                Listening for {midiNoteName(targetMidi)}… keep the attempt gentle.
              </p>
              <Progress value={captureProgress} className="mt-2 h-1.5 rounded-none" />
            </div>
          )}

          <p
            className="mt-5 border-l-2 border-primary pl-3 text-sm"
            role="status"
            aria-live="polite"
          >
            {status}
          </p>

          {phase === "reflecting" && evidence && (
            <div className="mt-5 border-y border-border py-5">
              <p className="text-sm font-medium">Reflection required</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {evidenceMessage(evidence)} The ladder cannot advance until both ratings are
                recorded.
              </p>

              <fieldset className="mt-5">
                <legend className="text-sm font-medium">Comfort after the note</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {RATINGS.map((rating) => (
                    <Button
                      key={`comfort-${rating}`}
                      type="button"
                      size="sm"
                      variant={comfort === rating ? "default" : "outline"}
                      aria-pressed={comfort === rating}
                      onClick={() => setComfort(rating)}
                    >
                      {rating}
                    </Button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  1 = very uncomfortable · 5 = fully comfortable
                </p>
              </fieldset>

              <fieldset className="mt-5">
                <legend className="text-sm font-medium">Effort after the note</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {RATINGS.map((rating) => (
                    <Button
                      key={`effort-${rating}`}
                      type="button"
                      size="sm"
                      variant={effort === rating ? "default" : "outline"}
                      aria-pressed={effort === rating}
                      onClick={() => setEffort(rating)}
                    >
                      {rating}
                    </Button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">1 = easy · 5 = maximum effort</p>
              </fieldset>

              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={comfort == null || effort == null}
                  onClick={() => {
                    if (comfort != null && effort != null) applyReflection(comfort, effort);
                  }}
                >
                  <Check className="size-4" /> Save reflection and decide
                </Button>
                <Button type="button" variant="outline" onClick={() => applyReflection(2, 4)}>
                  <ArrowDown className="size-4" /> Hard—save and step down
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
