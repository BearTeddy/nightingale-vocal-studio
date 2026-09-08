/**
 * Loads the transcript for the current track and normalizes segments for display.
 */

import { loadTranscript } from "@/bridge/playback";
import type { Segment, Transcript } from "@/types/Transcript";
import { useEffect, useState } from "react";
import { splitLongSegments } from "@/utils/playback/transcript-segments";

export function usePlaybackTranscript(fileHash: string) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [transcriptSource, setTranscriptSource] = useState("generated");

  useEffect(() => {
    let cancelled = false;
    setSegments([]);
    loadTranscript(fileHash)
      .then((transcript: Transcript) => {
        if (cancelled) return;
        setSegments(splitLongSegments(transcript.segments));
        setTranscriptSource(transcript.source ?? "generated");
      })
      .catch(() => {
        if (!cancelled) setSegments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fileHash]);

  return { segments, transcriptSource };
}
