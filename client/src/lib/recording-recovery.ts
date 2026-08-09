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
