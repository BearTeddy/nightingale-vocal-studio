import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { RecordingPreview } from "@/components/studio/recording-preview";
import { usePlaybackMicActions, usePlaybackMicState } from "@/contexts/playback";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSpatialNavigation } from "@/hooks/navigation/use-studio-navigation";
import { useRecordingPreview } from "@/hooks/use-recording-preview";
import type { ScoreRecord } from "@/types/ScoreRecord";
import type { Song } from "@/types/Song";
import { cn } from "@/lib/utils";
import { scoringDifficultyProfile } from "@/lib/pitch/difficulty";
import { topScoresForSong, type PersonalBestComparison } from "@/utils/playback/result";
import { Stars } from "@/components/shared/stars";
import type { PerformanceScore } from "@/types/PerformanceScore";
import type { RecordingTake } from "@/types/RecordingTake";
import type { MelodyMap } from "@/types/MelodyMap";
import { freqToSemitone, type PitchSeries } from "@/lib/pitch/state";
import { openMediaPath, revealItemInDir } from "@/bridge/opener";
import {
  Download,
  FolderOpen,
  LoaderCircle,
  Mic2,
  Music2,
  Pause,
  Play,
  RefreshCw,
  Trophy,
  Video,
} from "lucide-react";
import { useEffect, useRef } from "react";

const TOP_LIMIT = 5;

function PerformanceReplay({ melody, series }: { melody: MelodyMap; series: PitchSeries }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const width = Math.max(280, canvas.parentElement?.clientWidth ?? 460);
      const height = 116;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "rgba(0,0,0,0.7)";
      context.fillRect(0, 0, width, height);

      const userMidi = series.userPitches
        .filter((pitch): pitch is number => pitch != null)
        .map(freqToSemitone);
      const targetMidi = melody.notes.map((note) => note.midi + note.cents / 100);
      const allMidi = [...targetMidi, ...userMidi];
      const minMidi = allMidi.length === 0 ? 48 : Math.floor(Math.min(...allMidi) - 1);
      const maxMidi = allMidi.length === 0 ? 72 : Math.ceil(Math.max(...allMidi) + 1);
      const start = Math.min(melody.notes[0]?.start ?? 0, series.timestamps[0] ?? 0);
      const end = Math.max(
        melody.notes[melody.notes.length - 1]?.end ?? 1,
        series.timestamps[series.timestamps.length - 1] ?? 1,
        start + 1,
      );
      const x = (time: number) => ((time - start) / (end - start)) * width;
      const y = (midi: number) =>
        height - ((midi - minMidi) / Math.max(1, maxMidi - minMidi)) * height;

      context.strokeStyle = "rgba(255,255,255,0.08)";
      context.lineWidth = 1;
      for (let midi = minMidi; midi <= maxMidi; midi += 1) {
        context.beginPath();
        context.moveTo(0, y(midi));
        context.lineTo(width, y(midi));
        context.stroke();
      }
      for (const note of melody.notes) {
        const noteY = y(note.midi + note.cents / 100);
        context.strokeStyle = note.eligible ? "rgba(77,222,235,0.9)" : "rgba(77,222,235,0.35)";
        context.lineWidth = note.eligible ? 4 : 2;
        context.beginPath();
        context.moveTo(x(note.start), noteY);
        context.lineTo(x(note.end), noteY);
        context.stroke();
      }
      context.lineWidth = 1.6;
      for (let index = 1; index < series.userPitches.length; index += 1) {
        const previous = series.userPitches[index - 1];
        const current = series.userPitches[index];
        if (previous == null || current == null) continue;
        const similarity = series.similarities[index] ?? 0;
        context.strokeStyle =
          similarity >= 0.8
            ? "rgba(55,224,111,0.95)"
            : similarity >= 0.45
              ? "rgba(250,204,62,0.95)"
              : "rgba(248,90,90,0.9)";
        context.beginPath();
        context.moveTo(x(series.timestamps[index - 1] ?? 0), y(freqToSemitone(previous)));
        context.lineTo(x(series.timestamps[index] ?? 0), y(freqToSemitone(current)));
        context.stroke();
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, [melody, series]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-muted-foreground">
        <span>TARGET AND VOICE</span>
        <span>Cyan target, colored voice</span>
      </div>
      <canvas
        ref={canvasRef}
        className="block w-full"
        aria-label="Target versus performance pitch trace"
      />
    </div>
  );
}

interface Props {
  open: boolean;
  score: number;
  performance: PerformanceScore;
  performanceSeries: PitchSeries;
  melody: MelodyMap | null;
  recordingTake: RecordingTake | null;
  recordingStatus: string;
  recordingError: string | null;
  song: Song;
  scores: ScoreRecord[];
  activeProfile: string | null;
  personalBest: PersonalBestComparison | null;
  onFinish: () => void;
}

