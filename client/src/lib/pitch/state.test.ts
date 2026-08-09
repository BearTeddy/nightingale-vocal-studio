import { describe, expect, it } from "vitest";

import type { MelodyMap } from "@/types/MelodyMap";
import type { PitchFrame } from "@/types/PitchFrame";
import {
  centsSimilarity,
  displayedCentsOffset,
  freqToSemitone,
  MelodyPerformanceScoring,
  midiToFreq,
  pitchSimilarity,
  PitchStateBuffer,
  pushPitchSeriesFrame,
  sampleAudioBufferRms,
  scoreDynamics,
  scorePitchSeries,
  scoreTechnique,
  VisualPitchTracker,
} from "./state";

const frame = (midi: number): PitchFrame => ({
  hz: 440 * 2 ** ((midi - 69) / 12),
  midi,
  clarity: 1,
  rms: 0.1,
  voiced: true,
  sample_index: 0,
  sample_rate: 48_000,
  captured_at_ms: 0,
});

const melody = (eligible = true): MelodyMap => ({
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
      confidence: eligible ? 1 : 0.2,
      eligible,
      lyric_word_indices: [],
    },
  ],
});

describe("strict pitch scoring", () => {
  it("steadies ordinary input wobble in the visual tracker", () => {
    const tracker = new VisualPitchTracker();
    const rawMidi = [69, 69.25, 68.75, 69.2, 68.8, 69.1];
    const displayedMidi = rawMidi.map((midi) => freqToSemitone(tracker.update(midiToFreq(midi))!));
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);

    expect(spread(displayedMidi)).toBeLessThan(spread(rawMidi) * 0.4);
  });

  it("rejects an isolated octave jump but follows a sustained real leap", () => {
    const tracker = new VisualPitchTracker();
    tracker.update(midiToFreq(69));
    tracker.update(midiToFreq(69.05));
    const isolated = tracker.update(midiToFreq(81));
    expect(freqToSemitone(isolated!)).toBeLessThan(69.1);

    tracker.reset();
    tracker.update(midiToFreq(69));
    tracker.update(midiToFreq(69));
    tracker.update(midiToFreq(81));
    tracker.update(midiToFreq(81));
    const followed = tracker.update(midiToFreq(81));
    expect(freqToSemitone(followed!)).toBeGreaterThan(80.5);
  });

  it("bridges two missing input frames and then clears the visual pitch", () => {
    const tracker = new VisualPitchTracker();
    const detected = tracker.update(440);

    expect(tracker.update(null)).toBe(detected);
    expect(tracker.update(null)).toBe(detected);
    expect(tracker.update(null)).toBeNull();
  });

  it("does not let a duplicate microphone frame confirm an octave jump", () => {
    const buffer = new PitchStateBuffer();
    buffer.tryPush(440, midiToFreq(69), 1, 1, 100);
    buffer.tryPush(440, midiToFreq(81), 0, 1.03, 200);
    buffer.tryPush(440, midiToFreq(81), 0, 1.06, 200);
    buffer.tryPush(440, midiToFreq(69), 1, 1.09, 300);

    const displayed = buffer
      .snapshot()
      .userPitches.filter((pitch): pitch is number => pitch != null)
      .map(freqToSemitone);
    expect(Math.max(...displayed)).toBeLessThan(69.1);
  });

  it("reports displayed cents from the stable guide pitch", () => {
    expect(displayedCentsOffset(440, midiToFreq(69.24))).toBe(24);
    expect(displayedCentsOffset(440, null)).toBeNull();
  });

  it("awards full credit through 25 cents and none at 100 cents", () => {
    expect(centsSimilarity(25)).toBe(1);
    expect(centsSimilarity(-25)).toBe(1);
    expect(centsSimilarity(100)).toBe(0);
    expect(centsSimilarity(-100)).toBe(0);
  });

  it("does not fold an octave error onto the target", () => {
    expect(pitchSimilarity(440, 880)).toBe(0);

    const scoring = new MelodyPerformanceScoring(melody());
    scoring.accumulate(0.2, frame(81));
    expect(scoring.snapshot().categories.find((category) => category.key === "pitch")?.score).toBe(
      0,
    );
  });

  it("excludes low-confidence notes from the result", () => {
    const map = melody();
    map.notes.push({
      ...map.notes[0],
      id: "uncertain",
      start: 1,
      end: 2,
      confidence: 0.2,
      eligible: false,
    });
    const scoring = new MelodyPerformanceScoring(map);
    scoring.accumulate(0.2, frame(69));
    scoring.accumulate(1.2, null);
    expect(scoring.snapshot().phrase_accuracy).toBe(100);
  });

  it("leaves scoring unavailable when every note is uncertain", () => {
    const result = new MelodyPerformanceScoring(melody(false)).snapshot();
    expect(result.overall).toBe(0);
    expect(result.categories.every((category) => !category.available)).toBe(true);
  });

  it("penalizes silence and late entrances without inventing pitch credit", () => {
    const silent = new MelodyPerformanceScoring(melody());
    silent.accumulate(0.2, null);
    silent.accumulate(0.8, null);
    const silentResult = silent.snapshot();
    expect(silentResult.phrase_accuracy).toBe(0);
    expect(silentResult.phrases[0]?.accuracy).toBe(0);

    const onTime = new MelodyPerformanceScoring(melody());
    onTime.accumulate(0.05, frame(69));
    const late = new MelodyPerformanceScoring(melody());
    late.accumulate(0.75, frame(69));
    const timing = (result: ReturnType<MelodyPerformanceScoring["snapshot"]>) =>
      result.categories.find((category) => category.key === "timing")?.score ?? 0;
    expect(timing(late.snapshot())).toBeLessThan(timing(onTime.snapshot()));
  });

  it("penalizes partial-note silence and withholds unsupported categories", () => {
    const scoring = new MelodyPerformanceScoring(melody());
    scoring.accumulate(0.1, frame(69));
    scoring.accumulate(0.3, null);
    scoring.accumulate(0.5, null);
    scoring.accumulate(0.7, null);
    scoring.accumulate(0.9, null);
    const result = scoring.snapshot();
    const category = (key: string) => result.categories.find((item) => item.key === key);

    expect(category("pitch")?.score).toBe(20);
    expect(result.phrases[0]?.accuracy).toBe(20);
    expect(category("stability")?.available).toBe(false);
    expect(category("dynamics")?.available).toBe(false);
    expect(category("technique")?.available).toBe(false);
  });

  it("reports the current streak and breaks it after a missed note", () => {
    const map = melody();
    map.notes.push({ ...map.notes[0], id: "b4", start: 1.1, end: 2.1, midi: 71 });
    const scoring = new MelodyPerformanceScoring(map);

    scoring.accumulate(0.2, frame(69));
    scoring.accumulate(1.15, null);
    expect(scoring.snapshot().streak).toBe(1);

    scoring.accumulate(2.2, null);
    expect(scoring.snapshot().streak).toBe(0);
  });

  it("resets the live streak when playback seeks", () => {
    const map = melody();
    map.notes.push({ ...map.notes[0], id: "b4", start: 1.1, end: 2.1, midi: 71 });
    const scoring = new MelodyPerformanceScoring(map);

    scoring.accumulate(0.2, frame(69));
    scoring.accumulate(1.15, null);
    expect(scoring.snapshot().streak).toBe(1);

    scoring.accumulate(0.2, frame(69));
    expect(scoring.snapshot().streak).toBe(0);
  });

  it("resumes the live trace immediately after backward and forward seeks", () => {
    const buffer = new PitchStateBuffer();
    buffer.tryPush(440, 440, 1, 10);
    buffer.tryPush(466, 466, 1, 5);
    buffer.tryPush(494, 494, 1, 20);

    const snapshot = buffer.snapshot();
    expect(snapshot.userPitches[0]).toBeCloseTo(440);
    expect(snapshot.userPitches[1]).toBeNull();
    expect(snapshot.userPitches[2]).toBeCloseTo(466);
    expect(snapshot.userPitches[3]).toBeNull();
    expect(snapshot.userPitches[4]).toBeCloseTo(494);
    expect(snapshot.timestamps).toEqual([10, 5, 5, 20, 20]);
  });

  it("adds persisted trace breaks instead of drawing across seeks", () => {
    const series = {
      refPitches: [] as Array<number | null>,
      userPitches: [] as Array<number | null>,
      similarities: [] as number[],
      timestamps: [] as number[],
      frames: [] as Array<PitchFrame | null>,
      discontinuities: [] as boolean[],
    };
    const lastPush = { current: 0 };
    pushPitchSeriesFrame(series, lastPush, 440, 440, 1, 10, frame(69));
    pushPitchSeriesFrame(series, lastPush, 466, 466, 1, 5, frame(70));

    expect(series.userPitches).toEqual([440, null, 466]);
    expect(series.frames.map((item) => item?.midi ?? null)).toEqual([69, null, 70]);
    expect(series.timestamps).toEqual([10, 5, 5]);
    expect(series.discontinuities).toEqual([false, true, false]);
  });

  it("does not persist the same microphone window twice during normal playback", () => {
    const series = {
      refPitches: [] as Array<number | null>,
      userPitches: [] as Array<number | null>,
      similarities: [] as number[],
      timestamps: [] as number[],
      frames: [] as Array<PitchFrame | null>,
      discontinuities: [] as boolean[],
    };
    const lastPush = { current: 0 };
    const repeatedFrame = { ...frame(69), sample_index: 100 };

    pushPitchSeriesFrame(series, lastPush, 440, 440, 1, 0.1, repeatedFrame, 0);
    pushPitchSeriesFrame(series, lastPush, 440, 440, 1, 0.2, repeatedFrame, 0);

    expect(series.timestamps).toEqual([0.1]);
    expect(series.frames).toHaveLength(1);
  });

  it("persists the same microphone window again after a seek", () => {
    const series = {
      refPitches: [] as Array<number | null>,
      userPitches: [] as Array<number | null>,
      similarities: [] as number[],
      timestamps: [] as number[],
      frames: [] as Array<PitchFrame | null>,
      discontinuities: [] as boolean[],
    };
    const lastPush = { current: 0 };
    const repeatedFrame = { ...frame(69), sample_index: 100 };

    pushPitchSeriesFrame(series, lastPush, 440, 440, 1, 10, repeatedFrame, 0);
    pushPitchSeriesFrame(series, lastPush, 440, 440, 1, 5, repeatedFrame, 0);

    expect(series.userPitches).toEqual([440, null, 440]);
    expect(series.frames.map((item) => item?.sample_index ?? null)).toEqual([100, null, 100]);
    expect(series.timestamps).toEqual([10, 5, 5]);
    expect(series.discontinuities).toEqual([false, true, false]);
  });

  it("does not count persisted seek markers as silent singing", () => {
    const result = scorePitchSeries(melody(), {
      refPitches: [440, null, 440],
      userPitches: [440, null, 440],
      similarities: [1, 0, 1],
      timestamps: [0.2, 0.2, 0.4],
      frames: [frame(69), null, frame(69)],
      discontinuities: [false, true, false],
    });

    expect(result.phrase_accuracy).toBe(100);
  });

  it("re-scores persisted dense microphone frames against an edited map", () => {
    const result = scorePitchSeries(melody(), {
      refPitches: [440, 440],
      userPitches: [440, 440],
      similarities: [1, 1],
      timestamps: [0.1, 0.6],
      frames: [frame(69), frame(69)],
    });
    expect(result.categories.find((category) => category.key === "pitch")?.score).toBe(100);
    expect(result.phrases[0]?.accuracy).toBe(100);
  });

  it("scores a gain-independent dynamics contour against the vocal reference", () => {
    const reference = Array.from({ length: 30 }, (_, index) => 0.01 * 2 ** (index / 10));
    const matched = reference.map((referenceRms) => ({
      referenceRms,
      userRms: referenceRms * 0.35,
    }));
    const reversed = reference.map((referenceRms, index) => ({
      referenceRms,
      userRms: reference[reference.length - index - 1] * 0.35,
    }));

    expect(scoreDynamics(matched)).toBe(100);
    expect(scoreDynamics(reversed)).toBeLessThan(40);
    expect(
      scoreDynamics(Array.from({ length: 30 }, () => ({ referenceRms: 0.04, userRms: 0.02 }))),
    ).toBeNull();
  });

  it("exposes dynamics in the weighted performance result when the contour is measurable", () => {
    const scoring = new MelodyPerformanceScoring(melody());
    for (let index = 0; index < 30; index += 1) {
      const referenceRms = 0.01 * 2 ** (index / 10);
      scoring.accumulate(index / 30, {
        ...frame(69),
        rms: referenceRms * 0.4,
        reference_rms: referenceRms,
      });
    }

    const dynamics = scoring.snapshot().categories.find((category) => category.key === "dynamics");
    expect(dynamics).toMatchObject({ available: true, score: 100 });
  });

  it("scores technique from note-centered reference pitch movement", () => {
    const matched = Array.from({ length: 40 }, (_, index) => {
      const movement = Math.sin((index / 10) * Math.PI * 2) * 0.5;
      return {
        time: index / 50,
        referenceMidi: 69 + movement,
        userMidi: 71 + movement,
      };
    });
    const flat = matched.map((sample) => ({ ...sample, userMidi: 71 }));
    const straightReference = matched.map((sample) => ({ ...sample, referenceMidi: 69 }));

    expect(scoreTechnique([matched])).toBe(100);
    expect(scoreTechnique([flat])).toBeLessThan(10);
    expect(scoreTechnique([straightReference])).toBeNull();
  });

  it("exposes technique only when enough reference contour is measurable", () => {
    const scoring = new MelodyPerformanceScoring(melody());
    for (let index = 0; index < 40; index += 1) {
      const movement = Math.sin((index / 10) * Math.PI * 2) * 0.5;
      scoring.accumulate(index / 50, {
        ...frame(69 + movement),
        reference_midi: 69 + movement,
      });
    }

    expect(
      scoring.snapshot().categories.find((category) => category.key === "technique"),
    ).toMatchObject({ available: true, score: 100 });

    const unavailable = new MelodyPerformanceScoring(melody());
    for (let index = 0; index < 40; index += 1) unavailable.accumulate(index / 50, frame(69));
    expect(
      unavailable.snapshot().categories.find((category) => category.key === "technique"),
    ).toMatchObject({ available: false, score: 0 });
  });

  it("retains reference contour data when re-scoring a persisted take", () => {
    const frames = Array.from({ length: 40 }, (_, index) => {
      const movement = Math.sin((index / 10) * Math.PI * 2) * 0.5;
      return { ...frame(69 + movement), reference_midi: 69 + movement };
    });
    const result = scorePitchSeries(melody(), {
      refPitches: frames.map(() => 440),
      userPitches: frames.map((item) => item.hz),
      similarities: frames.map(() => 1),
      timestamps: frames.map((_, index) => index / 50),
      frames,
    });

    expect(result.categories.find((category) => category.key === "technique")).toMatchObject({
      available: true,
      score: 100,
    });
  });

  it("samples reference RMS without allocating an audio window", () => {
    const samples = new Float32Array([0, 1, -1, 0]);
    const buffer = {
      numberOfChannels: 1,
      sampleRate: 4,
      getChannelData: () => samples,
    } as unknown as AudioBuffer;

    expect(sampleAudioBufferRms(buffer, 0.5, 1)).toBeCloseTo(Math.sqrt(0.5));
    expect(sampleAudioBufferRms(null, 0)).toBeNull();
  });
});
