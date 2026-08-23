import { removeSong } from "@/bridge/analysis";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDialogNav } from "@/hooks/navigation/use-dialog-nav";
import { useDialog } from "@/hooks/use-dialog";
import { cn } from "@/lib/utils";
import { ANALYSIS_QUEUE, CACHE_STATS, MENU, SONGS, SONGS_META } from "@/queries/keys";
import { formatBytes } from "@/utils/stats";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

const RING = "ring-2 ring-primary";
const NO_FOCUS_RING = "focus-visible:ring-0 focus-visible:border-transparent";

export const RemoveSongDialog = () => {
  const { close, mode } = useDialog();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const open = typeof mode === "object" && mode !== null && mode.mode === "remove-song";
  const removeMode = open ? mode : null;
  const song = removeMode?.song ?? null;
  const isLocal = song?.origin.kind === "local_file";
  const isUsdx = Boolean(song?.usdx);
  const itemCount = isLocal ? 3 : 2;

  const runRemove = useCallback(
    async (deleteSource: boolean) => {
      if (!song || busy) return;
      setBusy(true);
      try {
        const result = await removeSong(song.file_hash, song.path, deleteSource);
        const freed = result.freed_bytes > 0 ? ` Freed ${formatBytes(result.freed_bytes)}.` : "";
        toast.success(
          deleteSource
            ? `Deleted “${song.title}” and removed it from Nightingale.${freed}`
            : `Removed “${song.title}” from Nightingale.${freed}`,
        );
        removeMode?.onRemoved?.();
        close();
        await Promise.all(
          [SONGS, SONGS_META, MENU, ANALYSIS_QUEUE, CACHE_STATS].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not remove song");
      } finally {
        setBusy(false);
      }
    },
    [busy, close, queryClient, removeMode, song],
  );

  const onConfirm = useCallback(
    (index: number) => {
      if (busy) return;
      if (index === 0) close();
      else if (isLocal && index === 2) void runRemove(true);
      else void runRemove(false);
    },
    [busy, close, isLocal, runRemove],
  );

  const { focusedIndex } = useDialogNav({
    open,
    itemCount,
    onConfirm,
    onBack: () => {
      if (!busy) close();
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={() => !busy && close()}>
      <AlertDialogContent onEscapeKeyDown={(event) => busy && event.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{song?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {isLocal
              ? isUsdx
                ? "Remove from Nightingale keeps the USDX song files and clears generated files. Delete source files permanently removes the descriptor and its referenced audio/video files too. The song stays out after rescans."
                : "Remove from Nightingale keeps your original song file and clears generated files. Delete file permanently removes the original too. The song stays out after rescans."
              : "This hides the song from Nightingale and deletes its downloaded and generated files. It does not delete anything from your media server."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel
            disabled={busy}
            onClick={close}
            className={cn(NO_FOCUS_RING, open && focusedIndex === 0 && RING)}
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void runRemove(false);
            }}
            className={cn(NO_FOCUS_RING, open && focusedIndex === 1 && RING)}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            Remove from Nightingale
          </AlertDialogAction>
          {isLocal ? (
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void runRemove(true);
              }}
              className={cn(NO_FOCUS_RING, open && focusedIndex === 2 && RING)}
            >
              {isUsdx ? "Delete source files permanently" : "Delete file permanently"}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
