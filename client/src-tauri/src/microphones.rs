use crate::monitor::{
    DEFAULT_MONITOR_GAIN, MAX_MONITOR_GAIN, MonitorMode, MonitorProcessor, MonitorRing,
    MonitorTelemetry, stream_buffer_size,
};
use crate::native_pitch::{NativePitchFrame, NativePitchTracker};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;
use tracing::{info, warn};
use ts_rs::TS;

/// Worker drains the cpal queue in fixed-size chunks before forwarding to the
/// JS side; smaller chunks lower IPC latency at the cost of more sends/sec.
const SAMPLE_CHUNK: usize = 512;
const PCM_QUEUE_CAP: usize = 24_000;
const PRE_ROLL_SECONDS: usize = 1;

static MONITOR_GAIN_BITS: once_cell::sync::Lazy<Arc<AtomicU32>> =
    once_cell::sync::Lazy::new(|| Arc::new(AtomicU32::new(DEFAULT_MONITOR_GAIN.to_bits())));
static MONITOR_TELEMETRY: once_cell::sync::Lazy<Arc<MonitorTelemetry>> =
    once_cell::sync::Lazy::new(|| Arc::new(MonitorTelemetry::default()));
static MIC_SAMPLE_RATE: AtomicU32 = AtomicU32::new(0);
static MIC_INPUT_SAMPLES: AtomicU64 = AtomicU64::new(0);
static MIC_SENT_FRAMES: AtomicU64 = AtomicU64::new(0);
static MIC_SEND_ERRORS: AtomicU64 = AtomicU64::new(0);
static MIC_PITCH_FRAMES: AtomicU64 = AtomicU64::new(0);
static MIC_PITCH_ERRORS: AtomicU64 = AtomicU64::new(0);
static MIC_LATEST_RMS_BITS: AtomicU32 = AtomicU32::new(0);
static MIC_LATEST_PEAK_BITS: AtomicU32 = AtomicU32::new(0);
static RECORDER_PAUSED: AtomicBool = AtomicBool::new(false);
static RECORDER_OVERRUN: AtomicBool = AtomicBool::new(false);
static RECORDER_DEVICE_LOST: AtomicBool = AtomicBool::new(false);
static RECORDER_CAPTURED_SAMPLES: AtomicU64 = AtomicU64::new(0);
const RECORDING_QUEUE_CHUNKS: usize = 256;

type RecordingSender = SyncSender<Vec<f32>>;
type SharedRecordingSender = Arc<Mutex<Option<RecordingSender>>>;
type InputPusher = Arc<dyn Fn(&[f32]) + Send + Sync>;

struct RecorderRuntime {
    take: app_core::RecordingTake,
    handle: JoinHandle<Result<(), String>>,
}

static RECORDER_SENDER: once_cell::sync::Lazy<SharedRecordingSender> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static PRE_ROLL: once_cell::sync::Lazy<Arc<Mutex<VecDeque<f32>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(VecDeque::new())));
static RECORDER: once_cell::sync::Lazy<Mutex<Option<RecorderRuntime>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
static RECORDER_WRITE_ERROR: once_cell::sync::Lazy<Mutex<Option<String>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
static RECORDER_OP_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

#[tauri::command]
pub fn set_monitor_gain(gain: f32) {
    let clamped = gain.clamp(0.0, MAX_MONITOR_GAIN);
    MONITOR_GAIN_BITS.store(clamped.to_bits(), Ordering::Relaxed);
}

