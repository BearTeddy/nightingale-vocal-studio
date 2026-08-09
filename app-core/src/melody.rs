use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use ts_rs::TS;

use crate::cache::CacheDir;
use crate::vendor::{analyzer_dir, python_path, silent_command};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TargetNote {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub midi: f64,
    #[serde(default)]
    pub cents: f64,
    pub confidence: f64,
    #[serde(default = "default_true")]
    pub eligible: bool,
    #[serde(default)]
    pub lyric_word_indices: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MelodyMap {
    pub version: u32,
    pub source: String,
    pub hop_ms: u32,
    pub confidence: f64,
    pub strict_scoring_available: bool,
    #[serde(default)]
    pub fallback_reason: Option<String>,
    pub notes: Vec<TargetNote>,
}

fn default_true() -> bool {
    true
}

pub fn load_melody_map(file_hash: &str) -> Option<MelodyMap> {
    let cache = CacheDir::new();
    let path = cache.melody_path(file_hash);
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(map) = serde_json::from_str::<MelodyMap>(&data) {
            return Some(map);
        }
    }

    melody_from_usdx_transcript(&cache, file_hash)
}

pub fn save_melody_map(file_hash: &str, mut melody: MelodyMap) -> Result<(), String> {
    melody.version = 1;
    melody.notes.retain(|note| {
        note.start.is_finite()
            && note.end.is_finite()
            && note.midi.is_finite()
            && note.end > note.start
            && (0.0..=127.0).contains(&note.midi)
    });
    melody
        .notes
        .sort_by(|left, right| left.start.total_cmp(&right.start));
    melody.strict_scoring_available = melody.notes.iter().any(|note| note.eligible);

    let cache = CacheDir::new();
    let path = cache.melody_path(file_hash);
    let partial = path.with_extension("json.partial");
    let json = serde_json::to_string_pretty(&melody).map_err(|error| error.to_string())?;
    std::fs::write(&partial, json).map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&partial, &path).map_err(|error| error.to_string())
}

pub fn rebuild_melody_map(file_hash: &str) -> Result<MelodyMap, String> {
    let cache = CacheDir::new();
    if let Some(map) = melody_from_usdx_transcript(&cache, file_hash) {
        save_melody_map(file_hash, map.clone())?;
        return Ok(map);
    }

    let transcript = cache.transcript_path(file_hash);
    if !transcript.is_file() {
        return Err("Analyze the song before building its pitch guide".into());
    }
    let vocals = canonical_vocals_path(&cache, file_hash)
        .ok_or_else(|| "The isolated vocal stem is missing; run full analysis first".to_string())?;
    let output = cache.melody_path(file_hash);
    let result = silent_command(python_path())
        .arg(analyzer_dir().join("melody.py"))
        .arg(&vocals)
        .arg(&output)
        .arg(&transcript)
        .output()
        .map_err(|error| format!("Could not start pitch-guide analysis: {error}"))?;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if message.is_empty() {
            format!("Pitch-guide analysis failed with status {}", result.status)
        } else {
            message
        });
    }
    let data = std::fs::read_to_string(&output)
        .map_err(|error| format!("Pitch guide was not written: {error}"))?;
    serde_json::from_str(&data).map_err(|error| format!("Pitch guide is invalid: {error}"))
}

fn canonical_vocals_path(cache: &CacheDir, file_hash: &str) -> Option<PathBuf> {
    if let Some(song) = crate::library_db::load_song_by_hash(file_hash)
        .ok()
        .flatten()
    {
        if song.no_stems {
            return None;
        }
        if let Some(bundle) = song.usdx.as_ref() {
            return Some(bundle.vocals.as_ref().unwrap_or(&bundle.audio).clone());
        }
        if let Some(key) = song.key.as_deref() {
            let canonical = cache.variant_vocals_path(file_hash, key, 1.0);
            if canonical.is_file() {
                return Some(canonical);
            }
        }
    }

    for candidate in [
        cache.vocals_path(file_hash),
        cache.legacy_vocals_path(file_hash),
    ] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let prefix = format!("{file_hash}_vocals_");
    std::fs::read_dir(&cache.path)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with("_1.0.mp3"))
        })
}

fn melody_from_usdx_transcript(cache: &CacheDir, file_hash: &str) -> Option<MelodyMap> {
    let data = std::fs::read_to_string(cache.transcript_path(file_hash)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&data).ok()?;
    if value.get("source")?.as_str()? != "usdx" {
        return None;
    }

    let mut notes = Vec::new();
    let mut word_index = 0usize;
    for segment in value.get("segments")?.as_array()? {
        let Some(words) = segment.get("words").and_then(|words| words.as_array()) else {
            continue;
        };
        for word in words {
            let start = word.get("start").and_then(|value| value.as_f64());
            let end = word.get("end").and_then(|value| value.as_f64());
            let pitch = word.get("pitch").and_then(|value| value.as_f64());
            if let (Some(start), Some(end), Some(pitch)) = (start, end, pitch) {
                notes.push(TargetNote {
                    id: format!("u{}", notes.len() + 1),
                    start,
                    end,
                    // UltraStar pitch 0 is middle C (MIDI 60).
                    midi: pitch + 60.0,
                    cents: 0.0,
                    confidence: 1.0,
                    eligible: true,
                    lyric_word_indices: vec![word_index],
                });
            }
            word_index += 1;
        }
    }

    if notes.is_empty() {
        return None;
    }

    Some(MelodyMap {
        version: 1,
        source: "usdx".into(),
        hop_ms: 10,
        confidence: 1.0,
        strict_scoring_available: true,
        fallback_reason: None,
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_notes_before_save_shape() {
        let mut notes = vec![
            TargetNote {
                id: "bad".into(),
                start: 2.0,
                end: 1.0,
                midi: 60.0,
                cents: 0.0,
                confidence: 1.0,
                eligible: true,
                lyric_word_indices: Vec::new(),
            },
            TargetNote {
                id: "good".into(),
                start: 1.0,
                end: 2.0,
                midi: 60.0,
                cents: 0.0,
                confidence: 1.0,
                eligible: true,
                lyric_word_indices: Vec::new(),
            },
        ];
        notes.retain(|note| note.end > note.start && (0.0..=127.0).contains(&note.midi));
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, "good");
    }
}
