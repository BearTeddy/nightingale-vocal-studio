import type { VocalCheckupResult } from "@/lib/vocal-checkup";
import type { PracticeSession } from "@/types/PracticeSession";

export type VoiceProfile = VocalCheckupResult & { assessmentComplete: boolean };

interface ProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LEGACY_STORAGE_KEY = "nightingale.voice-profile";
const MIGRATION_STORAGE_KEY = "nightingale.voice-profile.v2-migrated";
const CHECKUP_SCORE_KEYS = [
  "microphoneScore",
  "pitchMatchScore",
  "intervalMatchScore",
  "stabilityScore",
  "sustainScore",
  "rhythmScore",
] as const satisfies ReadonlyArray<keyof VocalCheckupResult>;

function browserStorage(): ProfileStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

export function voiceProfileStorageKey(profile: string): string {
  return `nightingale.voice-profile.v2:${encodeURIComponent(profile.trim() || "Guest")}`;
}

export function parseVoiceProfile(payload: unknown, fallbackCheckedAt = 0): VoiceProfile | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const lowMidi = finiteNumber(value.lowMidi, Number.NaN);
  const highMidi = finiteNumber(value.highMidi, Number.NaN);
  if (!Number.isFinite(lowMidi) || !Number.isFinite(highMidi) || lowMidi > highMidi) return null;

  const tessituraLowMidi = clamp(finiteNumber(value.tessituraLowMidi, lowMidi), lowMidi, highMidi);
  const tessituraHighMidi = clamp(
    finiteNumber(value.tessituraHighMidi, highMidi),
    tessituraLowMidi,
    highMidi,
  );
  const assessmentComplete = CHECKUP_SCORE_KEYS.every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
  const recommendations = Array.isArray(value.recommendations)
    ? value.recommendations.filter(
        (recommendation): recommendation is string =>
          typeof recommendation === "string" && recommendation.trim().length > 0,
      )
    : [];

  return {
    lowMidi,
    highMidi,
    tessituraLowMidi,
    tessituraHighMidi,
    microphoneScore: finiteNumber(value.microphoneScore, 0),
    noiseFloorDb: finiteNumber(value.noiseFloorDb, 0),
    clippingPercent: finiteNumber(value.clippingPercent, 0),
    pitchMatchScore: finiteNumber(value.pitchMatchScore, 0),
    intervalMatchScore: finiteNumber(value.intervalMatchScore, 0),
    stabilityScore: finiteNumber(value.stabilityScore, 0),
    sustainScore: finiteNumber(value.sustainScore, 0),
    rhythmScore: finiteNumber(value.rhythmScore, 0),
    recommendations,
    checkedAt: finiteNumber(value.checkedAt, fallbackCheckedAt),
    assessmentComplete,
  };
}

function parseStored(raw: string | null): VoiceProfile | null {
  if (!raw) return null;
  try {
    return parseVoiceProfile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveStoredVoiceProfile(
  profile: string,
  voiceProfile: VoiceProfile,
  storage: ProfileStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(voiceProfileStorageKey(profile), JSON.stringify(voiceProfile));
    return true;
  } catch {
    return false;
  }
}

export function loadStoredVoiceProfile(
  profile: string,
  storage: ProfileStorage | null = browserStorage(),
): VoiceProfile | null {
  if (!storage) return null;
  try {
    const stored = parseStored(storage.getItem(voiceProfileStorageKey(profile)));
    if (stored) return stored;

    if (storage.getItem(MIGRATION_STORAGE_KEY) != null) return null;
    const legacy = parseStored(storage.getItem(LEGACY_STORAGE_KEY));
    storage.setItem(MIGRATION_STORAGE_KEY, profile);
    if (legacy) saveStoredVoiceProfile(profile, legacy, storage);
    return legacy;
  } catch {
    return null;
  }
}

export function latestVoiceProfileFromSessions(
  sessions: readonly PracticeSession[],
): VoiceProfile | null {
  let latest: VoiceProfile | null = null;
  for (const session of sessions) {
    if (session.kind !== "voice-checkup" || !session.performance_json) continue;
    try {
      const parsed = parseVoiceProfile(
        JSON.parse(session.performance_json),
        session.started_at * 1000,
      );
      if (!parsed?.assessmentComplete) continue;
      if (!latest || parsed.checkedAt > latest.checkedAt) latest = parsed;
    } catch {
      // Corrupt legacy sessions remain in History but cannot restore a range.
    }
  }
  return latest;
}

export function mostRecentVoiceProfile(
  first: VoiceProfile | null,
  second: VoiceProfile | null,
): VoiceProfile | null {
  if (!first) return second;
  if (!second) return first;
  if (first.assessmentComplete !== second.assessmentComplete) {
    return first.assessmentComplete ? first : second;
  }
  return second.checkedAt > first.checkedAt ? second : first;
}
