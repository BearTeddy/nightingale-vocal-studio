import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { RecordingPreview } from "@/components/studio/recording-preview";
import { VoiceRangeScale } from "@/components/studio/voice-range-scale";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { microphoneAdapter } from "@/bridge/microphone";
import {
  exportRecording,
  listPracticeSessions,
  loadRecordingTake,
  savePracticeSession,
  startVocalRecording,
  stopVocalRecording,
} from "@/bridge/recording";
import { ensurePlayableSourceVideo } from "@/bridge/playback";
import { openMediaPath, revealItemInDir } from "@/bridge/opener";
import { useMicCapture, useMicPitch } from "@/hooks/use-mic-pitch";
import { useStudioNavigation } from "@/hooks/navigation/use-studio-navigation";
import { useRecordingPreview } from "@/hooks/use-recording-preview";
import {
  assessIntervalAnswer,
  assessSungPitch,
  INTERVAL_CHOICES,
  intervalChoice,
  listeningScores,
  nextInterval,
  shouldAutoStartListeningCapture,
  type IntervalAnswer,
  type SungPitchAttempt,
} from "@/lib/interval-listening";
import { buildListeningSession } from "@/lib/listening-session";
import { recordingsDirectoryFromDataPath } from "@/lib/recording-path";
import { canRecoverRecordingMix } from "@/lib/recording-recovery";
import { diagnoseMicInput } from "@/lib/mic/input-diagnostic";
import { DEFAULT_MIC_LATENCY_COMPENSATION_SEC } from "@/lib/pitch/constants";
import { freqToSemitone, VisualPitchTracker } from "@/lib/pitch/state";
import { createVocalFeedback } from "@/lib/vocal-feedback";
import {
  latestVoiceProfileFromSessions,
  loadStoredVoiceProfile,
  mostRecentVoiceProfile,
  saveStoredVoiceProfile,
  type VoiceProfile,
} from "@/lib/voice-profile";
import { planStudioBackAction, planStudioTabChange, type StudioTab } from "@/lib/studio-navigation";
import { useConfigMutation } from "@/mutations/use-config-mutation";
import {
  adaptExercisePace,
  adaptExerciseToRange,
  analyzeExercise,
  exerciseScoringTargetAt,
  exerciseStepAt,
  exerciseTotalSeconds,
  type ExerciseFrame,
  type ExercisePhase,
  type ExerciseResult,
} from "@/lib/vocal-exercise";
import {
  adaptiveCheckupBaseMidi,
  analyzeVocalCheckup,
  canCompleteVocalCheckup,
  CHECKUP_DURATION_SECONDS,
  checkupSessionDuration,
  checkupStageAt,
  vocalCheckupScore,
  type CheckupFrame,
  type VocalCheckupScores,
} from "@/lib/vocal-checkup";
import { useConfig } from "@/queries/use-config";
import { useMicDevices } from "@/queries/use-mic-devices";
import { useProfiles } from "@/queries/use-profiles";
import type { PracticeSession, SavePracticeSession } from "@/types/PracticeSession";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { PitchFrame } from "@/types/PitchFrame";
import type { RecordingTake } from "@/types/RecordingTake";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Dumbbell,
  Ear,
  History,
  LibraryBig,
  Mic2,
  Music2,
  Pause,
  FolderOpen,
  Play,
  RefreshCw,
  Square,
  Video,
  Volume2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

const SYSTEM_DEFAULT_MIC = "__system_default__";

function exerciseScoresFromSessions(sessions: PracticeSession[]): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const session of sessions) {
    if (!session.kind.startsWith("exercise:")) continue;
    const exerciseId = session.kind.slice("exercise:".length);
    if (!exerciseId || scores[exerciseId] != null || !session.performance_json) continue;
    try {
      const payload = JSON.parse(session.performance_json) as {
        score?: unknown;
        completed?: unknown;
      };
      if (payload.completed === false) continue;
      if (typeof payload.score === "number" && Number.isFinite(payload.score)) {
        scores[exerciseId] = payload.score;
      }
    } catch {
      // Older sessions with invalid payloads do not affect adaptive pacing.
    }
  }
  return scores;
}

const CHECKUP_SCORE_KEYS = [
  "microphoneScore",
  "pitchMatchScore",
  "intervalMatchScore",
  "stabilityScore",
  "sustainScore",
  "rhythmScore",
] as const satisfies ReadonlyArray<keyof VocalCheckupScores>;

function sessionScore(session: PracticeSession): number | null {
  if (!session.performance_json) return null;
  try {
    const parsed = JSON.parse(session.performance_json) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const payload = parsed as Record<string, unknown>;
    const directScore = payload.score ?? payload.overall;
    if (typeof directScore === "number" && Number.isFinite(directScore)) {
      return Math.round(Math.max(0, Math.min(100, directScore)));
    }
    if (
      session.kind === "voice-checkup" &&
      CHECKUP_SCORE_KEYS.every(
        (key) => typeof payload[key] === "number" && Number.isFinite(payload[key]),
      )
    ) {
      return vocalCheckupScore(payload as VocalCheckupScores);
    }
  } catch {
    // Invalid legacy payloads remain visible without a score.
  }
  return null;
}

interface Exercise {
  id: string;
  title: string;
  category: string;
  instruction: string;
  pattern: number[];
  secondsPerNote: number;
  mode?: "sing" | "call-response" | "listening";
}

interface ActiveExerciseRun {
  exercise: Exercise;
  baseMidi: number;
  pattern: number[];
  secondsPerNote: number;
  totalSeconds: number;
  startedAt: number;
  profile: string;
  previousScore: number | null;
}

const EXERCISES: Exercise[] = [
  {
    id: "center",
    title: "Center the note",
    category: "Pitch",
    instruction: "Match each piano tone cleanly and hold it without sliding in.",
    pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0],
    secondsPerNote: 0.85,
  },
  {
    id: "listening",
    title: "Hear, sing, and name",
    category: "Listening",
    instruction:
      "Hear two notes, sing the second note back for pitch feedback, then name the distance.",
    pattern: [],
    secondsPerNote: 1,
    mode: "listening",
  },
  {
    id: "intervals",
    title: "Interval echo",
    category: "Ear training",
    instruction: "Nightingale plays each note first. Echo it only when the sing cue appears.",
    pattern: [0, 4, 0, 7, 0, 5, 2, 0],
    secondsPerNote: 1,
    mode: "call-response",
  },
  {
    id: "scale",
    title: "Five-note scale",
    category: "Scales",
    instruction: "Keep every vowel consistent while the pitch moves step by step.",
    pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0],
    secondsPerNote: 0.65,
  },
  {
    id: "arpeggio",
    title: "Arpeggio balance",
    category: "Scales",
    instruction: "Move through the chord without pushing the upper notes louder.",
    pattern: [0, 4, 7, 12, 7, 4, 0],
    secondsPerNote: 0.75,
  },
  {
    id: "sustain",
    title: "Steady sustain",
    category: "Breath and stability",
    instruction: "Use an easy volume and keep the vowel steady to the end.",
    pattern: [0, 0, 0, 0, 0, 0],
    secondsPerNote: 1,
  },
  {
    id: "slides",
    title: "Controlled slides",
    category: "Pitch movement",
    instruction: "Connect the notes smoothly while arriving exactly at each target.",
    pattern: [0, 5, 2, 7, 4, 0],
    secondsPerNote: 1.1,
  },
  {
    id: "dynamics",
    title: "Even dynamics",
    category: "Expression",
    instruction: "Sing softly, grow gradually, then return without losing pitch.",
    pattern: [0, 0, 0, 0, 0],
    secondsPerNote: 1,
  },
  {
    id: "vibrato",
    title: "Straight tone to vibrato",
    category: "Technique",
    instruction: "Begin straight and allow a small, even vibrato only in the second half.",
    pattern: [0, 0, 0, 0, 0, 0],
    secondsPerNote: 1,
  },
];

const TABS: Array<{ id: StudioTab; label: string; icon: typeof Activity }> = [
  { id: "checkup", label: "Checkup", icon: Activity },
  { id: "exercises", label: "Exercises", icon: Dumbbell },
  { id: "songs", label: "Song Practice", icon: LibraryBig },
  { id: "history", label: "History", icon: History },
];

