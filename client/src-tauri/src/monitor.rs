use cpal::{BufferSize, SupportedBufferSize};
use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

pub const DEFAULT_MONITOR_GAIN: f32 = 0.65;
pub const MAX_MONITOR_GAIN: f32 = 2.0;

const RING_CAPACITY: usize = 32_768;
const LOW_LATENCY_TARGET_MS: f32 = 8.0;
const COMPATIBLE_TARGET_MS: f32 = 24.0;
const LOW_LATENCY_BUFFER_FRAMES: u32 = 128;
const FADE_MS: f32 = 5.0;
const HIGH_PASS_HZ: f32 = 70.0;
const MAX_CLOCK_CORRECTION: f64 = 0.005;
const CLOCK_CORRECTION_GAIN: f64 = 0.002;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonitorMode {
    LowLatency,
    Compatible,
}

impl MonitorMode {
    pub fn from_config(value: Option<&str>) -> Self {
        match value {
            Some("compatible") => Self::Compatible,
            _ => Self::LowLatency,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::LowLatency => "low_latency",
            Self::Compatible => "compatible",
        }
    }

    pub fn target_ms(self) -> f32 {
        match self {
            Self::LowLatency => LOW_LATENCY_TARGET_MS,
            Self::Compatible => COMPATIBLE_TARGET_MS,
        }
    }
}

pub fn stream_buffer_size(supported: &SupportedBufferSize, mode: MonitorMode) -> BufferSize {
    if mode == MonitorMode::Compatible {
        return BufferSize::Default;
    }

    match *supported {
        SupportedBufferSize::Range { min, max } => {
            BufferSize::Fixed(LOW_LATENCY_BUFFER_FRAMES.max(min).min(max))
        }
        SupportedBufferSize::Unknown => BufferSize::Default,
    }
}

#[derive(Clone, Debug, Default)]
pub struct MonitorSnapshot {
    pub available: bool,
    pub active: bool,
    pub input_sample_rate: u32,
    pub output_sample_rate: u32,
    pub buffered_frames: u32,
    pub target_frames: u32,
    pub underruns: u64,
    pub overruns: u64,
    pub estimated_latency_ms: f32,
    pub mode: &'static str,
}

#[derive(Debug)]
pub struct MonitorTelemetry {
    available: AtomicBool,
    active: AtomicBool,
    input_sample_rate: AtomicU32,
    output_sample_rate: AtomicU32,
    buffered_frames: AtomicU32,
    target_frames: AtomicU32,
    output_buffer_frames: AtomicU32,
    underruns: AtomicU64,
    overruns: AtomicU64,
    mode: AtomicU32,
}

impl Default for MonitorTelemetry {
    fn default() -> Self {
        Self {
            available: AtomicBool::new(false),
            active: AtomicBool::new(false),
            input_sample_rate: AtomicU32::new(0),
            output_sample_rate: AtomicU32::new(0),
            buffered_frames: AtomicU32::new(0),
            target_frames: AtomicU32::new(0),
            output_buffer_frames: AtomicU32::new(0),
            underruns: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            mode: AtomicU32::new(0),
        }
    }
}

impl MonitorTelemetry {
    pub fn reset(&self, input_sample_rate: u32, mode: MonitorMode) {
        self.available.store(false, Ordering::SeqCst);
        self.active.store(false, Ordering::SeqCst);
        self.input_sample_rate
            .store(input_sample_rate, Ordering::SeqCst);
        self.output_sample_rate.store(0, Ordering::SeqCst);
        self.buffered_frames.store(0, Ordering::SeqCst);
        self.target_frames.store(0, Ordering::SeqCst);
        self.output_buffer_frames.store(0, Ordering::SeqCst);
        self.underruns.store(0, Ordering::SeqCst);
        self.overruns.store(0, Ordering::SeqCst);
        self.mode.store(mode as u32, Ordering::SeqCst);
    }

    pub fn mark_output_ready(
        &self,
        output_sample_rate: u32,
        target_frames: usize,
        output_buffer_frames: u32,
    ) {
        self.output_sample_rate
            .store(output_sample_rate, Ordering::Release);
        self.target_frames
            .store(target_frames as u32, Ordering::Release);
        self.output_buffer_frames
            .store(output_buffer_frames, Ordering::Release);
        self.available.store(true, Ordering::Release);
    }

    pub fn mark_stopped(&self) {
        self.available.store(false, Ordering::Release);
        self.active.store(false, Ordering::Release);
        self.buffered_frames.store(0, Ordering::Release);
    }

    fn update_render_state(&self, buffered_frames: usize, active: bool) {
        self.buffered_frames.store(
            buffered_frames.min(u32::MAX as usize) as u32,
            Ordering::Relaxed,
        );
        self.active.store(active, Ordering::Relaxed);
    }