#[tauri::command]
pub fn set_monitor_enabled(enabled: bool) {
    MONITOR_ENABLED.store(enabled, Ordering::SeqCst);
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MicrophoneInfo {
    pub name: String,
}

/// Mono PCM frame streamed from Rust to JS for recording diagnostics, latency
/// calibration, and reactive visuals. Desktop pitch detection runs natively.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MicSampleFrame {
    pub sample_rate: u32,
    #[ts(type = "number")]
    pub sample_index: u64,
    pub samples: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MicCaptureStatus {
    pub running: bool,
    pub channel_attached: bool,
    pub sample_rate: u32,
    #[ts(type = "number")]
    pub input_samples: u64,
    #[ts(type = "number")]
    pub sent_frames: u64,
    #[ts(type = "number")]
    pub send_errors: u64,
    #[ts(type = "number")]
    pub pitch_frames: u64,
    #[ts(type = "number")]
    pub pitch_errors: u64,
    pub rms: f32,
    pub peak: f32,
    pub monitor_requested: bool,
    pub monitor_available: bool,
    pub monitor_active: bool,
    pub monitor_input_sample_rate: u32,
    pub monitor_output_sample_rate: u32,
    pub monitor_buffered_frames: u32,
    pub monitor_target_frames: u32,
    #[ts(type = "number")]
    pub monitor_underruns: u64,
    #[ts(type = "number")]
    pub monitor_overruns: u64,
    pub monitor_estimated_latency_ms: f32,
    pub monitor_mode: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct VocalRecordingStatus {
    pub active: bool,
    pub paused: bool,
    pub sample_rate: u32,
    #[ts(type = "number")]
    pub captured_samples: u64,
    pub overrun: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct MicCaptureOptions {
    pub emit_audio: bool,
    pub monitor_mode: Option<String>,
}

fn device_display_name(device: &cpal::Device) -> String {
    device.name().unwrap_or_else(|_| "(unknown)".into())
}

#[tauri::command]
pub fn list_microphones() -> Result<Vec<MicrophoneInfo>, String> {
    let host = cpal::default_host();
    let devices = host
        .input_devices()
        .map_err(|e| format!("input devices: {e}"))?;

    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();

    for device in devices {
        if device.default_input_config().is_err() {
            continue;
        }
        let name = device_display_name(&device);
        let key = name.to_lowercase();
        if seen.insert(key) {
            out.push(MicrophoneInfo { name });
        }
    }

    Ok(out)
}

#[tauri::command]
pub fn get_mic_capture_status() -> MicCaptureStatus {
    let monitor = MONITOR_TELEMETRY.snapshot();
    MicCaptureStatus {
        running: MIC_RUNNING.load(Ordering::Relaxed),
        channel_attached: MIC_CHANNEL
            .lock()
            .map(|channel| channel.is_some())
            .unwrap_or(false),
        sample_rate: MIC_SAMPLE_RATE.load(Ordering::Relaxed),
        input_samples: MIC_INPUT_SAMPLES.load(Ordering::Relaxed),
        sent_frames: MIC_SENT_FRAMES.load(Ordering::Relaxed),
        send_errors: MIC_SEND_ERRORS.load(Ordering::Relaxed),
        pitch_frames: MIC_PITCH_FRAMES.load(Ordering::Relaxed),
        pitch_errors: MIC_PITCH_ERRORS.load(Ordering::Relaxed),
        rms: f32::from_bits(MIC_LATEST_RMS_BITS.load(Ordering::Relaxed)),
        peak: f32::from_bits(MIC_LATEST_PEAK_BITS.load(Ordering::Relaxed)),
        monitor_requested: MONITOR_ENABLED.load(Ordering::Relaxed),
        monitor_available: monitor.available,
        monitor_active: monitor.active,
        monitor_input_sample_rate: monitor.input_sample_rate,
        monitor_output_sample_rate: monitor.output_sample_rate,
        monitor_buffered_frames: monitor.buffered_frames,
        monitor_target_frames: monitor.target_frames,
        monitor_underruns: monitor.underruns,
        monitor_overruns: monitor.overruns,
        monitor_estimated_latency_ms: monitor.estimated_latency_ms,
        monitor_mode: monitor.mode.to_string(),
    }
}

#[tauri::command]
pub fn get_latest_mic_samples() -> Option<MicSampleFrame> {
    let sample_rate = MIC_SAMPLE_RATE.load(Ordering::Relaxed);
    if !MIC_RUNNING.load(Ordering::Relaxed) || sample_rate == 0 {
        return None;
    }

    let pre_roll = PRE_ROLL.lock().ok()?;
    if pre_roll.len() < 2_048 {
        return None;
    }
    let start = pre_roll.len() - 2_048;
    let samples: Vec<f32> = pre_roll.iter().skip(start).copied().collect();
    let end_index = MIC_INPUT_SAMPLES.load(Ordering::Relaxed);

    Some(MicSampleFrame {
        sample_rate,
        sample_index: end_index.saturating_sub(samples.len() as u64),
        samples,
    })
}

#[tauri::command]
pub fn get_vocal_recording_status() -> VocalRecordingStatus {
    VocalRecordingStatus {
        active: RECORDER
            .lock()
            .map(|recorder| recorder.is_some())
            .unwrap_or(false),
        paused: RECORDER_PAUSED.load(Ordering::Relaxed),
        sample_rate: MIC_SAMPLE_RATE.load(Ordering::Relaxed),
        captured_samples: RECORDER_CAPTURED_SAMPLES.load(Ordering::Relaxed),
        overrun: RECORDER_OVERRUN.load(Ordering::Relaxed),
        error: RECORDER_WRITE_ERROR
            .lock()
            .ok()
            .and_then(|error| error.clone()),
    }
}

fn i16_to_f32(sample: i16) -> f32 {
    sample as f32 / i16::MAX as f32
}

fn i32_to_f32(sample: i32) -> f32 {
    sample as f32 / i32::MAX as f32
}

fn f32_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

fn f32_to_u16(sample: f32) -> u16 {
    ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * u16::MAX as f32) as u16
}

fn f32_to_i32(sample: f32) -> i32 {
    (sample.clamp(-1.0, 1.0) * i32::MAX as f32) as i32
}

fn f32_to_u32(sample: f32) -> u32 {
    ((sample.clamp(-1.0, 1.0) * 0.5 + 0.5) * u32::MAX as f32) as u32
}

fn push_mapped_input<T, F>(data: &[T], push: &InputPusher, mut map: F)
where
    T: Copy,
    F: FnMut(T) -> f32,
{
    let floats: Vec<f32> = data.iter().copied().map(&mut map).collect();
    push(&floats);
}

fn report_input_stream_error(error: cpal::StreamError) {
    warn!("[mic] input stream error: {error}");
    MIC_RUNNING.store(false, Ordering::SeqCst);
    RECORDER_DEVICE_LOST.store(true, Ordering::SeqCst);
}

fn report_monitor_stream_error(error: cpal::StreamError) {
    warn!("[mic] monitor output stream error: {error}");
    MONITOR_TELEMETRY.mark_stopped();
}

static MIC_RUNNING: AtomicBool = AtomicBool::new(false);
static MIC_SHUTDOWN: once_cell::sync::Lazy<Arc<AtomicBool>> =
    once_cell::sync::Lazy::new(|| Arc::new(AtomicBool::new(false)));
static MONITOR_ENABLED: once_cell::sync::Lazy<Arc<AtomicBool>> =
    once_cell::sync::Lazy::new(|| Arc::new(AtomicBool::new(false)));
static MIC_CHANNEL: once_cell::sync::Lazy<Arc<Mutex<Option<Channel<MicSampleFrame>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static MIC_PITCH_CHANNEL: once_cell::sync::Lazy<Arc<Mutex<Option<Channel<NativePitchFrame>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));
static MIC_THREAD: once_cell::sync::Lazy<Mutex<Option<JoinHandle<()>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));
/// Serializes start/stop so concurrent IPC dispatches can't interleave a
/// teardown with a fresh spawn.
static MIC_OP_LOCK: once_cell::sync::Lazy<Mutex<()>> =
    once_cell::sync::Lazy::new(|| Mutex::new(()));

