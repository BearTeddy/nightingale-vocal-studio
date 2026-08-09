use pitch_detection::detector::mcleod::McLeodDetector;
use pitch_detection::detector::PitchDetector;
use serde::Serialize;
use std::collections::VecDeque;
use ts_rs::TS;

pub const PITCH_WINDOW_SAMPLES: usize = 2_048;
const PITCH_PADDING_SAMPLES: usize = PITCH_WINDOW_SAMPLES / 2;
const PITCH_HOP_SAMPLES: usize = 1_536;
const MIN_PITCH_HZ: f32 = 55.0;
const MAX_PITCH_HZ: f32 = 1_200.0;
const RMS_GATE: f32 = 0.003;
const POWER_THRESHOLD: f32 = RMS_GATE * RMS_GATE * PITCH_WINDOW_SAMPLES as f32;
const CLARITY_THRESHOLD: f32 = 0.55;
const LARGE_JUMP_SEMITONES: f32 = 4.0;
const JUMP_MATCH_SEMITONES: f32 = 1.5;
const JUMP_CONFIRMATION_FRAMES: u8 = 3;
const TRACKING_RESET_FRAMES: u8 = 5;

#[derive(Debug, Clone, Copy)]
struct PendingJump {
    midi: f32,
    observations: u8,
}

