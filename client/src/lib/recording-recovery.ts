export function canRecoverRecordingMix(
  sessionKind: string,
  songHash: string | null,
  vocalPath: string | null | undefined,
  mixPath: string | null | undefined,
): boolean {
  return (
    (sessionKind === "karaoke" || sessionKind === "recovered-recording") &&
    Boolean(songHash && vocalPath && !mixPath)
  );
}

export function shouldAutoExportRecording(status: string): boolean {
  return status === "recorded";
}

export interface RecordingTakeNotice {
  label: string;
  tone: "warning" | "error";
}

export function recordingTakeNotice(
  status: string,
  mixPath: string | null | undefined,
  error: string | null | undefined,
): RecordingTakeNotice | null {
  if (status === "failed") {
    return { label: error ?? "Recording incomplete", tone: "error" };
  }
  if (status === "recovered") {
    return { label: error ?? "Recovered after interruption", tone: "warning" };
  }
  if (status === "recorded" && !mixPath) {
    return { label: error ?? "Vocal saved, mix not created", tone: "warning" };
  }
  return error ? { label: error, tone: "warning" } : null;
}
