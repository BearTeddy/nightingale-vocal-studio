import { describe, expect, it } from "vitest";
import {
  clampRecordingPreviewTime,
  formatRecordingPreviewTime,
  recordingPreviewDecision,
} from "./recording-preview";

describe("recording preview", () => {
  it("starts a new file and toggles the active file", () => {
    expect(recordingPreviewDecision(null, false, "vocal.wav")).toBe("start");
    expect(recordingPreviewDecision("vocal.wav", true, "vocal.wav")).toBe("pause");
    expect(recordingPreviewDecision("vocal.wav", false, "vocal.wav")).toBe("resume");
    expect(recordingPreviewDecision("vocal.wav", true, "mix.m4a")).toBe("start");
  });

  it("clamps seeking and formats stable transport times", () => {
    expect(clampRecordingPreviewTime(-5, 120)).toBe(0);
    expect(clampRecordingPreviewTime(150, 120)).toBe(120);
    expect(clampRecordingPreviewTime(42.5, 120)).toBe(42.5);
    expect(formatRecordingPreviewTime(0)).toBe("0:00");
    expect(formatRecordingPreviewTime(125.9)).toBe("2:05");
  });
});
