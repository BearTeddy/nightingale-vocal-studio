export interface VocalRangeReference {
  id: string;
  label: string;
  lowMidi: number;
  highMidi: number;
}

export const VOCAL_SCALE_LOW_MIDI = 36;
export const VOCAL_SCALE_HIGH_MIDI = 84;

export const VOCAL_RANGE_REFERENCES: VocalRangeReference[] = [
  { id: "bass", label: "Bass", lowMidi: 36, highMidi: 64 },
  { id: "bass-baritone", label: "Bass-baritone", lowMidi: 40, highMidi: 65 },
  { id: "baritone", label: "Baritone", lowMidi: 43, highMidi: 67 },
  { id: "tenor", label: "Tenor", lowMidi: 48, highMidi: 72 },
  { id: "countertenor", label: "Countertenor", lowMidi: 52, highMidi: 76 },
  { id: "contralto", label: "Contralto", lowMidi: 53, highMidi: 77 },
  { id: "mezzo-soprano", label: "Mezzo-soprano", lowMidi: 57, highMidi: 81 },
  { id: "soprano", label: "Soprano", lowMidi: 60, highMidi: 84 },
];

export interface RangePlacement {
  leftPercent: number;
  widthPercent: number;
}

export function vocalRangePlacement(
  lowMidi: number,
  highMidi: number,
  scaleLowMidi = VOCAL_SCALE_LOW_MIDI,
  scaleHighMidi = VOCAL_SCALE_HIGH_MIDI,
): RangePlacement {
  const span = Math.max(1, scaleHighMidi - scaleLowMidi);
  const low = Math.max(scaleLowMidi, Math.min(scaleHighMidi, Math.min(lowMidi, highMidi)));
  const high = Math.max(scaleLowMidi, Math.min(scaleHighMidi, Math.max(lowMidi, highMidi)));
  return {
    leftPercent: ((low - scaleLowMidi) / span) * 100,
    widthPercent: Math.max(1.25, ((high - low) / span) * 100),
  };
}
