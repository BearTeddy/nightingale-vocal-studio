export type RecordingPreviewDecision = "start" | "pause" | "resume";

export function recordingPreviewDecision(
  activePath: string | null,
  playing: boolean,
  requestedPath: string,
): RecordingPreviewDecision {
  if (activePath !== requestedPath) return "start";
  return playing ? "pause" : "resume";
}

export function clampRecordingPreviewTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(duration, time));
}

export function formatRecordingPreviewTime(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
