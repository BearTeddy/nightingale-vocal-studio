"""Lead-vocal pitch extraction and note segmentation for karaoke guidance."""

from __future__ import annotations

import argparse
import json
import math
import os
from typing import Iterable

import numpy as np
import soundfile as sf


TARGET_SAMPLE_RATE = 16_000
HOP_MS = 10
MIN_HZ = 65.0
MAX_HZ = 1_200.0
MIN_NOTE_SEC = 0.08
MAX_GAP_SEC = 0.07
NOTE_CHANGE_SEMITONES = 0.7
STRICT_CONFIDENCE = 0.55
SILENCE_RMS_GATE = 0.003
VERIFICATION_MATCH_SEMITONES = 0.8
VERIFICATION_OCTAVE_TOLERANCE = 0.8


def _load_mono(path: str) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    mono = np.mean(audio, axis=1, dtype=np.float32)
    if sample_rate != TARGET_SAMPLE_RATE:
        from scipy.signal import resample_poly

        gcd = math.gcd(sample_rate, TARGET_SAMPLE_RATE)
        mono = resample_poly(
            mono,
            TARGET_SAMPLE_RATE // gcd,
            sample_rate // gcd,
        ).astype(np.float32, copy=False)
        sample_rate = TARGET_SAMPLE_RATE
    return mono, sample_rate


def _extract_torchcrepe(audio: np.ndarray, sample_rate: int, device: str):
    import torch
    import torchcrepe

    tensor = torch.from_numpy(audio).unsqueeze(0).to(device)
    hop_length = max(1, round(sample_rate * HOP_MS / 1000))
    with torch.inference_mode():
        pitch, periodicity = torchcrepe.predict(
            tensor,
            sample_rate,
            hop_length,
            MIN_HZ,
            MAX_HZ,
            model="full",
            batch_size=1024,
            device=device,
            decoder=torchcrepe.decode.viterbi,
            return_periodicity=True,
        )
        periodicity = torchcrepe.filter.median(periodicity, 3)
        pitch = torchcrepe.filter.mean(pitch, 3)
    return (
        pitch.squeeze(0).detach().cpu().numpy(),
        periodicity.squeeze(0).detach().cpu().numpy(),
        "torchcrepe",
    )


def _extract_pyin(audio: np.ndarray, sample_rate: int):
    import librosa

    hop_length = max(1, round(sample_rate * HOP_MS / 1000))
    pitch, voiced, probability = librosa.pyin(
        audio,
        fmin=MIN_HZ,
        fmax=MAX_HZ,
        sr=sample_rate,
        frame_length=2048,
        hop_length=hop_length,
        center=True,
    )
    probability = np.where(voiced, probability, 0.0)
    return pitch, probability, "pyin"


def _midi(hz: float) -> float:
    return 69.0 + 12.0 * math.log2(hz / 440.0)


def _frame_rms(audio: np.ndarray, sample_rate: int, frame_count: int) -> np.ndarray:
    hop_length = max(1, round(sample_rate * HOP_MS / 1000))
    radius = max(hop_length, round(sample_rate * 0.02))
    levels = np.zeros(frame_count, dtype=np.float32)
    for index in range(frame_count):
        center = index * hop_length
        start = max(0, center - radius)
        end = min(len(audio), center + radius)
        if end > start:
            window = audio[start:end]
            levels[index] = float(np.sqrt(np.mean(window * window)))
    return levels


def _correct_isolated_octave_jumps(
    pitch: np.ndarray,
    confidence: np.ndarray,
) -> np.ndarray:
    corrected = np.asarray(pitch, dtype=np.float32).copy()
    for index in range(1, len(corrected) - 1):
        if confidence[index] < 0.2:
            continue
        previous = corrected[index - 1]
        current = corrected[index]
        following = corrected[index + 1]
        if not all(np.isfinite(value) and value > 0 for value in (previous, current, following)):
            continue
        previous_midi = _midi(float(previous))
        following_midi = _midi(float(following))
        if abs(previous_midi - following_midi) > 2.0:
            continue
        neighbor_midi = (previous_midi + following_midi) / 2.0
        octave_error = round((_midi(float(current)) - neighbor_midi) / 12.0)
        if octave_error == 0:
            continue
        shifted = float(current) / (2.0**octave_error)
        if abs(_midi(shifted) - neighbor_midi) <= 2.0:
            corrected[index] = shifted
    return corrected