fn take_mic_thread() -> Option<JoinHandle<()>> {
    MIC_THREAD.lock().unwrap_or_else(|p| p.into_inner()).take()
}

fn stop_internal() {
    MIC_SHUTDOWN.store(true, Ordering::SeqCst);
    MONITOR_ENABLED.store(false, Ordering::SeqCst);
    MONITOR_TELEMETRY.mark_stopped();
    /*
     * Drop the channel before joining: this triggers Tauri's `Channel` Drop,
     * which sends `{end: true}` to JS so the callback id is unregistered
     * cleanly. The mic loop also gets `None` next iteration and stops sending.
     */
    if let Ok(mut slot) = MIC_CHANNEL.lock() {
        *slot = None;
    }
    if let Ok(mut slot) = MIC_PITCH_CHANNEL.lock() {
        *slot = None;
    }
    if let Some(handle) = take_mic_thread() {
        let _ = handle.join();
    }
    MIC_RUNNING.store(false, Ordering::SeqCst);
    MIC_SAMPLE_RATE.store(0, Ordering::SeqCst);
    MIC_INPUT_SAMPLES.store(0, Ordering::SeqCst);
    MIC_SENT_FRAMES.store(0, Ordering::SeqCst);
    MIC_SEND_ERRORS.store(0, Ordering::SeqCst);
    MIC_PITCH_FRAMES.store(0, Ordering::SeqCst);
    MIC_PITCH_ERRORS.store(0, Ordering::SeqCst);
    MIC_LATEST_RMS_BITS.store(0, Ordering::SeqCst);
    MIC_LATEST_PEAK_BITS.store(0, Ordering::SeqCst);
    PRE_ROLL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clear();
}

#[tauri::command]
pub fn start_vocal_recording(
    request: app_core::RecordingRequest,
) -> Result<app_core::RecordingTake, String> {
    let _guard = RECORDER_OP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = RECORDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
    {
        return Ok(runtime.take.clone());
    }
    if !MIC_RUNNING.load(Ordering::SeqCst) {
        return Err("Start the microphone before recording".into());
    }
    let sample_rate = MIC_SAMPLE_RATE.load(Ordering::SeqCst);
    if sample_rate == 0 {
        return Err("Microphone sample rate is not ready".into());
    }

    let pre_roll = PRE_ROLL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .copied()
        .collect::<Vec<_>>();
    let take = app_core::prepare_recording(request, sample_rate, pre_roll.len() as u64)?;
    let partial_path = take.partial_path.clone();
    let final_path = take.vocal_path.clone();
    let (sender, receiver) = sync_channel::<Vec<f32>>(RECORDING_QUEUE_CHUNKS);
    RECORDER_OVERRUN.store(false, Ordering::SeqCst);
    RECORDER_DEVICE_LOST.store(false, Ordering::SeqCst);
    RECORDER_PAUSED.store(false, Ordering::SeqCst);
    RECORDER_CAPTURED_SAMPLES.store(0, Ordering::SeqCst);
    *RECORDER_WRITE_ERROR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    if !pre_roll.is_empty() {
        sender
            .send(pre_roll)
            .map_err(|_| "Could not queue the recording pre-roll".to_string())?;
    }

    let handle = std::thread::spawn(move || {
        let result = write_recording_stream(&partial_path, &final_path, sample_rate, receiver);
        if let Err(error) = &result {
            *RECORDER_WRITE_ERROR
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.clone());
        }
        result
    });

    *RECORDER_SENDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(sender);
    *RECORDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(RecorderRuntime {
        take: take.clone(),
        handle,
    });
    Ok(take)
}