function midiName(midi: number | null): string {
  if (midi == null || !Number.isFinite(midi)) return "--";
  const rounded = Math.round(midi);
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function sessionLabel(session: PracticeSession): string {
  if (session.kind === "karaoke") return "Karaoke";
  if (session.kind === "voice-checkup") return "Voice checkup";
  if (session.kind === "recovered-recording") return "Recovered vocal";
  if (session.kind.startsWith("exercise:")) {
    if (session.performance_json) {
      try {
        const payload = JSON.parse(session.performance_json) as {
          exercise?: unknown;
          completed?: unknown;
        };
        if (typeof payload.exercise === "string" && payload.exercise.trim()) {
          const suffix = payload.completed === false ? " (partial)" : "";
          return `Exercise: ${payload.exercise.trim()}${suffix}`;
        }
      } catch {
        // Invalid legacy payloads fall back to the stable exercise id.
      }
    }
    const name = session.kind.slice("exercise:".length).replace(/-/g, " ");
    return `Exercise: ${name}`;
  }
  return session.kind;
}

function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function scheduleTone(
  context: AudioContext,
  midi: number,
  start: number,
  duration: number,
  level = 0.16,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = midiHz(midi);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.025);
  gain.gain.setValueAtTime(level, start + Math.max(0.03, duration - 0.08));
  gain.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function SignalStrip({
  frame,
  active,
  captureActive,
  targetMidi,
  error,
  captureStatus,
}: {
  frame: PitchFrame | null;
  active: boolean;
  captureActive: boolean;
  targetMidi: number | null;
  error: string | null;
  captureStatus: MicCaptureStatus | null;
}) {
  const feedback = createVocalFeedback(frame, active, targetMidi);
  const diagnostic = diagnoseMicInput(captureStatus, captureActive);
  const cents = feedback.cents == null ? null : Math.max(-100, Math.min(100, feedback.cents));
  const markerPosition = cents == null ? 50 : ((cents + 100) / 200) * 100;
  const onTarget = targetMidi != null && feedback.cents != null && Math.abs(feedback.cents) <= 25;
  const statusClass =
    feedback.state === "clipping"
      ? "text-destructive"
      : onTarget
        ? "text-emerald-500"
        : targetMidi != null && feedback.state === "tracking"
          ? "text-amber-500"
          : "text-foreground";
  const markerClass =
    feedback.state === "clipping"
      ? "bg-destructive"
      : onTarget || (targetMidi == null && feedback.state === "tracking")
        ? "bg-emerald-500"
        : "bg-amber-400";

  return (
    <div className="border-y border-border py-3">
      <div className="grid items-center gap-3 sm:grid-cols-[8rem_minmax(10rem,1fr)_6rem]">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Mic2 className="size-4" /> {active ? "Mic live" : "Mic idle"}
        </span>
        <div className="min-w-0">
          <div className="mb-1 flex justify-between text-[0.625rem] text-muted-foreground">
            <span>INPUT LEVEL</span>
            <span className="tabular-nums">{feedback.level}%</span>
          </div>
          <Progress value={feedback.level} className="h-2 rounded-none" />
        </div>
        <div className="text-left sm:text-right">
          <p className="text-[0.625rem] text-muted-foreground">HEARD</p>
          <p className="text-lg font-medium tabular-nums">{midiName(frame?.midi ?? null)}</p>
        </div>
      </div>

      <div className="mt-4 grid items-center gap-3 lg:grid-cols-[14rem_minmax(14rem,1fr)_9rem]">
        <div className="h-11 min-w-0" aria-live="polite" aria-atomic="true">
          <p className={`truncate text-sm font-medium ${statusClass}`} title={feedback.headline}>
            {feedback.headline}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={feedback.instruction}>
            {feedback.instruction}
          </p>
        </div>
        <div className="min-w-0">
          <div className="mb-1 grid h-5 grid-cols-[1fr_auto_1fr] items-center text-[0.625rem] text-muted-foreground">
            <span>LOWER</span>
            <span className="px-2 font-semibold text-foreground tabular-nums">
              {targetMidi == null ? "YOUR NOTE" : `TARGET ${midiName(targetMidi)}`}
            </span>
            <span className="text-right">HIGHER</span>
          </div>
          <div
            role="meter"
            aria-label={targetMidi == null ? "Pitch center" : "Distance from target pitch"}
            aria-valuemin={-100}
            aria-valuemax={100}
            aria-valuenow={feedback.cents ?? undefined}
            className="relative h-4 overflow-hidden bg-muted"
          >
            <div className="absolute inset-y-0 left-[37.5%] w-1/4 bg-emerald-500/20" />
            <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" />
            {feedback.cents != null && (
              <div
                className={`absolute inset-y-0 w-1.5 -translate-x-1/2 transition-[left] ${markerClass}`}
                style={{ left: `${markerPosition}%` }}
              />
            )}
          </div>
          <div className="mt-1 grid grid-cols-3 text-[0.625rem] text-muted-foreground">
            <span>100c low</span>
            <span className="text-center">center</span>
            <span className="text-right">100c high</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-right lg:grid-cols-1 lg:gap-1">
          <p className="text-xs text-muted-foreground">
            Confidence <span className="text-foreground tabular-nums">{feedback.confidence}%</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {feedback.match == null ? "Target --" : "Live match"}{" "}
            <span className="text-foreground tabular-nums">
              {feedback.match == null ? "" : `${feedback.match}%`}
            </span>
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 border-t border-border text-xs sm:grid-cols-6">
        {[
          ["STREAM", diagnostic.label, diagnostic.detail],
          [
            "FORMAT",
            captureStatus?.sample_rate
              ? `${(captureStatus.sample_rate / 1000).toFixed(1)} kHz`
              : "--",
            "Native mono capture",
          ],
          [
            "RMS",
            diagnostic.rmsDb == null ? "--" : `${diagnostic.rmsDb.toFixed(1)} dB`,
            "Current input energy",
          ],
          ["PEAK", `${diagnostic.peakPercent}%`, "Current input peak"],
          [
            "PITCH",
            captureStatus
              ? `${captureStatus.pitch_frames} / ${captureStatus.pitch_errors}`
              : "-- / --",
            "Native analysis frames / errors",
          ],
          [
            "IPC",
            captureStatus
              ? `${captureStatus.sent_frames} / ${captureStatus.send_errors}`
              : "-- / --",
            "Frames / errors",
          ],
        ].map(([label, value, title]) => (
          <div
            key={label}
            className="min-w-0 border-b border-border px-2 py-2 sm:border-b-0 sm:border-r last:border-r-0"
          >
            <p className="text-[0.625rem] text-muted-foreground">{label}</p>
            <p className="mt-0.5 truncate font-medium tabular-nums" title={title}>
              {value}
            </p>
          </div>
        ))}
      </div>
      {error && (
        <p className="mt-3 text-sm text-destructive" role="alert">
          Microphone unavailable: {error}
        </p>
      )}
    </div>
  );
}

export function VocalStudioPage() {
  const navigate = useNavigate();
  const studioRef = useRef<HTMLElement | null>(null);
  const { data: config } = useConfig();
  const { data: profiles } = useProfiles();
  const activeProfile = profiles?.active ?? "Guest";
  const profilesLoaded = profiles != null;
  const micDevices = useMicDevices();
  const { mutate: updateConfig, isLoading: inputChanging } = useConfigMutation();
  const [tab, setTab] = useState<StudioTab>("checkup");
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile | null>(null);
  const [checkupRunning, setCheckupRunning] = useState(false);
  const [checkupSeconds, setCheckupSeconds] = useState(CHECKUP_DURATION_SECONDS);
  const [checkupElapsed, setCheckupElapsed] = useState(0);
  const checkupFrames = useRef<CheckupFrame[]>([]);
  const checkupStarted = useRef(0);
  const checkupContext = useRef<AudioContext | null>(null);
  const checkupFinishing = useRef(false);
  const checkupCuesScheduled = useRef(false);
  const [history, setHistory] = useState<PracticeSession[]>([]);
  const recordingPreview = useRecordingPreview();
  const [historyTakes, setHistoryTakes] = useState<Record<string, RecordingTake>>({});
  const [recoveringTakeId, setRecoveringTakeId] = useState<string | null>(null);
  const [exerciseHistoryScores, setExerciseHistoryScores] = useState<Record<string, number>>({});
  const [selectedExercise, setSelectedExercise] = useState(EXERCISES[0]);
  const [runningExercise, setRunningExercise] = useState<string | null>(null);
  const [exercisePhase, setExercisePhase] = useState<ExercisePhase | null>(null);
  const [exerciseStopping, setExerciseStopping] = useState(false);
  const [exerciseNoteMidi, setExerciseNoteMidi] = useState<number | null>(null);
  const [targetMidi, setTargetMidi] = useState<number | null>(null);
  const [exerciseScore, setExerciseScore] = useState<number | null>(null);
  const [exerciseResult, setExerciseResult] = useState<ExerciseResult | null>(null);
  const [exerciseCompleted, setExerciseCompleted] = useState<boolean | null>(null);
  const [recordExercises, setRecordExercises] = useState(true);
  const [exerciseTake, setExerciseTake] = useState<RecordingTake | null>(null);
  const exerciseContext = useRef<AudioContext | null>(null);
  const exerciseTimer = useRef<number | null>(null);
  const exerciseStart = useRef(0);
  const exerciseFrames = useRef<ExerciseFrame[]>([]);
  const activeExerciseRun = useRef<ActiveExerciseRun | null>(null);
  const exerciseRecording = useRef<Promise<RecordingTake | null> | null>(null);
  const exerciseRecordingStop = useRef<Promise<RecordingTake | null> | null>(null);
  const visualPitchTracker = useRef(new VisualPitchTracker());
  const visualPitchSource = useRef<PitchFrame | null | undefined>(undefined);
  const [listeningQuestion, setListeningQuestion] = useState<{
    baseMidi: number;
    semitones: number;
  } | null>(null);
  const [listeningReady, setListeningReady] = useState(false);
  const [listeningAnswer, setListeningAnswer] = useState<IntervalAnswer | null>(null);
  const [listeningAnswers, setListeningAnswers] = useState<IntervalAnswer[]>([]);
  const [listeningSungAttempts, setListeningSungAttempts] = useState<
    Array<SungPitchAttempt | null>
  >([]);
  const [listeningSingSeconds, setListeningSingSeconds] = useState(0);
  const [listeningSingResult, setListeningSingResult] = useState<SungPitchAttempt | null>(null);
  const [listeningSingError, setListeningSingError] = useState<string | null>(null);
  const listeningSingFrames = useRef<PitchFrame[]>([]);
  const listeningSingStarted = useRef(0);
  const listeningSingAttempted = useRef(false);
  const listeningSetStartedAt = useRef<number | null>(null);

  const baseMidi = useMemo(() => {
    if (!voiceProfile) return 60;
    return Math.round((voiceProfile.lowMidi + voiceProfile.highMidi) / 2) - 3;
  }, [voiceProfile]);
  const [checkupBaseMidi, setCheckupBaseMidi] = useState(baseMidi);
  const checkupBaseMidiRef = useRef(baseMidi);
  const recordingsDirectory = useMemo(
    () => recordingsDirectoryFromDataPath(config?.data_path),
    [config?.data_path],
  );
  const checkupStage = useMemo(
    () => checkupStageAt(checkupElapsed, checkupRunning ? checkupBaseMidi : baseMidi),
    [baseMidi, checkupBaseMidi, checkupElapsed, checkupRunning],
  );
  const selectedPitchPlan = useMemo(
    () =>
      adaptExerciseToRange(
        selectedExercise.pattern,
        baseMidi,
        voiceProfile?.lowMidi ?? null,
        voiceProfile?.highMidi ?? null,
      ),
    [baseMidi, selectedExercise.pattern, voiceProfile],
  );
  const selectedExercisePace = adaptExercisePace(
    selectedExercise.secondsPerNote,
    exerciseHistoryScores[selectedExercise.id] ?? null,
  );
  const checkupHistoryScores = useMemo(
    () =>
      history
        .filter((session) => session.kind === "voice-checkup")
        .map((session) => ({ score: sessionScore(session), startedAt: session.started_at }))
        .filter((entry): entry is { score: number; startedAt: number } => entry.score != null)
        .sort((left, right) => right.startedAt - left.startedAt),
    [history],
  );

  const capture = useMicCapture(
    config?.preferred_mic ?? null,
    true,
    { emit_audio: false },
    microphoneAdapter,
  );
  const { latestFrame, active: pitchActive } = useMicPitch(capture.active);
  if (latestFrame !== visualPitchSource.current) {
    visualPitchTracker.current.update(latestFrame?.voiced ? latestFrame.hz : null);
    visualPitchSource.current = latestFrame;
  }
  const visualPitchHz = visualPitchTracker.current.currentHz();
  const displayPitchFrame = latestFrame
    ? {
        ...latestFrame,
        hz: visualPitchHz,
        midi: visualPitchHz == null ? null : freqToSemitone(visualPitchHz),
        voiced: visualPitchHz != null,
      }
    : null;
  const firstSelectedExerciseMidi =
    selectedPitchPlan.baseMidi + (selectedPitchPlan.pattern[0] ?? 0);
  const visibleExerciseNoteMidi = exerciseNoteMidi ?? firstSelectedExerciseMidi;
  const exerciseDisplayTargetMidi =
    selectedExercise.mode === "listening" ? targetMidi : visibleExerciseNoteMidi;

  useEffect(() => {
    visualPitchTracker.current.reset();
    visualPitchSource.current = undefined;
  }, [capture.active, capture.deviceName]);

  useEffect(() => {
    if (capture.error) toast.error(`Microphone: ${capture.error}`);
  }, [capture.error]);

  useEffect(() => {
    if (checkupRunning && latestFrame) {
      checkupFrames.current.push({
        elapsed_sec: Math.max(0, (performance.now() - checkupStarted.current) / 1000),
        frame: latestFrame,
      });
    }
    if (runningExercise && latestFrame) {
      if (runningExercise === "listening-sing" && targetMidi != null) {
        listeningSingFrames.current.push(latestFrame);
      } else {
        const run = activeExerciseRun.current;
        const elapsedSec = (performance.now() - exerciseStart.current) / 1000;
        const scoringTarget = run
          ? exerciseScoringTargetAt(
              elapsedSec,
              run.pattern,
              run.baseMidi,
              run.secondsPerNote,
              run.exercise.mode === "call-response",
            )
          : null;
        if (scoringTarget != null) {
          exerciseFrames.current.push({
            elapsed_sec: Math.max(0, elapsedSec),
            target_midi: scoringTarget,
            frame: latestFrame,
          });
        }
      }
    }
  }, [checkupRunning, latestFrame, runningExercise, targetMidi]);

  const finishCheckup = useCallback(() => {
    if (checkupFinishing.current) return;
    const elapsedSeconds = Math.max(0, (performance.now() - checkupStarted.current) / 1000);
    checkupFinishing.current = true;
    setCheckupRunning(false);
    setCheckupElapsed(0);
    const context = checkupContext.current;
    checkupContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    if (!canCompleteVocalCheckup(elapsedSeconds)) {
      checkupFrames.current = [];
      setCheckupSeconds(CHECKUP_DURATION_SECONDS);
      toast.info("Checkup cancelled before all measurement stages were complete.");
      return;
    }
    const cueBaseMidi = checkupBaseMidiRef.current;
    const next = analyzeVocalCheckup(checkupFrames.current, cueBaseMidi);
    if (!next) {
      toast.error("Not enough steady voice was detected. Try again closer to the microphone.");
      return;
    }
    const completed: VoiceProfile = { ...next, assessmentComplete: true };
    setVoiceProfile(completed);
    saveStoredVoiceProfile(activeProfile, completed);
    const now = Math.floor(Date.now() / 1000);
    const durationSeconds = checkupSessionDuration(elapsedSeconds);
    const score = vocalCheckupScore(completed);
    const session: SavePracticeSession = {
      id: `checkup-${Date.now()}`,
      profile: activeProfile,
      song_hash: null,
      kind: "voice-checkup",
      started_at: now - durationSeconds,
      ended_at: now,
      performance_json: JSON.stringify({ ...completed, score, durationSeconds, cueBaseMidi }),
      recording_take_id: null,
      transport_segments: [],
    };
    void savePracticeSession(session)
      .then(() =>
        setHistory((current) => [session, ...current.filter((item) => item.id !== session.id)]),
      )
      .catch((error) =>
        toast.error(`Checkup history: ${error instanceof Error ? error.message : String(error)}`),
      );
  }, [activeProfile]);

  useEffect(() => {
    if (!checkupRunning) return;
    setCheckupSeconds(CHECKUP_DURATION_SECONDS);
    const timer = window.setInterval(() => {
      const elapsed = Math.max(0, (performance.now() - checkupStarted.current) / 1000);
      if (!checkupCuesScheduled.current && elapsed >= 10) {
        const measuredRange = checkupFrames.current
          .filter(
            ({ elapsed_sec, frame }) =>
              elapsed_sec >= 3 &&
              elapsed_sec < 10 &&
              frame.voiced &&
              frame.midi != null &&
              frame.clarity >= 0.35,
          )
          .map(({ frame }) => frame.midi as number);
        const cueBaseMidi = adaptiveCheckupBaseMidi(measuredRange, baseMidi);
        checkupBaseMidiRef.current = cueBaseMidi;
        setCheckupBaseMidi(cueBaseMidi);
        const context = checkupContext.current;
        if (context && context.state !== "closed") {
          const timelineTime = (seconds: number) =>
            context.currentTime + Math.max(0.05, seconds - elapsed);
          [0, 4, 7].forEach((offset, index) =>
            scheduleTone(context, cueBaseMidi + offset, timelineTime(11 + index * 2), 0.65),
          );
          scheduleTone(context, cueBaseMidi, timelineTime(17), 0.75);
          for (let index = 0; index < 8; index += 1) {
            scheduleTone(context, cueBaseMidi, timelineTime(23.25 + index * 0.75), 0.12, 0.2);
          }
        }
        checkupCuesScheduled.current = true;
      }
      const remaining = Math.max(0, CHECKUP_DURATION_SECONDS - Math.floor(elapsed));
      setCheckupElapsed(elapsed);
      setCheckupSeconds(remaining);
      if (remaining === 0) finishCheckup();
    }, 200);
    return () => window.clearInterval(timer);
  }, [baseMidi, checkupRunning, finishCheckup]);

  useEffect(() => {
    if (!profilesLoaded) return;
    let cancelled = false;
    const storedProfile = loadStoredVoiceProfile(activeProfile);
    setVoiceProfile(storedProfile);
    setHistory([]);
    setHistoryTakes({});
    setExerciseHistoryScores({});

    void listPracticeSessions(activeProfile)
      .then((sessions) => {
        if (cancelled) return;
        const restoredProfile = latestVoiceProfileFromSessions(sessions);
        const nextProfile = mostRecentVoiceProfile(storedProfile, restoredProfile);
        setVoiceProfile(nextProfile);
        if (nextProfile) saveStoredVoiceProfile(activeProfile, nextProfile);
        setHistory(sessions);
        setExerciseHistoryScores(exerciseScoresFromSessions(sessions));
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(`History: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProfile, profilesLoaded]);

  useEffect(() => {
    if (tab !== "history") return;
    const takeIds = history
      .map((session) => session.recording_take_id)
      .filter((id): id is string => id != null);
    void Promise.all(takeIds.map((id) => loadRecordingTake(id)))
      .then((takes) =>
        setHistoryTakes(
          Object.fromEntries(
            takes
              .filter((take): take is RecordingTake => take != null)
              .map((take) => [take.id, take]),
          ),
        ),
      )
      .catch((error) =>
        toast.error(`Recordings: ${error instanceof Error ? error.message : String(error)}`),
      );
  }, [history, tab]);

  useEffect(() => {
    if (tab !== "history") recordingPreview.stop();
  }, [recordingPreview.stop, tab]);

  const startCheckup = () => {
    if (!capture.active) {
      toast.error(capture.error ?? "The microphone is not ready yet.");
      return;
    }
    const prior = checkupContext.current;
    checkupContext.current = null;
    if (prior && prior.state !== "closed") void prior.close().catch(() => {});
    checkupFrames.current = [];
    checkupFinishing.current = false;
    checkupCuesScheduled.current = false;
    checkupBaseMidiRef.current = baseMidi;
    setCheckupBaseMidi(baseMidi);
    checkupStarted.current = performance.now();
    setCheckupElapsed(0);
    setCheckupSeconds(CHECKUP_DURATION_SECONDS);
    const context = new AudioContext();
    checkupContext.current = context;
    setCheckupRunning(true);
  };

  const cancelCheckup = useCallback(() => {
    checkupFinishing.current = true;
    setCheckupRunning(false);
    setCheckupElapsed(0);
    setCheckupSeconds(CHECKUP_DURATION_SECONDS);
    checkupFrames.current = [];
    checkupCuesScheduled.current = false;
    const context = checkupContext.current;
    checkupContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }, []);

  const stopExerciseRecording = useCallback((): Promise<RecordingTake | null> => {
    if (exerciseRecordingStop.current) return exerciseRecordingStop.current;
    const pending = exerciseRecording.current;
    exerciseRecording.current = null;
    if (!pending) return Promise.resolve(null);

    const stopping = (async () => {
      try {
        const started = await pending;
        if (!started) return null;
        return await stopVocalRecording();
      } catch (error) {
        toast.error(
          `Exercise recording: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    })();
    exerciseRecordingStop.current = stopping;
    void stopping.finally(() => {
      if (exerciseRecordingStop.current === stopping) exerciseRecordingStop.current = null;
    });
    return stopping;
  }, []);

  const persistExerciseAttempt = useCallback(
    async (
      run: ActiveExerciseRun,
      result: ExerciseResult,
      take: RecordingTake | null,
      completed: boolean,
      durationSeconds: number,
    ) => {
      const endedAt = Math.floor(Date.now() / 1000);
      const session: SavePracticeSession = {
        id: take?.session_id ?? `exercise-${run.exercise.id}-${Date.now()}`,
        profile: run.profile,
        song_hash: null,
        kind: `exercise:${run.exercise.id}`,
        started_at: run.startedAt,
        ended_at: endedAt,
        performance_json: JSON.stringify({
          score: result.overall,
          exercise: run.exercise.title,
          baseMidi: run.baseMidi,
          pattern: run.pattern,
          secondsPerNote: run.secondsPerNote,
          previousScore: run.previousScore,
          metrics: result.metrics,
          recommendations: result.recommendations,
          completed,
          durationSeconds: Number(Math.max(0, durationSeconds).toFixed(2)),
        }),
        recording_take_id: take?.id ?? null,
        transport_segments: [],
      };
      await savePracticeSession(session);
      setHistory((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      if (take) {
        setHistoryTakes((current) => ({ ...current, [take.id]: take }));
      }
      setExerciseTake(take);
      if (completed) {
        setExerciseHistoryScores((current) => ({
          ...current,
          [run.exercise.id]: result.overall,
        }));
      }
    },
    [],
  );

  const closeExerciseAudio = useCallback(() => {
    const context = exerciseContext.current;
    exerciseContext.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => {});
    }
  }, []);

  const stopExercise = useCallback(async (): Promise<RecordingTake | null> => {
    const run = activeExerciseRun.current;
    activeExerciseRun.current = null;
    const elapsedSeconds = run
      ? Math.max(0, Math.min(run.totalSeconds, (performance.now() - exerciseStart.current) / 1000))
      : 0;
    if (exerciseTimer.current != null) window.clearInterval(exerciseTimer.current);
    exerciseTimer.current = null;
    closeExerciseAudio();
    setRunningExercise(null);
    setExercisePhase(null);
    setExerciseNoteMidi(null);
    setTargetMidi(null);
    setExerciseStopping(true);
    try {
      const take = await stopExerciseRecording();
      if (run) {
        const result = analyzeExercise(
          run.exercise.id,
          exerciseFrames.current,
          Math.max(0.1, elapsedSeconds),
        );
        setExerciseScore(result.overall);
        setExerciseResult(result);
        setExerciseCompleted(false);
        await persistExerciseAttempt(run, result, take, false, elapsedSeconds);
      }
      return take;
    } finally {
      setExerciseStopping(false);
    }
  }, [closeExerciseAudio, persistExerciseAttempt, stopExerciseRecording]);

  const resetListeningPrompt = useCallback(() => {
    listeningSingFrames.current = [];
    listeningSingAttempted.current = false;
    setListeningQuestion(null);
    setListeningReady(false);
    setListeningAnswer(null);
    setListeningSingResult(null);
    setListeningSingError(null);
    setListeningSingSeconds(0);
    setExerciseNoteMidi(null);
    setTargetMidi(null);
  }, []);

  const selectExercise = useCallback(
    (exercise: Exercise) => {
      if (exercise.id === selectedExercise.id) return;
      if (selectedExercise.mode === "listening") resetListeningPrompt();
      setSelectedExercise(exercise);
    },
    [resetListeningPrompt, selectedExercise.id, selectedExercise.mode],
  );

  const startExercise = useCallback(
    async (exercise: Exercise) => {
      await stopExercise();
      if (exercise.mode === "listening") return;
      if (!capture.active) {
        toast.error("The microphone is not ready yet.");
        return;
      }
      setSelectedExercise(exercise);
      const pitchPlan = adaptExerciseToRange(
        exercise.pattern,
        baseMidi,
        voiceProfile?.lowMidi ?? null,
        voiceProfile?.highMidi ?? null,
      );
      const exerciseBaseMidi = pitchPlan.baseMidi;
      const exercisePattern = pitchPlan.pattern;
      const secondsPerNote = adaptExercisePace(
        exercise.secondsPerNote,
        exerciseHistoryScores[exercise.id] ?? null,
      );
      setRunningExercise(exercise.id);
      setExercisePhase("listen");
      setExerciseNoteMidi(exerciseBaseMidi + (exercisePattern[0] ?? 0));
      setExerciseScore(null);
      setExerciseResult(null);
      setExerciseCompleted(null);
      exerciseFrames.current = [];
      setExerciseTake(null);
      if (recordExercises && capture.active) {
        exerciseRecording.current = startVocalRecording({
          song_hash: `exercise-${exercise.id}`,
          profile: activeProfile,
          title: exercise.title,
          artist: "Nightingale Vocal Studio",
          playback_time_sec: 0,
        }).catch((error) => {
          toast.error(
            `Exercise recording: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
      }
      const context = new AudioContext();
      exerciseContext.current = context;
      const callAndResponse = exercise.mode === "call-response";
      const leadIn = callAndResponse ? 0.35 : 1.1;
      if (callAndResponse) {
        exercisePattern.forEach((offset, index) => {
          const stride = secondsPerNote * 2;
          const start = context.currentTime + leadIn + index * stride;
          scheduleTone(context, exerciseBaseMidi + offset, start, secondsPerNote * 0.82, 0.18);
        });
      } else if (exercisePattern.length > 0) {
        scheduleTone(
          context,
          exerciseBaseMidi + exercisePattern[0],
          context.currentTime + 0.15,
          0.7,
          0.18,
        );
      }
      exerciseStart.current = performance.now() + leadIn * 1000;
      const totalSeconds = exerciseTotalSeconds(
        exercisePattern.length,
        secondsPerNote,
        callAndResponse,
      );
      const run: ActiveExerciseRun = {
        exercise,
        baseMidi: exerciseBaseMidi,
        pattern: exercisePattern,
        secondsPerNote,
        totalSeconds,
        startedAt: Math.floor(Date.now() / 1000),
        profile: activeProfile,
        previousScore: exerciseHistoryScores[exercise.id] ?? null,
      };
      activeExerciseRun.current = run;
      const totalMs = totalSeconds * 1000;
      exerciseTimer.current = window.setInterval(() => {
        const elapsed = performance.now() - exerciseStart.current;
        if (elapsed < 0) {
          setExercisePhase("listen");
          setExerciseNoteMidi(exerciseBaseMidi + (exercisePattern[0] ?? 0));
          setTargetMidi(null);
          return;
        }
        const step = exerciseStepAt(
          elapsed / 1000,
          exercisePattern.length,
          secondsPerNote,
          callAndResponse,
        );
        if (step.phase !== "complete" && step.index != null) {
          const noteMidi = exerciseBaseMidi + exercisePattern[step.index];
          setExercisePhase(step.phase);
          setExerciseNoteMidi(noteMidi);
          setTargetMidi(step.phase === "sing" ? noteMidi : null);
          return;
        }
        if (elapsed >= totalMs) {
          const result = analyzeExercise(exercise.id, exerciseFrames.current, totalSeconds);
          const score = result.overall;
          setExerciseScore(score);
          setExerciseResult(result);
          setExerciseCompleted(true);
          activeExerciseRun.current = null;
          if (exerciseTimer.current != null) window.clearInterval(exerciseTimer.current);
          exerciseTimer.current = null;
          closeExerciseAudio();
          setRunningExercise(null);
          setExercisePhase(null);
          setExerciseNoteMidi(null);
          setTargetMidi(null);
          setExerciseStopping(true);
          void stopExerciseRecording()
            .then((take) => persistExerciseAttempt(run, result, take, true, totalSeconds))
            .catch((error) =>
              toast.error(
                `Save exercise: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
            .finally(() => setExerciseStopping(false));
        }
      }, 40);
    },
    [
      baseMidi,
      capture.active,
      closeExerciseAudio,
      activeProfile,
      recordExercises,
      exerciseHistoryScores,
      persistExerciseAttempt,
      stopExercise,
      stopExerciseRecording,
      voiceProfile,
    ],
  );

  const playListeningQuestion = useCallback(
    async (replay = false) => {
      await stopExercise();
      const resetSet = !replay && listeningAnswers.length >= 5;
      if (!replay && (listeningAnswers.length === 0 || resetSet)) {
        listeningSetStartedAt.current = Math.floor(Date.now() / 1000);
      }
      if (resetSet) {
        setListeningAnswers([]);
        setListeningSungAttempts([]);
      }
      const priorInterval = listeningQuestion?.semitones ?? null;
      const semitones =
        replay && listeningQuestion ? listeningQuestion.semitones : nextInterval(priorInterval);
      const question = {
        baseMidi: Math.max(48, Math.min(72, baseMidi)),
        semitones,
      };
      setListeningQuestion(question);
      if (!replay) {
        listeningSingAttempted.current = false;
        setListeningAnswer(null);
        setListeningSingResult(null);
        setListeningSingError(null);
      }
      setListeningReady(false);
      setRunningExercise("listening");
      setExercisePhase("listen");

      const context = new AudioContext();
      exerciseContext.current = context;
      const start = context.currentTime + 0.1;
      scheduleTone(context, question.baseMidi, start, 0.65, 0.18);
      scheduleTone(context, question.baseMidi + question.semitones, start + 0.9, 0.65, 0.18);
      exerciseTimer.current = window.setTimeout(() => {
        exerciseTimer.current = null;
        closeExerciseAudio();
        setRunningExercise(null);
        setExercisePhase(null);
        setListeningReady(true);
      }, 1750);
    },
    [baseMidi, closeExerciseAudio, listeningAnswers.length, listeningQuestion, stopExercise],
  );

  const finishListeningSing = useCallback(() => {
    if (exerciseTimer.current != null) window.clearInterval(exerciseTimer.current);
    exerciseTimer.current = null;
    const target = listeningQuestion
      ? listeningQuestion.baseMidi + listeningQuestion.semitones
      : null;
    const result = target == null ? null : assessSungPitch(target, listeningSingFrames.current);
    setListeningSingResult(result);
    setListeningSingError(
      result
        ? null
        : "No steady sung note was detected. Move closer, hold an ah vowel, and try again.",
    );
    setListeningSingSeconds(0);
    setRunningExercise(null);
    setExercisePhase(null);
    setExerciseNoteMidi(target);
    setTargetMidi(target);
  }, [listeningQuestion]);

  const startListeningSing = useCallback(() => {
    if (!listeningQuestion || !listeningReady) return;
    listeningSingAttempted.current = true;
    if (!capture.active) {
      setListeningSingError(capture.error ?? "The microphone is not ready yet.");
      return;
    }
    listeningSingFrames.current = [];
    listeningSingStarted.current = performance.now();
    setListeningSingResult(null);
    setListeningSingError(null);
    setListeningSingSeconds(4);
    setRunningExercise("listening-sing");
    setExercisePhase("sing");
    const target = listeningQuestion.baseMidi + listeningQuestion.semitones;
    setExerciseNoteMidi(target);
    setTargetMidi(target);
    exerciseTimer.current = window.setInterval(() => {
      const elapsed = (performance.now() - listeningSingStarted.current) / 1000;
      setListeningSingSeconds(Math.max(0, Math.ceil(4 - elapsed)));
      if (elapsed >= 4) finishListeningSing();
    }, 100);
  }, [capture.active, capture.error, finishListeningSing, listeningQuestion, listeningReady]);

  useEffect(() => {
    if (
      !shouldAutoStartListeningCapture({
        ready: listeningReady,
        microphoneActive: capture.active,
        attempted: listeningSingAttempted.current,
        answered: listeningAnswer != null,
        busy: runningExercise != null,
      })
    ) {
      return;
    }
    startListeningSing();
  }, [
    capture.active,
    listeningAnswer,
    listeningQuestion,
    listeningReady,
    runningExercise,
    startListeningSing,
  ]);

  const answerListeningQuestion = useCallback(
    (selectedSemitones: number) => {
      if (!listeningQuestion || !listeningReady || listeningAnswer) return;
      const answer = assessIntervalAnswer(listeningQuestion.semitones, selectedSemitones);
      const answers = [...listeningAnswers, answer];
      const sungAttempts = [...listeningSungAttempts, listeningSingResult];
      setListeningAnswer(answer);
      setListeningAnswers(answers);
      setListeningSungAttempts(sungAttempts);
      if (answers.length !== 5) return;

      const now = Math.floor(Date.now() / 1000);
      const session = buildListeningSession({
        id: `listening-${Date.now()}`,
        profile: activeProfile,
        startedAt: listeningSetStartedAt.current ?? now,
        endedAt: now,
        answers,
        sungAttempts,
      });
      listeningSetStartedAt.current = null;
      void savePracticeSession(session)
        .then(() =>
          setHistory((current) => [session, ...current.filter((item) => item.id !== session.id)]),
        )
        .catch((error) =>
          toast.error(
            `Save listening set: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    },
    [
      listeningAnswer,
      listeningAnswers,
      listeningQuestion,
      listeningReady,
      listeningSingResult,
      listeningSungAttempts,
      activeProfile,
    ],
  );

  const listeningScoreSummary = listeningScores(listeningAnswers, listeningSungAttempts);

  useEffect(
    () => () => {
      void stopExercise();
    },
    [stopExercise],
  );
  useEffect(
    () => () => {
      const context = checkupContext.current;
      checkupContext.current = null;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    },
    [],
  );

  const changeTab = useCallback(
    (nextTab: StudioTab) => {
      const exit = planStudioTabChange(
        tab,
        nextTab,
        checkupRunning,
        runningExercise,
        listeningQuestion != null ||
          listeningReady ||
          listeningSingResult != null ||
          listeningSingError != null,
      );
      if (!exit.changed) return;
      if (exit.cancelCheckup) cancelCheckup();
      if (exit.stopExercise) {
        void stopExercise().catch((error) =>
          toast.error(`Stop exercise: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
      if (exit.resetListeningPrompt) resetListeningPrompt();
      setTab(nextTab);
    },
    [
      cancelCheckup,
      checkupRunning,
      listeningQuestion,
      listeningReady,
      listeningSingError,
      listeningSingResult,
      resetListeningPrompt,
      runningExercise,
      stopExercise,
      tab,
    ],
  );

  const recoverRecordingMix = useCallback(
    async (session: PracticeSession, take: RecordingTake) => {
      if (recoveringTakeId || !session.song_hash) return;
      setRecoveringTakeId(take.id);
      try {
        const videoPath = await ensurePlayableSourceVideo(session.song_hash).catch(() => null);
        const recovered = await exportRecording(
          take.id,
          config?.mic_latency_compensation_sec ?? DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
          1,
          videoPath,
          session.transport_segments,
        );
        setHistoryTakes((current) => ({ ...current, [recovered.id]: recovered }));
        toast.success(
          recovered.video_path
            ? "Performance mix and video recovered."
            : "Performance mix recovered.",
        );
      } catch (error) {
        const latest = await loadRecordingTake(take.id).catch(() => null);
        if (latest) setHistoryTakes((current) => ({ ...current, [latest.id]: latest }));
        toast.error(
          `Recover performance mix: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setRecoveringTakeId(null);
      }
    },
    [config?.mic_latency_compensation_sec, recoveringTakeId],
  );

  const handleStudioBack = useCallback(() => {
    switch (planStudioBackAction(checkupRunning, runningExercise, exerciseStopping)) {
      case "cancel-checkup":
        cancelCheckup();
        break;
      case "stop-exercise":
        void stopExercise().catch((error) =>
          toast.error(`Stop exercise: ${error instanceof Error ? error.message : String(error)}`),
        );
        break;
      case "stay":
        break;
      case "leave":
        navigate("/");
        break;
    }
  }, [cancelCheckup, checkupRunning, exerciseStopping, navigate, runningExercise, stopExercise]);

  useStudioNavigation(studioRef, handleStudioBack);

  return (
    <main
      ref={studioRef}
      data-spatial-navigation
      className="h-full min-h-screen overflow-y-auto bg-background text-foreground"
    >
      <header className="sticky top-0 z-10 flex min-h-16 items-center justify-between border-b border-border bg-background/95 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title="Back to library"
            onClick={() => navigate("/")}
          >
            <ArrowLeft className="size-5" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">Vocal Studio</h1>
            <p className="truncate text-xs text-muted-foreground">{activeProfile}</p>
          </div>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {midiName(displayPitchFrame?.midi ?? null)}
        </span>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        <nav
          aria-label="Vocal Studio views"
          className="mb-5 flex overflow-x-auto border-b border-border"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => changeTab(id)}
              className={`flex h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm ${
                tab === id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </nav>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <label className="flex min-w-0 items-center gap-2 text-sm" htmlFor="studio-mic-input">
            <Mic2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium">Input</span>
            <Select
              value={config?.preferred_mic ?? SYSTEM_DEFAULT_MIC}
              disabled={inputChanging || checkupRunning || runningExercise != null}
              onValueChange={(value) =>
                updateConfig({ preferred_mic: value === SYSTEM_DEFAULT_MIC ? null : value })
              }
            >
              <SelectTrigger id="studio-mic-input" className="max-w-[min(28rem,70vw)]">
                <SelectValue placeholder="Choose microphone" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value={SYSTEM_DEFAULT_MIC}>System default</SelectItem>
                {micDevices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={capture.deviceName ?? undefined}
          >
            {capture.active && capture.deviceName
              ? `Active: ${capture.deviceName}`
              : inputChanging
                ? "Switching input"
                : "Input unavailable"}
          </span>
        </div>

        <SignalStrip
          frame={displayPitchFrame}
          active={capture.active && pitchActive}
          captureActive={capture.active}
          error={capture.error}
          captureStatus={capture.status}
          targetMidi={
            checkupRunning
              ? checkupStage.targetMidi
              : tab === "exercises"
                ? exerciseDisplayTargetMidi
                : null
          }
        />

        {tab === "checkup" && (
          <section className="py-8">
            <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
              <div>
                <h2 className="text-xl font-semibold">Full voice checkup</h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Use an easy volume throughout. Stop immediately if anything feels painful or
                  strained, and rest before trying again.
                </p>
                {checkupRunning && (
                  <div className="mt-5 max-w-2xl border-y border-border py-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-xs font-medium text-primary">{checkupStage.label}</p>
                        <p className="mt-1 text-sm">{checkupStage.instruction}</p>
                      </div>
                      <span className="text-2xl font-semibold tabular-nums">{checkupSeconds}s</span>
                    </div>
                    <Progress
                      value={(checkupElapsed / CHECKUP_DURATION_SECONDS) * 100}
                      className="mt-4 h-1.5 rounded-none"
                    />
                  </div>
                )}
                <div className="mt-6 flex items-center gap-3">
                  <Button
                    type="button"
                    disabled={!checkupRunning && !capture.active}
                    onClick={checkupRunning ? cancelCheckup : startCheckup}
                  >
                    {checkupRunning ? (
                      <Square className="size-4" />
                    ) : (
                      <Activity className="size-4" />
                    )}
                    {checkupRunning ? "Cancel checkup" : "Start 30-second checkup"}
                  </Button>
                </div>
              </div>
              <div className="border-l border-border pl-6">
                <p className="text-xs font-medium text-muted-foreground">COMFORTABLE RANGE</p>
                <p className="mt-3 text-3xl font-semibold tabular-nums">
                  {voiceProfile
                    ? `${midiName(voiceProfile.lowMidi)} - ${midiName(voiceProfile.highMidi)}`
                    : "Not measured"}
                </p>
                {voiceProfile && (
                  <>
                    <p className="mt-4 text-xs font-medium text-muted-foreground">TESSITURA</p>
                    <p className="mt-1 text-lg font-medium tabular-nums">
                      {midiName(voiceProfile.tessituraLowMidi)} -{" "}
                      {midiName(voiceProfile.tessituraHighMidi)}
                    </p>
                    <p className="mt-3 text-sm text-muted-foreground">
                      Exercises center near {midiName(baseMidi + 3)} and stay inside this range.
                    </p>
                  </>
                )}
              </div>
            </div>
            <VoiceRangeScale
              lowMidi={voiceProfile?.lowMidi ?? null}
              highMidi={voiceProfile?.highMidi ?? null}
              tessituraLowMidi={voiceProfile?.tessituraLowMidi ?? null}
              tessituraHighMidi={voiceProfile?.tessituraHighMidi ?? null}
              midiName={midiName}
            />
            {voiceProfile?.assessmentComplete && (
              <div className="mt-8 border-t border-border pt-6">
                <div className="flex items-end justify-between gap-4">
                  <h3 className="text-sm font-semibold">Latest assessment</h3>
                  <p className="text-xs text-muted-foreground">
                    Overall{" "}
                    <span className="text-2xl font-semibold tabular-nums text-foreground">
                      {vocalCheckupScore(voiceProfile)}
                    </span>
                    /100
                  </p>
                </div>
                <div className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Microphone", voiceProfile.microphoneScore],
                    ["Pitch match", voiceProfile.pitchMatchScore],
                    ["Intervals", voiceProfile.intervalMatchScore],
                    ["Stability", voiceProfile.stabilityScore],
                    ["Sustain", voiceProfile.sustainScore],
                    ["Rhythm", voiceProfile.rhythmScore],
                  ].map(([label, value]) => (
                    <div key={label} className="border-b border-border pb-2">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-medium tabular-nums">{value}</span>
                      </div>
                      <Progress value={value as number} className="mt-2 h-1 rounded-none" />
                    </div>
                  ))}
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  Noise floor {voiceProfile.noiseFloorDb} dB, clipping{" "}
                  {voiceProfile.clippingPercent}%
                </p>
                {voiceProfile.recommendations.length > 0 && (
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-xs font-medium text-muted-foreground">NEXT PRACTICE</p>
                    {voiceProfile.recommendations.map((recommendation) => (
                      <p key={recommendation} className="mt-1 text-sm">
                        {recommendation}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {tab === "exercises" && (
          <section className="grid gap-6 py-6 lg:grid-cols-[18rem_1fr]">
            <div className="border-r border-border pr-4">
              {EXERCISES.map((exercise) => (
                <button
                  key={exercise.id}
                  type="button"
                  onClick={() => selectExercise(exercise)}
                  disabled={runningExercise != null || exerciseStopping}
                  className={`w-full border-b border-border px-2 py-3 text-left ${
                    selectedExercise.id === exercise.id ? "bg-muted" : "hover:bg-muted/50"
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <span className="block text-sm font-medium">{exercise.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {exercise.category}
                  </span>
                </button>
              ))}
            </div>
            <div className="min-w-0 py-2">
              <p className="text-xs font-medium text-primary">{selectedExercise.category}</p>
              <h2 className="mt-1 text-2xl font-semibold">{selectedExercise.title}</h2>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {selectedExercise.instruction}
              </p>
              {selectedExercise.mode === "listening" ? (
                <div className="mt-8 max-w-2xl">
                  <div className="grid grid-cols-[1fr_auto] items-center gap-5 border-y border-border py-5">
                    <div>
                      <p className="text-xs text-muted-foreground">FIVE-QUESTION SET</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums">
                        {listeningAnswers.length}/5 answered
                      </p>
                      <Progress
                        value={(listeningAnswers.length / 5) * 100}
                        className="mt-3 h-1.5 max-w-xs rounded-none"
                      />
                    </div>
                    {!listeningQuestion || listeningAnswer ? (
                      <Button
                        type="button"
                        disabled={runningExercise != null || exerciseStopping}
                        onClick={() => void playListeningQuestion(false)}
                        className="min-w-44"
                      >
                        <Ear className="size-4" />
                        {!listeningQuestion
                          ? "Hear first interval"
                          : listeningAnswers.length >= 5
                            ? "Start another set"
                            : "Hear next interval"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={runningExercise != null}
                        onClick={() => void playListeningQuestion(true)}
                        className="min-w-44"
                      >
                        <Volume2 className="size-4" /> Replay
                      </Button>
                    )}
                  </div>

                  <div className="mt-5 border-b border-border pb-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-muted-foreground">VOICE INPUT</p>
                        <p
                          className="mt-1 h-5 truncate text-sm tabular-nums"
                          aria-live="polite"
                          aria-atomic="true"
                        >
                          {runningExercise === "listening-sing" && listeningQuestion
                            ? `Sing ${midiName(listeningQuestion.baseMidi + listeningQuestion.semitones)} now - ${listeningSingSeconds}s`
                            : listeningSingResult
                              ? `Heard ${midiName(listeningSingResult.detectedMidi)}`
                              : !capture.active
                                ? "Input unavailable"
                                : displayPitchFrame?.voiced && displayPitchFrame.midi != null
                                  ? `Live input: ${midiName(displayPitchFrame.midi)}`
                                  : listeningQuestion
                                    ? "Ready to hear the second note."
                                    : "Microphone ready"}
                        </p>
                      </div>
                      {listeningQuestion && (
                        <Button
                          type="button"
                          variant={runningExercise === "listening-sing" ? "destructive" : "default"}
                          disabled={
                            !listeningReady ||
                            (runningExercise != null && runningExercise !== "listening-sing")
                          }
                          onClick={
                            runningExercise === "listening-sing"
                              ? finishListeningSing
                              : startListeningSing
                          }
                          className="min-w-44"
                        >
                          {runningExercise === "listening-sing" ? (
                            <Square className="size-4" />
                          ) : (
                            <Mic2 className="size-4" />
                          )}
                          {runningExercise === "listening-sing"
                            ? "Finish"
                            : listeningSingResult || listeningSingError
                              ? "Try voice again"
                              : "Sing second note"}
                        </Button>
                      )}
                    </div>
                    <div className="mt-4 min-h-14" aria-live="polite" aria-atomic="true">
                      <div className="flex h-10 items-start justify-between gap-4 text-sm">
                        {listeningSingResult ? (
                          <>
                            <span className="line-clamp-2">{listeningSingResult.feedback}</span>
                            <span className="shrink-0 font-semibold tabular-nums">
                              {listeningSingResult.score}%
                            </span>
                          </>
                        ) : listeningSingError ? (
                          <p className="line-clamp-2 text-destructive" role="alert">
                            {listeningSingError}
                          </p>
                        ) : (
                          <span className="text-muted-foreground">
                            {runningExercise === "listening-sing"
                              ? "Listening for a steady note..."
                              : "Awaiting voice response"}
                          </span>
                        )}
                      </div>
                      <Progress
                        value={listeningSingResult?.score ?? 0}
                        className="h-1.5 rounded-none"
                      />
                    </div>
                  </div>

                  {listeningQuestion && (
                    <div className="mt-5">
                      <p className="mb-2 text-xs font-medium text-muted-foreground">
                        NAME THE INTERVAL
                      </p>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {INTERVAL_CHOICES.map((choice) => (
                          <Button
                            key={choice.semitones}
                            type="button"
                            variant="outline"
                            disabled={
                              !listeningReady ||
                              listeningAnswer != null ||
                              runningExercise === "listening-sing"
                            }
                            onClick={() => answerListeningQuestion(choice.semitones)}
                            className="justify-start"
                          >
                            {choice.shortLabel}
                          </Button>
                        ))}
                      </div>
                      <div
                        className="mt-4 min-h-24 border-t border-border pt-4"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {!listeningReady ? (
                          <p className="text-sm text-primary">Listen to both notes...</p>
                        ) : runningExercise === "listening-sing" ? (
                          <p className="text-sm text-primary">Voice response in progress...</p>
                        ) : listeningAnswer ? (
                          <div className="flex gap-3">
                            {listeningAnswer.correct ? (
                              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-500" />
                            ) : (
                              <XCircle className="mt-0.5 size-5 shrink-0 text-amber-500" />
                            )}
                            <div>
                              <p className="text-sm font-medium">
                                {listeningAnswer.correct
                                  ? `Correct: ${intervalChoice(listeningAnswer.expectedSemitones).label}`
                                  : `That was ${intervalChoice(listeningAnswer.expectedSemitones).label}`}
                              </p>
                              {!listeningAnswer.correct && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  You chose{" "}
                                  {intervalChoice(listeningAnswer.selectedSemitones).label}. Replay
                                  the notes once, then compare the size of the jump.
                                </p>
                              )}
                              <div className="mt-2 grid grid-cols-3 gap-4 text-xs text-muted-foreground tabular-nums">
                                <span>Set {listeningScoreSummary.overall}%</span>
                                <span>
                                  Interval{" "}
                                  {listeningScoreSummary.interval == null
                                    ? "--"
                                    : `${listeningScoreSummary.interval}%`}
                                </span>
                                <span>
                                  Voice{" "}
                                  {listeningScoreSummary.pitch == null
                                    ? "--"
                                    : `${listeningScoreSummary.pitch}%`}
                                </span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">Choose the interval.</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="mt-8 grid max-w-xl grid-cols-[1fr_auto] items-end gap-5 border-y border-border py-5">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {exercisePhase == null
                          ? "TARGET"
                          : exercisePhase === "listen"
                            ? "LISTEN"
                            : "SING"}
                      </p>
                      <p className="mt-1 h-12 text-4xl font-semibold tabular-nums">
                        {midiName(visibleExerciseNoteMidi)}
                      </p>
                      <p className="mt-2 h-5 truncate text-sm text-primary tabular-nums">
                        {exercisePhase === "listen"
                          ? "Listen now. Your turn is next."
                          : exercisePhase === "sing"
                            ? `Sing and hold ${midiName(visibleExerciseNoteMidi)}`
                            : exerciseScore != null
                              ? `${exerciseCompleted === false ? "Partial accuracy" : "Last accuracy"} ${exerciseScore}%`
                              : `Ready at ${midiName(visibleExerciseNoteMidi)}`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      disabled={exerciseStopping || (!capture.active && runningExercise == null)}
                      onClick={() =>
                        void (runningExercise ? stopExercise() : startExercise(selectedExercise))
                      }
                    >
                      {runningExercise ? (
                        <Square className="size-4" />
                      ) : (
                        <Play className="size-4" />
                      )}
                      {exerciseStopping ? "Finishing" : runningExercise ? "Stop" : "Start"}
                    </Button>
                  </div>
                  <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                    <Volume2 className="size-4" /> Reference tones stay between{" "}
                    {midiName(selectedPitchPlan.baseMidi + Math.min(...selectedPitchPlan.pattern))}{" "}
                    and{" "}
                    {midiName(selectedPitchPlan.baseMidi + Math.max(...selectedPitchPlan.pattern))}.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Adaptive pace {selectedExercisePace.toFixed(2)} seconds per note
                    {exerciseHistoryScores[selectedExercise.id] != null
                      ? ` from your ${exerciseHistoryScores[selectedExercise.id]}% previous attempt.`
                      : "."}
                  </p>
                  {exerciseResult && (
                    <div className="mt-5 max-w-xl border-t border-border pt-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        {exerciseResult.metrics.map((metric) => (
                          <div key={metric.label} className="border-b border-border pb-2">
                            <div className="flex justify-between gap-3 text-xs">
                              <span className="text-muted-foreground">{metric.label}</span>
                              <span className="font-medium tabular-nums">{metric.score}</span>
                            </div>
                            <Progress value={metric.score} className="mt-2 h-1 rounded-none" />
                          </div>
                        ))}
                      </div>
                      {exerciseResult.recommendations.map((recommendation) => (
                        <p key={recommendation} className="mt-2 text-xs text-muted-foreground">
                          {recommendation}
                        </p>
                      ))}
                    </div>
                  )}
                  <label className="mt-4 flex w-fit items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={recordExercises}
                      onCheckedChange={(checked) => setRecordExercises(checked === true)}
                      disabled={runningExercise != null || exerciseStopping}
                    />
                    Save a dry vocal take for each completed exercise
                  </label>
                  {exerciseTake?.vocal_path && (
                    <p className="mt-2 text-xs text-primary">
                      Exercise vocal saved to your recording history.
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {tab === "songs" && (
          <section className="py-10">
            <h2 className="text-xl font-semibold">Practice with your songs</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Choose an analyzed track, then use Coach for note-by-note guidance or Game for streaks
              and performance scoring.
            </p>
            <Button type="button" className="mt-6" onClick={() => navigate("/")}>
              <LibraryBig className="size-4" /> Open library
            </Button>
          </section>
        )}

        {tab === "history" && (
          <section className="py-6">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-xl font-semibold">Practice history</h2>
                <p
                  className="mt-1 max-w-2xl truncate text-xs text-muted-foreground"
                  title={recordingsDirectory ?? undefined}
                >
                  {recordingsDirectory ?? "Recording folder is unavailable"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={!recordingsDirectory}
                onClick={() => {
                  if (!recordingsDirectory) return;
                  void openMediaPath(recordingsDirectory).catch((error) =>
                    toast.error(
                      `Open recordings folder: ${error instanceof Error ? error.message : String(error)}`,
                    ),
                  );
                }}
              >
                <FolderOpen className="size-4" /> Open recordings folder
              </Button>
            </div>
            <RecordingPreview preview={recordingPreview} />
            {checkupHistoryScores[0] && (
              <div className="mb-6 border-y border-border py-4">
                <p className="text-xs font-medium text-muted-foreground">VOICE CHECKUP PROGRESS</p>
                <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="text-2xl font-semibold tabular-nums">
                    {checkupHistoryScores[0].score}/100
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {checkupHistoryScores[1]
                      ? checkupHistoryScores[0].score === checkupHistoryScores[1].score
                        ? "Unchanged since your previous assessment"
                        : `${checkupHistoryScores[0].score > checkupHistoryScores[1].score ? "+" : ""}${checkupHistoryScores[0].score - checkupHistoryScores[1].score} points since your previous assessment`
                      : "Complete another checkup to measure progress"}
                  </span>
                </div>
              </div>
            )}
            <div className="sticky top-16 z-[5] grid grid-cols-[minmax(8rem,1fr)_7rem_5rem_8.5rem] border-b border-border bg-background px-2 py-2 text-xs text-muted-foreground">
              <span>Session</span>
              <span>Date</span>
              <span className="text-right">Score</span>
              <span className="text-right">Recording</span>
            </div>
            {history.length === 0 ? (
              <p className="py-10 text-sm text-muted-foreground">
                No completed practice sessions yet.
              </p>
            ) : (
              history.map((session) => {
                const score = sessionScore(session);
                const take = session.recording_take_id
                  ? historyTakes[session.recording_take_id]
                  : null;
                const recordingName = take
                  ? take.artist.trim()
                    ? `${take.artist} - ${take.title}`
                    : take.title
                  : "Recording";
                return (
                  <div
                    key={session.id}
                    className="grid grid-cols-[minmax(8rem,1fr)_7rem_5rem_8.5rem] items-center border-b border-border px-2 py-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate">{sessionLabel(session)}</p>
                      {take && (
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={take.artist.trim() ? `${take.artist} - ${take.title}` : take.title}
                        >
                          {take.artist.trim() ? `${take.artist} - ${take.title}` : take.title}
                        </p>
                      )}
                      {take?.status === "recovered" && (
                        <p
                          className="truncate text-xs text-amber-600 dark:text-amber-400"
                          title={take.error ?? undefined}
                        >
                          Recovered after interruption
                        </p>
                      )}
                      {take?.status === "failed" && (
                        <p
                          className="truncate text-xs text-destructive"
                          title={take.error ?? undefined}
                        >
                          Recording incomplete
                        </p>
                      )}
                      {take?.status === "recorded" && !take.mix_path && (
                        <p className="truncate text-xs text-amber-600 dark:text-amber-400">
                          Vocal saved, mix not created
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {new Date(session.started_at * 1000).toLocaleDateString()}
                    </span>
                    <span className="text-right font-medium tabular-nums">{score ?? "--"}</span>
                    <span className="flex justify-end gap-1">
                      {take?.vocal_path && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title={
                            recordingPreview.path === take.vocal_path && recordingPreview.playing
                              ? "Pause vocal master"
                              : "Play vocal master"
                          }
                          onClick={() =>
                            void recordingPreview.play(
                              take.vocal_path,
                              `Vocal master - ${recordingName}`,
                            )
                          }
                        >
                          {recordingPreview.path === take.vocal_path && recordingPreview.playing ? (
                            <Pause className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {take?.mix_path && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title={
                            recordingPreview.path === take.mix_path && recordingPreview.playing
                              ? "Pause performance mix"
                              : "Play performance mix"
                          }
                          onClick={() =>
                            void recordingPreview.play(
                              take.mix_path as string,
                              `Performance mix - ${recordingName}`,
                            )
                          }
                        >
                          {recordingPreview.path === take.mix_path && recordingPreview.playing ? (
                            <Pause className="size-3.5" />
                          ) : (
                            <Music2 className="size-3.5" />
                          )}
                        </Button>
                      )}
                      {take?.video_path && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Play performance video"
                          onClick={() => void openMediaPath(take.video_path as string)}
                        >
                          <Video className="size-3.5" />
                        </Button>
                      )}
                      {take &&
                        canRecoverRecordingMix(
                          session.kind,
                          session.song_hash,
                          take.vocal_path,
                          take.mix_path,
                        ) && (
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            title="Create performance mix"
                            disabled={recoveringTakeId != null}
                            onClick={() => void recoverRecordingMix(session, take)}
                          >
                            <RefreshCw
                              className={`size-3.5 ${
                                recoveringTakeId === take.id ? "animate-spin" : ""
                              }`}
                            />
                          </Button>
                        )}
                      {take?.vocal_path && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          title="Show recording in folder"
                          onClick={() => void revealItemInDir(take.mix_path ?? take.vocal_path)}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </section>
        )}
      </div>
    </main>
  );
}