def _verified_consensus(
    primary_pitch: np.ndarray,
    primary_confidence: np.ndarray,
    secondary_pitch: np.ndarray,
    secondary_confidence: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Keep frames independently supported by two pitch detectors.

    Disagreements close to a whole octave are resolved against recent verified
    context (or toward the lower candidate at the start of a phrase), which
    removes the common high-harmonic spike without flattening a real high note
    that both detectors agree on.
    """
    frame_count = min(
        len(primary_pitch),
        len(primary_confidence),
        len(secondary_pitch),
        len(secondary_confidence),
    )
    pitch = np.full(frame_count, np.nan, dtype=np.float32)
    confidence = np.zeros(frame_count, dtype=np.float32)
    recent_midi: list[float] = []
    matched = 0
    octave_resolved = 0
    rejected = 0

    for index in range(frame_count):
        first_hz = float(primary_pitch[index])
        second_hz = float(secondary_pitch[index])
        first_conf = float(primary_confidence[index])
        second_conf = float(secondary_confidence[index])
        valid = all(
            math.isfinite(value) and value > 0
            for value in (first_hz, second_hz, first_conf, second_conf)
        )
        if not valid or first_conf < 0.2 or second_conf < 0.2:
            rejected += 1
            continue

        first_midi = _midi(first_hz)
        second_midi = _midi(second_hz)
        difference = abs(first_midi - second_midi)
        chosen_midi: float | None = None

        if difference <= VERIFICATION_MATCH_SEMITONES:
            weight = max(0.001, first_conf + second_conf)
            chosen_midi = (first_midi * first_conf + second_midi * second_conf) / weight
            matched += 1
        else:
            octave_distance = abs(difference - round(difference / 12.0) * 12.0)
            if difference >= 10.0 and octave_distance <= VERIFICATION_OCTAVE_TOLERANCE:
                if recent_midi:
                    reference = float(np.median(np.asarray(recent_midi[-15:], dtype=np.float32)))
                    chosen_midi = min(
                        (first_midi, second_midi),
                        key=lambda candidate: abs(candidate - reference),
                    )
                else:
                    chosen_midi = min(first_midi, second_midi)
                octave_resolved += 1

        if chosen_midi is None:
            rejected += 1
            continue

        pitch[index] = 440.0 * (2.0 ** ((chosen_midi - 69.0) / 12.0))
        confidence[index] = math.sqrt(first_conf * second_conf)
        recent_midi.append(chosen_midi)

    return pitch, confidence, {
        "matched_frames": matched,
        "octave_frames_resolved": octave_resolved,
        "rejected_frames": rejected,
        "total_frames": frame_count,
    }


def _word_windows(transcript: dict) -> list[tuple[int, float, float]]:
    words = []
    word_index = 0
    for segment in transcript.get("segments", []):
        for word in segment.get("words", []):
            try:
                start = float(word["start"])
                end = float(word["end"])
            except (KeyError, TypeError, ValueError):
                word_index += 1
                continue
            words.append((word_index, start, end))
            word_index += 1
    return words


def _aligned_word_indices(start: float, end: float, words: Iterable[tuple[int, float, float]]):
    return [index for index, word_start, word_end in words if min(end, word_end) > max(start, word_start)]


def _segment_notes(
    pitch: np.ndarray,
    confidence: np.ndarray,
    transcript: dict,
    rms: np.ndarray | None = None,
) -> list[dict]:
    frame_sec = HOP_MS / 1000.0
    word_windows = _word_windows(transcript)
    frames: list[tuple[float, float, float] | None] = []

    for index, (hz, conf) in enumerate(zip(pitch, confidence)):
        silent = rms is not None and index < len(rms) and rms[index] < SILENCE_RMS_GATE
        if silent or not np.isfinite(hz) or hz <= 0 or not np.isfinite(conf) or conf < 0.2:
            frames.append(None)
            continue
        frames.append((index * frame_sec, _midi(float(hz)), float(conf)))

    notes: list[dict] = []
    current: list[tuple[float, float, float]] = []

    def flush():
        nonlocal current
        if not current:
            return
        start = current[0][0]
        end = current[-1][0] + frame_sec
        if end - start >= MIN_NOTE_SEC:
            midi_values = np.asarray([frame[1] for frame in current], dtype=np.float32)
            confidence_values = np.asarray([frame[2] for frame in current], dtype=np.float32)
            midi = float(np.median(midi_values))
            note_confidence = float(np.mean(confidence_values))
            notes.append(
                {
                    "id": f"n{len(notes) + 1}",
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "midi": round(midi),
                    "cents": round((midi - round(midi)) * 100.0, 1),
                    "confidence": round(note_confidence, 3),
                    "eligible": note_confidence >= STRICT_CONFIDENCE,
                    "lyric_word_indices": _aligned_word_indices(start, end, word_windows),
                }
            )
        current = []

    for index, frame in enumerate(frames):
        if frame is None:
            if current and index * frame_sec - current[-1][0] > MAX_GAP_SEC:
                flush()
            continue
        if current:
            previous_time, previous_midi, _ = current[-1]
            reference_midi = float(np.median([item[1] for item in current]))
            if (
                frame[0] - previous_time > MAX_GAP_SEC
                or abs(frame[1] - previous_midi) > NOTE_CHANGE_SEMITONES
                or abs(frame[1] - reference_midi) > NOTE_CHANGE_SEMITONES
            ):
                flush()
        current.append(frame)
    flush()
    return notes


def generate_melody(
    vocals_path: str,
    output_path: str,
    transcript: dict,
    device: str,
    verify: bool = False,
) -> dict:
    audio, sample_rate = _load_mono(vocals_path)
    backend_error = None
    try:
        pitch, confidence, source = _extract_torchcrepe(audio, sample_rate, device)
    except Exception as error:
        backend_error = str(error)
        pitch, confidence, source = _extract_pyin(audio, sample_rate)

    verification = None
    if verify:
        if source != "torchcrepe":
            raise RuntimeError(
                "Deep verification needs TorchCREPE and pYIN; TorchCREPE was unavailable"
            )
        secondary_pitch, secondary_confidence, _ = _extract_pyin(audio, sample_rate)
        pitch, confidence, verification = _verified_consensus(
            pitch,
            confidence,
            secondary_pitch,
            secondary_confidence,
        )
        source = "torchcrepe+pyin-verified"

    pitch = _correct_isolated_octave_jumps(pitch, confidence)
    rms = _frame_rms(audio, sample_rate, len(pitch))
    notes = _segment_notes(pitch, confidence, transcript, rms)
    eligible = [note for note in notes if note["eligible"]]
    payload = {
        "version": 1,
        "source": source,
        "hop_ms": HOP_MS,
        "silence_rms_gate": SILENCE_RMS_GATE,
        "confidence": round(
            sum(note["confidence"] for note in notes) / max(1, len(notes)),
            3,
        ),
        "strict_scoring_available": len(eligible) > 0,
        "notes": notes,
    }
    if backend_error:
        payload["fallback_reason"] = backend_error
    if verification is not None:
        payload["verification"] = verification

    tmp = f"{output_path}.partial"
    with open(tmp, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.replace(tmp, output_path)
    return payload


def _main() -> None:
    parser = argparse.ArgumentParser(description="Build a Nightingale melody map")
    parser.add_argument("vocals_path")
    parser.add_argument("output_path")
    parser.add_argument("transcript_path")
    parser.add_argument("--device", default=None)
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Cross-check every pitch frame with TorchCREPE and pYIN (slow)",
    )
    args = parser.parse_args()

    with open(args.transcript_path, "r", encoding="utf-8") as file:
        transcript = json.load(file)
    device = args.device
    if not device:
        from whisper_compat import detect_device

        device = detect_device()
    payload = generate_melody(
        os.path.abspath(args.vocals_path),
        os.path.abspath(args.output_path),
        transcript,
        device,
        verify=args.verify,
    )
    print(
        json.dumps(
            {
                "source": payload["source"],
                "notes": len(payload["notes"]),
                "strict_scoring_available": payload["strict_scoring_available"],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    _main()
