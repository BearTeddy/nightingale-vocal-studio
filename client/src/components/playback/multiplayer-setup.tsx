import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listMultiplayerMicrophones, saveMultiplayerPlayers } from "@/bridge/multiplayer";
import { Button } from "@/components/ui/button";
import { useMultiplayerCapture } from "@/hooks/use-multiplayer-capture";
import { multiplayerSetupError, PLAYER_COLORS } from "@/lib/multiplayer";
import { useProfiles } from "@/queries/use-profiles";
import { CONFIG, PROFILES } from "@/queries/keys";
import type { AppConfig } from "@/types/AppConfig";
import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";

export function MultiplayerSetup({
  config,
  onStart,
  onBack,
}: {
  config: AppConfig | null;
  onStart: (players: MultiplayerPlayer[]) => void;
  onBack: () => void;
}) {
  const { data: profiles } = useProfiles();
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: ["multiplayer-microphones"],
    queryFn: listMultiplayerMicrophones,
    refetchOnWindowFocus: true,
  });
  const [players, setPlayers] = useState<MultiplayerPlayer[]>(() =>
    config?.multiplayer_players?.length
      ? config.multiplayer_players.slice(0, 4)
      : [0, 1].map((index) => ({
          id: `player-${index + 1}`,
          profile: index === 0 ? (profiles?.active ?? "Player 1") : "Player 2",
          microphone: "",
          channel: null,
          color: PLAYER_COLORS[index],
        })),
  );
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = useMultiplayerCapture(players, testing);
  const setupError = multiplayerSetupError(players, devices.data ?? []);
  const checkError = Object.values(capture.errors)[0];
  const allReceiving =
    capture.ready && players.every((player) => capture.frames[player.id] != null) && !checkError;
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (allReceiving) setVerified(true);
  }, [allReceiving]);
  useEffect(() => {
    if (checkError) setVerified(false);
  }, [checkError]);

  const update = (index: number, patch: Partial<MultiplayerPlayer>) => {
    setTesting(false);
    setVerified(false);
    setPlayers((current) =>
      current.map((player, i) => (i === index ? { ...player, ...patch } : player)),
    );
  };
  const start = async () => {
    if (setupError || !verified || checkError) return;
    setBusy(true);
    setError(null);
    setTesting(false);
    try {
      const normalized = players.map((player) => ({ ...player, profile: player.profile.trim() }));
      const saved = await saveMultiplayerPlayers(normalized);
      queryClient.setQueryData(CONFIG, saved);
      await queryClient.invalidateQueries({ queryKey: PROFILES });
      onStart(normalized);
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  };

  return (
    <main className="h-full overflow-auto px-5 py-12">
      <div className="mx-auto max-w-3xl space-y-5">
        <h1 className="text-2xl font-semibold">Sing together</h1>
        <p className="text-sm text-muted-foreground">
          2–4 singers · one microphone or input channel per person · separate scores. Use headphones
          to reduce song audio leaking into the microphones.
        </p>
        <div className="flex gap-2" aria-label="Number of singers">
          {[2, 3, 4].map((count) => (
            <Button
              key={count}
              variant={players.length === count ? "default" : "outline"}
              disabled={busy}
              onClick={() => {
                setTesting(false);
                setVerified(false);
                setPlayers((current) =>
                  Array.from(
                    { length: count },
                    (_, index) =>
                      current[index] ?? {
                        id: `player-${index + 1}`,
                        profile: `Player ${index + 1}`,
                        microphone: "",
                        channel: null,
                        color: PLAYER_COLORS[index],
                      },
                  ),
                );
              }}
            >
              {count} players
            </Button>
          ))}
        </div>
        <datalist id="multiplayer-profiles">
          {profiles?.profiles.map((profile) => (
            <option key={profile} value={profile} />
          ))}
        </datalist>
        <div className="grid gap-3 sm:grid-cols-2">
          {players.map((player, index) => (
            <fieldset
              key={player.id}
              className="space-y-3 rounded-lg border p-4"
              style={{ borderColor: player.color }}
              disabled={busy}
            >
              <legend className="px-2 font-semibold">Player {index + 1}</legend>
              <label className="block text-sm">
                Singer name
                <input
                  aria-label={`Player ${index + 1} name`}
                  list="multiplayer-profiles"
                  maxLength={40}
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={player.profile}
                  onChange={(event) => update(index, { profile: event.target.value })}
                />
              </label>
              <label className="block text-sm">
                Microphone
                <select
                  aria-label={`Player ${index + 1} microphone`}
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={player.microphone}
                  onChange={(event) =>
                    update(index, { microphone: event.target.value, channel: null })
                  }
                >
                  <option value="">Choose a microphone</option>
                  {player.microphone &&
                    !devices.data?.some((device) => device.name === player.microphone) && (
                      <option value={player.microphone}>{player.microphone} (disconnected)</option>
                    )}
                  {devices.data?.map((device, index) => (
                    <option key={device.name} value={device.name}>
                      {device.label} · input {index + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                Input channel
                <select
                  aria-label={`Player ${index + 1} input channel`}
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={player.channel ?? "mix"}
                  onChange={(event) =>
                    update(index, {
                      channel: event.target.value === "mix" ? null : Number(event.target.value),
                    })
                  }
                >
                  <option value="mix">All channels (one mic)</option>
                  {Array.from(
                    {
                      length:
                        devices.data?.find((device) => device.name === player.microphone)
                          ?.channels ?? 0,
                    },
                    (_, channel) => (
                      <option key={channel} value={channel}>
                        Channel {channel + 1}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <label className="block text-sm">
                Player color
                <select
                  aria-label={`Player ${index + 1} color`}
                  className="mt-1 w-full rounded border bg-background p-2"
                  value={player.color}
                  onChange={(event) => update(index, { color: event.target.value })}
                >
                  {PLAYER_COLORS.map((color, i) => (
                    <option key={color} value={color}>
                      {["Cyan", "Pink", "Gold", "Mint"][i]}
                    </option>
                  ))}
                </select>
              </label>
              {testing && (
                <div className="space-y-1">
                  <progress
                    aria-label={`${player.profile} microphone level`}
                    max={1}
                    value={Math.min(1, (capture.frames[player.id]?.rms ?? 0) * 6)}
                    className="w-full"
                  />
                  <p className="text-xs" role="status">
                    {capture.errors[player.id] ??
                      (capture.frames[player.id]
                        ? "Input connected — sing to check this meter"
                        : "Waiting for input…")}
                  </p>
                </div>
              )}
            </fieldset>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Multi-track recording and app voice monitoring are not enabled in this multiplayer mode.
          An audio interface’s direct monitoring can provide your live voices. Solo karaoke controls
          are unchanged.
        </p>
        {(error || devices.error || setupError || checkError) && (
          <p role="alert" className="text-sm text-amber-600">
            {error ?? (devices.error ? String(devices.error) : (setupError ?? checkError))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={onBack}>
            Back
          </Button>
          <Button
            variant="outline"
            disabled={busy || testing}
            onClick={() => void devices.refetch()}
          >
            Refresh microphones
          </Button>
          <Button
            variant="outline"
            disabled={busy || !!setupError}
            onClick={() => {
              setTesting((current) => !current);
              setVerified(false);
            }}
          >
            {testing ? "Stop mic check" : "Check microphones"}
          </Button>
          <Button
            disabled={busy || !!setupError || !verified || !!checkError}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Start multiplayer"}
          </Button>
        </div>
        {!verified && !setupError && (
          <p className="text-xs text-muted-foreground">
            Check microphones before starting. Make sure only the intended singer moves each meter.
          </p>
        )}
      </div>
    </main>
  );
}
