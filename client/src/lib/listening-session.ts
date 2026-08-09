import {
  listeningScores,
  type IntervalAnswer,
  type SungPitchAttempt,
} from "@/lib/interval-listening";
import type { SavePracticeSession } from "@/types/PracticeSession";

interface BuildListeningSessionOptions {
  id: string;
  profile: string;
  startedAt: number;
  endedAt: number;
  answers: IntervalAnswer[];
  sungAttempts: Array<SungPitchAttempt | null>;
}

export function buildListeningSession({
  id,
  profile,
  startedAt,
  endedAt,
  answers,
  sungAttempts,
}: BuildListeningSessionOptions): SavePracticeSession {
  const scores = listeningScores(answers, sungAttempts);
  return {
    id,
    profile,
    song_hash: null,
    kind: "exercise:listening",
    started_at: Math.min(startedAt, endedAt),
    ended_at: endedAt,
    performance_json: JSON.stringify({
      version: 3,
      score: scores.overall,
      intervalScore: scores.interval,
      pitchScore: scores.pitch,
      exercise: "Hear, sing, and name",
      answers,
      sungAttempts,
    }),
    recording_take_id: null,
    transport_segments: [],
  };
}
