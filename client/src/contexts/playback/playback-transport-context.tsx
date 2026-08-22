/**
 * Owns the audio engine for the active song: wraps `useAudioPlayer`, the
 * stems-ready handshake, the user-facing `paused` flag, and the pause/continue/
 * exit handlers shared by overlays, hotkeys, and the result dialog.
 *
 * Splits state and actions into two contexts so consumers that only need
 * stable callbacks (subscribe, getCurrentTime, handlePause...) don't re-render
 * when reactive fields like `isPlaying` or `guideVolume` change.
 */

import { type AudioPlayer, type TimeSubscriber, useAudioPlayer } from "@/hooks/use-audio-player";
import { ensureMp3Stems, onStemsReady } from "@/bridge/playback";
import { clampPlaybackTime } from "@/lib/playback/transport-controls";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

export interface PlaybackTransportState {
  isReady: boolean;
  isPlaying: boolean;
  isFinished: boolean;
  paused: boolean;
  duration: number;
  guideVolume: number;
  masterVolume: number;
  guideAvailable: boolean;
  error: string | null;
}

export interface PlaybackTransportActions {
  subscribe: (fn: TimeSubscriber) => () => void;
  getCurrentTime: () => number;
  seek: (time: number) => void;
  setGuideVolume: (volume: number) => void;
  setMasterVolume: (volume: number) => void;
  getVocalsBuffer: AudioPlayer["getVocalsBuffer"];
  getScoringBuffer: AudioPlayer["getScoringBuffer"];
  getAudioContext: AudioPlayer["getAudioContext"];
  subscribeTransportEvents: (fn: (event: TransportEvent) => void) => () => void;
  /** Raw audio-engine pause; does NOT raise the `paused` UI flag. */
  pauseAudio: () => void;
  finishAudio: () => void;
  handlePause: () => void;
  handleContinue: () => void;
  handleExit: () => void;
}

export type TransportEvent =
  | { type: "pause"; sourceTime: number }
  | { type: "resume"; sourceTime: number }
  | { type: "seek"; sourceTime: number; targetTime: number; playing: boolean }
  | { type: "finish"; sourceTime: number }
  | { type: "exit"; sourceTime: number };

const TransportStateContext = createContext<PlaybackTransportState | null>(null);
const TransportActionsContext = createContext<PlaybackTransportActions | null>(null);

interface PlaybackTransportProviderProps {
  fileHash: string;
  initialGuideVolume: number;
  children: ReactNode;
}

