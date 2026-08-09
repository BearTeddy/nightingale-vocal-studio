import type { MicCaptureOptions } from "@/types/MicCaptureOptions";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { MicrophoneInfo } from "@/types/MicrophoneInfo";
import type { MicSampleFrame } from "@/types/MicSampleFrame";
import { Channel, invoke } from "./runtime";
import { dispatchMicFrame, type MicrophoneAdapter, subscribeMicSamples } from "./microphone";

/**
 * Serializes start/stop so React's stop-then-start on song change can't race
 * at the Tauri IPC layer (commands run on a worker pool and would otherwise
 * be free to reorder).
 */
let opChain: Promise<unknown> = Promise.resolve();
let activeChannel: object | null = null;

const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
  const next = opChain.catch(() => undefined).then(op);
  opChain = next;
  return next;
};

const listDevices = (): Promise<MicrophoneInfo[]> => invoke<MicrophoneInfo[]>("list_microphones");

const startCapture = (preferred: string | null, options: MicCaptureOptions): Promise<string> =>
  enqueue(async () => {
    /**
     * Always allocate a fresh Channel: when Rust drops the previous one in
     * `stop_mic_capture` it sends an `end` message that unregisters the JS
     * callback id. Reusing the cached Channel would hand Rust a dead id and
     * spam "Couldn't find callback id ..." for every frame.
     */
    const channel = new Channel<MicSampleFrame>();
    channel.onmessage = dispatchMicFrame;
    activeChannel = channel;
    try {
      return await invoke<string>("start_mic_capture", {
        preferred,
        options,
        onSamples: channel,
      });
    } catch (error) {
      if (activeChannel === channel) activeChannel = null;
      throw error;
    }
  });

const stopCapture = (): Promise<void> =>
  enqueue(async () => {
    await invoke("stop_mic_capture");
    activeChannel = null;
  });

const getCaptureStatus = (): Promise<MicCaptureStatus> =>
  invoke<MicCaptureStatus>("get_mic_capture_status");

const getLatestSamples = (): Promise<MicSampleFrame | null> =>
  invoke<MicSampleFrame | null>("get_latest_mic_samples");

export const tauriMicrophoneAdapter: MicrophoneAdapter = {
  listDevices,
  startCapture,
  stopCapture,
  onSamples: async (cb) => subscribeMicSamples(cb),
  getCaptureStatus,
  getLatestSamples,
};
