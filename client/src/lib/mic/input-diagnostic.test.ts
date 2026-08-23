import { describe, expect, it } from "vitest";

import type { MicCaptureStatus } from "@/types/MicCaptureStatus";
import { amplitudeDb, diagnoseMicInput } from "./input-diagnostic";

const status = (overrides: Partial<MicCaptureStatus> = {}): MicCaptureStatus => ({
  running: true,
  channel_attached: true,
  sample_rate: 48_000,
  input_samples: 48_000,
  sent_frames: 93,
  send_errors: 0,
  pitch_frames: 30,
  pitch_errors: 0,
  rms: 0.05,
  peak: 0.2,
  monitor_requested: false,
  monitor_available: false,
  monitor_active: false,
  monitor_input_sample_rate: 48_000,
  monitor_output_sample_rate: 48_000,
  monitor_buffered_frames: 0,
  monitor_target_frames: 384,
  monitor_underruns: 0,
  monitor_overruns: 0,
  monitor_estimated_latency_ms: 0,
  monitor_mode: "low_latency",
  ...overrides,
});

describe("microphone input diagnostic", () => {
  it("distinguishes an opened device from samples reaching the UI", () => {
    expect(diagnoseMicInput(null, false).state).toBe("offline");
    expect(diagnoseMicInput(null, true).state).toBe("starting");
    expect(diagnoseMicInput(status({ input_samples: 0 }), true).state).toBe("no-samples");
    expect(diagnoseMicInput(status({ channel_attached: false }), true).state).toBe("error");
  });

  it("reports silent, weak, live, clipping, and dropped-frame signals", () => {
    expect(diagnoseMicInput(status({ rms: 0.001 }), true).state).toBe("silent");
    expect(diagnoseMicInput(status({ rms: 0.006 }), true).state).toBe("weak");
    expect(diagnoseMicInput(status(), true).state).toBe("live");
    expect(diagnoseMicInput(status({ peak: 0.99 }), true).state).toBe("clipping");
    expect(diagnoseMicInput(status({ send_errors: 1 }), true).state).toBe("error");
    expect(diagnoseMicInput(status({ pitch_errors: 1 }), true).state).toBe("error");
  });

  it("formats amplitude as decibels without inventing a floor", () => {
    expect(amplitudeDb(0.1)).toBe(-20);
    expect(amplitudeDb(0)).toBeNull();
  });
});
