import { MIC_RMS_GATE } from "@/lib/pitch/constants";
import { centsSimilarity } from "@/lib/pitch/state";
import type { PitchFrame } from "@/types/PitchFrame";

export type VocalSignalState = "idle" | "waiting" | "quiet" | "unclear" | "clipping" | "tracking";

export interface VocalFeedback {
  state: VocalSignalState;
  headline: string;
  instruction: string;
  cents: number | null;
  match: number | null;
  level: number;
  confidence: number;
}

function levelPercent(rms: number): number {
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.round(Math.max(0, Math.min(100, ((db + 60) / 60) * 100)));
}

export function createVocalFeedback(
  frame: PitchFrame | null,
  active: boolean,
  targetMidi: number | null,
): VocalFeedback {
  if (!active) {
    return {
      state: "idle",
      headline: "Microphone idle",
      instruction: "Waiting for the microphone to start.",
      cents: null,
      match: null,
      level: 0,
      confidence: 0,
    };
  }

  if (!frame) {
    return {
      state: "waiting",
      headline: "Starting microphone",
      instruction: "Waiting for the first audio samples.",
      cents: null,
      match: null,
      level: 0,
      confidence: 0,
    };
  }

  const level = levelPercent(frame.rms);
  const confidence = Math.round(Math.max(0, Math.min(1, frame.clarity)) * 100);
  const peak = frame.peak ?? frame.rms;

  if (peak >= 0.98 || frame.rms >= 0.7) {
    return {
      state: "clipping",
      headline: "Input clipping",
      instruction: "Move back or lower the microphone input level.",
      cents: null,
      match: null,
      level,
      confidence,
    };
  }

  if (frame.rms < MIC_RMS_GATE) {
    return {
      state: "quiet",
      headline: "Input too quiet",
      instruction: "Sing a little closer to the microphone.",
      cents: null,
      match: null,
      level,
      confidence,
    };
  }

  if (!frame.voiced || frame.midi == null) {
    return {
      state: "unclear",
      headline: "No steady pitch yet",
      instruction: "Hold one clear vowel such as ah for a moment.",
      cents: null,
      match: null,
      level,
      confidence,
    };
  }

  const referenceMidi = targetMidi ?? Math.round(frame.midi);
  const cents = Math.round((frame.midi - referenceMidi) * 100);
  const match = targetMidi == null ? null : Math.round(centsSimilarity(cents) * 100);

  if (targetMidi == null) {
    return {
      state: "tracking",
      headline: "Pitch detected",
      instruction:
        Math.abs(cents) <= 15
          ? "The note is centered and clear."
          : `The note is ${Math.abs(cents)} cents ${cents < 0 ? "flat" : "sharp"}.`,
      cents,
      match,
      level,
      confidence,
    };
  }

  if (Math.abs(cents) <= 25) {
    return {
      state: "tracking",
      headline: "On pitch",
      instruction: "Keep the note steady in the center.",
      cents,
      match,
      level,
      confidence,
    };
  }

  return {
    state: "tracking",
    headline: cents < 0 ? "Raise your pitch" : "Lower your pitch",
    instruction: `${Math.abs(cents)} cents ${cents < 0 ? "low" : "high"} from the target.`,
    cents,
    match,
    level,
    confidence,
  };
}
