import { Disc3Icon, FolderIcon, GraduationCap, MusicIcon } from "lucide-react";
import { useNavigate } from "react-router";

import { JellyfinIcon } from "@/components/icons/jellyfin";
import { PlexIcon } from "@/components/icons/plex";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useDialog } from "@/hooks/use-dialog";
import { useLibrarySourceActions } from "@/hooks/use-library-source-actions";

export const EmptySongList = () => {
  const { selectFolder, isPending, libraryPinned } = useLibrarySourceActions();
  const { setMode } = useDialog();
  const navigate = useNavigate();

  // Pinned library: nothing to pick in-app. An empty list here means the
  // configured folder is still scanning or has no supported files.
  if (libraryPinned) {
    return (
      <Empty className="px-4 pt-16 md:pt-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MusicIcon />
          </EmptyMedia>
          <EmptyTitle>No songs found</EmptyTitle>
          <EmptyDescription>
            The configured music folder is empty or still being scanned. Add supported files to it,
            then rescan from the sidebar.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Empty className="px-4 pt-16 md:pt-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MusicIcon />
        </EmptyMedia>
        <EmptyTitle>No library yet</EmptyTitle>
        <EmptyDescription>
          Pick a folder on this machine or connect a Plex, Jellyfin, or Navidrome server to start
          enjoying your karaoke!
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="max-w-lg flex-col justify-center gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="outline" onClick={() => setMode("plex-connect")} disabled={isPending}>
          <PlexIcon /> Connect Plex
        </Button>
        <Button variant="outline" onClick={() => setMode("navidrome-connect")} disabled={isPending}>
          <Disc3Icon /> Connect Navidrome
        </Button>
        <Button variant="outline" onClick={() => setMode("jellyfin-connect")} disabled={isPending}>
          <JellyfinIcon /> Connect Jellyfin
        </Button>
        <Button variant="outline" onClick={() => selectFolder()} disabled={isPending}>
          <FolderIcon /> Select folder
        </Button>
        <div className="mt-3 w-full border-t border-border pt-4 text-center">
          <p className="mb-3 text-xs text-muted-foreground">
            No songs yet? You can still check your microphone and start learning.
          </p>
          <Button onClick={() => navigate("/studio")}>
            <GraduationCap /> Start Vocal Studio
          </Button>
        </div>
      </EmptyContent>
    </Empty>
  );
};
