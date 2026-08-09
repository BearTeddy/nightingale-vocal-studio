import type { PracticeSession, SavePracticeSession } from "@/types/PracticeSession";
import type { RecordingRequest } from "@/types/RecordingRequest";
import type { RecordingTake } from "@/types/RecordingTake";
import type { TransportSegment } from "@/types/TransportSegment";
import type { VocalRecordingStatus } from "@/types/VocalRecordingStatus";
import { invoke } from "./runtime";

export const startVocalRecording = async (request: RecordingRequest): Promise<RecordingTake> =>
  await invoke<RecordingTake>("start_vocal_recording", { request });

export const pauseVocalRecording = async (): Promise<void> =>
  await invoke<void>("pause_vocal_recording");

export const resumeVocalRecording = async (): Promise<void> =>
  await invoke<void>("resume_vocal_recording");

export const stopVocalRecording = async (): Promise<RecordingTake | null> =>
  await invoke<RecordingTake | null>("stop_vocal_recording");

export const getVocalRecordingStatus = async (): Promise<VocalRecordingStatus> =>
  await invoke<VocalRecordingStatus>("get_vocal_recording_status");

export const exportRecording = async (
  takeId: string,
  latencyCompensationSec: number,
  vocalGain = 1,
  videoPath: string | null = null,
  transportSegments: TransportSegment[] = [],
): Promise<RecordingTake> =>
  await invoke<RecordingTake>("export_recording", {
    request: {
      take_id: takeId,
      latency_compensation_sec: latencyCompensationSec,
      vocal_gain: vocalGain,
      video_path: videoPath,
      transport_segments: transportSegments,
    },
  });

export const savePracticeSession = async (session: SavePracticeSession): Promise<void> =>
  await invoke<void>("save_practice_session", { session });

export const listPracticeSessions = async (profile: string | null): Promise<PracticeSession[]> =>
  await invoke<PracticeSession[]>("list_practice_sessions", { profile });

export const loadRecordingTake = async (id: string): Promise<RecordingTake | null> =>
  await invoke<RecordingTake | null>("load_recording_take", { id });