export const ResultDialog = ({
  open,
  score,
  performance,
  performanceSeries,
  melody,
  recordingTake,
  recordingStatus,
  recordingError,
  onFinish,
  song,
  scores,
  activeProfile,
  personalBest,
}: Props) => {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const recordingPreview = useRecordingPreview();
  const { retryRecordingExport, exportRecordingVideo, renderRecordingMix, setVocalGain } =
    usePlaybackMicActions();
  const { videoExportAvailable, vocalGain } = usePlaybackMicState();
  const strictScoringAvailable = melody?.strict_scoring_available === true;
  const difficulty = scoringDifficultyProfile(performance.scoring_difficulty);
  const board = topScoresForSong(
    scores,
    song.file_hash,
    TOP_LIMIT,
    performance.scoring_difficulty,
    performance.pitch_tolerance_factor,
  );

  useSpatialNavigation(dialogRef, onFinish, open);

  useEffect(() => {
    if (!open) recordingPreview.stop();
  }, [open, recordingPreview.stop]);

  return (
    <Dialog open={open} modal>
      <DialogContent
        ref={dialogRef}
        data-spatial-navigation
        showCloseButton={false}
        className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-lg"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-4 p-7">
          <DialogHeader className="gap-1 text-center sm:text-center">
            <DialogTitle className="text-xl font-semibold">{song.title}</DialogTitle>
            <DialogDescription className="text-sm">{song.artist}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-1">
            <p
              className="text-4xl font-semibold text-primary tabular-nums"
              aria-label={strictScoringAvailable ? `Score ${score}` : "Strict scoring unavailable"}
            >
              {strictScoringAvailable ? score : "--"}
            </p>
            {strictScoringAvailable ? (
              <>
                <Stars score={score * 10} size="lg" className="mt-1" />
                <p className="mt-1 text-xs font-medium text-muted-foreground">
                  {difficulty.label} scoring ·{" "}
                  {(performance.pitch_tolerance_factor ?? 1).toFixed(2)}× pitch window
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Strict scoring waits for melody analysis or corrected notes.
              </p>
            )}
            {personalBest && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                {personalBest.isNewBest && <Trophy className="size-3.5 text-amber-500" />}
                {personalBest.previousScore == null
                  ? "First scored performance"
                  : personalBest.isNewBest
                    ? `New personal best${personalBest.delta ? ` +${personalBest.delta}` : ""}`
                    : personalBest.delta === 0
                      ? "Matched your personal best"
                      : `${Math.abs(personalBest.delta ?? 0)} below your best of ${personalBest.previousScore}`}
              </p>
            )}
          </div>

          <div className="space-y-2">
            {performance.categories.map((category) => (
              <div
                key={category.key}
                className="grid grid-cols-[5.5rem_1fr_2.25rem] items-center gap-2 text-xs"
              >
                <span className={category.available ? "text-foreground" : "text-muted-foreground"}>
                  {category.label}
                </span>
                <div className="h-1.5 overflow-hidden bg-muted">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${category.available ? category.score : 0}%` }}
                  />
                </div>
                <span className="text-right tabular-nums text-muted-foreground">
                  {category.available ? category.score : "--"}
                </span>
              </div>
            ))}
          </div>

          {performance.phrases.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">PHRASE HEATMAP</p>
              <div
                className="flex h-8 gap-px overflow-hidden bg-muted"
                aria-label="Phrase accuracy heatmap"
              >
                {performance.phrases.map((phrase) => (
                  <div
                    key={phrase.note_id}
                    title={`${phrase.accuracy}% at ${phrase.start.toFixed(1)} seconds`}
                    className={cn(
                      "min-w-0 flex-1",
                      phrase.accuracy >= 80
                        ? "bg-emerald-500"
                        : phrase.accuracy >= 50
                          ? "bg-amber-400"
                          : "bg-red-500",
                    )}
                  />
                ))}
              </div>
            </div>
          )}

          {melody && performanceSeries.timestamps.length > 0 && (
            <PerformanceReplay melody={melody} series={performanceSeries} />
          )}

          {performance.coaching.length > 0 && (
            <div className="border-y border-border py-3">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">NEXT PRACTICE</p>
              {performance.coaching.map((note) => (
                <p key={note} className="text-xs leading-relaxed text-foreground/85">
                  {note}
                </p>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">
              {recordingStatus === "finalizing" || recordingStatus === "recording"
                ? "Finishing vocal and mix..."
                : recordingStatus === "exporting-video"
                  ? "Exporting performance video..."
                  : recordingStatus === "failed"
                    ? recordingTake?.mix_path
                      ? "Export failed; your vocal and mix are still saved"
                      : "Export failed; your dry vocal is still saved"
                    : recordingTake?.video_path
                      ? "Vocal master, mix, and performance video saved"
                      : recordingTake?.mix_path
                        ? "Vocal master and performance mix saved"
                        : recordingTake?.vocal_path
                          ? "Vocal master saved"
                          : "No recording saved"}
            </span>
            {(recordingStatus === "finalizing" ||
              recordingStatus === "recording" ||
              recordingStatus === "exporting-video") && (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            )}
            {recordingTake?.vocal_path && recordingStatus !== "finalizing" && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Show recording in folder"
                onClick={() =>
                  void revealItemInDir(recordingTake.mix_path ?? recordingTake.vocal_path)
                }
              >
                <FolderOpen className="size-4" />
              </Button>
            )}
          </div>

          {recordingStatus === "failed" && recordingError && (
            <p className="text-xs text-destructive" role="alert">
              {recordingError}
            </p>
          )}

          {recordingTake?.vocal_path && recordingStatus !== "recording" && (
            <div className="grid grid-cols-[5.5rem_minmax(8rem,1fr)_auto] items-center gap-3 border-y border-border py-3">
              <span className="text-xs text-muted-foreground">Vocal level</span>
              <Slider
                aria-label="Vocal level in replay mix"
                min={0}
                max={2}
                step={0.05}
                value={[vocalGain]}
                disabled={recordingStatus === "finalizing" || recordingStatus === "exporting-video"}
                onValueChange={(values) => setVocalGain(values[0] ?? 1)}
              />
              <span className="w-10 text-right text-xs tabular-nums">
                {Math.round(vocalGain * 100)}%
              </span>
              <span />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-fit"
                disabled={recordingStatus === "finalizing" || recordingStatus === "exporting-video"}
                onClick={renderRecordingMix}
              >
                <RefreshCw className="size-4" /> Render mix
              </Button>
            </div>
          )}

          {recordingTake?.vocal_path && recordingStatus !== "finalizing" && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void recordingPreview.play(recordingTake.vocal_path, "Vocal master")}
              >
                <Mic2 className="size-4" />
                {recordingPreview.path === recordingTake.vocal_path && recordingPreview.playing ? (
                  <Pause className="size-3" />
                ) : (
                  <Play className="size-3" />
                )}
                Vocal
              </Button>
              {recordingTake.mix_path && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void recordingPreview.play(recordingTake.mix_path as string, "Performance mix")
                  }
                >
                  <Music2 className="size-4" />
                  {recordingPreview.path === recordingTake.mix_path && recordingPreview.playing ? (
                    <Pause className="size-3" />
                  ) : (
                    <Play className="size-3" />
                  )}
                  Mix
                </Button>
              )}
              {recordingTake.video_path && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void openMediaPath(recordingTake.video_path as string)}
                >
                  <Video className="size-4" />
                  <Play className="size-3" /> Video
                </Button>
              )}
              {videoExportAvailable && recordingTake.mix_path && !recordingTake.video_path && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={recordingStatus === "exporting-video"}
                  onClick={exportRecordingVideo}
                >
                  {recordingStatus === "exporting-video" ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  Export video
                </Button>
              )}
              {!recordingTake.mix_path && recordingStatus !== "recording" && (
                <Button type="button" size="sm" variant="outline" onClick={retryRecordingExport}>
                  <Download className="size-4" /> Export mix
                </Button>
              )}
            </div>
          )}

          <RecordingPreview preview={recordingPreview} />

          {board.length > 0 ? (
            <>
              <div className="h-px w-full bg-border" />
              <p className="text-center text-[11px] font-medium tracking-wide text-muted-foreground">
                BEST SCORES
              </p>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 text-xs">#</TableHead>
                    <TableHead className="h-8 text-xs">Profile</TableHead>
                    <TableHead className="h-8 text-right text-xs">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {board.map(({ profile, score: rowScore }, i) => {
                    const isCurrent = profile === activeProfile && rowScore === score * 10;

                    return (
                      <TableRow key={profile} className={cn(isCurrent && "bg-primary/10")}>
                        <TableCell className="py-2 text-xs tabular-nums">{i + 1}</TableCell>
                        <TableCell
                          className={cn("py-2 text-xs", isCurrent && "font-medium text-primary")}
                        >
                          {profile}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "py-2 text-right text-xs tabular-nums",
                            isCurrent && "font-medium text-primary",
                          )}
                        >
                          {Math.round(rowScore / 10)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </>
          ) : null}

          <DialogFooter className="mt-2 sm:justify-center">
            <Button type="button" className="w-full sm:w-auto" onClick={onFinish}>
              Back to Menu
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
};
