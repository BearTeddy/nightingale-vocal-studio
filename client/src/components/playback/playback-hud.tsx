import {
  usePlaybackMicActions,
  usePlaybackMicState,
  usePlaybackThemeActions,
  usePlaybackThemeState,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from "@/contexts/playback";
import { usePlaybackConfigPersist } from "@/hooks/playback/use-playback-config-persist";
import type { VideoFlavor } from "@/lib/playback/video-flavor";
import type { AppConfig } from "@/types/AppConfig";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import {
  nextScoringDifficulty,
  scoringDifficultyProfile,
  type ScoringDifficulty,
} from "@/lib/pitch/difficulty";
import { computeLyricGapCaption, findCurrentSegment } from "@/utils/playback/lyrics-gap";
import { forwardRef, memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isPixabayTheme, themeName } from "./background";
import { PitchToleranceControl } from "./pitch-tolerance-control";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Circle,
  Gamepad2,
  Gauge,
  GraduationCap,
  Headphones,
  ImageIcon,
  Mic2,
  Repeat2,
  Square,
  Volume2,
} from "lucide-react";

function difficultyButtonClass(difficulty: ScoringDifficulty): string {
  if (difficulty === "easy") return "bg-emerald-400 text-black hover:bg-emerald-300";
  if (difficulty === "pro") return "bg-fuchsia-400 text-black hover:bg-fuchsia-300";
  return "bg-amber-300 text-black hover:bg-amber-200";
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds) % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

const SkipButton = forwardRef<HTMLButtonElement, { label: string; onClick: () => void }>(
  ({ label, onClick }, ref) => (
    <button
      ref={ref}
      onClick={onClick}
      className="pointer-events-auto flex gap-1 rounded-sm border-2 border-white/70 bg-black/10 px-2.5 py-1 text-sm text-white/90 transition-colors hover:bg-black/20"
      style={{ display: "none" }}
    >
      <span>{label}</span> <span>⏎</span>
    </button>
  ),
);

const NOTE_BASE_CLASS = `pointer-events-none absolute z-20 text-[0.6rem] text-white/30`;
const TOUCH_QUERIES = ["(pointer: coarse)", "(any-pointer: coarse)"];

function hasTouchInput(): boolean {
  return (
    typeof window !== "undefined" &&
    (navigator.maxTouchPoints > 0 ||
      TOUCH_QUERIES.some((query) => window.matchMedia(query).matches))
  );
}

function useHasTouchInput(): boolean {
  const [enabled, setEnabled] = useState(hasTouchInput);

  useEffect(() => {
    const media = TOUCH_QUERIES.map((query) => window.matchMedia(query));
    const sync = () => setEnabled(hasTouchInput());

    sync();
    media.forEach((item) => item.addEventListener("change", sync));
    return () => media.forEach((item) => item.removeEventListener("change", sync));
  }, []);

  return enabled;
}

function TouchButton({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="pointer-events-auto rounded-sm border-2 border-white/70 bg-black/10 px-2.5 py-1 text-sm text-white/90 transition-colors hover:bg-black/20 active:bg-black/30 disabled:opacity-35"
    >
      {label}
    </button>
  );
}

function SettingsInfo({
  guideVolume,
  guideAvailable,
  micUserEnabled,
  micName,
  micMonitorUserEnabled,
  micCaptureStatus,
  themeIndex,
  videoFlavor,
}: {
  guideVolume: number;
  guideAvailable: boolean;
  micUserEnabled: boolean;
  micName: string;
  micMonitorUserEnabled: boolean;
  micCaptureStatus: MicCaptureStatus | null;
  themeIndex: number;
  videoFlavor: VideoFlavor;
}) {
  const guidePercent = Math.round(guideVolume * 100);
  const theme = themeName(themeIndex, videoFlavor);
  const monitorLabel = !micMonitorUserEnabled
    ? "Off"
    : micCaptureStatus?.monitor_active
      ? `On · ~${Math.max(1, Math.round(micCaptureStatus.monitor_estimated_latency_ms))} ms`
      : micCaptureStatus?.monitor_available
        ? "Starting"
        : "Unavailable";
  return (
    <div className="flex max-w-[min(36rem,75vw)] flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-white/60">
      {guideAvailable && (
        <span
          className="flex items-center gap-1 tabular-nums"
          title={`Guide volume ${guidePercent}%`}
        >
          <Volume2 className="size-3.5" /> {guidePercent}%
        </span>
      )}
      <span
        className="flex min-w-0 items-center gap-1"
        title={micUserEnabled ? `Microphone ${micName}` : "Microphone off"}
      >
        <Mic2 className="size-3.5 shrink-0" />
        <span className="max-w-44 truncate">{micUserEnabled ? micName : "Off"}</span>
      </span>
      <span className="flex items-center gap-1" title={`Microphone monitoring ${monitorLabel}`}>
        <Headphones className="size-3.5" /> {monitorLabel}
      </span>
      <span className="flex min-w-0 items-center gap-1" title={`Background ${theme}`}>
        <ImageIcon className="size-3.5 shrink-0" />
        <span className="max-w-36 truncate">{theme}</span>
      </span>
    </div>
  );
}

