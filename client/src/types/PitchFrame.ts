export type PitchFrame = {
  hz: number | null;
  midi: number | null;
  clarity: number;
  rms: number;
  reference_rms?: number;
  reference_midi?: number;
  peak?: number;
  voiced: boolean;
  sample_index: number;
  sample_rate: number;
  captured_at_ms: number;
};
