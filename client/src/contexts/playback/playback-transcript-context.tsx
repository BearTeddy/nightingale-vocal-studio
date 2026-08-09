/**
 * Owns the transcript for the active song, the derived skip-intro / skip-outro
 * boundaries, and the handlers that act on them.
 *
 * Skip-outro is a two-step flow: pause the audio engine, then flag the
 * playback result handler to fall through to the result dialog.  That pending
 * flag lives here so the rest of the tree can subscribe to it without a
 * separate piece of useState wiring.
 */

import { usePlaybackTransportActions } from "@/contexts/playback/playback-transport-context";
import { usePlaybackTranscript } from "@/hooks/playback/use-playback-transcript";
import type { Segment } from "@/types/Transcript";
import { INTRO_SKIP_LEAD_SEC } from "@/utils/playback/transcript-segments";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface PlaybackTranscriptState {
  segments: Segment[];
  transcriptSource: string;
  firstSegmentStart: number;
  lastSegmentEnd: number;
  introSkipLeadSec: number;
  skipOutroPending: boolean;
  phraseLoopEnabled: boolean;
  loopedPhrase: Segment | null;
}

export interface PlaybackTranscriptActions {
  handleSkipIntro: () => void;
  handleSkipOutro: () => void;
  clearSkipOutroPending: () => void;
  togglePhraseLoop: () => void;
}

const TranscriptStateContext = createContext<PlaybackTranscriptState | null>(null);
const TranscriptActionsContext = createContext<PlaybackTranscriptActions | null>(null);

interface PlaybackTranscriptProviderProps {
  fileHash: string;
  children: ReactNode;
}

export function PlaybackTranscriptProvider({
  fileHash,
  children,
}: PlaybackTranscriptProviderProps) {
  const { seek, finishAudio, subscribe, getCurrentTime } = usePlaybackTransportActions();
  const { segments, transcriptSource } = usePlaybackTranscript(fileHash);
  const [skipOutroPending, setSkipOutroPending] = useState(false);
  const [loopedPhrase, setLoopedPhrase] = useState<Segment | null>(null);

  const firstSegmentStart = segments.length > 0 ? segments[0].start : 0;
  const lastSegmentEnd = segments.length > 0 ? segments[segments.length - 1].end : 0;

  const handleSkipIntro = useCallback(() => {
    if (segments.length === 0) {
      return;
    }
    const target = Math.max(0, firstSegmentStart - INTRO_SKIP_LEAD_SEC);
    seek(target);
  }, [seek, firstSegmentStart, segments.length]);

  const handleSkipOutro = useCallback(() => {
    // Pause the audio engine WITHOUT raising the user-facing `paused` flag,
    // otherwise PauseOverlay would flash open when the result dialog closes.
    finishAudio();
    setSkipOutroPending(true);
  }, [finishAudio]);

  const clearSkipOutroPending = useCallback(() => {
    setSkipOutroPending(false);
  }, []);

  const togglePhraseLoop = useCallback(() => {
    if (loopedPhrase) {
      setLoopedPhrase(null);
      return;
    }
    const time = getCurrentTime();
    const phrase =
      segments.find((segment) => time >= segment.start && time <= segment.end) ??
      segments.find((segment) => segment.start > time) ??
      null;
    setLoopedPhrase(phrase);
  }, [getCurrentTime, loopedPhrase, segments]);

  useEffect(() => {
    if (!loopedPhrase) return;
    return subscribe((time) => {
      if (time >= loopedPhrase.end + 0.12) {
        seek(Math.max(0, loopedPhrase.start - 0.25));
      }
    });
  }, [loopedPhrase, seek, subscribe]);

  const stateValue = useMemo<PlaybackTranscriptState>(
    () => ({
      segments,
      transcriptSource,
      firstSegmentStart,
      lastSegmentEnd,
      introSkipLeadSec: INTRO_SKIP_LEAD_SEC,
      skipOutroPending,
      phraseLoopEnabled: loopedPhrase != null,
      loopedPhrase,
    }),
    [segments, transcriptSource, firstSegmentStart, lastSegmentEnd, skipOutroPending, loopedPhrase],
  );

  const actionsValue = useMemo<PlaybackTranscriptActions>(
    () => ({
      handleSkipIntro,
      handleSkipOutro,
      clearSkipOutroPending,
      togglePhraseLoop,
    }),
    [handleSkipIntro, handleSkipOutro, clearSkipOutroPending, togglePhraseLoop],
  );

  return (
    <TranscriptStateContext.Provider value={stateValue}>
      <TranscriptActionsContext.Provider value={actionsValue}>
        {children}
      </TranscriptActionsContext.Provider>
    </TranscriptStateContext.Provider>
  );
}

export function usePlaybackTranscriptState(): PlaybackTranscriptState {
  const ctx = useContext(TranscriptStateContext);
  if (!ctx) {
    throw new Error("usePlaybackTranscriptState must be used within a PlaybackTranscriptProvider");
  }
  return ctx;
}

export function usePlaybackTranscriptActions(): PlaybackTranscriptActions {
  const ctx = useContext(TranscriptActionsContext);
  if (!ctx) {
    throw new Error(
      "usePlaybackTranscriptActions must be used within a PlaybackTranscriptProvider",
    );
  }
  return ctx;
}
