import type { LrclibCandidate } from "@/types/LrclibCandidate";
import type { LyricsFile } from "@/types/LyricsFile";
import { invoke } from "./runtime";

export const loadLyrics = async (fileHash: string): Promise<LyricsFile | null> => {
  return await invoke<LyricsFile | null>("load_lyrics", { fileHash });
};

export interface LyricsSearchOptions {
  title?: string;
  artist?: string;
  language?: string;
  reference?: string;
}

export const searchLrclibLyrics = async (
  fileHash: string,
  options?: LyricsSearchOptions,
): Promise<LrclibCandidate[]> => {
  return await invoke<LrclibCandidate[]>("search_lrclib_lyrics", { fileHash, options });
};

export const saveLyrics = async (
  fileHash: string,
  lines: string[],
  language?: string,
): Promise<void> => {
  return await invoke<void>("save_lyrics", { fileHash, lines, language });
};

export const provideLrc = async (
  fileHash: string,
  lrcText: string,
  separateStems: boolean,
  language?: string,
): Promise<void> => {
  return await invoke<void>("provide_lrc", { fileHash, lrcText, separateStems, language });
};

export const applyTimedLyrics = async (
  fileHash: string,
  lrcText: string,
  language?: string,
): Promise<void> => {
  return await invoke<void>("apply_timed_lyrics", { fileHash, lrcText, language });
};
