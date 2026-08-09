use client_lib::native_pitch::NativePitchTracker;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct SignalStats {
    callbacks: u64,
    samples: u64,
    sum_squares: f64,
    peak: f32,
    mono: Vec<f32>,
}

fn observe<T: Copy>(
    data: &[T],
    channels: usize,
    stats: &Arc<Mutex<SignalStats>>,
    map: impl Fn(T) -> f32,
) {
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    stats.callbacks += 1;
    for frame in data.chunks(channels.max(1)) {
        let sample = frame.iter().copied().map(&map).sum::<f32>() / channels.max(1) as f32;
        stats.samples += 1;
        stats.sum_squares += f64::from(sample) * f64::from(sample);
        stats.peak = stats.peak.max(sample.abs());
        stats.mono.push(sample);
    }
}

fn device_name(device: &cpal::Device) -> String {
    device.name().unwrap_or_else(|_| "(unknown)".into())
}

fn main() -> Result<(), Box<dyn Error>> {
    let host = cpal::default_host();
    println!("CPAL host: {:?}", host.id());

    let devices = host.input_devices()?.collect::<Vec<_>>();
    println!("Input devices: {}", devices.len());
    for (index, device) in devices.iter().enumerate() {
        match device.default_input_config() {
            Ok(config) => println!(
                "  [{index}] {} | {} Hz | {} ch | {:?}",
                device_name(device),
                config.sample_rate().0,
                config.channels(),
                config.sample_format()
            ),
            Err(error) => println!(
                "  [{index}] {} | config error: {error}",
                device_name(device)
            ),
        }
    }

    let device = host
        .default_input_device()
        .ok_or("No default input device is available")?;
    let supported = device.default_input_config()?;
    let sample_format = supported.sample_format();
    let config = supported.config();
    let channels = config.channels as usize;
    let stats = Arc::new(Mutex::new(SignalStats::default()));
    let on_error = |error| eprintln!("Input stream error: {error}");

    println!("Probing default input: {}", device_name(&device));
    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let stats = Arc::clone(&stats);
            device.build_input_stream(
                &config,
                move |data: &[f32], _| observe(data, channels, &stats, |sample| sample),
                on_error,
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let stats = Arc::clone(&stats);
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    observe(data, channels, &stats, |sample| {
                        sample as f32 / i16::MAX as f32
                    });
                },
                on_error,
                None,
            )?
        }
        cpal::SampleFormat::I32 => {
            let stats = Arc::clone(&stats);
            device.build_input_stream(
                &config,
                move |data: &[i32], _| {
                    observe(data, channels, &stats, |sample| {
                        sample as f32 / i32::MAX as f32
                    });
                },
                on_error,
                None,
            )?
        }
        format => return Err(format!("Unsupported input sample format: {format:?}").into()),
    };

    stream.play()?;
    std::thread::sleep(Duration::from_secs(3));
    drop(stream);

    let stats = stats.lock().map_err(|_| "Signal stats lock was poisoned")?;
    let rms = if stats.samples == 0 {
        0.0
    } else {
        (stats.sum_squares / stats.samples as f64).sqrt()
    };
    let rms_db = if rms > 0.0 {
        20.0 * rms.log10()
    } else {
        f64::NEG_INFINITY
    };
    println!(
        "Capture: callbacks={} samples={} rms={rms:.6} rms_db={rms_db:.1} peak={:.6}",
        stats.callbacks, stats.samples, stats.peak
    );

    if stats.samples == 0 {
        return Err("The device opened but delivered no input samples".into());
    }

    let mut pitch_tracker = NativePitchTracker::default();
    let mut pitch_frames = 0u64;
    let mut voiced_frames = 0u64;
    let mut voiced_hz = Vec::new();
    let mut sample_index = 0u64;
    for chunk in stats.mono.chunks(512) {
        sample_index += chunk.len() as u64;
        if let Some(frame) = pitch_tracker.push_samples(chunk, config.sample_rate.0, sample_index) {
            pitch_frames += 1;
            if let Some(hz) = frame.hz {
                voiced_frames += 1;
                voiced_hz.push(hz);
            }
        }
    }
    voiced_hz.sort_by(f32::total_cmp);
    let median_hz = voiced_hz.get(voiced_hz.len() / 2).copied();
    println!("Native pitch: frames={pitch_frames} voiced={voiced_frames} median_hz={median_hz:?}");
    if pitch_frames == 0 {
        return Err("The native pitch tracker produced no analysis frames".into());
    }
    Ok(())
}
