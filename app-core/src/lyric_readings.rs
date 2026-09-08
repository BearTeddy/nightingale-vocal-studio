//! Lightweight reading enrichment for old and timed-LRC transcripts.
//! A content-keyed sidecar leaves authored text/timestamps untouched.
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::cache::CacheDir;
use crate::vendor::{analyzer_dir, python_path, silent_command};
use serde_json::Value;

pub(crate) fn enrich(file_hash: &str, transcript: Value) -> Value {
    if transcript.get("readings_version").and_then(Value::as_u64) == Some(1) {
        return transcript;
    }
    let Ok(input) = serde_json::to_vec(&transcript) else {
        return transcript;
    };
    if input.len() > 4 * 1024 * 1024 || !python_path().is_file() {
        return transcript;
    }
    let fingerprint = blake3::hash(&input).to_hex().to_string();
    let cache = CacheDir::new();
    let path = cache.path.join(format!("{file_hash}_readings_v1.json"));
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if value["fingerprint"].as_str() == Some(&fingerprint)
                && value["transcript"].is_object()
            {
                return value["transcript"].clone();
            }
        }
    }
    let Some(enriched) = run_reader(input) else {
        tracing::warn!("Reading enrichment unavailable; keeping original lyrics");
        return transcript;
    };
    if let Ok(bytes) =
        serde_json::to_vec(&serde_json::json!({"fingerprint": fingerprint, "transcript": enriched}))
    {
        // The sidecar is disposable: a partial write is ignored on the next load.
        let _ = std::fs::write(path, bytes);
    }
    enriched
}

fn run_reader(input: Vec<u8>) -> Option<Value> {
    let mut child = silent_command(python_path())
        .arg(analyzer_dir().join("cjk.py"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(16 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(15) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let written = writer.join().ok()?.is_ok();
    let bytes = reader.join().ok()?.ok()?;
    if !success || !written {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    (value.get("readings_version").and_then(Value::as_u64) == Some(1)).then_some(value)
}
