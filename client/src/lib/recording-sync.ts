import type { VocalRecordingStatus } from "@/types/VocalRecordingStatus";

export interface RecordingAttachmentPlan {
  reattached: boolean;
  sourceStart: number;
  recordedStart: number;
  resumeNativeRecorder: boolean;
}

export function planRecordingAttachment(
  before: VocalRecordingStatus,
  after: VocalRecordingStatus,
  playbackStart: number,
  currentPlayback: number,
): RecordingAttachmentPlan {
  if (!after.active || after.sample_rate <= 0) {
    throw new Error("The native vocal recorder did not start");
  }

  const reattached = before.active;
  return {
    reattached,
    sourceStart: reattached ? currentPlayback : playbackStart,
    recordedStart: reattached ? after.captured_samples / after.sample_rate : 0,
    resumeNativeRecorder: reattached && after.paused,
  };
}