function TouchControls({
  config,
  hasTouch,
  position,
}: {
  config: AppConfig | null;
  hasTouch: boolean;
  position: PlaybackHudPosition;
}) {
  const [open, setOpen] = useState(false);
  const { guideVolume, guideAvailable } = usePlaybackTransportState();
  const { setGuideVolume, handlePause } = usePlaybackTransportActions();
  const { phraseLoopEnabled } = usePlaybackTranscriptState();
  const { togglePhraseLoop } = usePlaybackTranscriptActions();
  const { micUserEnabled, micName, micMonitorUserEnabled, micCaptureStatus } =
    usePlaybackMicState();
  const { handleToggleMic, handleCycleMic, handleToggleMicMonitor } = usePlaybackMicActions();
  const { themeIndex, videoFlavor } = usePlaybackThemeState();
  const { cycleTheme, cycleFlavor } = usePlaybackThemeActions();
  const persistConfig = usePlaybackConfigPersist(config);

  const setPersistedGuideVolume = useCallback(
    (volume: number) => {
      const next = Math.max(0, Math.min(1, volume));
      setGuideVolume(next);
      persistConfig({ guide_volume: next });
    },
    [persistConfig, setGuideVolume],
  );

  if (!hasTouch) {
    return null;
  }

  const touchLayoutClass = position === "bottom" ? "mb-2 flex-col-reverse" : "mt-2 flex-col";

  return (
    <div className={`flex w-[min(18rem,80vw)] items-end gap-2 ${touchLayoutClass}`}>
      <div className="sm:hidden">
        <SettingsInfo
          guideVolume={guideVolume}
          guideAvailable={guideAvailable}
          micUserEnabled={micUserEnabled}
          micName={micName}
          micMonitorUserEnabled={micMonitorUserEnabled}
          micCaptureStatus={micCaptureStatus}
          themeIndex={themeIndex}
          videoFlavor={videoFlavor}
        />
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="pointer-events-auto rounded-sm border-2 border-white/70 bg-black/10 px-2.5 py-1 text-sm text-white/90 transition-colors hover:bg-black/20 active:bg-black/30"
      >
        {open ? "Hide controls" : "Playback controls"}
      </button>

      {open && (
        <div className="grid w-full grid-cols-3 gap-2 text-center">
          <TouchButton label="Pause" onClick={handlePause} />
          {guideAvailable && (
            <>
              <TouchButton
                label={guideVolume === 0 ? "Guide On" : "Guide Off"}
                onClick={() => setPersistedGuideVolume(guideVolume > 0 ? 0 : 0.3)}
              />
              <TouchButton
                label="Guide +"
                onClick={() => setPersistedGuideVolume(guideVolume + 0.1)}
              />
              <TouchButton
                label="Guide -"
                onClick={() => setPersistedGuideVolume(guideVolume - 0.1)}
              />
            </>
          )}
          <TouchButton label={micUserEnabled ? "Mic Off" : "Mic On"} onClick={handleToggleMic} />
          <TouchButton label="Mic Select" onClick={handleCycleMic} />
          <TouchButton
            label={micMonitorUserEnabled ? "Monitor Off" : "Monitor On"}
            onClick={handleToggleMicMonitor}
          />
          <TouchButton label="Theme" onClick={cycleTheme} />
          <TouchButton
            label={phraseLoopEnabled ? "Loop Off" : "Loop Phrase"}
            onClick={togglePhraseLoop}
          />
          <TouchButton
            label="Flavor"
            onClick={cycleFlavor}
            disabled={!isPixabayTheme(themeIndex)}
          />
        </div>
      )}
    </div>
  );
}

