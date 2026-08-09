import { describe, expect, it } from "vitest";

import type { PracticeSession } from "@/types/PracticeSession";
import {
  latestVoiceProfileFromSessions,
  loadStoredVoiceProfile,
  mostRecentVoiceProfile,
  parseVoiceProfile,
  saveStoredVoiceProfile,
  voiceProfileStorageKey,
  type VoiceProfile,
} from "./voice-profile";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function profile(checkedAt = 100): VoiceProfile {
  return {
    lowMidi: 43,
    highMidi: 67,
    tessituraLowMidi: 48,
    tessituraHighMidi: 64,
    microphoneScore: 80,
    noiseFloorDb: -52,
    clippingPercent: 0,
    pitchMatchScore: 74,
    intervalMatchScore: 70,
    stabilityScore: 68,
    sustainScore: 76,
    rhythmScore: 72,
    recommendations: ["Practice one note."],
    checkedAt,
    assessmentComplete: true,
  };
}

function session(id: string, startedAt: number, payload: unknown): PracticeSession {
  return {
    id,
    profile: "Singer",
    song_hash: null,
    kind: "voice-checkup",
    started_at: startedAt,
    ended_at: startedAt + 30,
    performance_json: JSON.stringify(payload),
    recording_take_id: null,
    transport_segments: [],
  };
}

describe("voice profile persistence", () => {
  it("keeps storage isolated by Unicode profile name", () => {
    const storage = new MemoryStorage();
    const singer = profile();

    expect(saveStoredVoiceProfile("日本語", singer, storage)).toBe(true);
    expect(loadStoredVoiceProfile("日本語", storage)).toEqual(singer);
    expect(loadStoredVoiceProfile("Guest", storage)).toBeNull();
    expect(voiceProfileStorageKey("日本語")).toContain(encodeURIComponent("日本語"));
  });

  it("migrates the legacy global profile only to the first active singer", () => {
    const storage = new MemoryStorage();
    storage.setItem("nightingale.voice-profile", JSON.stringify(profile()));

    expect(loadStoredVoiceProfile("Singer", storage)?.lowMidi).toBe(43);
    expect(loadStoredVoiceProfile("Another singer", storage)).toBeNull();
  });

  it("restores the newest complete checkup from practice history", () => {
    const oldProfile = profile(1_000);
    const newestProfile = { ...profile(2_000), lowMidi: 40 };
    const sessions = [
      session("old", 1, oldProfile),
      session("new", 2, newestProfile),
      { ...session("exercise", 3, profile(3_000)), kind: "exercise:center" },
    ];

    expect(latestVoiceProfileFromSessions(sessions)?.lowMidi).toBe(40);
  });

  it("rejects malformed ranges and prefers a completed database assessment", () => {
    expect(parseVoiceProfile({ lowMidi: 72, highMidi: 48 })).toBeNull();
    const partial = parseVoiceProfile({ lowMidi: 48, highMidi: 72, checkedAt: 3_000 });
    const complete = profile(2_000);

    expect(partial?.assessmentComplete).toBe(false);
    expect(mostRecentVoiceProfile(partial, complete)).toEqual(complete);
  });
});
