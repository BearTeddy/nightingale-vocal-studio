use cpal::device_description::DeviceType;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::ipc::Channel;
use tracing::{info, warn};
use ts_rs::TS;

/// Worker drains the cpal queue in fixed-size chunks before forwarding to the
/// JS side; smaller chunks lower IPC latency at the cost of more sends/sec.
const SAMPLE_CHUNK: usize = 512;
const AUDIO_QUEUE_CAP: usize = 24_000;
const PCM_QUEUE_CAP: usize = 24_000;
const DEFAULT_MONITOR_GAIN: f32 = 0.65;
const MAX_MONITOR_GAIN: f32 = 2.0;
const PRE_ROLL_SECONDS: usize = 1;

static MONITOR_GAIN_BITS: AtomicU32 = AtomicU32::new(DEFAULT_MONITOR_GAIN.to_bits());
static MIC_SAMPLE_RATE: AtomicU32 = AtomicU32::new(0);
static MIC_INPUT_SAMPLES: AtomicU64 = AtomicU64::new(0);
static MIC_SENT_FRAMES: AtomicU64 = AtomicU64::new(0);
static MIC_SEND_ERRORS: AtomicU64 = AtomicU64::new(0);
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

fn monitor_gain() -> f32 {
    f32::from_bits(MONITOR_GAIN_BITS.load(Ordering::Relaxed))
}

pub fn set_monitor_gain(gain: f32) {
    let clamped = gain.clamp(0.0, MAX_MONITOR_GAIN);
    MONITOR_GAIN_BITS.store(clamped.to_bits(), Ordering::Relaxed);
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MicrophoneInfo {
    pub name: String,
}

/// Mono PCM frame streamed from Rust to JS. JS owns all DSP (pitch, reactive
/// analysis) and runs it on a sliding window built from these frames.
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
    pub rms: f32,
    pub peak: f32,
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
}

fn device_display_name(device: &cpal::Device) -> String {
    let Ok(desc) = device.description() else {
        return "(unknown)".into();
    };
    if let Some(friendly) = desc.extended().first() {
        return friendly.clone();
    }
    desc.to_string()
}