    fn record_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
    }

    fn record_overrun(&self) {
        self.overruns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MonitorSnapshot {
        let input_rate = self.input_sample_rate.load(Ordering::Relaxed);
        let output_rate = self.output_sample_rate.load(Ordering::Relaxed);
        let buffered = self.buffered_frames.load(Ordering::Relaxed);
        let output_buffer = self.output_buffer_frames.load(Ordering::Relaxed);
        let queue_ms = if input_rate == 0 {
            0.0
        } else {
            buffered as f32 / input_rate as f32 * 1_000.0
        };
        let output_ms = if output_rate == 0 {
            0.0
        } else {
            output_buffer as f32 / output_rate as f32 * 1_000.0
        };
        let mode = if self.mode.load(Ordering::Relaxed) == MonitorMode::Compatible as u32 {
            MonitorMode::Compatible
        } else {
            MonitorMode::LowLatency
        };

        MonitorSnapshot {
            available: self.available.load(Ordering::Relaxed),
            active: self.active.load(Ordering::Relaxed),
            input_sample_rate: input_rate,
            output_sample_rate: output_rate,
            buffered_frames: buffered,
            target_frames: self.target_frames.load(Ordering::Relaxed),
            underruns: self.underruns.load(Ordering::Relaxed),
            overruns: self.overruns.load(Ordering::Relaxed),
            estimated_latency_ms: queue_ms + output_ms,
            mode: mode.as_str(),
        }
    }
}

/// Single-producer/single-consumer PCM ring. Samples use their IEEE-754 bit
/// pattern so the audio callbacks never acquire a mutex or allocate memory.
pub struct MonitorRing {
    samples: Box<[AtomicU32]>,
    capacity: usize,
    write_index: AtomicUsize,
    read_index: AtomicUsize,
    telemetry: Arc<MonitorTelemetry>,
}

impl MonitorRing {
    pub fn new(telemetry: Arc<MonitorTelemetry>) -> Self {
        let samples = (0..RING_CAPACITY)
            .map(|_| AtomicU32::new(0))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        Self {
            samples,
            capacity: RING_CAPACITY,
            write_index: AtomicUsize::new(0),
            read_index: AtomicUsize::new(0),
            telemetry,
        }
    }

    pub fn push(&self, sample: f32) -> bool {
        let write = self.write_index.load(Ordering::Relaxed);
        let next = self.next(write);
        if next == self.read_index.load(Ordering::Acquire) {
            self.telemetry.record_overrun();
            return false;
        }
        self.samples[write].store(sample.to_bits(), Ordering::Relaxed);
        self.write_index.store(next, Ordering::Release);
        true
    }

    pub fn pop(&self) -> Option<f32> {
        let read = self.read_index.load(Ordering::Relaxed);
        if read == self.write_index.load(Ordering::Acquire) {
            return None;
        }
        let sample = f32::from_bits(self.samples[read].load(Ordering::Relaxed));
        self.read_index.store(self.next(read), Ordering::Release);
        Some(sample)
    }

    pub fn available(&self) -> usize {
        let write = self.write_index.load(Ordering::Acquire);
        let read = self.read_index.load(Ordering::Acquire);
        if write >= read {
            write - read
        } else {
            self.capacity - read + write
        }
    }

    pub fn discard(&self, count: usize) {
        for _ in 0..count {
            if self.pop().is_none() {
                break;
            }
        }
    }

    pub fn discard_all(&self) {
        let write = self.write_index.load(Ordering::Acquire);
        self.read_index.store(write, Ordering::Release);
    }

    fn next(&self, index: usize) -> usize {
        if index + 1 == self.capacity {
            0
        } else {
            index + 1
        }
    }
}

pub struct MonitorProcessor {
    ring: Arc<MonitorRing>,
    enabled: Arc<AtomicBool>,
    gain_bits: Arc<AtomicU32>,
    telemetry: Arc<MonitorTelemetry>,
    target_frames: usize,
    nominal_step: f64,
    phase: f64,
    current: f32,
    next: f32,
    primed: bool,
    was_enabled: bool,
    envelope: f32,
    envelope_step: f32,
    high_pass_alpha: f32,
    high_pass_previous_input: f32,
    high_pass_previous_output: f32,
}

