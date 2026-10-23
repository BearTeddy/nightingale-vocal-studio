/**
 * Playback route: requires `song` in location state; otherwise redirects home.
 *
 * On reload, Firefox preserves `history.state.song` and Chromium browsers
 * usually do too, so the song reference survives. The playback session itself
 * rebuilds from scratch (`PlaybackInner key={file_hash}` re-mounts a fresh
 * providers tree); the engine reads its inputs from the song hash, which is
 * stable across reloads. The only missing piece historically was a WS race
 * in `PlaybackTransportProvider` (`stems-ready` emitted before the freshly
 * reconnected socket subscribed) — fixed at the source so reloads can resume
 * playback from the beginning.
 */

import { useConfig } from "@/queries/use-config";
import type { Song } from "@/types/Song";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useState } from "react";
import { MultiplayerSetup } from "@/components/playback/multiplayer-setup";
import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";
import { PlaybackInner } from "./playback-inner";

export const Playback = () => {
  const { state } = useLocation();
  const { data: config } = useConfig();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<MultiplayerPlayer[] | null>(null);

  const typedState = state as { song?: Song; multiplayer?: boolean } | null;
  const song = typedState?.song;

  if (!song) {
    return <Navigate to="/" replace />;
  }

  if (typedState?.multiplayer && !players)
    return (
      <MultiplayerSetup config={config ?? null} onStart={setPlayers} onBack={() => navigate("/")} />
    );
  return (
    <PlaybackInner
      key={song.file_hash}
      song={song}
      config={config ?? null}
      players={typedState?.multiplayer ? (players ?? undefined) : undefined}
    />
  );
};
