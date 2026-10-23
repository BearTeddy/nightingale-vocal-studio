import { useProfiles } from "@/queries/use-profiles";
import { useConfig } from "@/queries/use-config";
import { pitchToleranceFactor, scoringDifficulty } from "@/lib/pitch/difficulty";
import { matchesScoringSettings } from "@/utils/playback/result";
import { useMemo } from "react";

export function useBestScoresBySongForActiveProfile(): Map<string, number> {
  const { data } = useProfiles();
  const { data: config } = useConfig();
  const active = data?.active;
  const scores = data?.scores ?? [];
  const difficulty = scoringDifficulty(config?.scoring_difficulty);
  const factor = pitchToleranceFactor(config?.pitch_tolerance_factor);

  return useMemo(() => {
    const map = new Map<string, number>();
    if (!active) {
      return map;
    }

    for (const r of scores) {
      if (r.profile !== active || !matchesScoringSettings(r, difficulty, factor)) {
        continue;
      }

      const prev = map.get(r.song_hash);
      if (prev === undefined || r.score > prev) {
        map.set(r.song_hash, r.score);
      }
    }

    return map;
  }, [scores, active, difficulty, factor]);
}
