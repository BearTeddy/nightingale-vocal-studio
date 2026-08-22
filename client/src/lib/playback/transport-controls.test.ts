import { describe, expect, it } from "vitest";
import { clampPlaybackTime, formatPlaybackTime, seekPlaybackBy } from "./transport-controls";

describe("playback transport controls", () => {
  it("clamps seeking to the song boundaries", () => {
    expect(clampPlaybackTime(-4, 120)).toBe(0);
    expect(clampPlaybackTime(42, 120)).toBe(42);
    expect(clampPlaybackTime(180, 120)).toBe(120);
  });

  it("handles invalid values without passing NaN to Web Audio", () => {
    expect(clampPlaybackTime(Number.NaN, 120)).toBe(0);
    expect(clampPlaybackTime(12, Number.NaN)).toBe(12);
    expect(clampPlaybackTime(12, 0)).toBe(12);
  });

  it("seeks by ten seconds in either direction", () => {
    expect(seekPlaybackBy(4, -10, 180)).toBe(0);
    expect(seekPlaybackBy(45, 10, 180)).toBe(55);
    expect(seekPlaybackBy(176, 10, 180)).toBe(180);
  });

  it("formats normal and long song durations", () => {
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(65.9)).toBe("1:05");
    expect(formatPlaybackTime(3661)).toBe("1:01:01");
  });
});
