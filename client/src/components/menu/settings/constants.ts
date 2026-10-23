import {
  DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
  MAX_MIC_LATENCY_COMPENSATION_SEC,
} from "@/lib/pitch/constants";
import type { AppConfig } from "@/types/AppConfig";

export type SettingsTab = "general" | "analysis";
export type SettingsOption = { value: string; label: string; description?: string };

export const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "analysis", label: "Analysis" },
];

export const SEPARATORS: SettingsOption[] = [
  {
    value: "karaoke",
    label: "UVR Karaoke",
    description: "Usually separates more cleanly, but can occasionally slip on tricky parts.",
  },
  {
    value: "demucs",
    label: "Demucs",
    description:
      "Smoother and more consistent with fewer abrupt artifacts, though slightly less crisp overall.",
  },
];

export const ASR_ENGINES: SettingsOption[] = [
  {
    value: "whisper",
    label: "Whisper",
    description: "Works in any language and lets you pick a model size below.",
  },
  {
    value: "parakeet",
    label: "Parakeet v3 (Experimental)",
    description:
      "Much faster and produces its own word timings (skipping alignment), but only covers 25 European languages. Whisper takes over for anything else.",
  },
];

export const ALIGN_BACKENDS: SettingsOption[] = [
  {
    value: "whisperx",
    label: "WhisperX",
    description: "The reliable default, timing words with a proven decoder.",
  },
  {
    value: "ctc",
    label: "CTC Forced Alignment (Experimental)",
    description:
      "Calculates word start/end points with a different algorithm, and runs much faster on GPU and Apple Silicon. Falls back to WhisperX if a line trips it up.",
  },
  {
    value: "qwen",
    label: "Qwen Forced Alignment (Experimental)",
    description:
      "A fast AI model covering 11 languages. Timing quality varies song to song, but it can do better on Chinese, Japanese, and Korean. Falls back to WhisperX otherwise.",
  },
];

export const MODELS = ["large-v3", "large-v3-turbo", "medium", "small", "base", "tiny"];

export const LYRICS_VERTICAL_POSITIONS: SettingsOption[] = [
  { value: "bottom", label: "Bottom" },
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
];

export const LYRICS_HORIZONTAL_POSITIONS: SettingsOption[] = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
];

export const MIC_MONITOR_MODES: SettingsOption[] = [
  {
    value: "low_latency",
    label: "Low latency",
    description: "Small native audio buffers for wired headphones and USB audio interfaces.",
  },
  {
    value: "compatible",
    label: "Compatible",
    description: "A larger safety buffer for devices that crackle or drop out in Low latency mode.",
  },
];

export const JAPANESE_LYRICS_DISPLAY: SettingsOption[] = [
  { value: "both", label: "Original + furigana + romaji" },
  { value: "furigana", label: "Original + furigana" },
  { value: "romanization", label: "Original + romaji" },
  { value: "original", label: "Original kanji / kana only" },
  { value: "romanization_only", label: "Romaji only" },
];

export const KOREAN_LYRICS_DISPLAY: SettingsOption[] = [
  { value: "romanization", label: "Hangul + romanization" },
  { value: "original", label: "Hangul only" },
  { value: "romanization_only", label: "Romanization only" },
];

export const DEFAULTS = {
  separator: "karaoke",
  asr_engine: "whisper",
  align_backend: "whisperx",
  vocal_detection_threshold_pct: 0.15,
  whisper_model: "large-v3",
  beam_size: 8,
  batch_size: 8,
  mic_monitor_gain: 0.65,
  pitch_tolerance_factor: 1,
  mic_monitor_mode: "low_latency",
  mic_latency_compensation_sec: DEFAULT_MIC_LATENCY_COMPENSATION_SEC,
  auto_analyze: false,
  verify_melody_analysis: false,
  lyrics_vertical_position: "bottom",
  lyrics_horizontal_position: "center",
} satisfies Pick<
  AppConfig,
  | "separator"
  | "asr_engine"
  | "align_backend"
  | "vocal_detection_threshold_pct"
  | "whisper_model"
  | "beam_size"
  | "batch_size"
  | "mic_monitor_gain"
  | "pitch_tolerance_factor"
  | "mic_monitor_mode"
  | "mic_latency_compensation_sec"
  | "auto_analyze"
  | "verify_melody_analysis"
  | "lyrics_vertical_position"
  | "lyrics_horizontal_position"
>;

export const MIC_MONITOR_GAIN_STEP = 0.01;
export const MIC_MONITOR_GAIN_MAX = 2;
export const MIC_LATENCY_STEP = 0.005;
export const MIC_LATENCY_MAX = MAX_MIC_LATENCY_COMPENSATION_SEC;
// Vocal-detection threshold is stored as a fraction of peak RMS (0-1) but shown
// as a percentage. Capped at 60% since anything higher trims almost everything.
export const VOCAL_THRESHOLD_STEP = 0.01;
export const VOCAL_THRESHOLD_MIN = 0;
export const VOCAL_THRESHOLD_MAX = 0.6;
export const NUMBER_PICKER_SIZE = 16;

export const NAV = {
  tabSegment: 0,
  general: {
    window: 1,
    microphone: 2,
    pitchTolerance: 3,
    micMonitorGain: 4,
    micMonitorMode: 5,
    micLatency: 6,
    lyricsVerticalPosition: 7,
    lyricsHorizontalPosition: 8,
    japaneseLyrics: 9,
    koreanLyrics: 10,
  },
} as const;

// The Whisper-only "Model size" + "Beam Size" fields sit right after the
// transcription model, so every later field shifts by two segments when
// Parakeet hides them. Fields that aren't rendered map to -1 so focus rings
// never match them.
export function getAnalysisNav(isParakeet: boolean) {
  return isParakeet
    ? {
        separator: 1,
        asrEngine: 2,
        whisperModel: -1,
        beamSize: -1,
        alignBackend: 3,
        autoAnalyze: 4,
        verifyMelody: 5,
        vocalThreshold: 6,
        batchSize: 7,
      }
    : {
        separator: 1,
        asrEngine: 2,
        whisperModel: 3,
        beamSize: 4,
        alignBackend: 5,
        autoAnalyze: 6,
        verifyMelody: 7,
        vocalThreshold: 8,
        batchSize: 9,
      };
}

export function getSettingsStops(tab: SettingsTab, isParakeet: boolean) {
  if (tab === "general") {
    return [2, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 2];
  }

  return isParakeet
    ? [2, 1, 1, 1, 2, 2, 1, NUMBER_PICKER_SIZE, 2]
    : [2, 1, 1, 1, NUMBER_PICKER_SIZE, 1, 2, 2, 1, NUMBER_PICKER_SIZE, 2];
}
