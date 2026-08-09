import type { MelodyMap } from "@/types/MelodyMap";

export function transformMelodyMap(
  melody: MelodyMap,
  keyOffset: number,
  tempo: number,
): MelodyMap {
  const safeTempo = Number.isFinite(tempo) && tempo > 0 ? tempo : 1;
  const safeKeyOffset = Number.isFinite(keyOffset) ? keyOffset : 0;
  if (safeTempo === 1 && safeKeyOffset === 0) return melody;

  return {
    ...melody,
    hop_ms: Math.max(1, Math.round(melody.hop_ms / safeTempo)),
    notes: melody.notes.map((note) => ({
      ...note,
      start: note.start / safeTempo,
      end: note.end / safeTempo,
      midi: note.midi + safeKeyOffset,
    })),
  };
}
