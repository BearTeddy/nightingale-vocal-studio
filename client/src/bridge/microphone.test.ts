import { describe, expect, it, vi } from "vitest";

import type { NativePitchFrame } from "@/types/NativePitchFrame";
import { dispatchNativePitchFrame, subscribeNativePitch } from "./microphone";

const pitchFrame = (sampleIndex: number): NativePitchFrame => ({
  hz: 220,
  midi: 57,
  clarity: 0.98,
  rms: 0.1,
  peak: 0.2,
  voiced: true,
  sample_index: sampleIndex,
  sample_rate: 48_000,
  captured_at_ms: (sampleIndex / 48_000) * 1_000,
});

describe("native microphone pitch dispatch", () => {
  it("fans out frames and removes stopped subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeNativePitch(first);
    const stopSecond = subscribeNativePitch(second);

    dispatchNativePitchFrame(pitchFrame(2_048));
    stopFirst();
    dispatchNativePitchFrame(pitchFrame(3_584));
    stopSecond();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(second.mock.calls[1]?.[0].sample_index).toBe(3_584);
  });

  it("keeps delivering when another subscriber throws", () => {
    const throwing = () => {
      throw new Error("subscriber failed");
    };
    const healthy = vi.fn();
    const stopThrowing = subscribeNativePitch(throwing);
    const stopHealthy = subscribeNativePitch(healthy);

    expect(() => dispatchNativePitchFrame(pitchFrame(2_048))).not.toThrow();
    stopThrowing();
    stopHealthy();

    expect(healthy).toHaveBeenCalledOnce();
  });
});
