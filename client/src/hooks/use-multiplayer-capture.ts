import { useEffect, useRef, useState } from "react";
import { startMultiplayerCapture } from "@/bridge/multiplayer";
import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";
import type { PitchFrame } from "@/types/PitchFrame";

export function useMultiplayerCapture(players: MultiplayerPlayer[], enabled: boolean) {
  const [frames, setFrames] = useState<Record<string, PitchFrame | null>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const lastFrameAt = useRef<Record<string, number>>({});
  useEffect(() => {
    setReady(false);
    if (!enabled || players.length < 2) return;
    setFrames({});
    setErrors({});
    lastFrameAt.current = {};
    let cancelled = false;
    let stop: (() => Promise<void>) | undefined;
    // Permission prompts/device startup are not missing audio. Start the
    // watchdog only after all streams have successfully opened.
    let startedAt = Number.POSITIVE_INFINITY;
    void startMultiplayerCapture(players, (event) => {
      if (cancelled) return;
      if (event.type === "error") {
        setErrors((current) => ({ ...current, [event.player_id]: event.message }));
        setFrames((current) => ({ ...current, [event.player_id]: null }));
      } else {
        lastFrameAt.current[event.player_id] = Date.now();
        setFrames((current) => ({ ...current, [event.player_id]: event.frame }));
      }
    })
      .then((cleanup) => {
        if (cancelled) void cleanup();
        else {
          stop = cleanup;
          startedAt = Date.now();
          setReady(true);
        }
      })
      .catch((error) => {
        if (!cancelled) setErrors({ all: error instanceof Error ? error.message : String(error) });
      });
    const timer = window.setInterval(() => {
      const stale = players.filter(
        (player) => Date.now() - (lastFrameAt.current[player.id] ?? startedAt) > 2000,
      );
      if (stale.length) {
        setFrames((current) => ({
          ...current,
          ...Object.fromEntries(stale.map((player) => [player.id, null])),
        }));
        setErrors((current) => ({
          ...current,
          ...Object.fromEntries(
            stale.map((player) => [
              player.id,
              "No microphone samples. Check the connection and retry.",
            ]),
          ),
        }));
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      void stop?.();
    };
  }, [players, enabled]);
  return { frames, errors, ready };
}
