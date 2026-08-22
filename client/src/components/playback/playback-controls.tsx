import { isFullScreen, setFullScreen } from "@/bridge/fullScreen";
import { isTauri } from "@/bridge/runtime";
import { startWindowDragging } from "@/bridge/window";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePlaybackTransportActions, usePlaybackTransportState } from "@/contexts/playback";
import { usePlaybackConfigPersist } from "@/hooks/playback/use-playback-config-persist";
import {
  PLAYBACK_CONTROLS_TOGGLE_EVENT,
  PLAYBACK_SEEK_STEP_SECONDS,
  formatPlaybackTime,
  seekPlaybackBy,
} from "@/lib/playback/transport-controls";
import { cn } from "@/lib/utils";
import type { AppConfig } from "@/types/AppConfig";
import {
  EyeOff,
  GripHorizontal,
  ListRestart,
  LogOut,
  Maximize2,
  MicVocal,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

const AUTO_HIDE_DELAY_MS = 3_500;
const CONTROL_BUTTON_CLASS =
  "size-9 border-white/10 bg-white/5 text-white hover:border-white/25 hover:bg-white/15 hover:text-white";

interface PlaybackControlsProps {
  title: string;
  artist: string;
  config: AppConfig | null;
}

interface ControlButtonProps extends Omit<ComponentProps<typeof Button>, "children"> {
  label: string;
  shortcut?: string;
  children: ReactNode;
}

function ControlButton({ label, shortcut, children, className, ...props }: ControlButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          className={cn(CONTROL_BUTTON_CLASS, className)}
          aria-label={shortcut ? `${label} (${shortcut})` : label}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <span>{label}</span>
        {shortcut && <span className="text-background/65">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function SeekIcon({ forward }: { forward: boolean }) {
  const Icon = forward ? RotateCw : RotateCcw;

  return (
    <span className="relative flex size-5 items-center justify-center" aria-hidden>
      <Icon className="size-5" />
      <span className="absolute text-[0.45rem] font-bold leading-none">10</span>
    </span>
  );
}

export function PlaybackControls({ title, artist, config }: PlaybackControlsProps) {
  const { isPlaying, paused, duration, guideVolume, guideAvailable, masterVolume } =
    usePlaybackTransportState();
  const {
    subscribe,
    getCurrentTime,
    seek,
    setGuideVolume,
    setMasterVolume,
    handlePause,
    handleContinue,
    handleExit,
  } = usePlaybackTransportActions();
  const persistConfig = usePlaybackConfigPersist(config);

  const [currentTime, setCurrentTime] = useState(() => getCurrentTime());
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [fullscreen, setFullscreenState] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const lastPointerActivityRef = useRef(0);
  const scrubTimeRef = useRef<number | null>(null);
  const previousVolumeRef = useRef(1);
  const previousGuideVolumeRef = useRef(Math.max(guideVolume, 0.3));

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    if (paused || !isPlaying) return;

    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false);
      hideTimerRef.current = null;
    }, AUTO_HIDE_DELAY_MS);
  }, [clearHideTimer, isPlaying, paused]);

  const revealControls = useCallback(() => {
    setVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  const toggleControls = useCallback(() => {
    setVisible((current) => {
      const next = !current;
      clearHideTimer();
      if (!next && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      if (next) window.setTimeout(scheduleHide, 0);
      return next;
    });
  }, [clearHideTimer, scheduleHide]);

  useEffect(() => {
    setCurrentTime(getCurrentTime());

    return subscribe((time) => {
      if (scrubTimeRef.current === null) setCurrentTime(time);
    });
  }, [getCurrentTime, subscribe]);

  useEffect(() => {
    const onActivity = (event: KeyboardEvent | PointerEvent | TouchEvent) => {
      if (event instanceof KeyboardEvent && (event.key === "h" || event.key === "H")) return;
      if (event instanceof PointerEvent) {
        const now = performance.now();
        if (now - lastPointerActivityRef.current < 120) return;
        lastPointerActivityRef.current = now;
      }
      revealControls();
    };

    const onToggle = () => toggleControls();

    window.addEventListener("pointermove", onActivity);
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener(PLAYBACK_CONTROLS_TOGGLE_EVENT, onToggle);

    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener(PLAYBACK_CONTROLS_TOGGLE_EVENT, onToggle);
      clearHideTimer();
    };
  }, [clearHideTimer, revealControls, toggleControls]);

  useEffect(() => {
    if (paused || !isPlaying) {
      clearHideTimer();
      setVisible(true);
      return;
    }

    scheduleHide();
  }, [clearHideTimer, isPlaying, paused, scheduleHide]);

  useEffect(() => {
    const syncFullscreen = () => {
      void isFullScreen().then(setFullscreenState);
    };

    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    window.addEventListener("focus", syncFullscreen);
    window.addEventListener("resize", syncFullscreen);

    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreen);
      window.removeEventListener("focus", syncFullscreen);
      window.removeEventListener("resize", syncFullscreen);
    };
  }, []);

  const displayedTime = scrubTime ?? currentTime;
  const sliderMaximum = Math.max(duration, 1);

  const seekRelative = useCallback(
    (delta: number) => {
      seek(seekPlaybackBy(getCurrentTime(), delta, duration));
      revealControls();
    },
    [duration, getCurrentTime, revealControls, seek],
  );

  const togglePlayback = useCallback(() => {
    if (paused) {
      handleContinue();
    } else {
      handlePause();
    }
  }, [handleContinue, handlePause, paused]);

  const toggleMasterMute = useCallback(() => {
    if (masterVolume > 0) {
      previousVolumeRef.current = masterVolume;
      setMasterVolume(0);
      return;
    }

    setMasterVolume(previousVolumeRef.current);
  }, [masterVolume, setMasterVolume]);

  const updateMasterVolume = useCallback(
    (values: number[]) => {
      const next = (values[0] ?? 0) / 100;
      if (next > 0) previousVolumeRef.current = next;
      setMasterVolume(next);
    },
    [setMasterVolume],
  );

  const toggleGuide = useCallback(() => {
    const next =
      guideVolume > 0 ? 0 : Math.max(previousGuideVolumeRef.current, config?.guide_volume ?? 0.3);

    if (guideVolume > 0) previousGuideVolumeRef.current = guideVolume;
    setGuideVolume(next);
    persistConfig({ guide_volume: next });
  }, [config?.guide_volume, guideVolume, persistConfig, setGuideVolume]);

  const toggleFullscreen = useCallback(async () => {
    const next = !(await isFullScreen());
    await setFullScreen(next);
    setFullscreenState(next);
    persistConfig({ fullscreen: next });
  }, [persistConfig]);

  const commitScrub = useCallback(
    (values: number[]) => {
      const next = values[0] ?? 0;
      scrubTimeRef.current = null;
      setScrubTime(null);
      setCurrentTime(next);
      seek(next);
      scheduleHide();
    },
    [scheduleHide, seek],
  );

  return (
    <section
      className={cn(
        "absolute inset-x-0 bottom-0 z-40 transform-gpu text-white transition-transform duration-200 motion-reduce:transition-none",
        visible ? "translate-y-0" : "translate-y-[calc(100%-0.2rem)] pointer-events-none",
      )}
      aria-label="Playback controls"
      aria-hidden={!visible}
      onPointerEnter={clearHideTimer}
      onPointerLeave={scheduleHide}
    >
      {isTauri && !fullscreen && visible && (
        <button
          type="button"
          className="pointer-events-auto absolute bottom-full left-1/2 flex h-7 w-16 -translate-x-1/2 items-center justify-center rounded-t-md border border-b-0 border-white/15 bg-black/80 text-white/65 backdrop-blur-md transition-colors hover:text-white"
          aria-label="Drag playback window"
          title="Drag playback window"
          onPointerDown={(event) => {
            if (event.button === 0) void startWindowDragging();
          }}
        >
          <GripHorizontal className="size-4" />
        </button>
      )}

      <div className="border-t border-white/15 bg-black/85 shadow-[0_-8px_30px_rgba(0,0,0,0.25)] backdrop-blur-md">
        <div className="flex h-8 items-center gap-2 px-3 pt-1 text-[0.65rem] tabular-nums text-white/75">
          <span className="w-12 text-right">{formatPlaybackTime(displayedTime)}</span>
          <Slider
            className="h-6 flex-1 [&_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-track]]:h-1.5"
            aria-label="Song position"
            data-nav-passthrough
            min={0}
            max={sliderMaximum}
            step={0.1}
            value={[Math.min(displayedTime, sliderMaximum)]}
            onValueChange={(values) => {
              const next = values[0] ?? 0;
              scrubTimeRef.current = next;
              setScrubTime(next);
            }}
            onValueCommit={commitScrub}
          />
          <span className="w-12">{formatPlaybackTime(duration)}</span>
        </div>

        <div className="flex min-h-14 items-center gap-2 px-2 pb-2 sm:px-3">
          <div className="hidden min-w-0 flex-1 md:block">
            <p className="truncate text-xs font-medium text-white">{title}</p>
            <p className="truncate text-[0.65rem] text-white/60">{artist}</p>
          </div>

          <div className="flex shrink-0 items-center justify-center gap-1 sm:gap-1.5">
            <ControlButton
              label="Restart song"
              shortcut="Home / 0"
              className="hidden sm:inline-flex"
              onClick={() => seek(0)}
            >
              <ListRestart />
            </ControlButton>
            <ControlButton
              label="Back 10 seconds"
              shortcut="Left arrow"
              onClick={() => seekRelative(-PLAYBACK_SEEK_STEP_SECONDS)}
            >
              <SeekIcon forward={false} />
            </ControlButton>
            <ControlButton
              label={paused ? "Resume" : "Pause"}
              shortcut="P / Space"
              className="size-10 border-primary/70 bg-primary text-primary-foreground hover:border-primary hover:bg-primary/85"
              onClick={togglePlayback}
            >
              {paused ? <Play className="size-5 fill-current" /> : <Pause className="size-5" />}
            </ControlButton>
            <ControlButton
              label="Forward 10 seconds"
              shortcut="Right arrow"
              onClick={() => seekRelative(PLAYBACK_SEEK_STEP_SECONDS)}
            >
              <SeekIcon forward />
            </ControlButton>
          </div>

          <div className="flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-1.5">
            <ControlButton
              label={guideVolume > 0 ? "Turn guide vocal off" : "Turn guide vocal on"}
              shortcut="G"
              className="hidden sm:inline-flex"
              disabled={!guideAvailable}
              onClick={toggleGuide}
            >
              <MicVocal className={cn(guideVolume <= 0 && "opacity-45")} />
            </ControlButton>

            <ControlButton
              label={masterVolume > 0 ? "Mute music" : "Unmute music"}
              onClick={toggleMasterMute}
            >
              {masterVolume > 0 ? <Volume2 /> : <VolumeX />}
            </ControlButton>
            <Slider
              className="hidden h-7 w-20 lg:flex [&_[data-slot=slider-thumb]]:size-3 [&_[data-slot=slider-track]]:h-1.5"
              aria-label="Music volume"
              data-nav-passthrough
              min={0}
              max={100}
              step={1}
              value={[masterVolume * 100]}
              onValueChange={updateMasterVolume}
            />

            <ControlButton
              label={fullscreen ? "Leave fullscreen" : "Enter fullscreen"}
              shortcut="F11"
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <Minimize2 /> : <Maximize2 />}
            </ControlButton>
            <ControlButton
              label="Hide controls"
              shortcut="H"
              className="hidden sm:inline-flex"
              onClick={toggleControls}
            >
              <EyeOff />
            </ControlButton>
            <ControlButton label="Exit to library" onClick={handleExit}>
              <LogOut />
            </ControlButton>
          </div>
        </div>
      </div>
    </section>
  );
}
