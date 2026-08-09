import { useMemo, type ComponentType, type SVGProps } from "react";
import { Disc3Icon, FolderIcon, RefreshCwIcon, YoutubeIcon } from "lucide-react";

import { JellyfinIcon } from "@/components/icons/jellyfin";
import { PlexIcon } from "@/components/icons/plex";
import type { BadgeTone } from "@/components/menu/sidebar/source-action-button";
import { useDialog } from "@/hooks/use-dialog";
import { useLibrarySourceActions } from "@/hooks/use-library-source-actions";

export interface SourceButton {
  key: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  tooltip: string;
  handler: () => void;
  disabled: boolean;
  badge?: BadgeTone;
}

type RemoteBadgeInput = {
  label: string;
  baseUrl: string | undefined;
  health: { reachable: boolean; server_name?: string; error?: string } | undefined;
};

/**
 * Reduces a remote source's `(connected? health?)` state into the tooltip
 * text and badge tone for its sidebar button. Shared by both Jellyfin and
 * Navidrome so the wording stays consistent and adding another remote
 * source costs one call instead of a new copy of the branch ladder.
 */
const remoteBadge = ({
  label,
  baseUrl,
  health,
}: RemoteBadgeInput): { tooltip: string; badge?: BadgeTone } => {
  if (!baseUrl) {
    return { tooltip: `Connect ${label}` };
  }
  const hostname = health?.server_name ?? baseUrl.replace(/^https?:\/\//, "");
  if (!health) {
    return { tooltip: `Checking ${hostname}…`, badge: "muted" };
  }
  if (health.reachable) {
    return { tooltip: `Connected to: ${hostname}`, badge: "ok" };
  }
  return {
    tooltip: health.error ? `Offline: ${hostname} — ${health.error}` : `Offline: ${hostname}`,
    badge: "warn",
  };
};

/**
 * Derives the ordered list of Library-cluster buttons (Jellyfin, Navidrome,
 * Folder, Rescan) along with their dynamic state — most notably the remote
 * connection badges + tooltips driven by their respective health hooks.
 * Centralising this keeps `FolderActions` focused on layout + focus
 * management.
 */
export const useSourceButtons = (): SourceButton[] => {
  const { setMode } = useDialog();
  const {
    selectFolder,
    rescan,
    rescanDisabled,
    isPending,
    hasSource,
    libraryPinned,
    jellyfinSource,
    navidromeSource,
    plexSource,
    jellyfinHealth,
    navidromeHealth,
    plexHealth,
    isFolderSource,
  } = useLibrarySourceActions();

  const jellyfin = useMemo(
    () =>
      remoteBadge({
        label: "Jellyfin",
        baseUrl: jellyfinSource?.base_url,
        health: jellyfinHealth,
      }),
    [jellyfinSource, jellyfinHealth],
  );

  const navidrome = useMemo(
    () =>
      remoteBadge({
        label: "Navidrome",
        baseUrl: navidromeSource?.base_url,
        health: navidromeHealth,
      }),
    [navidromeSource, navidromeHealth],
  );

  const plex = useMemo(
    () =>
      remoteBadge({
        label: "Plex",
        baseUrl: plexSource?.base_url,
        health: plexHealth,
      }),
    [plexSource, plexHealth],
  );

  return useMemo<SourceButton[]>(() => {
    // Operator pinned the library folder: source switching is disabled, only
    // the rescan action stays available.
    const buttons: SourceButton[] = libraryPinned
      ? []
      : [
          {
            key: "plex",
            icon: PlexIcon,
            label: "Connect Plex",
            tooltip: plex.tooltip,
            handler: () => setMode("plex-connect"),
            disabled: isPending,
            badge: plex.badge,
          },
          {
            key: "navidrome",
            icon: Disc3Icon,
            label: "Connect Navidrome",
            tooltip: navidrome.tooltip,
            handler: () => setMode("navidrome-connect"),
            disabled: isPending,
            badge: navidrome.badge,
          },
          {
            key: "jellyfin",
            icon: JellyfinIcon,
            label: "Connect Jellyfin",
            tooltip: jellyfin.tooltip,
            handler: () => setMode("jellyfin-connect"),
            disabled: isPending,
            badge: jellyfin.badge,
          },
          {
            key: "folder",
            icon: FolderIcon,
            label: "Select folder",
            tooltip: "Select folder",
            handler: selectFolder,
            disabled: isPending,
          },
        ];

    if (isFolderSource) {
      buttons.push({
        key: "youtube",
        icon: YoutubeIcon,
        label: "Import from YouTube",
        tooltip: "Import from YouTube",
        handler: () => setMode("youtube-import"),
        disabled: isPending,
      });
    }

    if (hasSource) {
      buttons.push({
        key: "rescan",
        icon: RefreshCwIcon,
        label: "Rescan library",
        tooltip: "Rescan library",
        handler: rescan,
        disabled: rescanDisabled,
      });
    }

    return buttons;
  }, [
    hasSource,
    libraryPinned,
    isPending,
    isFolderSource,
    jellyfin,
    navidrome,
    plex,
    rescan,
    rescanDisabled,
    selectFolder,
    setMode,
  ]);
};