type PlaybackHudPosition = "top" | "bottom";

function Disclaimer({
  source,
  position,
  noStems,
  micActive,
}: {
  source: string;
  position: PlaybackHudPosition;
  noStems: boolean;
  micActive: boolean;
}) {
  // No stems means we score against the original mix, so pitch scoring suffers.
  if (noStems && micActive) {
    return (
      <DisclaimerNote position={position}>
        Free sing and recording are available; strict scoring needs a melody guide
      </DisclaimerNote>
    );
  }

  // USDX and provided LRC timings are authored, not AI-generated.
  if (source === "usdx" || source === "lrc") {
    return null;
  }

  const text =
    source === "lyrics"
      ? "Timing is AI-generated and may not be perfectly accurate"
      : "Lyrics and timing are AI-generated and may not be perfectly accurate";

  return <DisclaimerNote position={position}>{text}</DisclaimerNote>;
}

function DisclaimerNote({
  position,
  children,
}: {
  position: PlaybackHudPosition;
  children: ReactNode;
}) {
  return (
    <p
      className={`${NOTE_BASE_CLASS} ${notePositionClass(position)} left-1/2 -translate-x-1/2 whitespace-nowrap text-center`}
    >
      {children}
    </p>
  );
}

function notePositionClass(hudPosition: PlaybackHudPosition): string {
  return hudPosition === "bottom" ? "top-2" : "bottom-2";
}

interface PlaybackHudProps {
  title: string;
  artist: string;
  config: AppConfig | null;
  position?: PlaybackHudPosition;
}

