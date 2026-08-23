import { useProfiles } from "@/queries/use-profiles";
import { useConfig } from "@/queries/use-config";
import { scoringDifficulty } from "@/lib/pitch/difficulty";
import { useMemo } from "react";

export function useBestScoresBySongForActiveProfile(): Map<string, number> {
  const { data } = useProfiles();
  const { data: config } = useConfig();
  const active = data?.active;
  const scores = data?.scores ?? [];
  const difficulty = scoringDifficulty(config?.scoring_difficulty);

  return useMemo(() => {
    const map = new Map<string, number>();
    if (!active) {
      return map;
    }

    for (const r of scores) {
      if (r.profile !== active || scoringDifficulty(r.difficulty) !== difficulty) {
        continue;
      }

      const prev = map.get(r.song_hash) ?? 0;
      if (r.score > prev) {
        map.set(r.song_hash, r.score);
      }
    }

    return map;
  }, [scores, active, difficulty]);
}
