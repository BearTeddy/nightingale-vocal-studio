import { loadMelodyMap, playbackAdapter, rebuildMelodyMap, saveMelodyMap } from "@/bridge/playback";
import { addScore } from "@/bridge/profile";
import { listPracticeSessions, savePracticeSession } from "@/bridge/recording";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDialog } from "@/hooks/use-dialog";
import { scorePitchSeries, type PitchSeries } from "@/lib/pitch/state";
import { transformMelodyMap } from "@/lib/pitch/melody";
import {
  cloneTargetNotes,
  MIN_SPLIT_DURATION_SECONDS,
  mergeTargetNotes,
  splitTargetNote,
  updateTargetNote,
} from "@/lib/pitch/melody-editor";
import { PROFILES } from "@/queries/keys";
import { useProfiles } from "@/queries/use-profiles";
import type { MelodyMap } from "@/types/MelodyMap";
import type { TargetNote } from "@/types/TargetNote";
import {
  AudioWaveform,
  Combine,
  Loader2,
  Minus,
  Play,
  Plus,
  Save,
  Scissors,
  Undo2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

function noteName(midi: number): string {
  const rounded = Math.round(midi);
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${names[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

function auditionTone(note: TargetNote): void {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const duration = Math.min(1.5, Math.max(0.25, note.end - note.start));
  oscillator.type = "sine";
  oscillator.frequency.value = 440 * 2 ** ((note.midi + note.cents / 100 - 69) / 12);
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.linearRampToValueAtTime(0.16, context.currentTime + 0.02);
  gain.gain.setValueAtTime(0.16, context.currentTime + Math.max(0.03, duration - 0.08));
  gain.gain.linearRampToValueAtTime(0, context.currentTime + duration);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + duration + 0.01);
  oscillator.onended = () => void context.close();
}

interface MelodyEditorState {
  melody: MelodyMap | null;
  selected: number;
  undo: TargetNote[][];
}

const EMPTY_EDITOR: MelodyEditorState = { melody: null, selected: 0, undo: [] };

export function MelodyEditorDialog() {
  const { mode, close } = useDialog();
  const queryClient = useQueryClient();
  const { data: profiles } = useProfiles();
  const open = typeof mode === "object" && mode?.mode === "edit-melody";
  const song = open ? mode.song : null;
  const [{ melody, selected, undo }, setEditor] = useState<MelodyEditorState>(EMPTY_EDITOR);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [vocalUrl, setVocalUrl] = useState<string | null>(null);
  const vocalAudioRef = useRef<HTMLAudioElement | null>(null);
  const vocalTimerRef = useRef<number | null>(null);
  const selectedNote = melody?.notes[selected] ?? null;
  const songHash = song?.file_hash;

  useEffect(() => {
    let cancelled = false;
    setEditor(EMPTY_EDITOR);
    setVocalUrl(null);
    if (!songHash) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void loadMelodyMap(songHash)
      .then((next) => {
        if (!cancelled) setEditor({ melody: next, selected: 0, undo: [] });
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(`Pitch guide: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    void playbackAdapter
      .init()
      .then(() => playbackAdapter.getAudioPaths(songHash))
      .then((paths) => {
        if (!cancelled) setVocalUrl(paths.vocals);
      })
      .catch(() => {
        if (!cancelled) setVocalUrl(null);
      });

    return () => {
      cancelled = true;
      if (vocalTimerRef.current !== null) window.clearTimeout(vocalTimerRef.current);
      vocalTimerRef.current = null;
      vocalAudioRef.current?.pause();
      vocalAudioRef.current = null;
    };
  }, [songHash]);

  const eligibleCount = useMemo(
    () => melody?.notes.filter((note) => note.eligible).length ?? 0,
    [melody],
  );

  const mutate = (
    change: (notes: TargetNote[], index: number) => TargetNote[],
    requestedIndex?: number,
  ) => {
    setEditor((current) => {
      if (!current.melody) return current;
      const editIndex = requestedIndex ?? current.selected;
      const before = cloneTargetNotes(current.melody.notes);
      const working = cloneTargetNotes(current.melody.notes);
      const notes = change(working, editIndex);
      if (notes === working) {
        return { ...current, selected: Math.min(editIndex, Math.max(0, working.length - 1)) };
      }
      return {
        melody: { ...current.melody, notes },
        selected: Math.min(editIndex, Math.max(0, notes.length - 1)),
        undo: [...current.undo.slice(-19), before],
      };
    });
  };

  const updateSelected = (change: (note: TargetNote) => TargetNote) =>
    mutate((notes, index) => updateTargetNote(notes, index, change));

  const split = () => mutate(splitTargetNote);

  const merge = () => mutate(mergeTargetNotes);

  const undoLast = () => {
    setEditor((current) => {
      const previous = current.undo[current.undo.length - 1];
      if (!current.melody || !previous) return current;
      return {
        melody: { ...current.melody, notes: cloneTargetNotes(previous) },
        selected: Math.min(current.selected, Math.max(0, previous.length - 1)),
        undo: current.undo.slice(0, -1),
      };
    });
  };

  const selectNote = (index: number, focus = false) => {
    setEditor((current) => {
      const lastIndex = Math.max(0, (current.melody?.notes.length ?? 1) - 1);
      const next = Math.min(Math.max(index, 0), lastIndex);
      if (focus) {
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`[data-melody-note-index="${next}"]`)?.focus();
        });
      }
      return { ...current, selected: next };
    });
  };

  const stopVocalAudition = () => {
    if (vocalTimerRef.current !== null) window.clearTimeout(vocalTimerRef.current);
    vocalTimerRef.current = null;
    vocalAudioRef.current?.pause();
    vocalAudioRef.current = null;
  };

  const auditionVocal = (note: TargetNote) => {
    if (!vocalUrl) return;
    stopVocalAudition();
    const audio = new Audio(vocalUrl);
    const start = Math.max(0, note.start - 0.15);
    const durationMs = Math.max(300, (note.end + 0.15 - start) * 1_000);
    audio.preload = "auto";
    audio.volume = 0.85;
    vocalAudioRef.current = audio;

    const play = () => {
      if (vocalAudioRef.current !== audio) return;
      audio.currentTime = start;
      void audio
        .play()
        .then(() => {
          vocalTimerRef.current = window.setTimeout(stopVocalAudition, durationMs);
        })
        .catch((error) => {
          stopVocalAudition();
          toast.error(`Vocal audition: ${error instanceof Error ? error.message : String(error)}`);
        });
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) play();
    else audio.addEventListener("loadedmetadata", play, { once: true });
  };

  const rescoreLatest = async (next: MelodyMap): Promise<boolean> => {
    if (!song) return false;
    const activeProfile = profiles?.active ?? "Guest";
    const sessions = await listPracticeSessions(activeProfile);
    const latest = sessions.find(
      (session) =>
        session.kind === "karaoke" &&
        session.song_hash === song.file_hash &&
        session.ended_at != null &&
        session.performance_json != null,
    );
    if (!latest?.performance_json || latest.ended_at == null) return false;

    const previous = JSON.parse(latest.performance_json) as Record<string, unknown> & {
      pitch_series?: PitchSeries;
      mic_latency_compensation_sec?: number;
    };
    const series = previous.pitch_series;
    if (!series || !Array.isArray(series.timestamps)) return false;
    const transformed = transformMelodyMap(next, song.key_offset, song.tempo);
    const rescored = scorePitchSeries(
      transformed,
      series,
      Number(previous.mic_latency_compensation_sec ?? 0),
    );
    await savePracticeSession({
      id: latest.id,
      profile: latest.profile,
      song_hash: latest.song_hash,
      kind: latest.kind,
      started_at: latest.started_at,
      ended_at: latest.ended_at,
      performance_json: JSON.stringify({
        ...previous,
        ...rescored,
        pitch_series: series,
        rescored_at: Date.now(),
        melody_version: next.version,
        melody_source: next.source,
      }),
      recording_take_id: latest.recording_take_id,
      transport_segments: latest.transport_segments,
    });
    await addScore(song.file_hash, rescored.legacy_score);
    await queryClient.invalidateQueries({ queryKey: PROFILES });
    return true;
  };

  const save = async (rescore: boolean) => {
    if (!song || !melody) return;
    const next = {
      ...melody,
      source: melody.source === "usdx" ? "usdx-edited" : "manual",
      strict_scoring_available: melody.notes.some((note) => note.eligible),
    };
    setSaving(true);
    try {
      await saveMelodyMap(song.file_hash, next);
      const rescored = rescore ? await rescoreLatest(next) : false;
      toast.success(
        rescore
          ? rescored
            ? "Pitch guide saved and latest performance re-scored"
            : "Pitch guide saved; no recorded performance was available to re-score"
          : "Pitch guide saved",
      );
      close();
    } catch (error) {
      toast.error(`Pitch guide: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const build = async () => {
    if (!song || building) return;
    setBuilding(true);
    try {
      const next = await rebuildMelodyMap(song.file_hash);
      setEditor({ melody: next, selected: 0, undo: [] });
      toast.success(`Pitch guide built with ${next.notes.length} notes`);
    } catch (error) {
      toast.error(`Pitch guide: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="grid h-[90vh] max-h-[48rem] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>Edit pitch guide</DialogTitle>
          <DialogDescription>
            {song?.artist} · {song?.title} · {eligibleCount} scored notes
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid min-h-0 place-items-center px-6 py-12">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading pitch guide
            </div>
          </div>
        ) : !melody ? (
          <div className="px-6 py-12">
            <p className="text-sm text-muted-foreground">
              No melody guide is available yet. Build one from the analyzed vocal stem.
            </p>
            <Button type="button" className="mt-5" disabled={building} onClick={build}>
              {building ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <AudioWaveform className="size-4" />
              )}
              {building ? "Building pitch guide" : "Build pitch guide"}
            </Button>
          </div>
        ) : (
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Undo"
                disabled={undo.length === 0}
                onClick={undoLast}
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Audition target tone"
                disabled={!selectedNote}
                onClick={() => selectedNote && auditionTone(selectedNote)}
              >
                <Play className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Audition isolated vocal"
                disabled={!selectedNote || !vocalUrl}
                onClick={() => selectedNote && auditionVocal(selectedNote)}
              >
                <Volume2 className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Split note"
                disabled={
                  !selectedNote ||
                  selectedNote.end - selectedNote.start < MIN_SPLIT_DURATION_SECONDS
                }
                onClick={split}
              >
                <Scissors className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Merge with next"
                disabled={!selectedNote || selected >= melody.notes.length - 1}
                onClick={merge}
              >
                <Combine className="size-4" />
              </Button>
              <span className="mx-2 h-6 w-px bg-border" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateSelected((note) => ({ ...note, midi: note.midi - 1 }))}
              >
                <Minus className="size-3.5" /> Pitch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateSelected((note) => ({ ...note, midi: note.midi + 1 }))}
              >
                <Plus className="size-3.5" /> Pitch
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  updateSelected((note) => ({ ...note, start: Math.max(0, note.start - 0.05) }))
                }
              >
                <Minus className="size-3.5" /> Start
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  updateSelected((note) => ({
                    ...note,
                    start: Math.min(note.end - 0.05, note.start + 0.05),
                  }))
                }
              >
                <Plus className="size-3.5" /> Start
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  updateSelected((note) => ({
                    ...note,
                    end: Math.max(note.start + 0.05, note.end - 0.05),
                  }))
                }
              >
                <Minus className="size-3.5" /> End
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => updateSelected((note) => ({ ...note, end: note.end + 0.05 }))}
              >
                <Plus className="size-3.5" /> End
              </Button>
            </div>

            <div className="min-h-0 overflow-y-auto">
              <div className="sticky top-0 z-[1] grid grid-cols-[3rem_5rem_6rem_6rem_1fr] border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
                <span>Score</span>
                <span>Note</span>
                <span>Start</span>
                <span>End</span>
                <span>Confidence</span>
              </div>
              {melody.notes.map((note, index) => (
                <div
                  key={`${note.id}-${index}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === index}
                  data-melody-note-index={index}
                  style={{ contentVisibility: "auto", containIntrinsicSize: "48px" }}
                  onClick={() => selectNote(index)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectNote(index);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      selectNote(index + 1, true);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      selectNote(index - 1, true);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      selectNote(0, true);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      selectNote(melody.notes.length - 1, true);
                    }
                  }}
                  className={`grid w-full grid-cols-[3rem_5rem_6rem_6rem_1fr] items-center border-b border-border px-4 py-2 text-left text-sm ${
                    selected === index ? "bg-primary/10" : "hover:bg-muted/50"
                  }`}
                >
                  <Checkbox
                    checked={note.eligible}
                    aria-label={`Score ${noteName(note.midi)}`}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={(checked) => {
                      mutate(
                        (notes, noteIndex) =>
                          updateTargetNote(notes, noteIndex, (item) => ({
                            ...item,
                            eligible: checked === true,
                          })),
                        index,
                      );
                    }}
                  />
                  <span className="font-medium">{noteName(note.midi)}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {note.start.toFixed(2)}s
                  </span>
                  <span className="tabular-nums text-muted-foreground">{note.end.toFixed(2)}s</span>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round(note.confidence * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button type="button" variant="outline" disabled={saving} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!melody || saving}
            onClick={() => void save(false)}
          >
            <Save className="size-4" /> Save guide
          </Button>
          <Button type="button" disabled={!melody || saving} onClick={() => void save(true)}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <AudioWaveform className="size-4" />
            )}
            Save &amp; re-score latest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
