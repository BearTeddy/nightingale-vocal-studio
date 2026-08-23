import type { MicCaptureOptions } from "@/types/MicCaptureOptions";
import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import type { MicrophoneInfo } from "@/types/MicrophoneInfo";
import type { MicSampleFrame } from "@/types/MicSampleFrame";
import type { NativePitchFrame } from "@/types/NativePitchFrame";

export type { MicCaptureOptions, MicSampleFrame, NativePitchFrame };

export type MicSamplesCallback = (frame: MicSampleFrame) => void;
export type NativePitchCallback = (frame: NativePitchFrame) => void;
export type StopListening = () => void;

export interface MicrophoneAdapter {
  listDevices(): Promise<MicrophoneInfo[]>;
  startCapture(preferred: string | null, options: MicCaptureOptions): Promise<string>;
  stopCapture(): Promise<void>;
  setMonitorEnabled?(enabled: boolean): Promise<void>;
  setMonitorGain?(gain: number): Promise<void>;
  onSamples(cb: MicSamplesCallback): Promise<StopListening>;
  onPitch?(cb: NativePitchCallback): Promise<StopListening>;
  getCaptureStatus?(): Promise<MicCaptureStatus>;
  getLatestSamples?(): Promise<MicSampleFrame | null>;
}

const subscribers = new Set<MicSamplesCallback>();
const pitchSubscribers = new Set<NativePitchCallback>();

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

export const dispatchNativePitchFrame = (frame: NativePitchFrame): void => {
  for (const cb of pitchSubscribers) {
    try {
      cb(frame);
    } catch {
      // Subscribers must not break the dispatch loop.
    }
  }
};

export const subscribeNativePitch = (cb: NativePitchCallback): StopListening => {
  pitchSubscribers.add(cb);
  return () => {
    pitchSubscribers.delete(cb);
  };
};

import { isTauri } from "./runtime";
import { tauriMicrophoneAdapter } from "./microphone.tauri";
import {
  setWebMicMonitorGain,
  setWebMicMonitorEnabled,
  webMicrophoneAdapter,
} from "./microphone.web";

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

/** Changes karaoke voice volume immediately without restarting mic capture. */
export const updateMicMonitorGain = (value: number): Promise<void> => {
  if (isTauri) return tauriMicrophoneAdapter.setMonitorGain?.(value) ?? Promise.resolve();
  setWebMicMonitorGain(value);
  return Promise.resolve();
};

/** Changes sidetone without restarting capture, so pitch scoring stays live. */
export const updateMicMonitorEnabled = (enabled: boolean): Promise<void> => {
  if (isTauri) return tauriMicrophoneAdapter.setMonitorEnabled?.(enabled) ?? Promise.resolve();
  return setWebMicMonitorEnabled(enabled);
};
