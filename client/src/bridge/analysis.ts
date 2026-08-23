import { invoke, listen } from "./runtime";
import type { LibraryMenuFilters } from "@/types/LibraryMenuFilters";
import type { RemoveSongResult } from "@/types/RemoveSongResult";
import { ShiftDone } from "@/types/ShiftDone";

export const enqueueOne = async (fileHash: string): Promise<void> => {
  return await invoke<void>("enqueue_one", { fileHash });
};

export const enqueueAll = async (filters: LibraryMenuFilters): Promise<void> => {
  return await invoke<void>("enqueue_all", { filters });
};

export const deleteSongCache = async (fileHash: string): Promise<void> => {
  return await invoke<void>("delete_song_cache", { fileHash });
};

export const removeSong = async (
  fileHash: string,
  path: string,
  deleteSource: boolean,
): Promise<RemoveSongResult> => {
  return await invoke<RemoveSongResult>("remove_song", { fileHash, path, deleteSource });
};

export const reanalyzeTranscript = async (fileHash: string, language?: string): Promise<void> => {
  return await invoke<void>("reanalyze_transcript", { fileHash, language });
};

export const reanalyzeFull = async (fileHash: string): Promise<void> => {
  return await invoke<void>("reanalyze_full", { fileHash });
};

export const realign = async (fileHash: string, language?: string): Promise<void> => {
  return await invoke<void>("realign", { fileHash, language });
};

export const reanalyzeForceTranscribe = async (fileHash: string): Promise<void> => {
  return await invoke<void>("reanalyze_force_transcribe", { fileHash });
};

export const shiftTempo = async (fileHash: string, tempo: number): Promise<void> => {
  return await invoke<void>("shift_tempo", { fileHash, tempo });
};

export const shiftKey = async (
  fileHash: string,
  key: string,
  pitchRatio: number,
  keyOffset: number,
): Promise<void> => {
  return await invoke<void>("shift_key", { fileHash, key, pitchRatio, keyOffset });
};

export const onShiftKeyDone = async (cb: (payload: ShiftDone) => void): Promise<() => void> => {
  return await listen<ShiftDone>("shift-key-done", ({ payload }) => cb(payload));
};

export const onShiftTempoDone = async (cb: (payload: ShiftDone) => void): Promise<() => void> => {
  return await listen<ShiftDone>("shift-tempo-done", ({ payload }) => cb(payload));
};
