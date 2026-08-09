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
}

fn observe<T: Copy>(data: &[T], stats: &Arc<Mutex<SignalStats>>, map: impl Fn(T) -> f32) {
    let Ok(mut stats) = stats.lock() else {
        return;
    };
    stats.callbacks += 1;
    stats.samples += data.len() as u64;
    for sample in data.iter().copied().map(map) {
        stats.sum_squares += f64::from(sample) * f64::from(sample);
        stats.peak = stats.peak.max(sample.abs());
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
    let stats = Arc::new(Mutex::new(SignalStats::default()));
    let on_error = |error| eprintln!("Input stream error: {error}");

    println!("Probing default input: {}", device_name(&device));
    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let stats = Arc::clone(&stats);
            device.build_input_stream(
                &config,
                move |data: &[f32], _| observe(data, &stats, |sample| sample),
                on_error,
                None,
            )?
        }
        cpal::SampleFormat::I16 => {
            let stats = Arc::clone(&stats);
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    observe(data, &stats, |sample| sample as f32 / i16::MAX as f32);
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
                    observe(data, &stats, |sample| sample as f32 / i32::MAX as f32);
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
    Ok(())
}
