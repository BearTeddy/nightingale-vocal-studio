use crate::native_pitch::{NativePitchFrame, NativePitchTracker};
use app_core::{MultiplayerPlayer, validate_multiplayer_players};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tauri::ipc::Channel;

#[derive(Clone, Serialize)]
pub struct MultiplayerMicrophone {
    name: String,
    label: String,
    channels: u16,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MultiplayerEvent {
    Pitch {
        player_id: String,
        frame: NativePitchFrame,
    },
    Error {
        player_id: String,
        message: String,
    },
}

struct Capture {
    id: String,
    stop: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}
static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);
static OPERATIONS: Mutex<()> = Mutex::new(());

#[tauri::command]
pub fn save_multiplayer_players(
    players: Vec<MultiplayerPlayer>,
) -> Result<app_core::AppConfig, String> {
    app_core::save_multiplayer_players(players)
}

#[tauri::command]
pub fn add_multiplayer_scores(
    song_hash: String,
    scores: Vec<app_core::MultiplayerScore>,
    difficulty: String,
    pitch_tolerance_factor: f64,
) -> Result<(), String> {
    app_core::add_multiplayer_scores(&song_hash, &scores, &difficulty, pitch_tolerance_factor)
}

#[tauri::command]
pub async fn list_multiplayer_microphones() -> Result<Vec<MultiplayerMicrophone>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        cpal::default_host()
            .input_devices()
            .map_err(|error| error.to_string())
            .map(|devices| {
                devices
                    .enumerate()
                    .filter_map(|(index, device)| {
                        let label = device.name().ok()?;
                        Some(MultiplayerMicrophone {
                            name: format!("input::{index}::{label}"),
                            label,
                            channels: device.default_input_config().ok()?.channels(),
                        })
                    })
                    .collect()
            })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn stop_capture(id: Option<&str>) {
    let mut slot = CAPTURE.lock().unwrap_or_else(|error| error.into_inner());
    if id.is_some_and(|id| slot.as_ref().is_none_or(|capture| capture.id != id)) {
        return;
    }
    if let Some(capture) = slot.take() {
        capture.stop.store(true, Ordering::SeqCst);
        let _ = capture.thread.join();
    }
}

#[tauri::command]
pub async fn stop_multiplayer_capture(session_id: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap_or_else(|error| error.into_inner());
        stop_capture(Some(&session_id));
    })
    .await;
}

