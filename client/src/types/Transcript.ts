export type Word = {
  word: string;
  start: number;
  end: number;
  score?: number;
  estimated?: boolean;
  reading?: string;
  romaji?: string;
  romanization?: string;
  annotations?: { text: string; furigana?: string; romaji?: string }[];
  /** Original spacing after this word, including no space in Japanese. */
  separator?: string;
  /** Present for authored UltraStar note events. Zero maps to MIDI 60. */
  pitch?: number;
};

export type Segment = {
  text: string;
  start: number;
  end: number;
  words: Word[];
};

export type Transcript = {
  language: string;
  segments: Segment[];
  source?: string;
};

export type AudioPaths = {
  instrumental: string;
  vocals: string | null;
};
