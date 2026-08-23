import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMicSamples } from "@/hooks/use-mic-samples";
import {
  encodeMonoWav,
  extractAcousticFeatureSummary,
} from "@/lib/learning/acoustic-feature-extractor";
import {
  assessTechniqueSafety,
  compareRelativeBrightness,
  rankCoachingCues,
  STARTER_COACHING_CUES,
  type AcousticFeatureSummary,
  type TechniqueReflection,
} from "@/lib/learning/technique-coaching";
import { Mic2, Play, RotateCcw, ShieldAlert, Sparkles, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CaptureKind = "baseline" | "comparison";
type TechniqueLanguage = "en" | "ja";

interface CapturedAttempt {
  features: AcousticFeatureSummary;
  audioUrl: string;
}

interface TechniqueLabProps {
  active: boolean;
  inactiveReason?: string;
  microphoneActive: boolean;
  deviceId: string;
  latestPitchHz: number | null;
  targetMidi: number;
  reflections: readonly TechniqueReflection[];
  onReflection: (reflection: TechniqueReflection) => void;
}

const VOWELS = [
  { id: "ah", label: "ah / あ" },
  { id: "ee", label: "ee / い" },
  { id: "oo", label: "oo / う" },
  { id: "eh", label: "eh / え" },
  { id: "oh", label: "oh / お" },
] as const;

const TECHNIQUE_CUES = STARTER_COACHING_CUES.filter((cue) =>
  ["vowel_shape", "tongue_release", "jaw_release", "lip_coordination", "diction"].includes(
    cue.domain,
  ),
);

function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function playReferenceTone(midi: number): void {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime + 0.04;
  oscillator.type = "sine";
  oscillator.frequency.value = midiHz(midi);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.14, start + 0.03);
  gain.gain.setValueAtTime(0.14, start + 0.65);
  gain.gain.linearRampToValueAtTime(0, start + 0.78);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.8);
  oscillator.addEventListener("ended", () => void context.close());
}

function playCapture(url: string): void {
  const audio = new Audio(url);
  void audio.play();
}

function brightnessLabel(result: ReturnType<typeof compareRelativeBrightness>): string {
  if (result.result === "unmeasurable") {
    return "These takes were too different to compare fairly. Match the pitch, vowel, and easy volume, then retry.";
  }
  if (result.result === "similar") return "The two takes had a similar sound color.";
  return `The second take sounded relatively ${result.result}. This describes sound color, not correctness.`;
}

