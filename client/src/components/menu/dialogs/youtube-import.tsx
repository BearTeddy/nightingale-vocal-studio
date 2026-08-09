import { importYouTube } from "@/bridge/youtube";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDialogNav } from "@/hooks/navigation/use-dialog-nav";
import { useDialog } from "@/hooks/use-dialog";
import { cn } from "@/lib/utils";
import { ANALYSIS_QUEUE, MENU, SONGS, SONGS_META } from "@/queries/keys";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, LoaderCircleIcon, YoutubeIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

const FOCUS_RING = "ring-2 ring-primary";
const NO_NATIVE_RING = "focus-visible:ring-0 focus-visible:border-transparent";

export const YouTubeImportDialog = () => {
  const { mode, close } = useDialog();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const open = mode === "youtube-import";

  const mutation = useMutation({
    mutationFn: importYouTube,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: SONGS });
      queryClient.invalidateQueries({ queryKey: SONGS_META });
      queryClient.invalidateQueries({ queryKey: MENU });
      queryClient.invalidateQueries({ queryKey: ANALYSIS_QUEUE });

      if (result.downloaded.length === 0) {
        toast.info("No new videos were found. They may already be in your library.");
      } else {
        const label = result.downloaded.length === 1 ? "video" : "videos";
        toast.success(`Imported ${result.downloaded.length} ${label}. Rescanning library…`);
      }
      close();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const { reset } = mutation;
  useEffect(() => {
    if (open) {
      setUrl("");
      reset();
    }
  }, [open, reset]);

  const closeIfIdle = () => {
    if (!mutation.isPending) close();
  };

  const { focusedIndex, focusSegment } = useDialogNav({
    open,
    itemCount: 3,
    stops: [1, 2],
    onBack: closeIfIdle,
    containerRef,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = url.trim();
    if (!value) return;
    mutation.mutate(value);
  };

  return (
    <Dialog open={open} onOpenChange={closeIfIdle}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <div ref={containerRef} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <YoutubeIcon className="size-4 text-red-500" />
                Import from YouTube
              </DialogTitle>
              <DialogDescription>
                Add a video or playlist to the active Nightingale library.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <label htmlFor="youtube-url" className="text-xs font-medium">
                YouTube URL
              </label>
              <Input
                id="youtube-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoFocus
                required
                value={url}
                disabled={mutation.isPending}
                aria-invalid={mutation.isError}
                placeholder="https://www.youtube.com/watch?v=…"
                onChange={(event) => setUrl(event.target.value)}
                onFocus={() => focusSegment(0)}
                className={cn(NO_NATIVE_RING, open && focusedIndex === 0 && FOCUS_RING)}
              />
              {mutation.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                  Downloading highest-quality video and audio…
                </p>
              )}
              {mutation.isError && (
                <p className="text-xs text-destructive">{mutation.error.message}</p>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={mutation.isPending}
                onClick={closeIfIdle}
                onMouseEnter={() => focusSegment(1, 0)}
                className={cn(NO_NATIVE_RING, open && focusedIndex === 1 && FOCUS_RING)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={mutation.isPending || !url.trim()}
                onMouseEnter={() => focusSegment(1, 1)}
                className={cn(NO_NATIVE_RING, open && focusedIndex === 2 && FOCUS_RING)}
              >
                {mutation.isPending ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <DownloadIcon />
                )}
                Import
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
