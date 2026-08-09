/**
 * Playback session: audio engine, visual background, lyrics HUD, and pause overlay.
 * Route shell (`Playback`) mounts this with a `key` of `file_hash` so state resets per track.
 *
 * `PlaybackInner` itself is the provider shell; `PlaybackLayout` is the
 * presentational tree that consumes the playback contexts via hooks.
 */

import { Background } from "@/components/playback/background";
import { ResultDialog } from "@/components/playback/dialogs/result";
import { LyricsDisplay } from "@/components/playback/lyrics-display";
import { PauseOverlay } from "@/components/playback/pause-overlay";
import { PitchGraph } from "@/components/playback/pitch-graph";
import { PlaybackHud } from "@/components/playback/playback-hud";
import {
  PlaybackProviders,
  usePlaybackMicState,
  usePlaybackTranscriptState,
  usePlaybackTransportActions,
  usePlaybackTransportState,
} from "@/contexts/playback";
import { usePlaybackInput, usePlaybackResult } from "@/hooks/playback";
import type { AppConfig } from "@/types/AppConfig";
import type { Song } from "@/types/Song";

export interface PlaybackInnerProps {
  song: Song;
  config: AppConfig | null;
}

interface PlaybackLayoutProps {
  song: Song;
  config: AppConfig | null;
}

function PlaybackLayout({ song, config }: PlaybackLayoutProps) {
  const { isReady, paused } = usePlaybackTransportState();
  const { handleContinue, handleExit } = usePlaybackTransportActions();
  const { segments } = usePlaybackTranscriptState();
  const { series } = usePlaybackMicState();
  const lyricsVerticalPosition = config?.lyrics_vertical_position ?? "bottom";
  const lyricsHorizontalPosition = config?.lyrics_horizontal_position ?? "center";
  const hudPosition = lyricsVerticalPosition === "top" ? "bottom" : "top";

  usePlaybackInput(config);
  const result = usePlaybackResult(song);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black" style={{ contain: "strict" }}>
      <Background />

      {isReady && (
        <>
          <PlaybackHud
            title={song.title}
            artist={song.artist}
            config={config}
            position={hudPosition}
          />
          <PitchGraph series={series} position={hudPosition} />
          <LyricsDisplay
            segments={segments}
            verticalPosition={lyricsVerticalPosition}
            horizontalPosition={lyricsHorizontalPosition}
          />
        </>
      )}

      <PauseOverlay open={paused && !result.open} onContinue={handleContinue} onExit={handleExit} />

      <ResultDialog
        open={result.open}
        score={result.score}
        performance={result.performance}
        performanceSeries={result.performanceSeries}
        melody={result.melody}
        recordingTake={result.recordingTake}
        recordingStatus={result.recordingStatus}
        song={song}
        scores={result.scores}
        activeProfile={result.activeProfile}
        personalBest={result.personalBest}
        recordingError={result.recordingError}
        onFinish={result.onFinish}
      />
    </div>
  );
}

export function PlaybackInner({ song, config }: PlaybackInnerProps) {
  return (
    <PlaybackProviders song={song} config={config}>
      <PlaybackLayout song={song} config={config} />
    </PlaybackProviders>
  );
}
