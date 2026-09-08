# Lyrics & Transcription

Nightingale provides word-level synchronized lyrics through two sources.

## LRCLIB

[LRCLIB](https://lrclib.net) is queried first. Close matches are selected using title, artist, duration and original script; ambiguous versions fall back to transcription. Retrieved text is aligned against the isolated vocals. Timings from LRCLIB are used directly only when you explicitly choose **Use LRC** in the editor.

Open **Edit lyrics → Find accurate lyrics** to correct the search title/artist and compare candidates with your pasted lyrics. Japanese original titles work better than translated video titles. The comparison runs locally; only title and artist are sent to LRCLIB. Match scores measure text/metadata similarity, not a guarantee of correct lyrics. Every result links to its source and must be selected before it replaces the editor buffer. Lyrics availability depends on LRCLIB's catalog.

For the best text accuracy, paste the complete original lyrics, keep repeated choruses, choose Japanese/Korean/English (or Auto), and use **Save & realign**. The app aligns your wording to audio rather than rewriting it from recognition. Romaji cannot uniquely determine kanji: use an original-script source to correct the written words. English contractions/capitalization and Korean Unicode normalization are preserved. Bracketed section labels such as `[Chorus]` are omitted from alignment input.

## WhisperX Transcription

When LRCLIB doesn't have lyrics for a song, Nightingale runs ASR over the isolated vocals to:

1. **Transcribe** the audio into text
2. **Align** each word to precise timestamps

This produces word-level timing information that drives the karaoke highlighting during playback.

## Choosing the ASR Engine

Two ASR engines are available, switchable from **Settings → Analysis**:

### Whisper (default)

Uses [WhisperX](https://github.com/m-bain/whisperX) with the `large-v3` model. Broad language coverage, robust on noisy or multilingual material. This is the default and the recommended choice for most users.

### Parakeet v3 (experimental)

[Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) by NVIDIA. Smaller and noticeably faster than Whisper large-v3. Two interchangeable backends are picked automatically based on your runtime device:

- **CUDA** → NVIDIA NeMo (`nemo_toolkit[asr]`)
- **CPU / MPS** → ONNX Runtime via `onnx-asr`

Parakeet is supported for the following 25 European languages: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian.

If Parakeet is selected for an unsupported language, or it produces no usable words for a song, Nightingale falls back to Whisper for that file. Word-level alignment after Parakeet still uses wav2vec2 forced alignment, so timing accuracy is comparable.

## Choosing the Forced-Alignment Backend

Whenever word timestamps are derived from wav2vec2 forced alignment — that is, the Whisper transcription path and the LRCLIB lyrics-alignment path — you can pick how the alignment itself is computed from **Settings → Analysis → Forced alignment**:

### WhisperX (default)

WhisperX's built-in aligner. Emissions come from wav2vec2, then a Viterbi decode + backtrack runs in pure Python on the CPU (even when a GPU is present). Reliable and well-tested; this is the default.

### GPU forced alignment (experimental)

Replaces only the Viterbi core with [`torchaudio.functional.forced_align`](https://docs.pytorch.org/audio/stable/generated/torchaudio.functional.forced_align.html) — a C++/CUDA CTC alignment kernel — while keeping everything else identical (model, dictionary, wildcard handling, character/word/sentence assembly, and the CJK per-character path). It runs on CUDA GPUs and, on Apple Silicon, on the optimized CPU kernel (torchaudio has no MPS kernel), which is still far faster than WhisperX's Python decode. It also speeds up LRCLIB lyrics alignment.

If the kernel fails for a segment (for example the audio is too short for the number of characters) it resorts to that segment's original bounds, and if the backend errors it automatically falls back to WhisperX — so switching it on is safe. This backend does not affect the Parakeet native-timestamp path, which skips forced alignment entirely.

### Qwen aligner (experimental)

Replaces wav2vec2 forced alignment entirely with [Qwen3-ForcedAligner-0.6B](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B-hf) (Apache-2.0), a non-autoregressive model that predicts a start/end timestamp for every token in a single forward pass from the audio and transcript together — no CTC, no phonetic conversion. It tokenizes the display text itself (Japanese via [nagisa](https://github.com/taishi-i/nagisa), Korean via [soynlp](https://github.com/lovit/soynlp), Chinese per character, space-delimited words otherwise) and drops punctuation, so Nightingale only attaches the romanized reading on top; the elaborate wav2vec2 CJK reattribution path is not needed here.

Notes:

- **Languages** — supports 11: Chinese, English, Cantonese, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish. Any other language automatically falls back to the wav2vec2 path.
- **Devices** — runs on CUDA (bf16), and unlike the other backends also on Apple Silicon **MPS** (falling back to CPU only where an op is unsupported).
- **Length** — the model handles up to ~5 minutes of audio per pass. The Whisper path aligns each segment against its own slice, so full songs are fine; a single over-long lyrics pass falls back to wav2vec2.
- **Safety** — any failure (unsupported language, over-length audio, OOM after a CPU retry, load error) falls back to WhisperX. The model weights (~1.8 GB) download on first use. Does not affect the Parakeet native-timestamp path.

## Language Support

The language is auto-detected from the audio. You can override it per song from the song-list controls. Nightingale includes Noto Sans CJK fonts for Chinese, Cantonese, Japanese, and Korean lyrics.

## CJK Languages

Japanese (`ja`), Chinese (`zh`), and Cantonese (`yue`) take a dedicated forced-alignment path because their wav2vec2 alignment models are character-level CTC checkpoints, not word/space-segmented. Nightingale:

1. **Transcribes** with Whisper or Parakeet as usual.
2. **Cleans** the text down to the alignment vocab (drops punctuation and other out-of-vocab symbols).
3. **Aligns** per character with a wav2vec2 model:
   - Japanese: `vumichien/wav2vec2-large-xlsr-japanese-hiragana` — feeds [fugashi](https://github.com/polm/fugashi)-derived hiragana readings into a hiragana-vocab CTC model. This sidesteps the dense kanji vocabulary of the default checkpoint and matches the acoustic prior of natural Japanese speech far better.
   - Chinese and Cantonese: `jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn` with [jieba](https://github.com/fxsjy/jieba) tokenization for display. Cantonese is written in the same Han characters, so it reuses the Chinese CTC model and per-character grouping; only its romanized reading differs.
4. **Reattributes** per-character timing back onto fugashi (ja) or jieba (zh/yue) tokens for word-level highlighting.

Korean (`ko`) uses `kresnik/wav2vec2-large-xlsr-korean`, which is already eojeol-segmented and bypasses the character-retokenization step.

For all four languages, every word is annotated with a romanized **reading** that appears above the original token during playback:

- Japanese — contextual furigana from [fugashi/UniDic](https://github.com/polm/fugashi), with Hepburn romaji via [pykakasi](https://github.com/miurahr/pykakasi); grammatical particles use their spoken readings
- Chinese — tone-mark pinyin via [pypinyin](https://github.com/mozillazg/python-pinyin)
- Cantonese — Jyutping via [ToJyutping](https://github.com/CanCLID/ToJyutping)
- Korean — pronunciation-aware romanization via [koroman](https://github.com/gerosyab/koroman), including liaison, nasal assimilation, lateralization and palatalization; older runtimes without koroman retain the existing spelling-based fallback

Heavy CJK modules are imported lazily on first use, so non-CJK songs don't pay the startup cost.

**Settings → General → Japanese lyrics** offers original only, original + furigana, original + romaji, both guides, or romaji only. **Korean lyrics** offers Hangul only, Hangul + romanization, or romanization only. English keeps its original spelling. Existing songs and timed-LRC files receive cached reading annotations when opened; this does not run vocal separation or forced alignment, and leaves authored text and timestamps intact. Reading guides follow dictionaries and standard pronunciation; artistic readings, proper names, dialect, and sung reductions can differ.

## Editing & Providing Lyrics

Open a non-USDX song's **Actions** button and choose **Edit lyrics** (ready songs) or **Provide LRC** (un-analyzed songs). The dialog has two tabs:

- **Edit tab** — a textarea for the lyrics. Paste timed **LRC / Enhanced LRC** (line- or word-level) to set timing directly and skip transcription, or paste plain lyrics to run alignment against the audio. For un-analyzed songs an **Audio** choice also appears: separate stems (karaoke) or play over the original mix.
- **Find accurate lyrics tab** — always available, including when no matches are found. Correct the title/artist, then press **Search** to rank results against your current input. Each shows track / artist / album / duration, match notes, source and original lyrics; select **Use LRC** to keep supplied timing or **Use text & align to audio** to rebuild timing.

Timed LRC is written straight to the transcript with no ML pass. Skipping stem separation plays the song over its original mix with the guide control hidden; a quick key-detection pass still enables key/tempo shifts, and pitch scoring falls back to the original mix (less accurate). Saved lyrics replace the cached transcript for that song's blake3 hash, so subsequent plays pick up the change immediately. CJK alignment paths are skipped on edits — the editor saves a flat per-line transcript and lets the alignment stage re-derive per-character timings on the next analyzer pass.

## Highlighting

During playback, lyrics are displayed with word-by-word highlighting:

- **Current word** — highlighted in the accent color
- **Sung words** — shown in a completed state
- **Upcoming words** — shown in a dimmer color
- **Next line** — previewed below the current line
- **Reading** — for CJK songs, the romanized reading is shown above each token in a smaller weight
- **Lyric gaps** — during longer pauses between lyric lines, a compact countdown appears beneath the song details while a circular bubble counts down the final three seconds beside the upcoming line. Lines from the next lyric block are not previewed across an instrumental break.
