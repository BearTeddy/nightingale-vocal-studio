import {
  usePlaybackMicActions,
  usePlaybackThemeActions,
  usePlaybackTranscriptActions,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from "@/contexts/playback";
import { useNavInput } from "@/hooks/navigation/use-nav-input";
import { usePlaybackConfigPersist } from "@/hooks/playback/use-playback-config-persist";
import {
  PLAYBACK_CONTROLS_TOGGLE_EVENT,
  PLAYBACK_SEEK_STEP_SECONDS,
  seekPlaybackBy,
} from "@/lib/playback/transport-controls";
import type { AppConfig } from "@/types/AppConfig";
import { useCallback, useEffect, useRef } from "react";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function isManagedShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-nav-passthrough]") !== null;
}

/**
 * Wires keyboard + gamepad input for the playback session. Reads everything it
 * needs from the playback contexts; only the app config is passed in so we can
 * persist guide-volume changes without coupling this hook to the config query.
 */
export function usePlaybackInput(config: AppConfig | null) {
  const { paused, isReady, duration, guideVolume, guideAvailable } = usePlaybackTransportState();
  const { getCurrentTime, seek, setGuideVolume, handlePause, handleContinue } =
    usePlaybackTransportActions();
  const { cycleTheme, cycleFlavor } = usePlaybackThemeActions();
  const { firstSegmentStart, lastSegmentEnd, introSkipLeadSec } = usePlaybackTranscriptState();
  const { handleSkipIntro, handleSkipOutro, togglePhraseLoop } = usePlaybackTranscriptActions();
  const {
    handleToggleMic,
    handleCycleMic,
    handleToggleMicMonitor,
    handleToggleRecording,
    setFeedbackMode,
  } = usePlaybackMicActions();

  const persistConfig = usePlaybackConfigPersist(config);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Gamepad: nav.back = pause/resume, nav.confirm = skip intro/outro
  useNavInput(
    useCallback(
      (action) => {
        if (action.back) {
          if (pausedRef.current) {
            handleContinue();
          } else {
            handlePause();
          }
          return;
        }

        if (action.left) {
          seek(seekPlaybackBy(getCurrentTime(), -PLAYBACK_SEEK_STEP_SECONDS, duration));
          return;
        }
        if (action.right) {
          seek(seekPlaybackBy(getCurrentTime(), PLAYBACK_SEEK_STEP_SECONDS, duration));
          return;
        }

        if (pausedRef.current) return;

        if (action.confirm) {
          if (!isReady) return;
          const t = getCurrentTime();
          if (t < firstSegmentStart - introSkipLeadSec) {
            handleSkipIntro();
          } else if (t > lastSegmentEnd + 1) {
            handleSkipOutro();
          }
        }
      },
      [
        handlePause,
        handleContinue,
        isReady,
        duration,
        getCurrentTime,
        seek,
        firstSegmentStart,
        lastSegmentEnd,
        introSkipLeadSec,
        handleSkipIntro,
        handleSkipOutro,
      ],
    ),
  );

  // Keyboard-only shortcuts (P/Space, Home/0, H, G, T, F, M, N, R, +/-)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (isManagedShortcutTarget(e.target)) return;

      if (e.key === " " || e.key === "p" || e.key === "P") {
        if (e.key === " " && e.target instanceof HTMLButtonElement) return;
        if (e.repeat) return;
        e.preventDefault();
        if (paused) {
          handleContinue();
        } else {
          handlePause();
        }
        return;
      }

      if (e.key === "Home" || e.key === "0") {
        if (e.repeat) return;
        e.preventDefault();
        seek(0);
        return;
      }

      if (e.key === "h" || e.key === "H") {
        if (e.repeat) return;
        window.dispatchEvent(new Event(PLAYBACK_CONTROLS_TOGGLE_EVENT));
        return;
      }

      if (paused) return;

      switch (e.key) {
        case "t":
        case "T":
          cycleTheme();
          break;

        case "f":
        case "F":
          cycleFlavor();
          break;

        case "g":
        case "G": {
          if (!guideAvailable) break;
          const nextVol = guideVolume > 0 ? 0 : 0.3;
          setGuideVolume(nextVol);
          persistConfig({ guide_volume: nextVol });
          break;
        }

        case "=":
        case "+": {
          if (!guideAvailable) break;
          const next = Math.min(1, guideVolume + 0.1);
          setGuideVolume(next);
          persistConfig({ guide_volume: next });
          break;
        }

        case "-": {
          if (!guideAvailable) break;
          const next = Math.max(0, guideVolume - 0.1);
          setGuideVolume(next);
          persistConfig({ guide_volume: next });
          break;
        }

        case "m":
        case "M":
          handleToggleMic();
          break;

        case "n":
        case "N":
          handleCycleMic();
          break;

        case "r":
        case "R":
          handleToggleMicMonitor();
          break;

        case "l":
        case "L":
          togglePhraseLoop();
          break;

        case "c":
        case "C":
          setFeedbackMode("coach");
          break;

        case "v":
        case "V":
          setFeedbackMode("game");
          break;

        case "k":
        case "K":
          handleToggleRecording();
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    paused,
    guideVolume,
    guideAvailable,
    setGuideVolume,
    cycleTheme,
    cycleFlavor,
    persistConfig,
    handlePause,
    handleContinue,
    seek,
    handleToggleMic,
    handleCycleMic,
    handleToggleMicMonitor,
    handleToggleRecording,
    setFeedbackMode,
    togglePhraseLoop,
  ]);
}