fn write_recording_stream(
    partial_path: &str,
    final_path: &str,
    sample_rate: u32,
    receiver: Receiver<Vec<f32>>,
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(partial_path, spec)
        .map_err(|error| format!("Could not create vocal recording: {error}"))?;
    for samples in receiver {
        for sample in samples {
            let pcm = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
            writer
                .write_sample(pcm)
                .map_err(|error| format!("Could not write vocal recording: {error}"))?;
        }
    }
    writer
        .finalize()
        .map_err(|error| format!("Could not finalize vocal recording: {error}"))?;
    if std::path::Path::new(final_path).exists() {
        std::fs::remove_file(final_path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(partial_path, final_path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn pause_vocal_recording() {
    RECORDER_PAUSED.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub fn resume_vocal_recording() {
    RECORDER_PAUSED.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn stop_vocal_recording() -> Result<Option<app_core::RecordingTake>, String> {
    let _guard = RECORDER_OP_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *RECORDER_SENDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    let Some(runtime) = RECORDER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    else {
        return Ok(None);
    };
    let mut take = runtime.take;
    let writer_result = runtime
        .handle
        .join()
        .map_err(|_| "Vocal recording writer stopped unexpectedly".to_string())?;
    let overrun = RECORDER_OVERRUN.swap(false, Ordering::SeqCst);
    let device_lost = RECORDER_DEVICE_LOST.swap(false, Ordering::SeqCst);
    take.recorded_samples = RECORDER_CAPTURED_SAMPLES.swap(0, Ordering::SeqCst);
    RECORDER_PAUSED.store(false, Ordering::SeqCst);
    match writer_result {
        Ok(()) if recording_completion_error(overrun, device_lost).is_none() => {
            take.status = "recorded".into();
            take.error = None;
            app_core::update_recording_take(&take)?;
            Ok(Some(take))
        }
        Ok(()) => {
            take.status = "failed".into();
            take.error = recording_completion_error(overrun, device_lost).map(str::to_string);
            app_core::update_recording_take(&take)?;
            Ok(Some(take))
        }
        Err(error) => {
            take.status = "failed".into();
            take.error = Some(error.clone());
            app_core::update_recording_take(&take)?;
            Err(error)
        }
    }
}

fn recording_completion_error(overrun: bool, device_lost: bool) -> Option<&'static str> {
    if device_lost {
        Some("The microphone was disconnected during recording")
    } else if overrun {
        Some("Recording could not keep up with the microphone stream")
    } else {
        None
    }
}

pub(crate) fn find_device(preferred: Option<&str>) -> Result<(cpal::Device, String), String> {
    let host = cpal::default_host();

    if let Some(name) = preferred {
        let devices = host
            .input_devices()
            .map_err(|e| format!("input devices: {e}"))?;
        for dev in devices {
            if device_display_name(&dev) == name {
                return Ok((dev, name.to_string()));
            }
        }
        return Err(format!("Microphone '{name}' not found"));
    }

    let device = host
        .default_input_device()
        .ok_or_else(|| "No default microphone found".to_string())?;
    let name = device_display_name(&device);
    Ok((device, name))
}

#[tauri::command]
pub async fn start_mic_capture(
    preferred: Option<String>,
    options: Option<MicCaptureOptions>,
    on_samples: Channel<MicSampleFrame>,
    on_pitch: Channel<NativePitchFrame>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        start_mic_capture_inner(preferred, options, on_samples, on_pitch)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn start_mic_capture_inner(
    preferred: Option<String>,
    options: Option<MicCaptureOptions>,
    on_samples: Channel<MicSampleFrame>,
    on_pitch: Channel<NativePitchFrame>,
) -> Result<String, String> {
    let _guard = MIC_OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    /*
     * Always tear down any prior session first. We used to short-circuit with
     * "already running" if MIC_RUNNING was true, but that hit a race where
     * the previous worker had already broken out on shutdown but not yet
     * cleared MIC_RUNNING — the new start would skip spawning, and capture
     * would silently die for the rest of the session.
     */
    stop_internal();

    let next_options = options.unwrap_or_default();
    MONITOR_ENABLED.store(next_options.emit_audio, Ordering::SeqCst);
    let monitor_mode = MonitorMode::from_config(next_options.monitor_mode.as_deref());

    let (device, name) = match find_device(preferred.as_deref()) {
        Ok(pair) => pair,
        Err(e) => {
            MONITOR_ENABLED.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    if let Ok(mut slot) = MIC_CHANNEL.lock() {
        *slot = Some(on_samples);
    }
    if let Ok(mut slot) = MIC_PITCH_CHANNEL.lock() {
        *slot = Some(on_pitch);
    }

    MIC_SHUTDOWN.store(false, Ordering::SeqCst);
    MIC_RUNNING.store(true, Ordering::SeqCst);

    let device_name = name.clone();
    let shutdown = Arc::clone(&MIC_SHUTDOWN);
    let (startup_tx, startup_rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        run_mic_loop(device, &name, shutdown, monitor_mode, startup_tx);
        MIC_RUNNING.store(false, Ordering::SeqCst);
    });

    if let Ok(mut slot) = MIC_THREAD.lock() {
        *slot = Some(handle);
    }

    match startup_rx.recv_timeout(std::time::Duration::from_secs(10)) {
        Ok(Ok(())) => {}
        result => {
            MIC_SHUTDOWN.store(true, Ordering::SeqCst);
            MONITOR_ENABLED.store(false, Ordering::SeqCst);
            return Err(match result {
                Ok(Err(error)) => error,
                Err(error) => format!("Microphone failed to start: {error}"),
                Ok(Ok(())) => unreachable!(),
            });
        }
    }

    Ok(device_name)
}

fn try_build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    pcm_shared: Arc<Mutex<VecDeque<f32>>>,
    monitor_ring: Arc<MonitorRing>,
) -> Option<cpal::Stream> {
    let ch = config.channels as usize;
    let pre_roll_capacity = config.sample_rate.0 as usize * PRE_ROLL_SECONDS;
    let push_samples: InputPusher = {
        let pcm_cb = Arc::clone(&pcm_shared);
        let monitor_cb = Arc::clone(&monitor_ring);
        Arc::new(move |data: &[f32]| {
            let mut mono_samples = Vec::with_capacity(data.len() / ch.max(1));
            for chunk in data.chunks(ch) {
                mono_samples.push(chunk.iter().sum::<f32>() / ch as f32);
            }
            MIC_INPUT_SAMPLES.fetch_add(mono_samples.len() as u64, Ordering::Relaxed);

            if let Ok(mut pre_roll) = PRE_ROLL.try_lock() {
                pre_roll.extend(mono_samples.iter().copied());
                let overflow = pre_roll.len().saturating_sub(pre_roll_capacity);
                if overflow > 0 {
                    pre_roll.drain(..overflow);
                }
            }

            if let Ok(mut q) = pcm_cb.try_lock() {
                for sample in &mono_samples {
                    q.push_back(*sample);
                }
                while q.len() > PCM_QUEUE_CAP {
                    q.pop_front();
                }
            }

            if MONITOR_ENABLED.load(Ordering::Relaxed) {
                for sample in &mono_samples {
                    monitor_cb.push(*sample);
                }
            }

            if !RECORDER_PAUSED.load(Ordering::Relaxed) {
                if let Ok(slot) = RECORDER_SENDER.try_lock() {
                    if let Some(sender) = slot.as_ref() {
                        match sender.try_send(mono_samples.clone()) {
                            Ok(()) => {
                                RECORDER_CAPTURED_SAMPLES
                                    .fetch_add(mono_samples.len() as u64, Ordering::Relaxed);
                            }
                            Err(TrySendError::Full(_)) => {
                                RECORDER_OVERRUN.store(true, Ordering::SeqCst);
                            }
                            Err(TrySendError::Disconnected(_)) => {}
                        }
                    }
                }
            }
        })
    };

    use cpal::SampleFormat;
    let build = |next_config: &cpal::StreamConfig| match sample_format {
        SampleFormat::F32 => {
            let push = Arc::clone(&push_samples);
            device.build_input_stream(
                next_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| push(data),
                report_input_stream_error,
                None,
            )
        }
        SampleFormat::I16 => {
            let push = Arc::clone(&push_samples);
            device.build_input_stream(
                next_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    push_mapped_input(data, &push, i16_to_f32);
                },
                report_input_stream_error,
                None,
            )
        }
        SampleFormat::I32 => {
            let push = Arc::clone(&push_samples);
            device.build_input_stream(
                next_config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    push_mapped_input(data, &push, i32_to_f32);
                },
                report_input_stream_error,
                None,
            )
        }
        _ => unreachable!("unsupported input sample format"),
    };

    if !matches!(
        sample_format,
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
    ) {
        return None;
    }
    let mut stream = build(config);
    if stream.is_err() && matches!(config.buffer_size, cpal::BufferSize::Fixed(_)) {
        let mut fallback = config.clone();
        fallback.buffer_size = cpal::BufferSize::Default;
        warn!("[mic] low-latency input buffer unavailable; retrying the device default");
        stream = build(&fallback);
    }
    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            warn!("[mic] build stream failed: {e}");
            return None;
        }
    };

    if let Err(e) = stream.play() {
        warn!("[mic] play failed: {e}");
        return None;
    }

    Some(stream)
}

fn try_build_output_stream(
    device: &cpal::Device,
    monitor_ring: Arc<MonitorRing>,
    input_sample_rate: u32,
    mode: MonitorMode,
) -> Option<cpal::Stream> {
    try_build_output_stream_with_buffer(device, monitor_ring, input_sample_rate, mode, false)
}

fn try_build_output_stream_with_buffer(
    device: &cpal::Device,
    monitor_ring: Arc<MonitorRing>,
    input_sample_rate: u32,
    mode: MonitorMode,
    force_default_buffer: bool,
) -> Option<cpal::Stream> {
    let default_cfg = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            warn!("[mic] output config error: {e}");
            return None;
        }
    };
    let sample_format = default_cfg.sample_format();
    let selected_buffer = if force_default_buffer {
        cpal::BufferSize::Default
    } else {
        stream_buffer_size(default_cfg.buffer_size(), mode)
    };
    let config = cpal::StreamConfig {
        channels: default_cfg.channels(),
        sample_rate: default_cfg.sample_rate(),
        buffer_size: selected_buffer,
    };
    let ch = config.channels as usize;
    let output_sample_rate = config.sample_rate.0;
    let output_buffer_frames = match config.buffer_size {
        cpal::BufferSize::Fixed(frames) => frames,
        cpal::BufferSize::Default => 0,
    };

    use cpal::SampleFormat;
    let stream = match sample_format {
        SampleFormat::F32 => {
            let mut processor = MonitorProcessor::new(
                Arc::clone(&monitor_ring),
                Arc::clone(&MONITOR_ENABLED),
                Arc::clone(&MONITOR_GAIN_BITS),
                Arc::clone(&MONITOR_TELEMETRY),
                input_sample_rate,
                output_sample_rate,
                mode,
            );
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    processor.render_interleaved(data, ch, |sample| sample);
                },
                report_monitor_stream_error,
                None,
            )
        }
        SampleFormat::I16 => {
            let mut processor = MonitorProcessor::new(
                Arc::clone(&monitor_ring),
                Arc::clone(&MONITOR_ENABLED),
                Arc::clone(&MONITOR_GAIN_BITS),
                Arc::clone(&MONITOR_TELEMETRY),
                input_sample_rate,
                output_sample_rate,
                mode,
            );
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    processor.render_interleaved(data, ch, f32_to_i16);
                },
                report_monitor_stream_error,
                None,
            )
        }
        SampleFormat::U16 => {
            let mut processor = MonitorProcessor::new(
                Arc::clone(&monitor_ring),
                Arc::clone(&MONITOR_ENABLED),
                Arc::clone(&MONITOR_GAIN_BITS),
                Arc::clone(&MONITOR_TELEMETRY),
                input_sample_rate,
                output_sample_rate,
                mode,
            );
            device.build_output_stream(
                &config,
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                    processor.render_interleaved(data, ch, f32_to_u16);
                },
                report_monitor_stream_error,
                None,
            )
        }
        SampleFormat::I32 => {
            let mut processor = MonitorProcessor::new(
                Arc::clone(&monitor_ring),
                Arc::clone(&MONITOR_ENABLED),
                Arc::clone(&MONITOR_GAIN_BITS),
                Arc::clone(&MONITOR_TELEMETRY),
                input_sample_rate,
                output_sample_rate,
                mode,
            );
            device.build_output_stream(
                &config,
                move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
                    processor.render_interleaved(data, ch, f32_to_i32);
                },
                report_monitor_stream_error,
                None,
            )
        }
        SampleFormat::U32 => {
            let mut processor = MonitorProcessor::new(
                Arc::clone(&monitor_ring),
                Arc::clone(&MONITOR_ENABLED),
                Arc::clone(&MONITOR_GAIN_BITS),
                Arc::clone(&MONITOR_TELEMETRY),
                input_sample_rate,
                output_sample_rate,
                mode,
            );
            device.build_output_stream(
                &config,
                move |data: &mut [u32], _: &cpal::OutputCallbackInfo| {
                    processor.render_interleaved(data, ch, f32_to_u32);
                },
                report_monitor_stream_error,
                None,
            )
        }
        _ => {
            warn!("[mic] unsupported output sample format: {sample_format:?}");
            return None;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            if !force_default_buffer && matches!(config.buffer_size, cpal::BufferSize::Fixed(_)) {
                warn!("[mic] low-latency output buffer unavailable; retrying the device default");
                return try_build_output_stream_with_buffer(
                    device,
                    monitor_ring,
                    input_sample_rate,
                    mode,
                    true,
                );
            }
            warn!("[mic] build output stream failed: {e}");
            return None;
        }
    };
    if let Err(e) = stream.play() {
        if !force_default_buffer && matches!(config.buffer_size, cpal::BufferSize::Fixed(_)) {
            warn!("[mic] low-latency output start failed; retrying the device default");
            return try_build_output_stream_with_buffer(
                device,
                monitor_ring,
                input_sample_rate,
                mode,
                true,
            );
        }
        warn!("[mic] output play failed: {e}");
        return None;
    }
    let target_frames = ((input_sample_rate as f32 * mode.target_ms()) / 1_000.0).round() as usize;
    MONITOR_TELEMETRY.mark_output_ready(
        output_sample_rate,
        target_frames.max(64),
        output_buffer_frames,
    );
    Some(stream)
}