fn accepted_frequency(hz: f32, clarity: f32) -> Option<f32> {
    (clarity >= CLARITY_THRESHOLD && hz.is_finite() && (MIN_PITCH_HZ..=MAX_PITCH_HZ).contains(&hz))
        .then_some(hz)
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct NativePitchFrame {
    pub hz: Option<f32>,
    pub midi: Option<f32>,
    pub clarity: f32,
    pub rms: f32,
    pub peak: f32,
    pub voiced: bool,
    #[ts(type = "number")]
    pub sample_index: u64,
    pub sample_rate: u32,
    pub captured_at_ms: f64,
}

pub struct NativePitchTracker {
    detector: McLeodDetector<f32>,
    window: VecDeque<f32>,
    sample_rate: u32,
    samples_since_estimate: usize,
    accepted_midi: Option<f32>,
    pending_jump: Option<PendingJump>,
    unvoiced_frames: u8,
}

impl Default for NativePitchTracker {
    fn default() -> Self {
        Self {
            detector: McLeodDetector::new(PITCH_WINDOW_SAMPLES, PITCH_PADDING_SAMPLES),
            window: VecDeque::with_capacity(PITCH_WINDOW_SAMPLES),
            sample_rate: 0,
            samples_since_estimate: 0,
            accepted_midi: None,
            pending_jump: None,
            unvoiced_frames: 0,
        }
    }
}

impl NativePitchTracker {
    pub fn push_samples(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        end_sample_index: u64,
    ) -> Option<NativePitchFrame> {
        if samples.is_empty() || sample_rate == 0 {
            return None;
        }
        if self.sample_rate != sample_rate {
            self.window.clear();
            self.samples_since_estimate = 0;
            self.sample_rate = sample_rate;
            self.accepted_midi = None;
            self.pending_jump = None;
            self.unvoiced_frames = 0;
        }

        self.window.extend(samples.iter().copied());
        while self.window.len() > PITCH_WINDOW_SAMPLES {
            self.window.pop_front();
        }
        self.samples_since_estimate = self.samples_since_estimate.saturating_add(samples.len());
        if self.window.len() < PITCH_WINDOW_SAMPLES
            || (self.samples_since_estimate < PITCH_HOP_SAMPLES
                && end_sample_index > PITCH_WINDOW_SAMPLES as u64)
        {
            return None;
        }
        self.samples_since_estimate = 0;

        let window = self.window.iter().copied().collect::<Vec<_>>();
        Some(self.detect_window(&window, sample_rate, end_sample_index))
    }

    fn detect_window(
        &mut self,
        samples: &[f32],
        sample_rate: u32,
        sample_index: u64,
    ) -> NativePitchFrame {
        let mut sum_squares = 0.0f32;
        let mut peak = 0.0f32;
        for sample in samples {
            sum_squares += sample * sample;
            peak = peak.max(sample.abs());
        }
        let rms = (sum_squares / samples.len().max(1) as f32).sqrt();
        let pitch = if rms >= RMS_GATE {
            self.detector.get_pitch(
                samples,
                sample_rate as usize,
                POWER_THRESHOLD,
                CLARITY_THRESHOLD,
            )
        } else {
            None
        };
        let clarity = pitch.as_ref().map(|pitch| pitch.clarity).unwrap_or(0.0);
        let raw_hz = pitch.and_then(|pitch| accepted_frequency(pitch.frequency, pitch.clarity));
        let hz = self.stabilize_pitch(raw_hz);
        let midi = hz.map(|hz| 69.0 + 12.0 * (hz / 440.0).log2());

        NativePitchFrame {
            hz,
            midi,
            clarity,
            rms,
            peak,
            voiced: hz.is_some(),
            sample_index,
            sample_rate,
            captured_at_ms: sample_index as f64 / sample_rate as f64 * 1_000.0,
        }
    }

    fn stabilize_pitch(&mut self, raw_hz: Option<f32>) -> Option<f32> {
        let Some(raw_hz) = raw_hz else {
            self.pending_jump = None;
            self.unvoiced_frames = self.unvoiced_frames.saturating_add(1);
            if self.unvoiced_frames > TRACKING_RESET_FRAMES {
                self.accepted_midi = None;
            }
            return None;
        };
        self.unvoiced_frames = 0;

        let raw_midi = 69.0 + 12.0 * (raw_hz / 440.0).log2();
        let Some(accepted_midi) = self.accepted_midi else {
            self.accepted_midi = Some(raw_midi);
            self.pending_jump = None;
            return Some(raw_hz);
        };

        if (raw_midi - accepted_midi).abs() < LARGE_JUMP_SEMITONES {
            self.accepted_midi = Some(raw_midi);
            self.pending_jump = None;
            return Some(raw_hz);
        }

        let pending = match self.pending_jump {
            Some(mut pending) if (raw_midi - pending.midi).abs() <= JUMP_MATCH_SEMITONES => {
                pending.observations = pending.observations.saturating_add(1);
                pending.midi += (raw_midi - pending.midi) / pending.observations as f32;
                pending
            }
            _ => PendingJump {
                midi: raw_midi,
                observations: 1,
            },
        };

        if pending.observations < JUMP_CONFIRMATION_FRAMES {
            self.pending_jump = Some(pending);
            return None;
        }

        self.accepted_midi = Some(pending.midi);
        self.pending_jump = None;
        Some(440.0 * 2.0f32.powf((pending.midi - 69.0) / 12.0))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        accepted_frequency, NativePitchFrame, NativePitchTracker, CLARITY_THRESHOLD,
        PITCH_WINDOW_SAMPLES, TRACKING_RESET_FRAMES,
    };

    const SAMPLE_RATE: u32 = 48_000;
    const CHUNK: usize = 512;

    fn sine_wave(hz: f32, amplitude: f32, samples: usize) -> Vec<f32> {
        (0..samples)
            .map(|index| {
                let phase = std::f32::consts::TAU * hz * index as f32 / SAMPLE_RATE as f32;
                phase.sin() * amplitude
            })
            .collect()
    }

    fn last_frame(samples: &[f32]) -> NativePitchFrame {
        let mut tracker = NativePitchTracker::default();
        let mut result = None;
        for (index, chunk) in samples.chunks(CHUNK).enumerate() {
            result = tracker
                .push_samples(chunk, SAMPLE_RATE, ((index + 1) * CHUNK) as u64)
                .or(result);
        }
        result.expect("expected a pitch frame")
    }

    #[test]
    fn detects_synthetic_voice_range_tones_in_the_correct_octave() {
        for expected in [65.406, 110.0, 220.0, 440.0, 880.0, 1_046.502] {
            let frame = last_frame(&sine_wave(expected, 0.2, PITCH_WINDOW_SAMPLES * 2));
            let detected = frame.hz.expect("tone should be voiced");
            assert!(
                (detected - expected).abs() < 1.0,
                "expected {expected}, got {detected}"
            );
            assert!(
                frame.clarity >= CLARITY_THRESHOLD,
                "expected accepted clarity for {expected} Hz, got {}",
                frame.clarity
            );
        }
    }

    #[test]
    fn rejects_silence_and_low_level_noise() {
        let silence = last_frame(&vec![0.0; PITCH_WINDOW_SAMPLES]);
        assert!(!silence.voiced);
        assert_eq!(silence.hz, None);

        let mut state = 0x1234_5678u32;
        let noise = (0..PITCH_WINDOW_SAMPLES)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state as f32 / u32::MAX as f32 - 0.5) * 0.002
            })
            .collect::<Vec<_>>();
        let noise = last_frame(&noise);
        assert!(!noise.voiced);
    }

    #[test]
    fn emits_the_first_estimate_within_the_analysis_window() {
        let signal = sine_wave(220.0, 0.2, PITCH_WINDOW_SAMPLES);
        let mut tracker = NativePitchTracker::default();
        let mut first = None;
        for (index, chunk) in signal.chunks(CHUNK).enumerate() {
            first = tracker.push_samples(chunk, SAMPLE_RATE, ((index + 1) * CHUNK) as u64);
            if first.is_some() {
                break;
            }
        }
        let frame = first.expect("pitch estimate should be ready after one window");
        assert_eq!(frame.sample_index, PITCH_WINDOW_SAMPLES as u64);
        assert!(frame.captured_at_ms < 43.0);
    }

    #[test]
    fn rejects_reported_clarity_below_the_acceptance_threshold() {
        assert_eq!(accepted_frequency(220.0, CLARITY_THRESHOLD - 0.01), None);
        assert_eq!(accepted_frequency(220.0, CLARITY_THRESHOLD), Some(220.0));
    }

    #[test]
    fn suppresses_an_isolated_octave_flip() {
        let mut tracker = NativePitchTracker::default();
        assert_eq!(tracker.stabilize_pitch(Some(220.0)), Some(220.0));
        assert_eq!(tracker.stabilize_pitch(Some(440.0)), None);
        assert_eq!(tracker.stabilize_pitch(Some(220.0)), Some(220.0));
    }

    #[test]
    fn accepts_a_sustained_octave_change_on_the_third_estimate() {
        let mut tracker = NativePitchTracker::default();
        assert_eq!(tracker.stabilize_pitch(Some(220.0)), Some(220.0));
        assert_eq!(tracker.stabilize_pitch(Some(440.0)), None);
        assert_eq!(tracker.stabilize_pitch(Some(440.5)), None);
        let accepted = tracker
            .stabilize_pitch(Some(439.5))
            .expect("sustained octave change should be accepted");
        assert!((accepted - 440.0).abs() < 1.0);
    }

    #[test]
    fn follows_a_gradual_pitch_change_without_transition_delay() {
        let mut tracker = NativePitchTracker::default();
        for midi in [69.0, 71.0, 73.0, 75.0] {
            let hz = 440.0 * 2.0f32.powf((midi - 69.0) / 12.0);
            assert!(tracker.stabilize_pitch(Some(hz)).is_some());
        }
    }

    #[test]
    fn keeps_normal_vibrato_continuously_voiced() {
        let mut tracker = NativePitchTracker::default();
        for index in 0..24 {
            let vibrato_midi = 69.0 + (index as f32 * std::f32::consts::TAU / 8.0).sin() * 0.5;
            let hz = 440.0 * 2.0f32.powf((vibrato_midi - 69.0) / 12.0);
            assert!(tracker.stabilize_pitch(Some(hz)).is_some());
        }
    }

    #[test]
    fn reacquires_immediately_after_a_real_silence() {
        let mut tracker = NativePitchTracker::default();
        assert_eq!(tracker.stabilize_pitch(Some(220.0)), Some(220.0));
        for _ in 0..=TRACKING_RESET_FRAMES {
            assert_eq!(tracker.stabilize_pitch(None), None);
        }
        assert_eq!(tracker.stabilize_pitch(Some(440.0)), Some(440.0));
    }
}
