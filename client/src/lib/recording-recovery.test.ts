import { describe, expect, it } from "vitest";
import {
  canRecoverRecordingMix,
  recordingTakeNotice,
  shouldAutoExportRecording,
} from "./recording-recovery";

describe("recording mix recovery", () => {
  it("offers recovery for interrupted karaoke and recovered song vocals", () => {
    expect(canRecoverRecordingMix("karaoke", "song-hash", "vocal.wav", null)).toBe(true);
    expect(canRecoverRecordingMix("recovered-recording", "song-hash", "vocal.wav", null)).toBe(
      true,
    );
  });

  it("does not offer a song mix for exercises, missing vocals, or completed mixes", () => {
    expect(canRecoverRecordingMix("exercise:center", "exercise-center", "vocal.wav", null)).toBe(
      false,
    );
    expect(canRecoverRecordingMix("karaoke", "song-hash", null, null)).toBe(false);
    expect(canRecoverRecordingMix("karaoke", "song-hash", "vocal.wav", "mix.m4a")).toBe(false);
  });

  it("automatically exports only a cleanly finalized recording", () => {
    expect(shouldAutoExportRecording("recorded")).toBe(true);
    expect(shouldAutoExportRecording("failed")).toBe(false);
    expect(shouldAutoExportRecording("recording")).toBe(false);
  });

  it("surfaces actionable interrupted-export messages", () => {
    expect(
      recordingTakeNotice("recorded", null, "Previous mix export was interrupted."),
    ).toEqual({
      label: "Previous mix export was interrupted.",
      tone: "warning",
    });
    expect(recordingTakeNotice("failed", null, "Disk full")).toEqual({
      label: "Disk full",
      tone: "error",
    });
    expect(recordingTakeNotice("ready", "mix.m4a", null)).toBeNull();
  });
});