impl MonitorProcessor {
    pub fn new(
        ring: Arc<MonitorRing>,
        enabled: Arc<AtomicBool>,
        gain_bits: Arc<AtomicU32>,
        telemetry: Arc<MonitorTelemetry>,
        input_sample_rate: u32,
        output_sample_rate: u32,
        mode: MonitorMode,
    ) -> Self {
        let target_frames = ((input_sample_rate as f32 * mode.target_ms()) / 1_000.0)
            .round()
            .max(64.0) as usize;
        let output_rate = output_sample_rate.max(1) as f32;
        let initially_enabled = enabled.load(Ordering::Relaxed);
        Self {
            ring,
            enabled,
            gain_bits,
            telemetry,
            target_frames,
            nominal_step: input_sample_rate as f64 / output_sample_rate.max(1) as f64,
            phase: 0.0,
            current: 0.0,
            next: 0.0,
            primed: false,
            was_enabled: initially_enabled,
            envelope: 0.0,
            envelope_step: (1.0 / (output_rate * FADE_MS / 1_000.0)).min(1.0),
            high_pass_alpha: (-2.0 * PI * HIGH_PASS_HZ / output_rate).exp(),
            high_pass_previous_input: 0.0,
            high_pass_previous_output: 0.0,
        }
    }

    #[cfg(test)]
    pub fn target_frames(&self) -> usize {
        self.target_frames
    }

    pub fn render_interleaved<T, F>(&mut self, data: &mut [T], channels: usize, mut map: F)
    where
        T: Copy,
        F: FnMut(f32) -> T,
    {
        if !self.enabled.load(Ordering::Relaxed) && self.envelope <= 0.0 {
            self.ring.discard_all();
            self.reset_resampler();
            let silence = map(0.0);
            data.fill(silence);
            self.telemetry.update_render_state(0, false);
            return;
        }
        for frame in data.chunks_mut(channels.max(1)) {
            let sample = map(self.next_output_sample());
            for output in frame {
                *output = sample;
            }
        }
        self.telemetry
            .update_render_state(self.ring.available(), self.envelope > 0.0 && self.primed);
    }

    fn next_output_sample(&mut self) -> f32 {
        let enabled = self.enabled.load(Ordering::Relaxed);
        if enabled && !self.was_enabled {
            // Samples captured while monitoring was off are stale. Always begin
            // from a fresh, bounded prefill so toggling on cannot play old audio.
            self.ring.discard_all();
            self.reset_resampler();
        }
        self.was_enabled = enabled;

        if !enabled && self.envelope <= 0.0 {
            self.ring.discard_all();
            self.reset_resampler();
            return 0.0;
        }

        if !self.primed {
            if !enabled || self.ring.available() < self.target_frames + 2 {
                return 0.0;
            }
            let available = self.ring.available();
            if available > self.target_frames * 3 {
                self.ring.discard(available - self.target_frames);
            }
            let Some(current) = self.ring.pop() else {
                return 0.0;
            };
            let Some(next) = self.ring.pop() else {
                return 0.0;
            };
            self.current = current;
            self.next = next;
            self.phase = 0.0;
            self.primed = true;
        }

        let raw = self.current + (self.next - self.current) * self.phase as f32;
        let available = self.ring.available();
        let normalized_error =
            (available as f64 - self.target_frames as f64) / self.target_frames.max(1) as f64;
        let correction = (normalized_error * CLOCK_CORRECTION_GAIN)
            .clamp(-MAX_CLOCK_CORRECTION, MAX_CLOCK_CORRECTION);
        self.phase += self.nominal_step * (1.0 + correction);

        while self.phase >= 1.0 {
            self.current = self.next;
            let Some(next) = self.ring.pop() else {
                self.telemetry.record_underrun();
                self.reset_resampler();
                self.envelope = 0.0;
                return 0.0;
            };
            self.next = next;
            self.phase -= 1.0;
        }

        let target_envelope = if enabled { 1.0 } else { 0.0 };
        if self.envelope < target_envelope {
            self.envelope = (self.envelope + self.envelope_step).min(target_envelope);
        } else if self.envelope > target_envelope {
            self.envelope = (self.envelope - self.envelope_step).max(target_envelope);
        }

        let filtered = self.high_pass(raw);
        let gain = f32::from_bits(self.gain_bits.load(Ordering::Relaxed));
        soft_limit(filtered * gain) * self.envelope
    }

    fn high_pass(&mut self, input: f32) -> f32 {
        let output = self.high_pass_alpha
            * (self.high_pass_previous_output + input - self.high_pass_previous_input);
        self.high_pass_previous_input = input;
        self.high_pass_previous_output = output;
        output
    }

    fn reset_resampler(&mut self) {
        self.phase = 0.0;
        self.current = 0.0;
        self.next = 0.0;
        self.primed = false;
        self.high_pass_previous_input = 0.0;
        self.high_pass_previous_output = 0.0;
    }
}

