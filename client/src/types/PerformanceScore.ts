import type { ScoringDifficulty } from "@/lib/pitch/difficulty";

export type CategoryScore = {
  key: "pitch" | "timing" | "stability" | "sustain" | "dynamics" | "technique";
  label: string;
  score: number;
  available: boolean;
};

export type PhraseScore = {
  note_id: string;
  start: number;
  end: number;
  accuracy: number;
};

export type PerformanceScore = {
  scoring_difficulty: ScoringDifficulty;
  pitch_tolerance_factor?: number;
  overall: number;
  legacy_score: number;
  phrase_accuracy: number;
  streak: number;
  cents_offset: number | null;
  categories: CategoryScore[];
  phrases: PhraseScore[];
  coaching: string[];
};
