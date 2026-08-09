import type { MicCaptureOptions } from "@/types/MicCaptureOptions";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { MicrophoneInfo } from "@/types/MicrophoneInfo";
import type { MicSampleFrame } from "@/types/MicSampleFrame";

export type { MicCaptureOptions, MicSampleFrame };

export type MicSamplesCallback = (frame: MicSampleFrame) => void;
export type StopListening = () => void;

export interface MicrophoneAdapter {
  listDevices(): Promise<MicrophoneInfo[]>;
  startCapture(preferred: string | null, options: MicCaptureOptions): Promise<string>;
  stopCapture(): Promise<void>;
  onSamples(cb: MicSamplesCallback): Promise<StopListening>;
  getCaptureStatus?(): Promise<MicCaptureStatus>;
  getLatestSamples?(): Promise<MicSampleFrame | null>;
}

const subscribers = new Set<MicSamplesCallback>();

/**
 * Backend implementations push every PCM frame through this single dispatch
 * so that the subscriber set is shared regardless of whether mic capture
 * originates from Tauri's `cpal` thread or a browser `AudioWorklet`.
 */
export const dispatchMicFrame = (frame: MicSampleFrame): void => {
  for (const cb of subscribers) {
    try {
      cb(frame);
    } catch {
      // Subscribers must not break the dispatch loop.
    }
  }
};

export const subscribeMicSamples = (cb: MicSamplesCallback): StopListening => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

import { isTauri } from "./runtime";
import { tauriMicrophoneAdapter } from "./microphone.tauri";
import { setWebMicMonitorGain, webMicrophoneAdapter } from "./microphone.web";

export { tauriMicrophoneAdapter, webMicrophoneAdapter };

export const microphoneAdapter: MicrophoneAdapter = isTauri
  ? tauriMicrophoneAdapter
  : webMicrophoneAdapter;

export const listMicrophones = (): Promise<MicrophoneInfo[]> => microphoneAdapter.listDevices();

export const startMicCapture = (
  preferred: string | null,
  options: MicCaptureOptions,
): Promise<string> => microphoneAdapter.startCapture(preferred, options);

export const stopMicCapture = (): Promise<void> => microphoneAdapter.stopCapture();

/**
 * Pushes a new monitor gain to the active web capture. In Tauri the same value
 * is applied server-side from `save_config` via `set_monitor_gain`, so this
 * call is a no-op in that build.
 */
export const updateMicMonitorGain = (value: number): void => {
  if (isTauri) return;
  setWebMicMonitorGain(value);
};