fn soft_limit(sample: f32) -> f32 {
    const THRESHOLD: f32 = 0.92;
    let magnitude = sample.abs();
    if magnitude <= THRESHOLD {
        return sample;
    }
    let headroom = 1.0 - THRESHOLD;
    let excess = magnitude - THRESHOLD;
    sample.signum() * (THRESHOLD + headroom * excess / (excess + headroom))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn harness(
        input_rate: u32,
        output_rate: u32,
        mode: MonitorMode,
    ) -> (
        Arc<MonitorRing>,
        Arc<AtomicBool>,
        Arc<MonitorTelemetry>,
        MonitorProcessor,
    ) {
        let telemetry = Arc::new(MonitorTelemetry::default());
        telemetry.reset(input_rate, mode);
        let ring = Arc::new(MonitorRing::new(Arc::clone(&telemetry)));
        let enabled = Arc::new(AtomicBool::new(true));
        let gain = Arc::new(AtomicU32::new(1.0f32.to_bits()));
        let processor = MonitorProcessor::new(
            Arc::clone(&ring),
            Arc::clone(&enabled),
            gain,
            Arc::clone(&telemetry),
            input_rate,
            output_rate,
            mode,
        );
        (ring, enabled, telemetry, processor)
    }

    #[test]
    fn ring_preserves_order_and_counts_overruns() {
        let telemetry = Arc::new(MonitorTelemetry::default());
        let ring = MonitorRing::new(Arc::clone(&telemetry));
        for value in 0..(RING_CAPACITY - 1) {
            assert!(ring.push(value as f32));
        }
        assert!(!ring.push(99.0));
        for expected in 0..(RING_CAPACITY - 1) {
            assert_eq!(ring.pop(), Some(expected as f32));
        }
        assert_eq!(ring.pop(), None);
        assert_eq!(telemetry.snapshot().overruns, 1);
    }

    #[test]
    fn resamples_mismatched_devices_without_runaway_latency() {
        let (ring, _, telemetry, mut processor) = harness(44_100, 48_000, MonitorMode::LowLatency);
        let target = processor.target_frames();
        let mut phase = 0.0f32;
        let mut rendered = vec![0.0f32; 480];

        for _ in 0..200 {
            for _ in 0..441 {
                ring.push((phase * 2.0 * PI).sin() * 0.2);
                phase = (phase + 440.0 / 44_100.0).fract();
            }
            processor.render_interleaved(&mut rendered, 1, |sample| sample);
        }

        let buffered = ring.available();
        assert!(
            buffered < target * 3,
            "buffer ran away to {buffered} frames"
        );
        assert_eq!(telemetry.snapshot().overruns, 0);
        assert!(rendered.iter().any(|sample| sample.abs() > 0.01));
    }

    #[test]
    fn adaptive_clock_control_bounds_a_long_running_fast_input() {
        let (ring, _, telemetry, mut processor) = harness(48_000, 48_000, MonitorMode::LowLatency);
        let target = processor.target_frames();
        for _ in 0..(target + 2) {
            ring.push(0.1);
        }
        let mut output = vec![0.0f32; 480];

        // A 481:480 producer/consumer skew is ~2,083 ppm, much larger than
        // normal independent audio clock drift. One simulated minute must
        // remain bounded without allowing latency to grow toward ring capacity.
        for _ in 0..6_000 {
            for _ in 0..481 {
                ring.push(0.1);
            }
            processor.render_interleaved(&mut output, 1, |sample| sample);
        }

        assert!(ring.available() < target * 3);
        assert_eq!(telemetry.snapshot().overruns, 0);
    }

    #[test]
    fn monitor_toggle_discards_stale_audio_and_fades_in() {
        let (ring, enabled, _, mut processor) = harness(48_000, 48_000, MonitorMode::LowLatency);
        for _ in 0..2_000 {
            ring.push(0.5);
        }
        let mut first = vec![0.0f32; 128];
        processor.render_interleaved(&mut first, 1, |sample| sample);
        assert!(first[0].abs() < first[127].abs());

        enabled.store(false, Ordering::Relaxed);
        let mut release = vec![0.0f32; 512];
        processor.render_interleaved(&mut release, 1, |sample| sample);
        assert_eq!(*release.last().unwrap(), 0.0);
    }

    #[test]
    fn limiter_keeps_boosted_monitor_audio_below_full_scale() {
        assert!(soft_limit(2.0) < 1.0);
        assert!(soft_limit(-2.0) > -1.0);
        assert_eq!(soft_limit(0.5), 0.5);
    }

    #[test]
    fn low_latency_mode_requests_the_smallest_safe_buffer() {
        assert_eq!(
            stream_buffer_size(
                &SupportedBufferSize::Range { min: 64, max: 512 },
                MonitorMode::LowLatency,
            ),
            BufferSize::Fixed(128)
        );
        assert_eq!(
            stream_buffer_size(
                &SupportedBufferSize::Range {
                    min: 256,
                    max: 1_024
                },
                MonitorMode::LowLatency,
            ),
            BufferSize::Fixed(256)
        );
        assert_eq!(
            stream_buffer_size(
                &SupportedBufferSize::Range { min: 64, max: 512 },
                MonitorMode::Compatible,
            ),
            BufferSize::Default
        );
    }
}
