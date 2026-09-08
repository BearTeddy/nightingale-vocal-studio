"""Regression tests use synthetic phrases, never fetched song lyrics."""
import copy
import unittest
import unicodedata
from unittest.mock import patch

import cjk


class LyricReadingsTests(unittest.TestCase):
    def test_japanese_context_particles_and_exact_surfaces(self):
        words = [{"word": text, "start": i, "end": i + 1} for i, text in enumerate(["今日", "は", "学校", "へ", "行く。"])]
        before = copy.deepcopy(words)
        cjk.attach_reading(words, "ja", "今日は学校へ行く。")
        self.assertEqual(words[0]["annotations"][0]["furigana"], "きょう")
        self.assertEqual(words[1]["reading"], "wa")
        self.assertEqual(words[3]["reading"], "e")
        self.assertEqual(words[4]["reading"], "iku。")
        for original, enriched in zip(before, words):
            self.assertEqual(original, {key: enriched[key] for key in original})
            self.assertEqual("".join(part["text"] for part in enriched["annotations"]), original["word"])

    def test_timed_lrc_line_gets_individual_ruby_without_retiming(self):
        word = {"word": "青い空を見よう。", "start": 15.2, "end": 20.4}
        transcript = {"language": None, "segments": [{"text": word["word"], "words": [word]}]}
        cjk.annotate_transcript(transcript)
        self.assertEqual(transcript["language"], "ja")
        self.assertTrue(any(part.get("furigana") for part in word["annotations"]))
        self.assertEqual((word["start"], word["end"]), (15.2, 20.4))

    def test_korean_sound_changes_and_mixed_english(self):
        for text, expected in [("같이", "gachi"), ("국물", "gungmul"), ("신라", "silla"), ("먹는", "meongneun"), ("Hello 사랑해!", "Hello saranghae!")]:
            self.assertEqual(cjk.reading(text, "ko"), expected)
        self.assertEqual(cjk.reading(unicodedata.normalize("NFD", "같이"), "ko"), "gachi")

    def test_english_punctuation_case_and_spacing_unchanged(self):
        words = [{"word": "Don't", "start": 0, "end": 1}, {"word": "STOP!", "start": 1, "end": 2}]
        cjk.attach_reading(words, "en", "Don't  STOP!")
        self.assertEqual(words[0]["separator"], "  ")
        self.assertNotIn("reading", words[0])
        self.assertEqual(words[1]["word"], "STOP!")

    def test_optional_dictionary_failure_keeps_original(self):
        words = [{"word": "今日", "start": 0, "end": 1}]
        with patch.object(cjk, "_get_fugashi", side_effect=ImportError):
            cjk.attach_reading(words, "ja")
        self.assertEqual(words[0]["word"], "今日")
        self.assertNotIn("annotations", words[0])

    def test_latin_in_japanese_is_not_treated_as_punctuation(self):
        entries = cjk.attribute_chars_to_tokens(["空", "Hello"], [{"start": 1, "end": 2}], cleaned_lengths=[1, 0])
        merged = cjk.merge_punct(entries)
        self.assertEqual([word["word"] for word in merged], ["空", "Hello"])
        self.assertTrue(merged[1]["estimated"])

    def test_script_detection_does_not_guess_romaji_as_english(self):
        self.assertIsNone(cjk.infer_lyric_language("sora wo miru"))
        self.assertEqual(cjk.infer_lyric_language("空を見よう Hello"), "ja")
        self.assertEqual(cjk.infer_lyric_language("Hello 안녕하세요"), "ko")


class SourceAlignmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import align
        cls.align = align

    def test_qwen_restores_source_spelling_and_punctuation(self):
        words = [{"word": "hello", "start": 0, "end": 1}, {"word": "world", "start": 1, "end": 2}]
        result = self.align._restore_source_surfaces("Hello, WORLD!", words)
        self.assertEqual([word["word"] for word in result], ["Hello,", "WORLD!"])
        self.assertEqual([word["start"] for word in result], [0, 1])

    def test_qwen_rejects_wrong_kanji_instead_of_guessing(self):
        self.assertIsNone(self.align._restore_source_surfaces("橋", [{"word": "箸", "start": 0, "end": 1}]))

    def test_unaligned_repeated_word_does_not_steal_later_timestamp(self):
        result = {"segments": [{"words": [{"word": "go", "start": 0, "end": 1}, {"word": "go"}, {"word": "go", "start": 4, "end": 5}]}]}
        segments = self.align._map_words_to_lines(result, ["Go go GO!"])
        words = segments[0]["words"]
        self.assertTrue(words[1]["estimated"])
        self.assertEqual(words[2]["start"], 4)
        self.assertEqual(words[2]["word"], "GO!")


if __name__ == "__main__":
    unittest.main()
