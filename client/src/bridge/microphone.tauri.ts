import type { MicCaptureOptions } from "@/types/MicCaptureOptions";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { MicrophoneInfo } from "@/types/MicrophoneInfo";
import type { MicSampleFrame } from "@/types/MicSampleFrame";
import type { NativePitchFrame } from "@/types/NativePitchFrame";
import { Channel, invoke } from "./runtime";
import {
  dispatchMicFrame,
  dispatchNativePitchFrame,
  type MicrophoneAdapter,
  subscribeMicSamples,
  subscribeNativePitch,
} from "./microphone";

/**
 * Serializes start/stop so React's stop-then-start on song change can't race
 * at the Tauri IPC layer (commands run on a worker pool and would otherwise
 * be free to reorder).
 */
let opChain: Promise<unknown> = Promise.resolve();
let activeChannels: { samples: object; pitch: object } | null = null;

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
    const sampleChannel = new Channel<MicSampleFrame>();
    const pitchChannel = new Channel<NativePitchFrame>();
    sampleChannel.onmessage = dispatchMicFrame;
    pitchChannel.onmessage = dispatchNativePitchFrame;
    const channels = { samples: sampleChannel, pitch: pitchChannel };
    activeChannels = channels;
    try {
      return await invoke<string>("start_mic_capture", {
        preferred,
        options,
        onSamples: sampleChannel,
        onPitch: pitchChannel,
      });
    } catch (error) {
      if (activeChannels === channels) activeChannels = null;
      throw error;
    }
  });

const stopCapture = (): Promise<void> =>
  enqueue(async () => {
    await invoke("stop_mic_capture");
    activeChannels = null;
  });

const setMonitorEnabled = (enabled: boolean): Promise<void> =>
  enqueue(() => invoke<void>("set_monitor_enabled", { enabled }));

const getCaptureStatus = (): Promise<MicCaptureStatus> =>
  invoke<MicCaptureStatus>("get_mic_capture_status");

const getLatestSamples = (): Promise<MicSampleFrame | null> =>
  invoke<MicSampleFrame | null>("get_latest_mic_samples");

export const tauriMicrophoneAdapter: MicrophoneAdapter = {
  listDevices,
  startCapture,
  stopCapture,
  setMonitorEnabled,
  onSamples: async (cb) => subscribeMicSamples(cb),
  onPitch: async (cb) => subscribeNativePitch(cb),
  getCaptureStatus,
  getLatestSamples,
};
