import type { TransportSegment } from "./TransportSegment";

export type PracticeSession = {
  id: string;
  profile: string;
  song_hash: string | null;
  kind: string;
  started_at: number;
  ended_at: number | null;
  performance_json: string | null;
  recording_take_id: string | null;
  transport_segments: TransportSegment[];
};

export type SavePracticeSession = Omit<PracticeSession, "ended_at" | "performance_json"> & {
  ended_at: number;
  performance_json: string;
};
