import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { openUrl } from "@/bridge/opener";
import type { LyricsSearchOptions } from "@/bridge/lyrics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogNav } from "@/hooks/navigation/use-dialog-nav";
import { useDialog } from "@/hooks/use-dialog";
import { useLyricsEditor } from "@/hooks/use-lyrics-editor";
import {
  useApplyTimedLyricsMutation,
  useProvideLrcMutation,
} from "@/mutations/use-timed-lyrics-mutation";
import { useSaveLyricsMutation } from "@/mutations/use-save-lyrics-mutation";
import { useLrclibCandidates } from "@/queries/use-lyrics";
import type { LrclibCandidate } from "@/types/LrclibCandidate";
import { detectLrcLevel, isEditLyricsDialogMode, stripLrcToPlainLines } from "@/utils/edit-lyrics";
import { Loader2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { CarouselNav } from "./carousel-nav";
import { EditLyricsFooter } from "./edit-lyrics-footer";
import { LrcOptions, type TimingChoice } from "./lrc-options";
import { LrclibMatches } from "./lrclib-matches";
import { LyricsEditor } from "./lyrics-editor";
import { ringFor } from "./parts";

export { isEditLyricsDialogMode } from "@/utils/edit-lyrics";

const LRC_SPEC_URL = "https://en.wikipedia.org/wiki/LRC_(file_format)";

type EditLyricsTab = "edit" | "lrclib";

interface NavLayout {
  stops: number[];
  editorSegment: number | null;
  // Top "header row" containing tabs (slots 0..1) and, on the LRCLIB tab, the
  // carousel arrows (slots 2..3) — all in the same segment so left/right walks
  // across them.
  headerSegment: number | null;
  // Slot offset where the carousel arrows start inside `headerSegment`; null
  // if no arrows in this view.
  arrowSlotStart: number | null;
  // Timing / audio radio rows (each 2 slots) on the edit pane, present only
  // when their controls are enabled.
  timingSegment: number | null;
  audioSegment: number | null;
  useThisSegment: number | null;
  footerSegment: number;
  searchSegment: number | null;
  languageSegment: number | null;
}

interface NavLayoutInput {
  showMatchesTab: boolean;
  activeTab: EditLyricsTab;
  hasCandidates: boolean;
  // Number of action buttons on the current LRCLIB candidate: 2 when it has
  // synced lyrics ("Use LRC" + "Use as plain text"), otherwise 1.
  useSlots: number;
  timingNav: boolean;
  audioNav: boolean;
}

function navLayout({
  showMatchesTab,
  activeTab,
  hasCandidates,
  useSlots,
  timingNav,
  audioNav,
}: NavLayoutInput): NavLayout {
  const onLrclib = showMatchesTab && activeTab === "lrclib";
  const segments: { key: string; width: number }[] = [];
  let arrowSlotStart: number | null = null;

  if (showMatchesTab) {
    if (onLrclib && hasCandidates) {
      segments.push({ key: "header", width: 4 });
      arrowSlotStart = 2;
    } else {
      segments.push({ key: "header", width: 2 });
    }
  }

  if (onLrclib) {
    segments.push({ key: "search", width: 3 });
    if (hasCandidates) segments.push({ key: "use", width: Math.max(1, useSlots) });
  } else {
    segments.push({ key: "language", width: 1 });
    segments.push({ key: "editor", width: 1 });
    if (timingNav) segments.push({ key: "timing", width: 2 });
    if (audioNav) segments.push({ key: "audio", width: 2 });
  }

  segments.push({ key: "footer", width: 2 });

  const indexOf = (key: string): number | null => {
    const i = segments.findIndex((s) => s.key === key);
    return i === -1 ? null : i;
  };

  return {
    stops: segments.map((s) => s.width),
    headerSegment: indexOf("header"),
    arrowSlotStart,
    editorSegment: indexOf("editor"),
    timingSegment: indexOf("timing"),
    audioSegment: indexOf("audio"),
    useThisSegment: indexOf("use"),
    footerSegment: indexOf("footer") ?? segments.length - 1,
    searchSegment: indexOf("search"),
    languageSegment: indexOf("language"),
  };
}

export const EditLyricsDialog = () => {
  const { mode, close } = useDialog();
  const editLyricsDialog = isEditLyricsDialogMode(mode) ? mode : null;
  const open = editLyricsDialog !== null;
  const song = editLyricsDialog?.song ?? null;
  const fileHash = song?.file_hash ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isAnalyzed = song?.is_analyzed ?? false;

  const editor = useLyricsEditor({ song, onSaved: close });
  const [searchTitle, setSearchTitle] = useState(song?.title ?? "");
  const [searchArtist, setSearchArtist] = useState(song?.artist ?? "");
  const [language, setLanguage] = useState("auto");
  const [searchOptions, setSearchOptions] = useState<LyricsSearchOptions>();
  const [searchRevision, setSearchRevision] = useState(0);
  const searchTitleRef = useRef<HTMLInputElement>(null);
  const searchArtistRef = useRef<HTMLInputElement>(null);
  const languageRef = useRef<HTMLSelectElement>(null);
  const candidatesQuery = useLrclibCandidates(fileHash, searchOptions, searchRevision);
  const candidates = candidatesQuery.data ?? [];
  const candidateCount = candidates.length;
  const matchesLoading = candidatesQuery.isFetching;
  const showMatchesTab = true;

  const provideLrcMutation = useProvideLrcMutation();
  const applyTimedMutation = useApplyTimedLyricsMutation();
  const saveLyricsMutation = useSaveLyricsMutation();

  const [activeTab, setActiveTab] = useState<EditLyricsTab>("edit");
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [timingChoice, setTimingChoice] = useState<TimingChoice>("provided");
  const [separateStems, setSeparateStems] = useState(false);
  const [lastHash, setLastHash] = useState<string | null>(fileHash);
  if (lastHash !== fileHash) {
    setLastHash(fileHash);
    setActiveTab("edit");
    setCarouselIndex(0);
    setTimingChoice("provided");
    setSeparateStems(false);
    setSearchTitle(song?.title ?? "");
    setSearchArtist(song?.artist === "Unknown Artist" ? "" : (song?.artist ?? ""));
    setLanguage(["ja", "ko", "en"].includes(song?.language ?? "") ? song!.language! : "auto");
    setSearchOptions(undefined);
    setSearchRevision(0);
  }

  const searchLyrics = () => {
    if (!searchTitle.trim() || matchesLoading) return;
    setSearchOptions({
      title: searchTitle.trim(),
      artist: searchArtist.trim(),
      language,
      reference: stripLrcToPlainLines(editor.text).join("\n"),
    });
    setSearchRevision((revision) => revision + 1);
    setCarouselIndex(0);
  };

  const lrcLevel = useMemo(() => detectLrcLevel(editor.text), [editor.text]);
  const hasLrc = lrcLevel !== "none";
  const useProvidedTiming = hasLrc && timingChoice === "provided";
  // Stems already exist only for analyzed tracks that weren't kept on the
  // original mix. Those can't change their audio mode by re-editing lyrics.
  const stemsSeparated = isAnalyzed && !(song?.no_stems ?? false);
  // Separation runs when the user opts in and the track doesn't already have
  // stems: a fresh track, or re-separating an LRC/original-mix track.
  const willSeparate = useProvidedTiming && separateStems && !stemsSeparated;

  const saving =
    provideLrcMutation.isLoading || applyTimedMutation.isLoading || saveLyricsMutation.isLoading;
  const canSave = !saving && !editor.loadingInitial && editor.text.trim().length > 0;

  const saveLabel = useProvidedTiming
    ? willSeparate
      ? "Save & separate stems"
      : isAnalyzed
        ? "Use timed lyrics"
        : "Save timed lyrics"
    : isAnalyzed
      ? "Save & realign"
      : "Save & analyze";

  const footerHints: string[] = [];
  if (!hasLrc) {
    footerHints.push("Paste LRC / Enhanced LRC to set timing directly.");
  } else {
    if (useProvidedTiming && lrcLevel === "line") {
      footerHints.push("Line-level LRC highlights whole lines — no per-word timing.");
    }
    if (useProvidedTiming && !willSeparate && !stemsSeparated) {
      footerHints.push("Original mix is used, so pitch scoring will likely be inaccurate.");
    }
  }
  const footerHint = footerHints.length > 0 ? footerHints.join(" ") : undefined;

  const handleSave = () => {
    if (!canSave || !song) return;
    const hash = song.file_hash;
    const title = song.title;

    if (useProvidedTiming) {
      if (willSeparate) {
        provideLrcMutation.mutate(
          { hash, lrcText: editor.text, separateStems: true, title, language },
          { onSuccess: close },
        );
      } else if (isAnalyzed) {
        applyTimedMutation.mutate(
          { hash, lrcText: editor.text, title, language },
          { onSuccess: close },
        );
      } else {
        provideLrcMutation.mutate(
          { hash, lrcText: editor.text, separateStems: false, title, language },
          { onSuccess: close },
        );
      }
      return;
    }

    const lines = hasLrc ? stripLrcToPlainLines(editor.text) : editor.normalized;
    if (lines.length === 0) return;
    saveLyricsMutation.mutate({ hash, lines, title, language }, { onSuccess: close });
  };

  const applyCandidate = (candidate: LrclibCandidate) => {
    editor.setText(candidate.lines.join("\n"));
    setTimingChoice("provided");
    setActiveTab("edit");
  };

  const applyCandidateLrc = (candidate: LrclibCandidate) => {
    if (candidate.synced_lyrics == null) return;
    editor.setText(candidate.synced_lyrics);
    setTimingChoice("provided");
    setActiveTab("edit");
  };

  const timingNav = hasLrc && !saving;
  const audioNav = useProvidedTiming && !stemsSeparated && !saving;

  const currentCandidate =
    candidateCount > 0 ? candidates[Math.min(carouselIndex, candidateCount - 1)] : undefined;
  const currentHasLrc = currentCandidate?.synced_lyrics != null;

  const layout = navLayout({
    showMatchesTab,
    activeTab,
    hasCandidates: candidateCount > 0,
    useSlots: currentHasLrc ? 3 : 2,
    timingNav,
    audioNav,
  });

  const { isFocused, focusSegment } = useDialogNav({
    open,
    itemCount: layout.stops.reduce((sum, n) => sum + n, 0),
    stops: layout.stops,
    onBack: close,
    containerRef,
    onAction: (segment, slot, action) => {
      const textarea = textareaRef.current;
      const focusedElement = document.activeElement;
      const editingInTextarea =
        focusedElement instanceof HTMLInputElement ||
        focusedElement instanceof HTMLSelectElement ||
        (textarea !== null && focusedElement === textarea);

      if (editingInTextarea) {
        if (action.back) {
          (focusedElement as HTMLElement)?.blur();
        }
        return true;
      }

      if (!action.confirm) return false;

      if (segment === layout.languageSegment) {
        languageRef.current?.focus();
        return true;
      }
      if (segment === layout.searchSegment) {
        if (slot === 0) searchTitleRef.current?.focus();
        else if (slot === 1) searchArtistRef.current?.focus();
        else searchLyrics();
        return true;
      }

      if (layout.editorSegment !== null && segment === layout.editorSegment) {
        textarea?.focus();
        return true;
      }

      // Header holds the tabs (slots 0..1) and, on the LRCLIB tab, the carousel
      // arrows (slots >= arrowSlotStart). Radix tabs activate on mousedown, not
      // click, so drive them from state; arrows adjust the carousel directly.
      if (layout.headerSegment !== null && segment === layout.headerSegment) {
        if (slot < 2) {
          setActiveTab(slot === 0 ? "edit" : "lrclib");
          return true;
        }
        if (layout.arrowSlotStart !== null && slot >= layout.arrowSlotStart) {
          const delta = slot - layout.arrowSlotStart === 0 ? -1 : 1;
          setCarouselIndex((i) =>
            Math.min(Math.max(0, i + delta), Math.max(0, candidateCount - 1)),
          );
          return true;
        }
      }

      if (layout.timingSegment !== null && segment === layout.timingSegment) {
        setTimingChoice(slot === 0 ? "provided" : "align");
        return true;
      }

      if (layout.audioSegment !== null && segment === layout.audioSegment) {
        setSeparateStems(slot === 1);
        return true;
      }

      if (layout.useThisSegment !== null && segment === layout.useThisSegment) {
        const candidate = candidates[Math.min(carouselIndex, candidateCount - 1)];
        if (candidate) {
          const candidateHasLrc = candidate.synced_lyrics != null;
          if (slot === 0) void openUrl(candidate.source_url);
          else if (candidateHasLrc && slot === 1) applyCandidateLrc(candidate);
          else applyCandidate(candidate);
        }
        return true;
      }

      if (segment === layout.footerSegment) {
        if (slot === 0) {
          if (!saving) close();
        } else {
          handleSave();
        }
        return true;
      }

      return false;
    },
  });

  if (!song || !editLyricsDialog) {
    return null;
  }

  const editorFocused = layout.editorSegment !== null && isFocused(layout.editorSegment);
  const focusTab = (slot: number) => {
    if (layout.headerSegment !== null) {
      focusSegment(layout.headerSegment, slot);
    }
  };

  const focusedSlotIn = (segment: number | null): number | null => {
    if (segment === null) return null;
    if (isFocused(segment, 0)) return 0;
    if (isFocused(segment, 1)) return 1;
    return null;
  };

  const editorPane = (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor="lyric-language">Lyrics language</label>
        <select
          id="lyric-language"
          ref={languageRef}
          value={language}
          disabled={saving}
          onChange={(event) => setLanguage(event.target.value)}
          className={
            "rounded-md border bg-card px-2 py-1.5 " +
            ringFor(layout.languageSegment !== null && isFocused(layout.languageSegment))
          }
        >
          <option value="auto">Auto — use the lyric script</option>
          <option value="ja">Japanese 日本語</option>
          <option value="ko">Korean 한국어</option>
          <option value="en">English</option>
        </select>
        <p className="basis-full text-muted-foreground">
          Use original kanji/kana, Hangul, or English, one sung line per row. Keep repeated
          choruses. Readings are generated separately; choose how to show them in Settings.
        </p>
      </div>
      <LyricsEditor
        textareaRef={textareaRef}
        text={editor.text}
        onChange={editor.setText}
        disabled={editor.loadingInitial || saving}
        loadingInitial={editor.loadingInitial}
        lineCount={editor.normalized.length}
        isDirty={editor.isDirty}
        focused={editorFocused}
      />
      <LrcOptions
        level={lrcLevel}
        stemsSeparated={stemsSeparated}
        timingChoice={timingChoice}
        onTimingChoiceChange={setTimingChoice}
        separateStems={separateStems}
        onSeparateStemsChange={setSeparateStems}
        disabled={saving}
        timingFocusedSlot={focusedSlotIn(layout.timingSegment)}
        audioFocusedSlot={focusedSlotIn(layout.audioSegment)}
        onFocusOption={(row, slot) => {
          const segment = row === "timing" ? layout.timingSegment : layout.audioSegment;
          if (segment !== null) focusSegment(segment, slot);
        }}
      />
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex h-[85vh] flex-col sm:max-w-2xl">
        <div ref={containerRef} className="contents">
          <DialogHeader>
            <DialogTitle>Edit lyrics</DialogTitle>
            <DialogDescription>
              Type plain lyrics to run alignment, or paste{" "}
              <a
                href={LRC_SPEC_URL}
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openUrl(LRC_SPEC_URL);
                }}
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                LRC / Enhanced LRC
              </a>{" "}
              to set timing directly.
            </DialogDescription>
          </DialogHeader>

          {showMatchesTab ? (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as EditLyricsTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex items-center justify-between gap-2">
                <TabsList>
                  <TabsTrigger
                    value="edit"
                    onMouseEnter={() => focusTab(0)}
                    onPointerDown={() => focusTab(0)}
                    onFocus={() => focusTab(0)}
                    className={ringFor(
                      layout.headerSegment !== null && isFocused(layout.headerSegment, 0),
                    )}
                  >
                    Edit
                  </TabsTrigger>
                  <TabsTrigger
                    value="lrclib"
                    onMouseEnter={() => focusTab(1)}
                    onPointerDown={() => focusTab(1)}
                    onFocus={() => focusTab(1)}
                    className={ringFor(
                      layout.headerSegment !== null && isFocused(layout.headerSegment, 1),
                    )}
                  >
                    Find accurate lyrics
                    {matchesLoading ? (
                      <Loader2Icon className="size-3 animate-spin" />
                    ) : (
                      `(${candidateCount})`
                    )}
                  </TabsTrigger>
                </TabsList>
                {activeTab === "lrclib" &&
                  layout.headerSegment !== null &&
                  layout.arrowSlotStart !== null && (
                    <CarouselNav
                      index={carouselIndex}
                      total={candidateCount}
                      onChange={setCarouselIndex}
                      isFocused={(slot) =>
                        isFocused(
                          layout.headerSegment as number,
                          (layout.arrowSlotStart as number) + slot,
                        )
                      }
                    />
                  )}
              </div>

              <TabsContent value="edit" className="mt-3 flex min-h-0 flex-1 flex-col">
                {editorPane}
              </TabsContent>

              <TabsContent value="lrclib" className="mt-3 flex min-h-0 flex-1 flex-col">
                <div className="mb-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <label className="min-w-0 text-xs">
                    Song title
                    <Input
                      ref={searchTitleRef}
                      value={searchTitle}
                      disabled={saving}
                      className={ringFor(
                        layout.searchSegment !== null && isFocused(layout.searchSegment, 0),
                      )}
                      onChange={(event) => setSearchTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") searchLyrics();
                      }}
                    />
                  </label>
                  <label className="min-w-0 text-xs">
                    Artist
                    <Input
                      ref={searchArtistRef}
                      value={searchArtist}
                      disabled={saving}
                      className={ringFor(
                        layout.searchSegment !== null && isFocused(layout.searchSegment, 1),
                      )}
                      onChange={(event) => setSearchArtist(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") searchLyrics();
                      }}
                    />
                  </label>
                  <Button
                    disabled={matchesLoading || saving || !searchTitle.trim()}
                    onClick={searchLyrics}
                    className={ringFor(
                      layout.searchSegment !== null && isFocused(layout.searchSegment, 2),
                    )}
                  >
                    Search
                  </Button>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">
                  Search LRCLIB using the song’s original title or artist name. Your input is
                  compared locally to rank matches. Preview the wording before using a version;
                  results can include covers and alternate versions.
                </p>
                <LrclibMatches
                  candidates={candidates}
                  isLoading={matchesLoading}
                  isError={candidatesQuery.isError}
                  errorMessage={
                    candidatesQuery.error instanceof Error ? candidatesQuery.error.message : null
                  }
                  index={carouselIndex}
                  onSelect={applyCandidate}
                  onUseLrc={applyCandidateLrc}
                  isFocused={(slot) =>
                    layout.useThisSegment !== null && isFocused(layout.useThisSegment, slot)
                  }
                />
              </TabsContent>
            </Tabs>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">{editorPane}</div>
          )}

          <EditLyricsFooter
            onCancel={close}
            onSave={handleSave}
            saving={saving}
            canSave={canSave}
            saveLabel={saveLabel}
            hint={footerHint}
            isFocused={(slot) => isFocused(layout.footerSegment, slot)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};
