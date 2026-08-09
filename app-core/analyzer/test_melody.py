from __future__ import annotations

import json
import math
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

import melody


def hz_for_midi(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


class MelodyExtractionTests(unittest.TestCase):
    def test_corrects_an_isolated_octave_mistake(self):
        pitch = np.asarray([440.0, 440.0, 880.0, 440.0, 440.0], dtype=np.float32)
        corrected = melody._correct_isolated_octave_jumps(pitch, np.ones(5, dtype=np.float32))
        self.assertAlmostEqual(float(corrected[2]), 440.0, places=3)

    def test_preserves_a_sustained_real_octave_change(self):
        pitch = np.asarray([440.0, 880.0, 880.0, 880.0, 440.0], dtype=np.float32)
        corrected = melody._correct_isolated_octave_jumps(pitch, np.ones(5, dtype=np.float32))
        np.testing.assert_allclose(corrected, pitch)

    def test_vibrato_stays_one_note_but_a_glide_is_segmented(self):
        phase = np.linspace(0.0, math.tau * 5.0, 100, endpoint=False)
        vibrato_midi = 69.0 + np.sin(phase) * 0.3
        vibrato = np.asarray([hz_for_midi(value) for value in vibrato_midi], dtype=np.float32)
        confidence = np.full(100, 0.95, dtype=np.float32)
        rms = np.full(100, 0.1, dtype=np.float32)
        vibrato_notes = melody._segment_notes(vibrato, confidence, {}, rms)
        self.assertEqual(len(vibrato_notes), 1)
        self.assertTrue(vibrato_notes[0]["eligible"])

        glide_midi = np.linspace(60.0, 67.0, 100)
        glide = np.asarray([hz_for_midi(value) for value in glide_midi], dtype=np.float32)
        glide_notes = melody._segment_notes(glide, confidence, {}, rms)
        self.assertGreater(len(glide_notes), 1)
        self.assertLess(glide_notes[0]["midi"], glide_notes[-1]["midi"])

    def test_rejects_silence_and_low_level_noise(self):
        pitch = np.full(40, 440.0, dtype=np.float32)
        confidence = np.full(40, 0.99, dtype=np.float32)
        quiet = np.full(40, melody.SILENCE_RMS_GATE / 2.0, dtype=np.float32)
        self.assertEqual(melody._segment_notes(pitch, confidence, {}, quiet), [])

    def test_marks_low_confidence_notes_ineligible_and_aligns_lyrics(self):
        pitch = np.full(50, 440.0, dtype=np.float32)
        confidence = np.full(50, 0.4, dtype=np.float32)
        rms = np.full(50, 0.1, dtype=np.float32)
        transcript = {
            "segments": [
                {
                    "words": [
                        {"start": 0.0, "end": 0.25, "word": "first"},
                        {"start": 0.25, "end": 0.5, "word": "second"},
                    ]
                }
            ]
        }
        notes = melody._segment_notes(pitch, confidence, transcript, rms)
        self.assertEqual(len(notes), 1)
        self.assertFalse(notes[0]["eligible"])
        self.assertEqual(notes[0]["lyric_word_indices"], [0, 1])

    def test_falls_back_to_pyin_and_records_the_backend_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "melody.json")
            pitch = np.full(20, 440.0, dtype=np.float32)
            confidence = np.full(20, 0.9, dtype=np.float32)
            with (
                mock.patch.object(melody, "_load_mono", return_value=(np.zeros(3200), 16000)),
                mock.patch.object(
                    melody,
                    "_extract_torchcrepe",
                    side_effect=RuntimeError("TorchCREPE unavailable"),
                ),
                mock.patch.object(
                    melody,
                    "_extract_pyin",
                    return_value=(pitch, confidence, "pyin"),
                ),
                mock.patch.object(
                    melody,
                    "_frame_rms",
                    return_value=np.full(20, 0.1, dtype=np.float32),
                ),
            ):
                payload = melody.generate_melody("vocals.wav", output, {}, "cpu")

            self.assertEqual(payload["source"], "pyin")
            self.assertEqual(payload["fallback_reason"], "TorchCREPE unavailable")
            self.assertTrue(payload["strict_scoring_available"])
            with open(output, "r", encoding="utf-8") as file:
                saved = json.load(file)
            self.assertEqual(saved["source"], "pyin")


if __name__ == "__main__":
    unittest.main()
