import { describe, expect, it } from "vitest";
import type { PitchFrame } from "@/types/PitchFrame";
import {
  analyzeVocalCheckup,
  canCompleteVocalCheckup,
  checkupSessionDuration,
  checkupStageAt,
  checkupTargetAt,
  vocalCheckupScore,
  type CheckupFrame,
} from "./vocal-checkup";

function frame(midi: number | null, rms = 0.08): PitchFrame {
  return {
    hz: midi == null ? null : 440 * 2 ** ((midi - 69) / 12),
    midi,
    clarity: midi == null ? 0 : 0.95,
    rms,
    peak: rms * 2,
    voiced: midi != null,
    sample_index: 0,
    sample_rate: 48_000,
    captured_at_ms: 0,
  };
}

describe("vocal checkup", () => {
  it("stores the actual elapsed checkup duration within valid bounds", () => {
    expect(checkupSessionDuration(12.2)).toBe(13);
    expect(checkupSessionDuration(0)).toBe(1);
    expect(checkupSessionDuration(35)).toBe(30);
    expect(checkupSessionDuration(Number.NaN)).toBe(30);
  });

  it("does not complete before every guided measurement stage has run", () => {
    expect(canCompleteVocalCheckup(28.99)).toBe(false);
    expect(canCompleteVocalCheckup(29)).toBe(true);
    expect(canCompleteVocalCheckup(Number.NaN)).toBe(false);
  });

  it("reports a transparent composite across all measured checkup skills", () => {
    expect(
      vocalCheckupScore({
        microphoneScore: 90,
        pitchMatchScore: 80,
        intervalMatchScore: 70,
        stabilityScore: 60,
        sustainScore: 50,
        rhythmScore: 40,
      }),
    ).toBe(65);
  });

  it("defines every guided stage and pitch target", () => {
    expect(checkupStageAt(1, 60).label).toBe("Room and microphone");
    expect(checkupStageAt(5, 60).label).toBe("Comfortable range");
    expect(checkupTargetAt(11.5, 60)).toBe(60);
    expect(checkupTargetAt(13.5, 60)).toBe(64);
    expect(checkupTargetAt(15.5, 60)).toBe(67);
    expect(checkupStageAt(25, 60).label).toBe("Rhythm");
  });

  it("produces range, quality, pitch, sustain, and rhythm metrics", () => {
    const samples: CheckupFrame[] = [];
    for (let time = 0; time < 30; time += 0.05) {
      let midi: number | null = null;
      let rms = 0.002;
      if (time >= 3 && time < 11) {
        midi = 55 + ((time - 3) / 8) * 14;
        rms = 0.08;
      } else if (time >= 11 && time < 17) {
        const cueStart = 11 + Math.floor((time - 11) / 2) * 2;
        if (time - cueStart >= 0.75) {
          midi = checkupTargetAt(time, 60);
          rms = 0.08;
        }
      } else if (time >= 17.85 && time < 23) {
        midi = 60;
        rms = 0.08;
      } else if (time >= 23 && time < 29) {
        const phase = (time - 23.25) % 0.75;
        if (phase >= 0.2 && phase < 0.4) {
          midi = 60;
          rms = 0.08;
        }
      }
      samples.push({ elapsed_sec: time, frame: frame(midi, rms) });
    }
    const result = analyzeVocalCheckup(samples, 60, 123);
    expect(result).not.toBeNull();
    expect(result?.microphoneScore).toBeGreaterThan(80);
    expect(result?.pitchMatchScore).toBe(100);
    expect(result?.stabilityScore).toBe(100);
    expect(result?.sustainScore).toBe(100);
    expect(result?.rhythmScore).toBeGreaterThan(80);
    expect(result?.lowMidi).toBeLessThan(result?.highMidi ?? 0);
    expect(result?.checkedAt).toBe(123);
  });

  it("does not score reference-tone bleed as the singer", () => {
    const samples: CheckupFrame[] = [];
    for (let time = 0; time < 30; time += 0.05) {
      let midi: number | null = null;
      let rms = 0.002;
      if (time >= 3 && time < 11) {
        midi = 55 + ((time - 3) / 8) * 14;
        rms = 0.08;
      } else if (time >= 11 && time < 17) {
        const cueStart = 11 + Math.floor((time - 11) / 2) * 2;
        if (time - cueStart < 0.65) {
          midi = checkupTargetAt(time, 60);
          rms = 0.08;
        }
      } else if (time >= 17 && time < 17.75) {
        midi = 60;
        rms = 0.08;
      } else if (time >= 23 && time < 29) {
        const phase = (time - 23.25) % 0.75;
        if (phase >= 0 && phase < 0.12) {
          midi = 60;
          rms = 0.08;
        }
      }
      samples.push({ elapsed_sec: time, frame: frame(midi, rms) });
    }

    const result = analyzeVocalCheckup(samples, 60, 123);
    expect(result).not.toBeNull();
    expect(result?.pitchMatchScore).toBe(0);
    expect(result?.intervalMatchScore).toBe(0);
    expect(result?.sustainScore).toBe(0);
    expect(result?.rhythmScore).toBe(0);
  });

  it("keeps isolated octave tracking errors from erasing stability", () => {
    const samples: CheckupFrame[] = [];
    for (let time = 0; time < 30; time += 0.05) {
      let midi: number | null = null;
      let rms = 0.002;
      if (time >= 3 && time < 11) {
        midi = 55 + ((time - 3) / 8) * 14;
        rms = 0.08;
      } else if (time >= 17.85 && time < 23) {
        const isTrackingJump = Math.abs(time - Math.round(time)) < 0.03;
        midi = isTrackingJump ? 72 : 60;
        rms = 0.08;
      }
      samples.push({ elapsed_sec: time, frame: frame(midi, rms) });
    }

    const result = analyzeVocalCheckup(samples, 60, 123);
    expect(result).not.toBeNull();
    expect(result?.stabilityScore).toBeGreaterThan(90);
  });
});
