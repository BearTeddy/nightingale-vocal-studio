import type { TargetNote } from "@/types/TargetNote";

export const MIN_SPLIT_DURATION_SECONDS = 0.12;

export function cloneTargetNotes(notes: TargetNote[]): TargetNote[] {
  return notes.map((note) => ({
    ...note,
    lyric_word_indices: [...note.lyric_word_indices],
  }));
}

export function updateTargetNote(
  notes: TargetNote[],
  index: number,
  change: (note: TargetNote) => TargetNote,
): TargetNote[] {
  if (index < 0 || index >= notes.length) return notes;
  return notes.map((note, noteIndex) =>
    noteIndex === index
      ? change({ ...note, lyric_word_indices: [...note.lyric_word_indices] })
      : note,
  );
}

export function splitTargetNote(notes: TargetNote[], index: number): TargetNote[] {
  const note = notes[index];
  if (!note || note.end - note.start < MIN_SPLIT_DURATION_SECONDS) return notes;
  const middle = (note.start + note.end) / 2;
  return [
    ...notes.slice(0, index),
    {
      ...note,
      id: `${note.id}a`,
      end: middle,
      lyric_word_indices: [...note.lyric_word_indices],
    },
    {
      ...note,
      id: `${note.id}b`,
      start: middle,
      lyric_word_indices: [...note.lyric_word_indices],
    },
    ...notes.slice(index + 1),
  ];
}

export function mergeTargetNotes(notes: TargetNote[], index: number): TargetNote[] {
  const left = notes[index];
  const right = notes[index + 1];
  if (!left || !right) return notes;

  const leftDuration = Math.max(0.001, left.end - left.start);
  const rightDuration = Math.max(0.001, right.end - right.start);
  const effectivePitch =
    ((left.midi + left.cents / 100) * leftDuration +
      (right.midi + right.cents / 100) * rightDuration) /
    (leftDuration + rightDuration);
  const midi = Math.round(effectivePitch);

  return [
    ...notes.slice(0, index),
    {
      ...left,
      id: `${left.id}+${right.id}`,
      start: Math.min(left.start, right.start),
      end: Math.max(left.end, right.end),
      midi,
      cents: Math.round((effectivePitch - midi) * 100),
      confidence: Math.min(left.confidence, right.confidence),
      eligible: left.eligible && right.eligible,
      lyric_word_indices: [...new Set([...left.lyric_word_indices, ...right.lyric_word_indices])],
    },
    ...notes.slice(index + 2),
  ];
}
