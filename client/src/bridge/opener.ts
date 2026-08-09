import {
  openPath as tauriOpenPath,
  openUrl as tauriOpenUrl,
  revealItemInDir as tauriRevealItemInDir,
} from "@tauri-apps/plugin-opener";
import { isTauri } from "./runtime";

export const openUrl = async (url: string): Promise<void> => {
  if (isTauri) {
    await tauriOpenUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
};

export const revealItemInDir = async (path: string): Promise<void> => {
  if (!isTauri) return;
  await tauriRevealItemInDir(path);
};

export const openMediaPath = async (path: string): Promise<void> => {
  if (!isTauri) return;
  await tauriOpenPath(path);
};
