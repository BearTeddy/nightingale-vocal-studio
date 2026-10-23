import { describe, expect, it } from "vitest";
import { multiplayerSetupError } from "./multiplayer";
import type { MultiplayerPlayer } from "@/types/MultiplayerPlayer";
import { MelodyPerformanceScoring } from "./pitch/state";
import type { MelodyMap } from "@/types/MelodyMap";

const player = (
  id: string,
  microphone = "USB",
  channel: number | null = null,
): MultiplayerPlayer => ({ id, profile: id, microphone, channel, color: "#67e8f9" });

describe("local multiplayer", () => {
  it("allows distinct microphones and separate channels on one interface", () => {
    expect(multiplayerSetupError([player("a"), player("b", "other")])).toBeNull();
    expect(multiplayerSetupError([player("a", "USB", 0), player("b", "USB", 1)])).toBeNull();
  });
  it("rejects shared input, duplicate profiles, disconnected and invalid channels", () => {
    expect(multiplayerSetupError([player("a"), player("b")])).toContain("different microphone");
    expect(multiplayerSetupError([player("a"), player("a", "other")])).toContain("different name");
    expect(multiplayerSetupError([player("a"), player("b", "other")], [])).toContain("reconnect");
    expect(multiplayerSetupError([player("a", "USB", -1), player("b", "USB", 1)])).toContain(
      "available channel",
    );
    expect(multiplayerSetupError([player("a", "USB", null), player("b", "USB", 1)])).toContain(
      "different microphone",
    );
  });
  it("does not copy the lead singer's pitches or score to other singers", () => {
    const melody: MelodyMap = {
      version: 1,
      source: "fixture",
      hop_ms: 10,
      confidence: 1,
      strict_scoring_available: true,
      fallback_reason: null,
      notes: [
        {
          id: "a4",
          start: 0,
          end: 1,
          midi: 69,
          cents: 0,
          confidence: 1,
          eligible: true,
          lyric_word_indices: [],
        },
      ],
    };
    const first = new MelodyPerformanceScoring(melody);
    const second = new MelodyPerformanceScoring(melody);
    const silent = new MelodyPerformanceScoring(melody);
    const frame = {
      hz: 440,
      midi: 69,
      clarity: 1,
      rms: 0.2,
      voiced: true,
      sample_index: 512,
      sample_rate: 48000,
      captured_at_ms: 0,
    };
    first.accumulate(0.1, frame);
    second.accumulate(0.1, { ...frame, hz: 466.16, midi: 70 });
    silent.accumulate(0.1, null);
    expect(first.snapshot().phrase_accuracy).toBe(100);
    expect(second.snapshot().phrase_accuracy).toBe(0);
    expect(silent.snapshot().phrases).toHaveLength(0);
    first.setPitchToleranceFactor(2);
    second.setPitchToleranceFactor(2);
    expect(second.snapshot().phrase_accuracy).toBeLessThan(first.snapshot().phrase_accuracy);
  });
});