fn drain_chunk(queue: &Mutex<VecDeque<f32>>) -> Option<Vec<f32>> {
    let mut q = queue.try_lock().ok()?;
    if q.len() < SAMPLE_CHUNK {
        return None;
    }
    Some(q.drain(..SAMPLE_CHUNK).collect())
}

fn run_mic_loop(
    device: cpal::Device,
    name: &str,
    shutdown: Arc<AtomicBool>,
    monitor_mode: MonitorMode,
    startup: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let default_cfg = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            warn!("[mic] '{name}' config error: {e}");
            let _ = startup.send(Err(format!(
                "Microphone '{name}' configuration failed: {e}"
            )));
            return;
        }
    };

    let sample_format = default_cfg.sample_format();
    let config = cpal::StreamConfig {
        channels: default_cfg.channels(),
        sample_rate: default_cfg.sample_rate(),
        buffer_size: stream_buffer_size(default_cfg.buffer_size(), monitor_mode),
    };
    let sr = config.sample_rate.0;
    MIC_SAMPLE_RATE.store(sr, Ordering::SeqCst);
    MONITOR_TELEMETRY.reset(sr, monitor_mode);

    info!(
        "[mic] opening '{name}': {sr} Hz, {}ch, {sample_format:?}",
        config.channels
    );

    let pcm_shared = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(PCM_QUEUE_CAP)));
    let monitor_ring = Arc::new(MonitorRing::new(Arc::clone(&MONITOR_TELEMETRY)));
    let Some(_stream) = try_build_stream(
        &device,
        &config,
        sample_format,
        Arc::clone(&pcm_shared),
        Arc::clone(&monitor_ring),
    ) else {
        warn!("[mic] failed to open '{name}'");
        let _ = startup.send(Err(format!("Failed to open microphone '{name}'")));
        return;
    };
    // Keep the silent output stream alive with the mic so Monitor can toggle
    // instantly without restarting pitch capture or losing a recording frame.
    let _monitor_stream = cpal::default_host()
        .default_output_device()
        .and_then(|output_device| {
            try_build_output_stream(&output_device, Arc::clone(&monitor_ring), sr, monitor_mode)
        });
    if MONITOR_ENABLED.load(Ordering::Relaxed) && _monitor_stream.is_none() {
        warn!("[mic] no output monitoring stream available");
    }

    info!("[mic] active: {name}");
    if startup.send(Ok(())).is_err() {
        return;
    }

    let sleep_dur = std::time::Duration::from_millis(4);
    let mut sample_index = 0u64;
    let mut pitch_tracker = NativePitchTracker::default();

    loop {
        std::thread::sleep(sleep_dur);

        if shutdown.load(Ordering::Relaxed) {
            break;
        }

        while let Some(samples) = drain_chunk(&pcm_shared) {
            let mut sum = 0.0f32;
            let mut peak = 0.0f32;
            for sample in &samples {
                sum += sample * sample;
                peak = peak.max(sample.abs());
            }
            let rms = (sum / samples.len().max(1) as f32).sqrt();
            MIC_LATEST_RMS_BITS.store(rms.to_bits(), Ordering::Relaxed);
            MIC_LATEST_PEAK_BITS.store(peak.to_bits(), Ordering::Relaxed);
            let end_sample_index = sample_index.saturating_add(samples.len() as u64);
            let pitch_frame = pitch_tracker.push_samples(&samples, sr, end_sample_index);
            sample_index = end_sample_index;

            if let Some(frame) = pitch_frame {
                let pitch_channel = MIC_PITCH_CHANNEL.lock().ok().and_then(|slot| slot.clone());
                if let Some(channel) = pitch_channel {
                    match channel.send(frame) {
                        Ok(()) => {
                            MIC_PITCH_FRAMES.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(error) => {
                            MIC_PITCH_ERRORS.fetch_add(1, Ordering::Relaxed);
                            warn!("[mic] pitch channel send failed: {error}");
                        }
                    }
                }
            }

            let channel = MIC_CHANNEL.lock().ok().and_then(|s| s.clone());
            if let Some(channel) = channel {
                let frame = MicSampleFrame {
                    sample_rate: sr,
                    sample_index: end_sample_index.saturating_sub(samples.len() as u64),
                    samples,
                };
                match channel.send(frame) {
                    Ok(()) => {
                        MIC_SENT_FRAMES.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => {
                        MIC_SEND_ERRORS.fetch_add(1, Ordering::Relaxed);
                        warn!("[mic] channel send failed: {e}");
                    }
                }
            }
        }
    }
    MONITOR_TELEMETRY.mark_stopped();
}

#[tauri::command]
pub fn stop_mic_capture() {
    let _guard = MIC_OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    stop_internal();
}

#[cfg(test)]
mod tests {
    use super::{
        PCM_QUEUE_CAP, RECORDING_QUEUE_CHUNKS, drain_chunk, find_device,
        recording_completion_error, sync_channel, try_build_stream, write_recording_stream,
    };
    use crate::monitor::{MonitorRing, MonitorTelemetry};
    use crate::native_pitch::NativePitchTracker;
    use cpal::traits::DeviceTrait;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn finalized_capture_failures_keep_an_actionable_reason() {
        assert_eq!(recording_completion_error(false, false), None);
        assert_eq!(
            recording_completion_error(true, false),
            Some("Recording could not keep up with the microphone stream")
        );
        assert_eq!(
            recording_completion_error(false, true),
            Some("The microphone was disconnected during recording")
        );
        assert_eq!(
            recording_completion_error(true, true),
            Some("The microphone was disconnected during recording")
        );
    }

    #[test]
    #[ignore = "writes and verifies a full 30-minute 24-bit vocal master"]
    fn writes_thirty_minutes_without_losing_samples() {
        const SAMPLE_RATE: u32 = 48_000;
        const TOTAL_SAMPLES: usize = SAMPLE_RATE as usize * 60 * 30;
        const CHUNK_SAMPLES: usize = 4_096;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir();
        let partial = directory.join(format!("nightingale-writer-{nonce}.partial.wav"));
        let final_path = directory.join(format!("nightingale-writer-{nonce}.wav"));
        let partial_string = partial.to_string_lossy().into_owned();
        let final_string = final_path.to_string_lossy().into_owned();
        let (sender, receiver) = sync_channel(RECORDING_QUEUE_CHUNKS);
        let started = Instant::now();
        let writer = std::thread::spawn(move || {
            write_recording_stream(&partial_string, &final_string, SAMPLE_RATE, receiver)
        });

        let mut remaining = TOTAL_SAMPLES;
        while remaining > 0 {
            let count = remaining.min(CHUNK_SAMPLES);
            sender.send(vec![0.01; count]).unwrap();
            remaining -= count;
        }
        drop(sender);
        writer.join().unwrap().unwrap();

        let reader = hound::WavReader::open(&final_path).unwrap();
        assert_eq!(reader.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(reader.spec().bits_per_sample, 24);
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.duration() as usize, TOTAL_SAMPLES);
        println!("30-minute vocal master written in {:?}", started.elapsed());
        std::fs::remove_file(final_path).unwrap();
    }

    #[test]
    #[ignore = "captures real microphone input for a headless hardware diagnostic"]
    fn probes_live_microphone_pitch_input() {
        let preferred = std::env::var("NIGHTINGALE_TEST_MIC").ok();
        let seconds = std::env::var("NIGHTINGALE_MIC_PROBE_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(6)
            .clamp(2, 30);
        let (device, name) = find_device(preferred.as_deref()).expect("microphone should exist");
        let default_config = device
            .default_input_config()
            .expect("microphone should expose a default input format");
        let sample_rate = default_config.sample_rate().0;
        let config = cpal::StreamConfig {
            channels: default_config.channels(),
            sample_rate: default_config.sample_rate(),
            buffer_size: cpal::BufferSize::Default,
        };
        let pcm = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(PCM_QUEUE_CAP)));
        let monitor = Arc::new(MonitorRing::new(Arc::new(MonitorTelemetry::default())));
        let stream = try_build_stream(
            &device,
            &config,
            default_config.sample_format(),
            Arc::clone(&pcm),
            monitor,
        )
        .expect("microphone stream should open");

        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut tracker = NativePitchTracker::default();
        let mut sample_index = 0u64;
        let mut pitch_frames = 0usize;
        let mut voiced_frames = 0usize;
        let mut clarity_sum = 0.0f32;
        let mut max_rms = 0.0f32;
        let mut midi_frames = Vec::new();

        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(4));
            while let Some(samples) = drain_chunk(&pcm) {
                sample_index += samples.len() as u64;
                if let Some(frame) = tracker.push_samples(&samples, sample_rate, sample_index) {
                    pitch_frames += 1;
                    max_rms = max_rms.max(frame.rms);
                    if let Some(midi) = frame.midi {
                        voiced_frames += 1;
                        clarity_sum += frame.clarity;
                        midi_frames.push(Some(midi));
                    } else {
                        midi_frames.push(None);
                    }
                }
            }
        }
        drop(stream);

        let voiced_percent = voiced_frames as f32 / pitch_frames.max(1) as f32 * 100.0;
        let mean_clarity = clarity_sum / voiced_frames.max(1) as f32;
        let mut step_cents = midi_frames
            .windows(2)
            .filter_map(|window| Some((window[1]? - window[0]?).abs() * 100.0))
            .collect::<Vec<_>>();
        step_cents.sort_by(f32::total_cmp);
        let p90_step_cents = step_cents
            .get(((step_cents.len().saturating_sub(1)) as f32 * 0.9).round() as usize)
            .copied()
            .unwrap_or(0.0);
        let large_steps = step_cents.iter().filter(|step| **step >= 600.0).count();
        let isolated_large_steps = midi_frames
            .windows(3)
            .filter(|window| match (window[0], window[1], window[2]) {
                (Some(previous), Some(current), Some(next)) => {
                    (current - previous).abs() >= 6.0 && (next - previous).abs() <= 1.5
                }
                _ => false,
            })
            .count();
        println!(
            "mic_probe device={name:?} sample_rate={sample_rate} samples={sample_index} \
             pitch_frames={pitch_frames} voiced_frames={voiced_frames} \
             voiced_percent={voiced_percent:.1} mean_clarity={mean_clarity:.3} \
             max_rms={max_rms:.4} p90_step_cents={p90_step_cents:.0} \
             large_steps={large_steps} isolated_large_steps={isolated_large_steps}"
        );

        let minimum_samples = sample_rate as u64 * seconds * 3 / 4;
        assert!(
            sample_index >= minimum_samples,
            "microphone delivered only {sample_index} of at least {minimum_samples} expected samples"
        );
        assert!(pitch_frames >= (seconds as usize * 20));
        assert!(max_rms > 0.0001, "microphone input was effectively silent");
    }
}
