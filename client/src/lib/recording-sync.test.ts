import { describe, expect, it } from "vitest";

import type { VocalRecordingStatus } from "@/types/VocalRecordingStatus";
import { planRecordingAttachment } from "./recording-sync";

const status = (overrides: Partial<VocalRecordingStatus> = {}): VocalRecordingStatus => ({
  active: false,
  paused: false,
  sample_rate: 48_000,
  captured_samples: 0,
  overrun: false,
  error: null,
  ...overrides,
});

describe("recording attachment", () => {
  it("starts a new take at the original playback position", () => {
    expect(
      planRecordingAttachment(
        status(),
        status({ active: true, captured_samples: 4_800 }),
        12.5,
        12.6,
      ),
    ).toEqual({
      reattached: false,
      sourceStart: 12.5,
      recordedStart: 0,
      resumeNativeRecorder: false,
    });
  });

  it("resumes a paused native take and anchors a fresh transport segment", () => {
    expect(
      planRecordingAttachment(
        status({ active: true, paused: true, captured_samples: 96_000 }),
        status({ active: true, paused: true, captured_samples: 96_000 }),
        12.5,
        81.25,
      ),
    ).toEqual({
      reattached: true,
      sourceStart: 81.25,
      recordedStart: 2,
      resumeNativeRecorder: true,
    });
  });

  it("rejects a recorder that failed to become active", () => {
    expect(() => planRecordingAttachment(status(), status(), 0, 0)).toThrow(
      "native vocal recorder did not start",
    );
  });
});