function PlaybackHudImpl({ title, artist, config, position = "top" }: PlaybackHudProps) {
  const { duration, guideVolume, guideAvailable } = usePlaybackTransportState();
  const { subscribe, getCurrentTime } = usePlaybackTransportActions();
  const { themeIndex, videoFlavor } = usePlaybackThemeState();
  const {
    firstSegmentStart,
    lastSegmentEnd,
    introSkipLeadSec,
    segments,
    transcriptSource,
    phraseLoopEnabled,
  } = usePlaybackTranscriptState();
  const { handleSkipIntro, handleSkipOutro, togglePhraseLoop } = usePlaybackTranscriptActions();
  const {
    pitchScore,
    micUserEnabled,
    micName,
    micMonitorUserEnabled,
    micCaptureStatus,
    micReady,
    melody,
    performance,
    feedbackMode,
    scoringDifficulty,
    pitchToleranceFactor,
    recordingWanted,
    recordingStatus,
    multiplayerPlayers,
  } = usePlaybackMicState();
  const {
    setFeedbackMode,
    setScoringDifficulty,
    setPitchToleranceFactor,
    handleToggleMicMonitor,
    handleToggleRecording,
  } = usePlaybackMicActions();

  const lastSecondRef = useRef(-1);
  const timerRef = useRef<HTMLParagraphElement>(null);
  const skipIntroRef = useRef<HTMLButtonElement>(null);
  const skipOutroRef = useRef<HTMLButtonElement>(null);
  const gapCaptionRef = useRef<HTMLParagraphElement>(null);
  const gapHintRef = useRef(0);

  const showPixabayCredit = isPixabayTheme(themeIndex);
  const hasTouch = useHasTouchInput();
  const difficultyProfile = scoringDifficultyProfile(scoringDifficulty);
  const nextDifficulty = nextScoringDifficulty(scoringDifficulty);
  const multiplayer = multiplayerPlayers.length > 1;

  // Update playback text without triggering React renders every frame.
  useEffect(() => {
    const updateGapCaption = (time: number) => {
      const el = gapCaptionRef.current;
      if (!el) return;
      if (segments.length === 0) {
        el.style.display = "none";
        return;
      }
      const idx = findCurrentSegment(segments, time, gapHintRef.current);
      gapHintRef.current = idx;
      const caption = computeLyricGapCaption(segments, time, idx);
      if (caption) {
        el.textContent = caption;
        el.style.display = "";
      } else {
        el.style.display = "none";
      }
    };

    gapHintRef.current = 0;
    if (timerRef.current) {
      timerRef.current.textContent = `${formatTime(getCurrentTime())} / ${formatTime(duration)}`;
    }
    updateGapCaption(getCurrentTime());

    return subscribe((time) => {
      const sec = Math.floor(time);
      if (sec !== lastSecondRef.current) {
        lastSecondRef.current = sec;
        if (timerRef.current) {
          timerRef.current.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
        }
      }

      if (skipIntroRef.current) {
        skipIntroRef.current.style.display =
          time < firstSegmentStart - introSkipLeadSec ? "" : "none";
      }
      if (skipOutroRef.current) {
        skipOutroRef.current.style.display = time > lastSegmentEnd + 1 ? "" : "none";
      }
      updateGapCaption(time);
    });
  }, [
    subscribe,
    getCurrentTime,
    duration,
    firstSegmentStart,
    introSkipLeadSec,
    lastSegmentEnd,
    segments,
  ]);

  const hudPositionClass =
    position === "bottom"
      ? "bottom-[calc(2rem+env(safe-area-inset-bottom))] items-end md:bottom-3"
      : "top-[4.25rem] items-start md:top-3";
  const hudFlowClass = position === "bottom" ? "flex-col-reverse" : "flex-col";
  const skipButtonsClass = position === "bottom" ? "mb-2" : "mt-2";

  return (
    <>
      <div
        className={`pointer-events-auto absolute inset-x-0 z-20 flex justify-between gap-3 px-3 md:px-4 ${hudPositionClass}`}
      >
        <div
          className={`flex min-w-0 max-w-[58%] overflow-hidden sm:max-w-[34%] lg:max-w-[40%] ${hudFlowClass}`}
        >
          <h1 className="line-clamp-2 [overflow-wrap:anywhere] text-base leading-tight text-white md:text-[1.375rem]">
            {title}
          </h1>
          <p className="line-clamp-1 [overflow-wrap:anywhere] text-sm text-white/70 md:text-base">
            {artist}
          </p>
          <p ref={timerRef} className="text-sm text-white/70 md:text-base">
            0:00 / {formatTime(duration)}
          </p>
          <div className={`flex gap-2 ${skipButtonsClass}`}>
            <SkipButton ref={skipIntroRef} label="Skip Intro" onClick={handleSkipIntro} />
            <SkipButton ref={skipOutroRef} label="Skip Outro" onClick={handleSkipOutro} />
          </div>
          <p
            ref={gapCaptionRef}
            role="status"
            aria-live="polite"
            className={`truncate text-xs font-medium text-white/60 md:text-sm ${
              position === "bottom" ? "order-first" : ""
            }`}
            style={{ display: "none" }}
          />
        </div>

        <div className={`flex min-w-0 items-end ${hudFlowClass}`}>
          <div className="pointer-events-auto mb-1 flex items-center gap-1 border border-white/20 bg-black/45 p-1">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`Adjust pitch catching, ${pitchToleranceFactor.toFixed(2)} times forgiveness`}
                  className="flex h-8 items-center gap-1 px-2 text-xs font-semibold text-cyan-200 hover:bg-white/10"
                >
                  Pitch {pitchToleranceFactor.toFixed(2)}×
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side={position === "bottom" ? "top" : "bottom"}
                className="w-auto border-0 bg-transparent p-0"
              >
                <PitchToleranceControl
                  compact
                  value={pitchToleranceFactor}
                  difficulty={scoringDifficulty}
                  onChange={setPitchToleranceFactor}
                />
              </PopoverContent>
            </Popover>
            <button
              type="button"
              title={phraseLoopEnabled ? "Stop phrase loop" : "Loop current phrase"}
              aria-pressed={phraseLoopEnabled}
              onClick={togglePhraseLoop}
              className={`flex size-8 items-center justify-center transition-colors ${
                phraseLoopEnabled ? "bg-cyan-400 text-black" : "text-white/75 hover:bg-white/10"
              }`}
            >
              <Repeat2 className="size-4" />
            </button>
            <button
              type="button"
              title={`${difficultyProfile.label} scoring: ${difficultyProfile.description} Click for ${scoringDifficultyProfile(nextDifficulty).label}.`}
              aria-label={`Scoring difficulty ${difficultyProfile.label}`}
              onClick={() => setScoringDifficulty(nextDifficulty)}
              className={`flex h-8 items-center gap-1 px-2 text-xs font-semibold transition-colors ${difficultyButtonClass(scoringDifficulty)}`}
            >
              <Gauge className="size-4" /> {difficultyProfile.label}
            </button>
            <button
              type="button"
              title="Coach feedback"
              aria-pressed={feedbackMode === "coach"}
              onClick={() => setFeedbackMode("coach")}
              className={`flex h-8 items-center gap-1 px-2 text-xs transition-colors ${
                feedbackMode === "coach" ? "bg-white text-black" : "text-white/75 hover:bg-white/10"
              }`}
            >
              <GraduationCap className="size-4" /> Coach
            </button>
            <button
              type="button"
              title="Perform without coaching interruptions; game effects stay on"
              aria-pressed={feedbackMode === "game"}
              onClick={() => setFeedbackMode("game")}
              className={`flex h-8 items-center gap-1 px-2 text-xs transition-colors ${
                feedbackMode === "game" ? "bg-white text-black" : "text-white/75 hover:bg-white/10"
              }`}
            >
              <Gamepad2 className="size-4" /> Perform
            </button>
            <button
              type="button"
              title={
                multiplayer
                  ? "Use your audio interface's direct monitoring in multiplayer"
                  : micMonitorUserEnabled
                    ? "Turn microphone monitoring off"
                    : "Hear your voice with low latency (wired headphones recommended)"
              }
              aria-label="Microphone monitoring"
              disabled={multiplayer}
              aria-pressed={micMonitorUserEnabled}
              onClick={handleToggleMicMonitor}
              className={`flex size-8 items-center justify-center transition-colors ${
                micMonitorUserEnabled
                  ? "bg-cyan-400 text-black hover:bg-cyan-300"
                  : "text-white/75 hover:bg-white/10"
              }`}
            >
              <Headphones className="size-4" />
            </button>
            <button
              type="button"
              title={
                multiplayer
                  ? "Vocal recording is available in solo mode"
                  : recordingWanted
                    ? "Stop vocal recording"
                    : "Start vocal recording"
              }
              disabled={multiplayer}
              aria-pressed={recordingWanted}
              onClick={handleToggleRecording}
              className={`flex size-8 items-center justify-center transition-colors ${
                recordingWanted ? "bg-red-600 text-white" : "text-white/75 hover:bg-white/10"
              }`}
            >
              {recordingWanted ? <Square className="size-3.5" /> : <Circle className="size-4" />}
            </button>
          </div>
          <div
            className={`text-base md:text-lg ${micReady && melody?.strict_scoring_available ? "text-white" : "text-white/50"}`}
          >
            {multiplayer ? `${multiplayerPlayers[0].profile}:` : "Score:"}{" "}
            {micReady && melody?.strict_scoring_available
              ? performance.overall
              : (pitchScore ?? "--")}
          </div>
          <div className="flex items-center gap-1 text-xs text-white/55">
            {recordingWanted && <Circle className="size-2 fill-red-500 text-red-500" />}
            <span>
              {multiplayer
                ? `${multiplayerPlayers.length} singers · individual scores`
                : recordingStatus === "off"
                  ? "Recording off"
                  : recordingStatus}
            </span>
          </div>
          <div className="hidden sm:block">
            <SettingsInfo
              guideVolume={guideVolume}
              guideAvailable={guideAvailable}
              micUserEnabled={micUserEnabled}
              micName={micName}
              micMonitorUserEnabled={micMonitorUserEnabled}
              micCaptureStatus={micCaptureStatus}
              themeIndex={themeIndex}
              videoFlavor={videoFlavor}
            />
          </div>
          <TouchControls config={config} hasTouch={hasTouch} position={position} />
        </div>
      </div>

      {showPixabayCredit && (
        <p className={`${NOTE_BASE_CLASS} ${notePositionClass(position)} right-4`}>
          Videos by Pixabay
        </p>
      )}

      <Disclaimer
        source={transcriptSource}
        position={position}
        noStems={!guideAvailable}
        micActive={micUserEnabled}
      />
    </>
  );
}

export const PlaybackHud = memo(PlaybackHudImpl);