export function TechniqueLab({
  active,
  inactiveReason,
  microphoneActive,
  deviceId,
  latestPitchHz,
  targetMidi,
  reflections,
  onReflection,
}: TechniqueLabProps) {
  const [language, setLanguage] = useState<TechniqueLanguage>("en");
  const [vowel, setVowel] = useState("ah");
  const rankedCues = useMemo(() => rankCoachingCues(TECHNIQUE_CUES, reflections), [reflections]);
  const [selectedCueId, setSelectedCueId] = useState(
    () =>
      rankedCues.find(({ safetySuppressed }) => !safetySuppressed)?.cue.id ??
      "vowel-small-rounding",
  );
  const selectedRankedCue = rankedCues.find(({ cue }) => cue.id === selectedCueId);
  const selectedCue = selectedRankedCue?.cue ?? rankedCues[0]?.cue;
  const selectedCueSafetySuppressed = selectedRankedCue?.safetySuppressed ?? false;
  const [capturing, setCapturing] = useState<CaptureKind | null>(null);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [baseline, setBaseline] = useState<CapturedAttempt | null>(null);
  const [comparison, setComparison] = useState<CapturedAttempt | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [safetyMessage, setSafetyMessage] = useState<string | null>(null);
  const [sessionSafetyStopped, setSessionSafetyStopped] = useState(false);
  const samplesRef = useRef<number[]>([]);
  const pitchesRef = useRef<number[]>([]);
  const sampleRateRef = useRef(0);
  const captureStartedRef = useRef(0);
  const urlsRef = useRef(new Set<string>());
  const currentSessionStopCueRef = useRef<string | null>(null);

  useMicSamples(
    (frame) => {
      if (!capturing) return;
      sampleRateRef.current = frame.sample_rate;
      samplesRef.current.push(...frame.samples);
      if (latestPitchHz != null && Number.isFinite(latestPitchHz)) {
        pitchesRef.current.push(latestPitchHz);
      }
    },
    active && capturing != null,
  );

  const releaseCapture = useCallback((attempt: CapturedAttempt | null) => {
    if (!attempt) return;
    URL.revokeObjectURL(attempt.audioUrl);
    urlsRef.current.delete(attempt.audioUrl);
  }, []);

  const resetCaptures = useCallback(() => {
    releaseCapture(baseline);
    releaseCapture(comparison);
    setBaseline(null);
    setComparison(null);
    setCaptureError(null);
    setSafetyMessage(null);
  }, [baseline, comparison, releaseCapture]);

  useEffect(() => {
    if (!selectedCueSafetySuppressed) return;
    resetCaptures();
    if (currentSessionStopCueRef.current !== selectedCueId) {
      const safeFallback = rankedCues.find(({ safetySuppressed }) => !safetySuppressed)?.cue;
      if (safeFallback && safeFallback.id !== selectedCueId) setSelectedCueId(safeFallback.id);
      return;
    }
    setSafetyMessage(
      (current) =>
        current ??
        "Technique session ended after your stop signal. Rest before starting a new session later.",
    );
    setSessionSafetyStopped(true);
  }, [rankedCues, resetCaptures, selectedCueId, selectedCueSafetySuppressed]);

  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!capturing) return;
    const progressTimer = window.setInterval(() => {
      const elapsed = performance.now() - captureStartedRef.current;
      setCaptureProgress(Math.min(100, (elapsed / 2_200) * 100));
    }, 50);
    const finishTimer = window.setTimeout(() => {
      const samples = samplesRef.current;
      const sampleRate = sampleRateRef.current;
      const features = extractAcousticFeatureSummary({
        deviceId,
        vowel,
        samples,
        sampleRate,
        pitchHz: pitchesRef.current,
      });
      const blob = encodeMonoWav(samples, sampleRate);
      if (!features || !blob) {
        setCaptureError(
          "Couldn’t measure that take. Use one steady vowel at an easy volume and avoid clipping.",
        );
      } else {
        const audioUrl = URL.createObjectURL(blob);
        urlsRef.current.add(audioUrl);
        const attempt = { features, audioUrl };
        if (capturing === "baseline") {
          releaseCapture(baseline);
          setBaseline(attempt);
          releaseCapture(comparison);
          setComparison(null);
        } else {
          releaseCapture(comparison);
          setComparison(attempt);
        }
        setCaptureError(null);
      }
      samplesRef.current = [];
      pitchesRef.current = [];
      sampleRateRef.current = 0;
      setCaptureProgress(100);
      setCapturing(null);
    }, 2_200);
    return () => {
      window.clearInterval(progressTimer);
      window.clearTimeout(finishTimer);
    };
  }, [baseline, capturing, comparison, deviceId, releaseCapture, vowel]);

  useEffect(() => {
    if (active || !capturing) return;
    samplesRef.current = [];
    pitchesRef.current = [];
    sampleRateRef.current = 0;
    setCaptureProgress(0);
    setCapturing(null);
  }, [active, capturing]);

  const startCapture = (kind: CaptureKind) => {
    if (
      !active ||
      !microphoneActive ||
      capturing ||
      selectedCueSafetySuppressed ||
      sessionSafetyStopped
    ) {
      return;
    }
    samplesRef.current = [];
    pitchesRef.current = [];
    sampleRateRef.current = 0;
    captureStartedRef.current = performance.now();
    setCaptureError(null);
    setCaptureProgress(0);
    setCapturing(kind);
  };

  const brightness =
    baseline && comparison
      ? compareRelativeBrightness(baseline.features, comparison.features)
      : null;

  const reflect = (
    helpfulness: TechniqueReflection["helpfulness"],
    comfortAfter: TechniqueReflection["comfortAfter"],
    effortAfter: TechniqueReflection["effortAfter"],
    stop = false,
  ) => {
    if (!selectedCue || (sessionSafetyStopped && !stop)) return;
    const reflection: TechniqueReflection = {
      cueId: selectedCue.id,
      recordedAt: Date.now(),
      comfortBefore: 4,
      comfortAfter,
      effortAfter,
      helpfulness,
      successfulOutcome: !stop && helpfulness === "helped" && brightness?.result !== "unmeasurable",
      stopSignals: stop ? ["strain"] : [],
    };
    const safety = assessTechniqueSafety(reflection);
    if (!safety.mayContinue) {
      currentSessionStopCueRef.current = selectedCue.id;
      setSessionSafetyStopped(true);
    }
    setSafetyMessage(safety.message[language]);
    onReflection(reflection);
  };

  const stopForSafety = () => {
    if (!active || sessionSafetyStopped) return;
    samplesRef.current = [];
    pitchesRef.current = [];
    sampleRateRef.current = 0;
    setCaptureProgress(0);
    setCapturing(null);
    reflect("made_harder", 1, 5, true);
  };

  if (!selectedCue) return null;

  const controlsReason = !active
    ? (inactiveReason ?? "Finish the current singing exercise before using Voice Color Lab.")
    : !microphoneActive
      ? "Choose an available microphone above before recording a comparison."
      : null;

  return (
    <section className="border-t border-border pt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-primary">VOICE COLOR LAB</p>
          <h3 className="mt-1 text-xl font-semibold">Compare one small change</h3>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Keep the pitch, vowel, microphone, and easy volume the same. Nightingale compares only
            relative sound color—it cannot see your tongue or diagnose tension.
          </p>
        </div>
        <div className="flex gap-2">
          <Select
            value={language}
            onValueChange={(value) => setLanguage(value as TechniqueLanguage)}
          >
            <SelectTrigger className="w-32" aria-label="Coaching language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="ja">日本語</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={vowel}
            disabled={!active || capturing != null || sessionSafetyStopped}
            onValueChange={(value) => {
              setVowel(value);
              resetCaptures();
            }}
          >
            <SelectTrigger className="w-28" aria-label="Practice vowel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VOWELS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[18rem_1fr]">
        <div className="border-y border-border">
          {rankedCues.map(({ cue, safetySuppressed }) => (
            <button
              key={cue.id}
              type="button"
              aria-pressed={cue.id === selectedCue.id}
              aria-describedby={controlsReason ? "technique-lab-controls-status" : undefined}
              disabled={!active || safetySuppressed || capturing != null || sessionSafetyStopped}
              onClick={() => {
                setSelectedCueId(cue.id);
                resetCaptures();
              }}
              className={`w-full border-b border-border px-3 py-3 text-left last:border-b-0 ${
                cue.id === selectedCue.id ? "bg-muted" : "hover:bg-muted/50"
              } disabled:opacity-40`}
            >
              <span className="block text-sm font-medium">{cue.title[language]}</span>
              <span className="mt-1 block text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                {cue.evidenceKind.replace("_", " ")}
              </span>
            </button>
          ))}
        </div>

        <div className="min-w-0">
          <div className="border-l-2 border-primary pl-4">
            <p className="text-sm font-medium">Try</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {selectedCue.instruction[language]}
            </p>
            <p className="mt-3 text-sm font-medium">Notice</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {selectedCue.selfCheck[language]}
            </p>
            <p className="mt-3 flex gap-2 text-xs text-amber-700 dark:text-amber-300">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              {selectedCue.safetyNote[language]}
            </p>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              aria-describedby={controlsReason ? "technique-lab-controls-status" : undefined}
              disabled={!active || selectedCueSafetySuppressed || sessionSafetyStopped}
              onClick={() => playReferenceTone(targetMidi)}
            >
              <Volume2 className="size-4" /> Play comfortable target
            </Button>
            <Button
              type="button"
              aria-describedby={controlsReason ? "technique-lab-controls-status" : undefined}
              disabled={
                !active ||
                !microphoneActive ||
                capturing != null ||
                selectedCueSafetySuppressed ||
                sessionSafetyStopped
              }
              onClick={() => startCapture("baseline")}
            >
              <Mic2 className="size-4" /> {baseline ? "Retake baseline" : "Record baseline"}
            </Button>
            <Button
              type="button"
              variant={baseline ? "default" : "outline"}
              aria-describedby={controlsReason ? "technique-lab-controls-status" : undefined}
              disabled={
                !active ||
                !baseline ||
                !microphoneActive ||
                capturing != null ||
                selectedCueSafetySuppressed ||
                sessionSafetyStopped
              }
              onClick={() => startCapture("comparison")}
            >
              <Sparkles className="size-4" /> {comparison ? "Retake experiment" : "Try the cue"}
            </Button>
            {(baseline || comparison) && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetCaptures}
                disabled={capturing != null || sessionSafetyStopped}
              >
                <RotateCcw className="size-4" /> Reset
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={!active || sessionSafetyStopped}
              onClick={stopForSafety}
            >
              <ShieldAlert className="size-3.5" /> Stop: pain, strain, or hoarseness
            </Button>
          </div>

          {controlsReason && (
            <p
              id="technique-lab-controls-status"
              className="mt-3 text-xs text-muted-foreground"
              role="status"
            >
              {controlsReason}
            </p>
          )}

          {capturing && (
            <div className="mt-4 max-w-xl" aria-live="polite">
              <p className="text-sm text-primary">
                Hold one easy {vowel} vowel… recording {capturing}.
              </p>
              <Progress value={captureProgress} className="mt-2 h-1.5 rounded-none" />
            </div>
          )}
          {captureError && <p className="mt-4 text-sm text-destructive">{captureError}</p>}

          {(baseline || comparison) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {baseline && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => playCapture(baseline.audioUrl)}
                >
                  <Play className="size-3.5" /> A: baseline
                </Button>
              )}
              {comparison && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => playCapture(comparison.audioUrl)}
                >
                  <Play className="size-3.5" /> B: experiment
                </Button>
              )}
            </div>
          )}

          {brightness && (
            <div className="mt-5 border-y border-border py-4" aria-live="polite">
              <p className="text-sm font-medium">{brightnessLabel(brightness)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Your preference and comfort matter more than this microphone-based proxy.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={sessionSafetyStopped}
                  onClick={() => reflect("helped", 5, 1)}
                >
                  Helped and easy
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={sessionSafetyStopped}
                  onClick={() => reflect("no_change", 4, 2)}
                >
                  Felt the same
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={sessionSafetyStopped}
                  onClick={() => reflect("made_harder", 2, 4)}
                >
                  Harder or unclear
                </Button>
              </div>
            </div>
          )}
          {safetyMessage && (
            <p className="mt-4 border-l-2 border-amber-500 pl-3 text-sm" role="status">
              {safetyMessage}
            </p>
          )}
          {sessionSafetyStopped && (
            <p className="mt-2 text-xs text-muted-foreground">
              All voice-color controls are locked for this session. Leave Skills and return only
              after your voice feels normal again.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
