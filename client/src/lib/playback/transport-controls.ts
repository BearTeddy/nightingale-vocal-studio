export const PLAYBACK_SEEK_STEP_SECONDS = 10;
export const PLAYBACK_CONTROLS_TOGGLE_EVENT = "nightingale:toggle-playback-controls";

export function clampPlaybackTime(time: number, duration: number): number {
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;

  if (!Number.isFinite(duration) || duration <= 0) {
    return safeTime;
  }

  return Math.min(safeTime, duration);
}

export function seekPlaybackBy(currentTime: number, delta: number, duration: number): number {
  return clampPlaybackTime(currentTime + delta, duration);
}

export function formatPlaybackTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds
      .toString()
      .padStart(2, "0")}`;
  }

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
