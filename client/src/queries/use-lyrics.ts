import { loadLyrics, searchLrclibLyrics, type LyricsSearchOptions } from "@/bridge/lyrics";
import { loadTranscript } from "@/bridge/playback";
import type { LrclibCandidate } from "@/types/LrclibCandidate";
import { linesFromTranscript } from "@/utils/edit-lyrics";
import { useQuery } from "@tanstack/react-query";
import { LRCLIB, LYRICS } from "./keys";

const fetchInitialLyrics = async (fileHash: string): Promise<string> => {
  const file = await loadLyrics(fileHash);
  if (file && file.lines.length > 0) {
    return file.lines.join("\n");
  }
  try {
    const transcript = await loadTranscript(fileHash);
    return linesFromTranscript(transcript);
  } catch {
    return "";
  }
};

export const useInitialLyrics = (fileHash: string | null) =>
  useQuery({
    queryKey: [...LYRICS, fileHash],
    queryFn: () => fetchInitialLyrics(fileHash as string),
    enabled: fileHash !== null,
    staleTime: Infinity,
  });

export const useLrclibCandidates = (
  fileHash: string | null,
  options?: LyricsSearchOptions,
  revision = 0,
) =>
  useQuery<LrclibCandidate[]>({
    queryKey: [...LRCLIB, fileHash, options, revision],
    queryFn: () => searchLrclibLyrics(fileHash as string, options),
    enabled: fileHash !== null,
    staleTime: Infinity,
    retry: false,
  });
