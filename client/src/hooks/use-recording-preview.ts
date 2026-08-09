import { playbackAdapter } from "@/bridge/playback";
import { clampRecordingPreviewTime, recordingPreviewDecision } from "@/lib/recording-preview";
import { useCallback, useEffect, useRef, useState } from "react";

export interface RecordingPreviewState {
  path: string | null;
  label: string;
  playing: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  error: string | null;
}

export interface RecordingPreviewController extends RecordingPreviewState {
  play: (path: string, label: string) => Promise<void>;
  toggle: () => Promise<void>;
  seek: (time: number) => void;
  stop: () => void;
}

const EMPTY_PREVIEW: RecordingPreviewState = {
  path: null,
  label: "",
  playing: false,
  loading: false,
  currentTime: 0,
  duration: 0,
  error: null,
};

export function useRecordingPreview(): RecordingPreviewController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pathRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const [state, setState] = useState<RecordingPreviewState>(EMPTY_PREVIEW);

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (!audio) return;
    audio.onloadedmetadata = null;
    audio.ontimeupdate = null;
    audio.onplaying = null;
    audio.onpause = null;
    audio.onended = null;
    audio.onwaiting = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const stop = useCallback(() => {
    requestRef.current += 1;
    pathRef.current = null;
    releaseAudio();
    setState(EMPTY_PREVIEW);
  }, [releaseAudio]);

  const start = useCallback(
    async (path: string, label: string) => {
      const request = requestRef.current + 1;
      requestRef.current = request;
      releaseAudio();
      pathRef.current = path;
      setState({
        path,
        label,
        playing: false,
        loading: true,
        currentTime: 0,
        duration: 0,
        error: null,
      });

      try {
        await playbackAdapter.init();
        if (requestRef.current !== request) return;
        const audio = new Audio(playbackAdapter.toMediaUrl(path));
        audio.preload = "metadata";
        audioRef.current = audio;
        const update = (change: Partial<RecordingPreviewState>) => {
          if (audioRef.current !== audio) return;
          setState((current) => ({ ...current, ...change }));
        };
        audio.onloadedmetadata = () =>
          update({ duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
        audio.ontimeupdate = () => update({ currentTime: audio.currentTime });
        audio.onplaying = () => update({ playing: true, loading: false, error: null });
        audio.onpause = () => update({ playing: false, loading: false });
        audio.onended = () =>
          update({ playing: false, loading: false, currentTime: audio.duration || 0 });
        audio.onwaiting = () => update({ loading: true });
        audio.onerror = () =>
          update({
            playing: false,
            loading: false,
            error: audio.error?.message || "The recording could not be played",
          });
        await audio.play();
      } catch (error) {
        if (requestRef.current !== request) return;
        setState((current) => ({
          ...current,
          playing: false,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [releaseAudio],
  );

  const play = useCallback(
    async (path: string, label: string) => {
      const audio = audioRef.current;
      const decision = recordingPreviewDecision(
        pathRef.current,
        audio != null && !audio.paused,
        path,
      );
      if (decision === "start" || !audio) {
        await start(path, label);
      } else if (decision === "pause") {
        audio.pause();
      } else {
        if (audio.ended) audio.currentTime = 0;
        await audio.play().catch((error) =>
          setState((current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          })),
        );
      }
    },
    [start],
  );

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (audio.ended) audio.currentTime = 0;
      await audio.play().catch((error) =>
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    } else {
      audio.pause();
    }
  }, []);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const next = clampRecordingPreviewTime(time, audio.duration);
    audio.currentTime = next;
    setState((current) => ({ ...current, currentTime: next }));
  }, []);

  useEffect(
    () => () => {
      requestRef.current += 1;
      pathRef.current = null;
      releaseAudio();
    },
    [releaseAudio],
  );

  return { ...state, play, toggle, seek, stop };
}