fn is_virtual(device: &cpal::Device) -> bool {
    let Ok(desc) = device.description() else {
        return false;
    };
    matches!(desc.device_type(), DeviceType::Virtual)
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
        if device.default_input_config().is_err() || is_virtual(&device) {
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
        rms: f32::from_bits(MIC_LATEST_RMS_BITS.load(Ordering::Relaxed)),
        peak: f32::from_bits(MIC_LATEST_PEAK_BITS.load(Ordering::Relaxed)),
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

fn write_output_frames<T, F>(
    data: &mut [T],
    channels: usize,
    next_sample: &Arc<dyn Fn() -> f32 + Send + Sync>,
    mut map: F,
) where
    T: Copy,
    F: FnMut(f32) -> T,
{
    for frame in data.chunks_mut(channels) {
        let out_sample = map(next_sample());
        for out in frame {
            *out = out_sample;
        }
    }
}

fn report_input_stream_error(error: cpal::StreamError) {
    warn!("[mic] input stream error: {error}");
    MIC_RUNNING.store(false, Ordering::SeqCst);
    RECORDER_DEVICE_LOST.store(true, Ordering::SeqCst);
}

static MIC_RUNNING: AtomicBool = AtomicBool::new(false);
static MIC_SHUTDOWN: once_cell::sync::Lazy<Arc<AtomicBool>> =
    once_cell::sync::Lazy::new(|| Arc::new(AtomicBool::new(false)));
static MONITOR_ENABLED: AtomicBool = AtomicBool::new(false);
static MIC_CHANNEL: once_cell::sync::Lazy<Arc<Mutex<Option<Channel<MicSampleFrame>>>>> =
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
    /*
     * Drop the channel before joining: this triggers Tauri's `Channel` Drop,
     * which sends `{end: true}` to JS so the callback id is unregistered
     * cleanly. The mic loop also gets `None` next iteration and stops sending.
     */
    if let Ok(mut slot) = MIC_CHANNEL.lock() {
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

fn find_device(preferred: Option<&str>) -> Result<(cpal::Device, String), String> {
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
pub fn start_mic_capture(
    preferred: Option<String>,
    options: Option<MicCaptureOptions>,
    on_samples: Channel<MicSampleFrame>,
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

    MIC_SHUTDOWN.store(false, Ordering::SeqCst);
    MIC_RUNNING.store(true, Ordering::SeqCst);

    let device_name = name.clone();
    let shutdown = Arc::clone(&MIC_SHUTDOWN);

    let handle = std::thread::spawn(move || {
        run_mic_loop(device, &name, shutdown);
        MIC_RUNNING.store(false, Ordering::SeqCst);
    });

    if let Ok(mut slot) = MIC_THREAD.lock() {
        *slot = Some(handle);
    }

    Ok(device_name)
}

fn try_build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    pcm_shared: Arc<Mutex<VecDeque<f32>>>,
    audio_shared: Arc<Mutex<VecDeque<f32>>>,
) -> Option<cpal::Stream> {
    let ch = config.channels as usize;
    let pre_roll_capacity = config.sample_rate as usize * PRE_ROLL_SECONDS;
    let push_samples: InputPusher = {
        let pcm_cb = Arc::clone(&pcm_shared);
        let audio_cb = Arc::clone(&audio_shared);
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
                if let Ok(mut q) = audio_cb.try_lock() {
                    for sample in &mono_samples {
                        q.push_back(*sample);
                    }
                    while q.len() > AUDIO_QUEUE_CAP {
                        q.pop_front();
                    }
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
    let stream = match sample_format {
        SampleFormat::F32 => {
            let push = push_samples.clone();
            device.build_input_stream(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| push(data),
                report_input_stream_error,
                None,
            )
        }
        SampleFormat::I16 => {
            let push = push_samples.clone();
            device.build_input_stream(
                config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    push_mapped_input(data, &push, i16_to_f32);
                },
                report_input_stream_error,
                None,
            )
        }
        SampleFormat::I32 => {
            let push = push_samples.clone();
            device.build_input_stream(
                config,
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    push_mapped_input(data, &push, i32_to_f32);
                },
                report_input_stream_error,
                None,
            )
        }
        _ => return None,
    };

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
    audio_shared: Arc<Mutex<VecDeque<f32>>>,
) -> Option<cpal::Stream> {
    let default_cfg = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            warn!("[mic] output config error: {e}");
            return None;
        }
    };
    let sample_format = default_cfg.sample_format();
    let config = cpal::StreamConfig {
        channels: default_cfg.channels(),
        sample_rate: default_cfg.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let ch = config.channels as usize;

    let next_sample: Arc<dyn Fn() -> f32 + Send + Sync> = {
        let audio_shared = Arc::clone(&audio_shared);
        Arc::new(move || -> f32 {
            if !MONITOR_ENABLED.load(Ordering::Relaxed) {
                return 0.0;
            }
            if let Ok(mut q) = audio_shared.try_lock() {
                q.pop_front().unwrap_or(0.0) * monitor_gain()
            } else {
                0.0
            }
        })
    };

    use cpal::SampleFormat;
    let stream = match sample_format {
        SampleFormat::F32 => {
            let next = Arc::clone(&next_sample);
            device.build_output_stream(
                &config,
                move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                    write_output_frames(data, ch, &next, |sample| sample);
                },
                |err| warn!("[mic] output stream error: {err}"),
                None,
            )
        }
        SampleFormat::I16 => {
            let next = Arc::clone(&next_sample);
            device.build_output_stream(
                &config,
                move |data: &mut [i16], _: &cpal::OutputCallbackInfo| {
                    write_output_frames(data, ch, &next, f32_to_i16);
                },
                |err| warn!("[mic] output stream error: {err}"),
                None,
            )
        }
        SampleFormat::U16 => {
            let next = Arc::clone(&next_sample);
            device.build_output_stream(
                &config,
                move |data: &mut [u16], _: &cpal::OutputCallbackInfo| {
                    write_output_frames(data, ch, &next, f32_to_u16);
                },
                |err| warn!("[mic] output stream error: {err}"),
                None,
            )
        }
        SampleFormat::I32 => {
            let next = Arc::clone(&next_sample);
            device.build_output_stream(
                &config,
                move |data: &mut [i32], _: &cpal::OutputCallbackInfo| {
                    write_output_frames(data, ch, &next, f32_to_i32);
                },
                |err| warn!("[mic] output stream error: {err}"),
                None,
            )
        }
        SampleFormat::U32 => {
            let next = Arc::clone(&next_sample);
            device.build_output_stream(
                &config,
                move |data: &mut [u32], _: &cpal::OutputCallbackInfo| {
                    write_output_frames(data, ch, &next, f32_to_u32);
                },
                |err| warn!("[mic] output stream error: {err}"),
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
            warn!("[mic] build output stream failed: {e}");
            return None;
        }
    };
    if let Err(e) = stream.play() {
        warn!("[mic] output play failed: {e}");
        return None;
    }
    Some(stream)
}

fn drain_chunk(queue: &Mutex<VecDeque<f32>>) -> Option<Vec<f32>> {
    let mut q = queue.try_lock().ok()?;
    if q.len() < SAMPLE_CHUNK {
        return None;
    }
    Some(q.drain(..SAMPLE_CHUNK).collect())
}

fn run_mic_loop(device: cpal::Device, name: &str, shutdown: Arc<AtomicBool>) {
    let default_cfg = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => {
            warn!("[mic] '{name}' config error: {e}");
            return;
        }
    };

    let sample_format = default_cfg.sample_format();
    let config = cpal::StreamConfig {
        channels: default_cfg.channels(),
        sample_rate: default_cfg.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };
    let sr = config.sample_rate;
    MIC_SAMPLE_RATE.store(sr, Ordering::SeqCst);

    info!(
        "[mic] opening '{name}': {sr} Hz, {}ch, {sample_format:?}",
        config.channels
    );

    let pcm_shared = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(PCM_QUEUE_CAP)));
    let audio_shared = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(AUDIO_QUEUE_CAP)));
    let Some(_stream) = try_build_stream(
        &device,
        &config,
        sample_format,
        Arc::clone(&pcm_shared),
        Arc::clone(&audio_shared),
    ) else {
        warn!("[mic] failed to open '{name}'");
        return;
    };
    let monitor_requested = MONITOR_ENABLED.load(Ordering::Relaxed);
    let monitor_stream = if monitor_requested {
        cpal::default_host()
            .default_output_device()
            .and_then(|output_device| {
                try_build_output_stream(&output_device, Arc::clone(&audio_shared))
            })
    } else {
        None
    };
    if monitor_requested && monitor_stream.is_none() {
        warn!("[mic] no output monitoring stream available");
    }

    info!("[mic] active: {name}");

    let sleep_dur = std::time::Duration::from_millis(4);
    let mut sample_index = 0u64;

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
            let channel = MIC_CHANNEL.lock().ok().and_then(|s| s.clone());
            if let Some(channel) = channel {
                let frame = MicSampleFrame {
                    sample_rate: sr,
                    sample_index,
                    samples,
                };
                sample_index = sample_index.saturating_add(frame.samples.len() as u64);
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
}

#[tauri::command]
pub fn stop_mic_capture() {
    let _guard = MIC_OP_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    stop_internal();
}

#[cfg(test)]
mod tests {
    use super::{
        recording_completion_error, sync_channel, write_recording_stream, RECORDING_QUEUE_CHUNKS,
    };
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
}