#[tauri::command]
pub async fn start_multiplayer_capture(
    session_id: String,
    players: Vec<MultiplayerPlayer>,
    on_event: Channel<MultiplayerEvent>,
) -> Result<(), String> {
    validate_multiplayer_players(&players)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OPERATIONS.lock().unwrap_or_else(|error| error.into_inner());
        stop_capture(None);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let (startup_tx, startup_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let result = open_streams(&players, &on_event, &worker_stop);
            match result {
                Ok((streams, mut inputs)) => {
                    if startup_tx.send(Ok(())).is_err() {
                        return;
                    }
                    while !worker_stop.load(Ordering::Relaxed) {
                        for input in &mut inputs {
                            for samples in input.samples.try_iter() {
                                for chunk in samples.chunks(512) {
                                    if chunk.is_empty() {
                                        continue;
                                    }
                                    input.index += chunk.len() as u64;
                                    if let Some(frame) =
                                        input.tracker.push_samples(chunk, input.rate, input.index)
                                    {
                                        if on_event
                                            .send(MultiplayerEvent::Pitch {
                                                player_id: input.id.clone(),
                                                frame,
                                            })
                                            .is_err()
                                        {
                                            worker_stop.store(true, Ordering::SeqCst);
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        std::thread::sleep(std::time::Duration::from_millis(4));
                    }
                    drop(streams);
                }
                Err(error) => {
                    let _ = startup_tx.send(Err(error));
                }
            }
        });
        *CAPTURE.lock().unwrap_or_else(|error| error.into_inner()) = Some(Capture {
            id: session_id,
            stop: stop.clone(),
            thread,
        });
        match startup_rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(error) => {
                stop.store(true, Ordering::SeqCst);
                Err(format!("Multiplayer microphones failed to start: {error}"))
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

struct Input {
    id: String,
    samples: std::sync::mpsc::Receiver<Vec<f32>>,
    tracker: NativePitchTracker,
    rate: u32,
    index: u64,
}
type Target = (String, Option<u16>, std::sync::mpsc::SyncSender<Vec<f32>>);

fn resolve_device(id: &str) -> Result<cpal::Device, String> {
    let mut parts = id.splitn(3, "::");
    if parts.next() != Some("input") {
        return crate::microphones::find_device(Some(id)).map(|(device, _)| device);
    }
    let index: usize = parts
        .next()
        .and_then(|part| part.parse().ok())
        .ok_or("Invalid microphone assignment")?;
    let name = parts.next().ok_or("Invalid microphone assignment")?;
    let device = cpal::default_host()
        .input_devices()
        .map_err(|error| error.to_string())?
        .nth(index)
        .ok_or("Microphone disconnected; refresh assignments")?;
    if device.name().ok().as_deref() != Some(name) {
        return Err("Microphone order changed; refresh assignments and check inputs".into());
    }
    Ok(device)
}

fn open_streams(
    players: &[MultiplayerPlayer],
    events: &Channel<MultiplayerEvent>,
    stopped: &Arc<AtomicBool>,
) -> Result<(Vec<cpal::Stream>, Vec<Input>), String> {
    let mut devices: BTreeMap<&str, Vec<&MultiplayerPlayer>> = BTreeMap::new();
    for player in players {
        devices.entry(&player.microphone).or_default().push(player);
    }
    let mut streams = Vec::new();
    let mut inputs = Vec::new();
    for (name, players) in devices {
        let device = resolve_device(name)?;
        let supported = device
            .default_input_config()
            .map_err(|error| error.to_string())?;
        let config: cpal::StreamConfig = supported.clone().into();
        let mut targets = Vec::new();
        for player in players {
            if player
                .channel
                .is_some_and(|channel| channel >= config.channels)
            {
                return Err(format!(
                    "{}: selected channel is unavailable on {name}",
                    player.profile
                ));
            }
            let (sender, samples) = std::sync::mpsc::sync_channel(32);
            targets.push((player.id.clone(), player.channel, sender));
            inputs.push(Input {
                id: player.id.clone(),
                samples,
                tracker: NativePitchTracker::default(),
                rate: config.sample_rate.0,
                index: 0,
            });
        }
        let stream = match supported.sample_format() {
            cpal::SampleFormat::F32 => {
                build_stream::<f32>(&device, &config, targets, events.clone(), stopped.clone())
            }
            cpal::SampleFormat::I16 => {
                build_stream::<i16>(&device, &config, targets, events.clone(), stopped.clone())
            }
            cpal::SampleFormat::U16 => {
                build_stream::<u16>(&device, &config, targets, events.clone(), stopped.clone())
            }
            format => Err(format!("Unsupported microphone format: {format:?}")),
        }?;
        stream
            .play()
            .map_err(|error| format!("Cannot start {name}: {error}"))?;
        streams.push(stream);
    }
    Ok((streams, inputs))
}

fn channel_sample<T>(frame: &[T], channel: Option<u16>) -> f32
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    channel
        .map(|channel| frame[channel as usize].to_sample::<f32>())
        .unwrap_or_else(|| {
            frame
                .iter()
                .map(|sample| sample.to_sample::<f32>())
                .sum::<f32>()
                / frame.len() as f32
        })
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    targets: Vec<Target>,
    events: Channel<MultiplayerEvent>,
    stopped: Arc<AtomicBool>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    let ids: Vec<_> = targets.iter().map(|target| target.0.clone()).collect();
    let callback_events = events.clone();
    let error_stop = stopped.clone();
    device.build_input_stream(config, move |data: &[T], _| {
        if stopped.load(Ordering::Relaxed) { return; }
        for (id, channel, samples) in &targets {
            let mono = data.chunks_exact(channels).map(|frame| channel_sample(frame, *channel)).collect();
            if samples.try_send(mono).is_ok() { continue; }
            stopped.store(true, Ordering::SeqCst);
            let _ = callback_events.send(MultiplayerEvent::Error { player_id: id.clone(), message: "Microphone processing could not keep up; restart after closing other audio apps".into() });
        }
    }, move |error| {
        error_stop.store(true, Ordering::SeqCst);
        for id in &ids { let _ = events.send(MultiplayerEvent::Error { player_id: id.clone(), message: error.to_string() }); }
    }, None).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stereo_channels_retain_independent_singer_pitches() {
        let mut left = NativePitchTracker::default();
        let mut right = NativePitchTracker::default();
        let mut pitches = (None, None);
        for chunk in 0..48 {
            let mut a = Vec::new();
            let mut b = Vec::new();
            for sample in 0..512 {
                let time = (chunk * 512 + sample) as f32 / 48000.0;
                let frame = [
                    (time * 220.0 * std::f32::consts::TAU).sin() * 0.2,
                    (time * 440.0 * std::f32::consts::TAU).sin() * 0.2,
                ];
                a.push(channel_sample(&frame, Some(0)));
                b.push(channel_sample(&frame, Some(1)));
            }
            pitches.0 = left
                .push_samples(&a, 48000, ((chunk + 1) * 512) as u64)
                .and_then(|frame| frame.hz)
                .or(pitches.0);
            pitches.1 = right
                .push_samples(&b, 48000, ((chunk + 1) * 512) as u64)
                .and_then(|frame| frame.hz)
                .or(pitches.1);
        }
        assert!((pitches.0.unwrap() - 220.0).abs() < 2.0);
        assert!((pitches.1.unwrap() - 440.0).abs() < 2.0);
    }
    #[test]
    fn channel_combining_is_explicit() {
        assert_eq!(channel_sample(&[0.1_f32, 0.9], Some(0)), 0.1);
        assert_eq!(channel_sample(&[0.1_f32, 0.9], Some(1)), 0.9);
        assert_eq!(channel_sample(&[0.1_f32, 0.9], None), 0.5);
    }
}