export function PlaybackTransportProvider({
  fileHash,
  initialGuideVolume,
  children,
}: PlaybackTransportProviderProps) {
  const navigate = useNavigate();
  // Snapshot the initial guide volume so changing config later doesn't
  // re-instantiate the audio engine via useAudioPlayer's effect deps.
  const initialGuideVolumeRef = useRef(initialGuideVolume);

  const [stemsReady, setStemsReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const transportSubscribersRef = useRef<Set<(event: TransportEvent) => void>>(new Set());

  const emitTransportEvent = useCallback((event: TransportEvent) => {
    for (const subscriber of transportSubscribersRef.current) subscriber(event);
  }, []);

  const subscribeTransportEvents = useCallback((fn: (event: TransportEvent) => void) => {
    transportSubscribersRef.current.add(fn);
    return () => transportSubscribersRef.current.delete(fn);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    // Register the listener BEFORE invoking the command. On a page reload the
    // WS handshake races the `stems-ready` broadcast — if the listener isn't
    // attached (or the socket isn't open) when the server emits, the event
    // is gone forever and `stemsReady` stays false, leaving the page stuck
    // on a black screen. `onStemsReady` awaits the socket open under the
    // hood, so once its promise resolves we are guaranteed to receive the
    // event the command triggers.
    onStemsReady((event) => {
      if (event.file_hash !== fileHash) return;
      if (event.error) {
        toast.error(`Stem conversion failed: ${event.error}`);
        navigate("/", { replace: true });
      } else {
        setStemsReady(true);
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      ensureMp3Stems(fileHash);
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [fileHash, navigate]);

  const audio = useAudioPlayer(fileHash, initialGuideVolumeRef.current, stemsReady);

  useEffect(() => {
    if (audio.error) {
      toast.error(audio.error);
      navigate("/", { replace: true });
    }
  }, [audio.error, navigate]);

  const handlePause = useCallback(() => {
    emitTransportEvent({ type: "pause", sourceTime: audio.getCurrentTime() });
    audio.pause();
    setPaused(true);
  }, [audio.getCurrentTime, audio.pause, emitTransportEvent]);

  const handleContinue = useCallback(() => {
    emitTransportEvent({ type: "resume", sourceTime: audio.getCurrentTime() });
    setPaused(false);
    audio.resume();
  }, [audio.getCurrentTime, audio.resume, emitTransportEvent]);

  const seek = useCallback(
    (time: number) => {
      const targetTime = clampPlaybackTime(time, audio.duration);
      emitTransportEvent({
        type: "seek",
        sourceTime: audio.getCurrentTime(),
        targetTime,
        playing: audio.isPlaying,
      });
      audio.seek(targetTime);
    },
    [audio.duration, audio.getCurrentTime, audio.isPlaying, audio.seek, emitTransportEvent],
  );

  const handleExit = useCallback(() => {
    emitTransportEvent({ type: "exit", sourceTime: audio.getCurrentTime() });
    audio.cleanup();
    navigate("/", { replace: true });
  }, [audio.cleanup, audio.getCurrentTime, emitTransportEvent, navigate]);

  const finishAudio = useCallback(() => {
    emitTransportEvent({ type: "finish", sourceTime: audio.getCurrentTime() });
    audio.pause();
  }, [audio.getCurrentTime, audio.pause, emitTransportEvent]);

  const stateValue = useMemo<PlaybackTransportState>(
    () => ({
      isReady: audio.isReady,
      isPlaying: audio.isPlaying,
      isFinished: audio.isFinished,
      paused,
      duration: audio.duration,
      guideVolume: audio.guideVolume,
      masterVolume: audio.masterVolume,
      guideAvailable: audio.guideAvailable,
      error: audio.error,
    }),
    [
      audio.isReady,
      audio.isPlaying,
      audio.isFinished,
      audio.duration,
      audio.guideVolume,
      audio.masterVolume,
      audio.guideAvailable,
      audio.error,
      paused,
    ],
  );

  const actionsValue = useMemo<PlaybackTransportActions>(
    () => ({
      subscribe: audio.subscribe,
      getCurrentTime: audio.getCurrentTime,
      seek,
      setGuideVolume: audio.setGuideVolume,
      setMasterVolume: audio.setMasterVolume,
      getVocalsBuffer: audio.getVocalsBuffer,
      getScoringBuffer: audio.getScoringBuffer,
      getAudioContext: audio.getAudioContext,
      subscribeTransportEvents,
      pauseAudio: audio.pause,
      finishAudio,
      handlePause,
      handleContinue,
      handleExit,
    }),
    [
      audio.subscribe,
      audio.getCurrentTime,
      seek,
      audio.setGuideVolume,
      audio.setMasterVolume,
      audio.getVocalsBuffer,
      audio.getScoringBuffer,
      audio.getAudioContext,
      subscribeTransportEvents,
      audio.pause,
      finishAudio,
      handlePause,
      handleContinue,
      handleExit,
    ],
  );

  return (
    <TransportStateContext.Provider value={stateValue}>
      <TransportActionsContext.Provider value={actionsValue}>
        {children}
      </TransportActionsContext.Provider>
    </TransportStateContext.Provider>
  );
}

export function usePlaybackTransportState(): PlaybackTransportState {
  const ctx = useContext(TransportStateContext);
  if (!ctx) {
    throw new Error("usePlaybackTransportState must be used within a PlaybackTransportProvider");
  }
  return ctx;
}

export function usePlaybackTransportActions(): PlaybackTransportActions {
  const ctx = useContext(TransportActionsContext);
  if (!ctx) {
    throw new Error("usePlaybackTransportActions must be used within a PlaybackTransportProvider");
  }
  return ctx;
}
