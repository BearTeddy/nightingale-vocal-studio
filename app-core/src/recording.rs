use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::cache::nightingale_dir;
use crate::library_db;
use crate::playback::{ensure_playable_source_video, get_audio_paths};
use crate::vendor::{ffmpeg_path, silent_command};

static RECORDING_EXPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordingRequest {
    pub song_hash: String,
    pub profile: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub playback_time_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordingTake {
    pub id: String,
    pub session_id: String,
    pub song_hash: String,
    pub profile: String,
    pub title: String,
    pub artist: String,
    pub vocal_path: String,
    pub partial_path: String,
    pub mix_path: Option<String>,
    pub video_path: Option<String>,
    pub status: String,
    pub sample_rate: u32,
    #[serde(default)]
    #[ts(type = "number")]
    pub pre_roll_samples: u64,
    #[serde(default)]
    #[ts(type = "number")]
    pub recorded_samples: u64,
    #[serde(default)]
    pub playback_start_sec: f64,
    #[ts(type = "number")]
    pub created_at: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransportSegment {
    pub source_start: f64,
    pub source_end: f64,
    pub recorded_start: f64,
    pub recorded_end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PracticeSession {
    pub id: String,
    pub profile: String,
    pub song_hash: Option<String>,
    pub kind: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub performance_json: Option<String>,
    pub recording_take_id: Option<String>,
    #[serde(default)]
    pub transport_segments: Vec<TransportSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavePracticeSession {
    pub id: String,
    pub profile: String,
    pub song_hash: Option<String>,
    pub kind: String,
    pub started_at: u64,
    pub ended_at: u64,
    pub performance_json: String,
    pub recording_take_id: Option<String>,
    #[serde(default)]
    pub transport_segments: Vec<TransportSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRecordingRequest {
    pub take_id: String,
    #[serde(default)]
    pub latency_compensation_sec: f64,
    #[serde(default = "default_vocal_gain")]
    pub vocal_gain: f64,
    #[serde(default)]
    pub video_path: Option<String>,
    #[serde(default)]
    pub transport_segments: Vec<TransportSegment>,
}

fn default_vocal_gain() -> f64 {
    1.0
}

fn unix_now() -> u64 {
    OffsetDateTime::now_utc().unix_timestamp().max(0) as u64
}

fn safe_component(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(96).collect()
    }
}

pub fn prepare_recording(
    request: RecordingRequest,
    sample_rate: u32,
    pre_roll_samples: u64,
) -> Result<RecordingTake, String> {
    let now = OffsetDateTime::now_utc();
    let created_at = now.unix_timestamp().max(0) as u64;
    let suffix = Alphanumeric
        .sample_string(&mut rand::rng(), 6)
        .to_ascii_lowercase();
    let session_id = format!("{}-{suffix}", now.unix_timestamp_nanos());
    let take_id = format!("take-{session_id}");
    let profile = safe_component(&request.profile, "Guest");
    let song_hash = safe_component(&request.song_hash, "exercise");
    let directory = nightingale_dir()
        .join("recordings")
        .join(profile)
        .join(now.year().to_string())
        .join(song_hash)
        .join(&session_id);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let stem = safe_component(
        &format!("{} - {}", request.artist, request.title),
        "Nightingale Take",
    );
    let vocal_path = directory.join(format!("{stem} - vocal.wav"));
    let partial_path = directory.join(format!("{stem} - vocal.partial.wav"));

    let take = RecordingTake {
        id: take_id,
        session_id,
        song_hash: request.song_hash,
        profile: request.profile,
        title: request.title,
        artist: request.artist,
        vocal_path: vocal_path.to_string_lossy().into_owned(),
        partial_path: partial_path.to_string_lossy().into_owned(),
        mix_path: None,
        video_path: None,
        status: "recording".into(),
        sample_rate,
        pre_roll_samples,
        recorded_samples: 0,
        playback_start_sec: request.playback_time_sec.max(0.0),
        created_at,
        error: None,
    };
    library_db::upsert_recording_take(&take).map_err(|error| error.to_string())?;
    Ok(take)
}

pub fn update_recording_take(take: &RecordingTake) -> Result<(), String> {
    library_db::upsert_recording_take(take).map_err(|error| error.to_string())
}

pub fn load_recording_take(take_id: &str) -> Result<Option<RecordingTake>, String> {
    library_db::load_recording_take(take_id).map_err(|error| error.to_string())
}

pub fn save_practice_session(session: SavePracticeSession) -> Result<(), String> {
    library_db::upsert_practice_session(&session).map_err(|error| error.to_string())?;
    let Some(take_id) = session.recording_take_id.as_deref() else {
        return Ok(());
    };
    let Some(take) = load_recording_take(take_id)? else {
        return Ok(());
    };
    let Some(directory) = Path::new(&take.vocal_path).parent() else {
        return Ok(());
    };
    let path = directory.join("performance_v1.json");
    let partial = directory.join("performance_v1.json.partial");
    let performance = serde_json::from_str::<serde_json::Value>(&session.performance_json)
        .unwrap_or_else(|_| serde_json::Value::String(session.performance_json.clone()));
    let payload = serde_json::json!({
        "version": 1,
        "session_id": session.id,
        "song_hash": session.song_hash,
        "profile": session.profile,
        "kind": session.kind,
        "started_at": session.started_at,
        "ended_at": session.ended_at,
        "transport_segments": session.transport_segments,
        "performance": performance,
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    std::fs::write(&partial, json).map_err(|error| error.to_string())?;
    replace_file(&partial, &path)
}

pub fn list_practice_sessions(profile: Option<&str>) -> Result<Vec<PracticeSession>, String> {
    library_db::list_practice_sessions(profile).map_err(|error| error.to_string())
}

pub fn export_recording(request: ExportRecordingRequest) -> Result<RecordingTake, String> {
    let _export_guard = RECORDING_EXPORT_LOCK
        .lock()
        .map_err(|_| "Recording export lock is unavailable".to_string())?;
    let mut take = load_recording_take(&request.take_id)?
        .ok_or_else(|| "Recording take not found".to_string())?;
    let vocal = PathBuf::from(&take.vocal_path);
    if !vocal.is_file() {
        return Err("Vocal recording is missing".into());
    }

    let audio_paths = get_audio_paths(&take.song_hash);
    let instrumental = PathBuf::from(audio_paths.instrumental);
    if !instrumental.is_file() {
        return Err("Instrumental is missing".into());
    }
    let directory = vocal
        .parent()
        .ok_or_else(|| "Invalid recording path".to_string())?;
    let stem = safe_component(
        &format!("{} - {}", take.artist, take.title),
        "Nightingale Take",
    );
    let mix = directory.join(format!("{stem} - performance.m4a"));
    let mix_partial = directory.join(format!("{stem} - performance.partial.m4a"));
    let filter = recording_mix_filter(&take, &request);
    let status = match silent_command(ffmpeg_path())
        .args(["-y", "-i"])
        .arg(&instrumental)
        .args(["-i"])
        .arg(&vocal)
        .args(["-filter_complex", &filter, "-map", "[out]"])
        .args(recording_audio_codec_args())
        .arg(&mix_partial)
        .status()
    {
        Ok(status) => status,
        Err(error) => return mark_export_failed(take, format!("Audio export failed: {error}")),
    };
    if !status.success() {
        let _ = std::fs::remove_file(&mix_partial);
        return mark_export_failed(take, format!("Audio export failed with status {status}"));
    }
    replace_file(&mix_partial, &mix)?;
    take.mix_path = Some(mix.to_string_lossy().into_owned());

    if let Some(video_source) =
        recording_video_source(&take.song_hash, request.video_path.as_deref())
    {
        let video = directory.join(format!("{stem} - performance.mp4"));
        let video_partial = directory.join(format!("{stem} - performance.partial.mp4"));
        let fast_status = silent_command(ffmpeg_path())
            .args(["-y", "-stream_loop", "-1", "-i"])
            .arg(&video_source)
            .args(["-i"])
            .arg(&mix)
            .args(["-map", "0:v:0", "-map", "1:a:0"])
            .args(recording_video_codec_args(true))
            .arg(&video_partial)
            .status();

        let video_status = if fast_status.as_ref().is_ok_and(|status| status.success()) {
            fast_status
        } else {
            let _ = std::fs::remove_file(&video_partial);
            silent_command(ffmpeg_path())
                .args(["-y", "-stream_loop", "-1", "-i"])
                .arg(&video_source)
                .args(["-i"])
                .arg(&mix)
                .args(["-map", "0:v:0", "-map", "1:a:0"])
                .args(recording_video_codec_args(false))
                .arg(&video_partial)
                .status()
        };
        let video_status = match video_status {
            Ok(status) => status,
            Err(error) => return mark_export_failed(take, format!("Video export failed: {error}")),
        };
        if video_status.success() {
            replace_file(&video_partial, &video)?;
            take.video_path = Some(video.to_string_lossy().into_owned());
        } else {
            let _ = std::fs::remove_file(&video_partial);
            return mark_export_failed(
                take,
                format!("Video export failed with status {video_status}"),
            );
        }
    }

    take.status = "ready".into();
    take.error = None;
    update_recording_take(&take)?;
    Ok(take)
}

fn recording_video_source(song_hash: &str, requested: Option<&str>) -> Option<PathBuf> {
    let requested = requested.map(PathBuf::from).filter(|path| path.is_file())?;
    ensure_playable_source_video(song_hash)
        .ok()
        .flatten()
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or(Some(requested))
}

fn recording_audio_codec_args() -> &'static [&'static str] {
    &["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-v", "error"]
}

fn recording_video_codec_args(stream_copy: bool) -> &'static [&'static str] {
    if stream_copy {
        &[
            "-c:v",
            "copy",
            "-c:a",
            "copy",
            "-shortest",
            "-shortest_buf_duration",
            "0.5",
            "-movflags",
            "+faststart",
            "-v",
            "error",
        ]
    } else {
        &[
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-shortest",
            "-shortest_buf_duration",
            "0.5",
            "-movflags",
            "+faststart",
            "-v",
            "error",
        ]
    }
}

fn recording_mix_filter(take: &RecordingTake, request: &ExportRecordingRequest) -> String {
    let sample_rate = take.sample_rate.max(1) as f64;
    let pre_roll = take.pre_roll_samples as f64 / sample_rate;
    let latency = request.latency_compensation_sec.clamp(0.0, 0.5);
    let gain = request.vocal_gain.clamp(0.0, 3.0);
    let segments = request
        .transport_segments
        .iter()
        .filter(|segment| {
            segment.source_end > segment.source_start
                && segment.recorded_end > segment.recorded_start
        })
        .collect::<Vec<_>>();

    if segments.is_empty() {
        let trim = pre_roll + latency;
        let delay_ms = (take.playback_start_sec.max(0.0) * 1000.0).round() as u64;
        return format!(
            "[1:a]atrim=start={trim:.6},asetpts=PTS-STARTPTS,volume={gain:.3},adelay={delay_ms}:all=1[voice];[0:a][voice]amix=inputs=2:duration=first:normalize=0[mix];[mix]loudnorm=I=-14:LRA=11:TP=-1.0,alimiter=limit=0.95[out]"
        );
    }

    let mut filter = String::new();
    for (index, segment) in segments.iter().enumerate() {
        let recorded_start = pre_roll + segment.recorded_start.max(0.0) + latency;
        let recorded_duration = segment.recorded_end - segment.recorded_start;
        let source_duration = segment.source_end - segment.source_start;
        let duration = recorded_duration.min(source_duration).max(0.001);
        let delay_ms = (segment.source_start.max(0.0) * 1000.0).round() as u64;
        filter.push_str(&format!(
            "[1:a]atrim=start={recorded_start:.6}:duration={duration:.6},asetpts=PTS-STARTPTS,volume={gain:.3},adelay={delay_ms}:all=1[v{index}];"
        ));
    }
    filter.push_str("[0:a]");
    for index in 0..segments.len() {
        filter.push_str(&format!("[v{index}]"));
    }
    filter.push_str(&format!(
        "amix=inputs={}:duration=first:normalize=0[mix];[mix]loudnorm=I=-14:LRA=11:TP=-1.0,alimiter=limit=0.95[out]",
        segments.len() + 1
    ));
    filter
}

fn mark_export_failed(mut take: RecordingTake, error: String) -> Result<RecordingTake, String> {
    take.status = "failed".into();
    take.error = Some(error.clone());
    let _ = update_recording_take(&take);
    Err(error)
}

fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        std::fs::remove_file(target).map_err(|error| error.to_string())?;
    }
    std::fs::rename(source, target).map_err(|error| error.to_string())
}

fn cleanup_completed_export_partial(path: &Path) -> Result<bool, String> {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return Ok(false);
    };
    let final_name = if let Some(stem) = file_name.strip_suffix(".partial.m4a") {
        format!("{stem}.m4a")
    } else if let Some(stem) = file_name.strip_suffix(".partial.mp4") {
        format!("{stem}.mp4")
    } else {
        return Ok(false);
    };
    let final_path = path.with_file_name(final_name);
    if !final_path.is_file() {
        return Ok(false);
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(true)
}

fn legacy_recovered_path(partial_path: &Path) -> PathBuf {
    let file_name = partial_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("recovered.partial.wav");
    partial_path.with_file_name(file_name.replace(".partial.wav", " - recovered.wav"))
}

fn recover_recording_take(mut take: RecordingTake) -> Result<RecordingTake, String> {
    let partial = PathBuf::from(&take.partial_path);
    let final_path = PathBuf::from(&take.vocal_path);
    let legacy_recovered = legacy_recovered_path(&partial);

    if !final_path.is_file() {
        if partial.is_file() {
            repair_partial_wav_header(&partial)
                .map_err(|error| format!("Interrupted vocal could not be repaired: {error}"))?;
            replace_file(&partial, &final_path)
                .map_err(|error| format!("Repaired vocal could not be restored: {error}"))?;
        } else if legacy_recovered.is_file() {
            replace_file(&legacy_recovered, &final_path)
                .map_err(|error| format!("Recovered vocal could not be reconnected: {error}"))?;
        } else {
            return Err("Interrupted vocal audio is missing".into());
        }
    }

    let reader = hound::WavReader::open(&final_path)
        .map_err(|error| format!("Recovered vocal is unreadable: {error}"))?;
    let sample_rate = reader.spec().sample_rate;
    let total_samples = reader.duration() as u64;
    if sample_rate == 0 || total_samples == 0 {
        return Err("Recovered vocal contains no playable audio".into());
    }

    take.sample_rate = sample_rate;
    take.recorded_samples = total_samples.saturating_sub(take.pre_roll_samples);
    take.status = "recovered".into();
    take.error = Some(
        "Recovered after Nightingale was interrupted. The dry vocal is available; no automatic mix was created."
            .into(),
    );
    Ok(take)
}

fn ensure_recovery_history(take: &RecordingTake, recovered: bool) -> Result<(), String> {
    let ended_at = recovery_session_end_time(take);
    if library_db::practice_session_exists(&take.session_id).map_err(|error| error.to_string())? {
        return library_db::repair_recovered_session_end_time(&take.session_id, ended_at)
            .map_err(|error| error.to_string());
    }
    let message = take.error.clone().unwrap_or_else(|| {
        if recovered {
            if take.mix_path.is_some() || take.video_path.is_some() {
                "Recovered finalized performance".into()
            } else {
                "Recovered dry vocal".into()
            }
        } else {
            "Interrupted recording could not be recovered".into()
        }
    });
    let session = SavePracticeSession {
        id: take.session_id.clone(),
        profile: take.profile.clone(),
        song_hash: (!take.song_hash.is_empty()).then(|| take.song_hash.clone()),
        kind: "recovered-recording".into(),
        started_at: take.created_at,
        ended_at,
        performance_json: serde_json::json!({
            "completion": if recovered { "recovered" } else { "recovery-failed" },
            "message": message,
        })
        .to_string(),
        recording_take_id: Some(take.id.clone()),
        transport_segments: Vec::new(),
    };
    library_db::upsert_practice_session(&session).map_err(|error| error.to_string())
}

fn recovery_session_end_time(take: &RecordingTake) -> u64 {
    let duration = if take.sample_rate == 0 {
        0
    } else {
        take.recorded_samples
            .saturating_add(take.sample_rate as u64 - 1)
            / take.sample_rate as u64
    };
    take.created_at.saturating_add(duration)
}

fn hydrate_recorded_samples_from_wav(take: &mut RecordingTake) -> Result<bool, String> {
    if take.recorded_samples > 0 {
        return Ok(false);
    }
    let vocal = Path::new(&take.vocal_path);
    if !vocal.is_file() {
        return Ok(false);
    }
    let reader = hound::WavReader::open(vocal)
        .map_err(|error| format!("Saved vocal is unreadable: {error}"))?;
    let sample_rate = reader.spec().sample_rate;
    let total_samples = reader.duration() as u64;
    if sample_rate == 0 || total_samples == 0 {
        return Ok(false);
    }
    take.sample_rate = sample_rate;
    take.recorded_samples = total_samples.saturating_sub(take.pre_roll_samples);
    Ok(true)
}

fn reconnect_finalized_recording_history(status: &str) {
    match library_db::list_recording_takes_by_status(status) {
        Ok(takes) => {
            for mut take in takes {
                let mut take_changed = match hydrate_recorded_samples_from_wav(&mut take) {
                    Ok(changed) => changed,
                    Err(error) => {
                        tracing::warn!("Failed to inspect finalized vocal metadata: {error}");
                        false
                    }
                };
                let has_saved_media = Path::new(&take.vocal_path).is_file()
                    || take
                        .mix_path
                        .as_deref()
                        .is_some_and(|path| Path::new(path).is_file())
                    || take
                        .video_path
                        .as_deref()
                        .is_some_and(|path| Path::new(path).is_file());
                if !has_saved_media && take.status != "failed" {
                    take.status = "failed".into();
                    take.error = Some("Finalized recording files are missing".into());
                    take_changed = true;
                }
                if take_changed {
                    if let Err(error) = update_recording_take(&take) {
                        tracing::warn!("Failed to mark missing finalized recording: {error}");
                        continue;
                    }
                }
                if let Err(error) = ensure_recovery_history(&take, has_saved_media) {
                    tracing::warn!("Failed to reconnect {status} recording to history: {error}");
                }
            }
        }
        Err(error) => tracing::warn!("Failed to load {status} recordings: {error}"),
    }
}

pub fn recover_partial_recordings() {
    let root = nightingale_dir().join("recordings");
    if !root.is_dir() {
        return;
    }

    let mut linked_partials = std::collections::HashSet::new();
    match library_db::list_recording_takes_by_status("recording") {
        Ok(takes) => {
            for take in takes {
                linked_partials.insert(PathBuf::from(&take.partial_path));
                match recover_recording_take(take.clone()) {
                    Ok(recovered) => {
                        if let Err(error) = update_recording_take(&recovered) {
                            tracing::warn!("Failed to reconnect recovered recording: {error}");
                            continue;
                        }
                        if let Err(error) = ensure_recovery_history(&recovered, true) {
                            tracing::warn!("Failed to add recovered recording to history: {error}");
                        }
                    }
                    Err(error) => {
                        let mut failed = take;
                        failed.status = "failed".into();
                        failed.error = Some(error);
                        if let Err(error) = update_recording_take(&failed) {
                            tracing::warn!("Failed to mark interrupted recording: {error}");
                            continue;
                        }
                        if let Err(error) = ensure_recovery_history(&failed, false) {
                            tracing::warn!(
                                "Failed to add interrupted recording to history: {error}"
                            );
                        }
                    }
                }
            }
        }
        Err(error) => tracing::warn!("Failed to load interrupted recordings: {error}"),
    }

    for status in ["recorded", "ready", "recovered", "failed"] {
        reconnect_finalized_recording_history(status);
    }

    for entry in walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        match cleanup_completed_export_partial(path) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(error) => tracing::warn!(
                "Failed to remove completed export partial {}: {error}",
                path.display()
            ),
        }
        if !path.to_string_lossy().ends_with(".partial.wav") {
            continue;
        }
        if linked_partials.contains(path) {
            continue;
        }
        if repair_partial_wav_header(path).is_ok() {
            let recovered = legacy_recovered_path(path);
            let _ = std::fs::rename(path, recovered);
        } else {
            tracing::warn!(
                "Leaving unreadable partial recording in place: {}",
                path.display()
            );
        }
    }
}

fn repair_partial_wav_header(path: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    if file_len <= 44 || file_len > u32::MAX as u64 {
        return Err("Partial WAV has no recoverable audio".into());
    }
    let mut header = vec![0_u8; file_len.min(4096) as usize];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if header.get(0..4) != Some(b"RIFF") || header.get(8..12) != Some(b"WAVE") {
        return Err("Partial recording is not a RIFF/WAVE file".into());
    }

    let mut offset = 12_usize;
    let mut data_size_offset = None;
    let mut data_start = None;
    let mut block_align = 3_u64;
    while offset + 8 <= header.len() {
        let chunk_id = &header[offset..offset + 4];
        let size = u32::from_le_bytes(
            header[offset + 4..offset + 8]
                .try_into()
                .map_err(|_| "Invalid WAV chunk size")?,
        ) as usize;
        if chunk_id == b"fmt " && offset + 22 <= header.len() {
            block_align = u16::from_le_bytes(
                header[offset + 20..offset + 22]
                    .try_into()
                    .map_err(|_| "Invalid WAV format chunk")?,
            )
            .max(1) as u64;
        }
        if chunk_id == b"data" {
            data_size_offset = Some(offset + 4);
            data_start = Some(offset + 8);
            break;
        }
        offset = offset
            .saturating_add(8)
            .saturating_add(size)
            .saturating_add(size % 2);
    }

    let data_size_offset = data_size_offset.ok_or("WAV data chunk is missing")?;
    let data_start = data_start.ok_or("WAV data payload is missing")? as u64;
    if data_start >= file_len {
        return Err("Partial WAV has no audio payload".into());
    }
    let data_size = ((file_len - data_start) / block_align) * block_align;
    if data_size == 0 || data_size > u32::MAX as u64 {
        return Err("Partial WAV audio payload is invalid".into());
    }
    let repaired_len = data_start + data_size;
    file.set_len(repaired_len)
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(4))
        .map_err(|error| error.to_string())?;
    file.write_all(&((repaired_len - 8) as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(data_size_offset as u64))
        .map_err(|error| error.to_string())?;
    file.write_all(&(data_size as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

pub fn new_exercise_session_id() -> String {
    format!("exercise-{}", unix_now())
}

#[cfg(test)]
mod tests {
    use super::{
        ExportRecordingRequest, RecordingTake, TransportSegment, cleanup_completed_export_partial,
        hydrate_recorded_samples_from_wav, recording_audio_codec_args, recording_mix_filter,
        recording_video_codec_args, recover_recording_take, recovery_session_end_time,
        repair_partial_wav_header, safe_component,
    };
    use crate::vendor::{ffmpeg_path, silent_command};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn preserves_unicode_while_removing_windows_invalid_characters() {
        assert_eq!(
            safe_component("back number - 花束: live?", "take"),
            "back number - 花束_ live_"
        );
    }

    #[test]
    fn removes_only_export_partials_that_have_a_completed_sibling() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-export-cleanup-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let completed = root.join("back number - 花束 - performance.m4a");
        let duplicate = root.join("back number - 花束 - performance.partial.m4a");
        let orphan = root.join("other - performance.partial.mp4");
        std::fs::write(&completed, b"complete").unwrap();
        std::fs::write(&duplicate, b"duplicate").unwrap();
        std::fs::write(&orphan, b"orphan").unwrap();

        assert!(cleanup_completed_export_partial(&duplicate).unwrap());
        assert!(!duplicate.exists());
        assert!(completed.exists());
        assert!(!cleanup_completed_export_partial(&orphan).unwrap());
        assert!(orphan.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovered_history_uses_recorded_duration_instead_of_restart_time() {
        let take = RecordingTake {
            id: "take-duration".into(),
            session_id: "session-duration".into(),
            song_hash: "song".into(),
            profile: "Guest".into(),
            title: "花束".into(),
            artist: "back number".into(),
            vocal_path: "vocal.wav".into(),
            partial_path: "vocal.partial.wav".into(),
            mix_path: None,
            video_path: None,
            status: "recovered".into(),
            sample_rate: 48_000,
            pre_roll_samples: 48_000,
            recorded_samples: 3_574_688,
            playback_start_sec: 0.0,
            created_at: 1_000,
            error: None,
        };

        assert_eq!(recovery_session_end_time(&take), 1_075);
    }

    #[test]
    fn hydrates_missing_legacy_sample_metadata_from_the_saved_vocal() {
        let path = std::env::temp_dir().join(format!(
            "nightingale-recording-metadata-{}.wav",
            rand::random::<u64>()
        ));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..72_000 {
            writer.write_sample(0_i32).unwrap();
        }
        writer.finalize().unwrap();
        let mut take = RecordingTake {
            id: "take-metadata".into(),
            session_id: "session-metadata".into(),
            song_hash: "song".into(),
            profile: "Guest".into(),
            title: "花束".into(),
            artist: "back number".into(),
            vocal_path: path.to_string_lossy().into_owned(),
            partial_path: String::new(),
            mix_path: None,
            video_path: None,
            status: "recorded".into(),
            sample_rate: 0,
            pre_roll_samples: 48_000,
            recorded_samples: 0,
            playback_start_sec: 0.0,
            created_at: 1_000,
            error: None,
        };

        assert!(hydrate_recorded_samples_from_wav(&mut take).unwrap());
        assert_eq!(take.sample_rate, 48_000);
        assert_eq!(take.recorded_samples, 24_000);
        assert_eq!(recovery_session_end_time(&take), 1_001);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reconnects_a_legacy_recovered_take_to_its_database_path() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-linked-recovery-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let final_path = root.join("back number - 花束 - vocal.wav");
        let partial_path = root.join("back number - 花束 - vocal.partial.wav");
        let legacy_path = root.join("back number - 花束 - vocal - recovered.wav");
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 48_000,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&legacy_path, spec).unwrap();
        for _ in 0..72_000 {
            writer.write_sample(0_i32).unwrap();
        }
        writer.finalize().unwrap();

        let take = RecordingTake {
            id: "take-linked".into(),
            session_id: "session-linked".into(),
            song_hash: "song".into(),
            profile: "Guest".into(),
            title: "花束".into(),
            artist: "back number".into(),
            vocal_path: final_path.to_string_lossy().into_owned(),
            partial_path: partial_path.to_string_lossy().into_owned(),
            mix_path: None,
            video_path: None,
            status: "recording".into(),
            sample_rate: 48_000,
            pre_roll_samples: 48_000,
            recorded_samples: 0,
            playback_start_sec: 0.0,
            created_at: 0,
            error: None,
        };
        let recovered = recover_recording_take(take).unwrap();

        assert_eq!(recovered.status, "recovered");
        assert_eq!(recovered.recorded_samples, 24_000);
        assert!(final_path.is_file());
        assert!(!legacy_path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_filter_places_each_transport_segment_on_its_source_timeline() {
        let take = RecordingTake {
            id: "take".into(),
            session_id: "session".into(),
            song_hash: "song".into(),
            profile: "Guest".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            vocal_path: "vocal.wav".into(),
            partial_path: "vocal.partial.wav".into(),
            mix_path: None,
            video_path: None,
            status: "recorded".into(),
            sample_rate: 48_000,
            pre_roll_samples: 48_000,
            recorded_samples: 240_000,
            playback_start_sec: 10.0,
            created_at: 0,
            error: None,
        };
        let request = ExportRecordingRequest {
            take_id: "take".into(),
            latency_compensation_sec: 0.125,
            vocal_gain: 1.0,
            video_path: None,
            transport_segments: vec![
                TransportSegment {
                    source_start: 10.0,
                    source_end: 12.0,
                    recorded_start: 0.0,
                    recorded_end: 2.0,
                },
                TransportSegment {
                    source_start: 30.0,
                    source_end: 33.0,
                    recorded_start: 2.0,
                    recorded_end: 5.0,
                },
            ],
        };
        let filter = recording_mix_filter(&take, &request);
        assert!(filter.contains("atrim=start=1.125000:duration=2.000000"));
        assert!(filter.contains("adelay=10000:all=1[v0]"));
        assert!(filter.contains("atrim=start=3.125000:duration=3.000000"));
        assert!(filter.contains("adelay=30000:all=1[v1]"));
        assert!(filter.contains("amix=inputs=3:duration=first"));
    }

    #[test]
    fn video_export_prefers_stream_copy_and_keeps_a_transcode_fallback() {
        let fast = recording_video_codec_args(true);
        assert!(fast.windows(2).any(|pair| pair == ["-c:v", "copy"]));
        assert!(fast.windows(2).any(|pair| pair == ["-c:a", "copy"]));
        assert!(
            fast.windows(2)
                .any(|pair| pair == ["-shortest_buf_duration", "0.5"])
        );

        let fallback = recording_video_codec_args(false);
        assert!(fallback.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(
            fallback
                .windows(2)
                .any(|pair| pair == ["-preset", "veryfast"])
        );
        assert!(fallback.windows(2).any(|pair| pair == ["-c:a", "copy"]));
    }

    #[test]
    fn performance_audio_uses_a_standard_forty_eight_kilohertz_aac_stream() {
        let args = recording_audio_codec_args();
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:a", "256k"]));
        assert!(args.windows(2).any(|pair| pair == ["-ar", "48000"]));
    }

    #[test]
    fn repairs_a_crash_interrupted_pcm_wav_header() {
        let path = std::env::temp_dir().join(format!(
            "nightingale-recovery-{}.partial.wav",
            rand::random::<u64>()
        ));
        let samples = [0_i32, 200_000, -200_000, 100_000];
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&48_000_u32.to_le_bytes());
        bytes.extend_from_slice(&(48_000_u32 * 3).to_le_bytes());
        bytes.extend_from_slice(&3_u16.to_le_bytes());
        bytes.extend_from_slice(&24_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        for sample in samples {
            let encoded = sample.to_le_bytes();
            bytes.extend_from_slice(&encoded[..3]);
        }
        std::fs::write(&path, bytes).unwrap();

        repair_partial_wav_header(&path).unwrap();
        let mut reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, 48_000);
        assert_eq!(reader.duration(), samples.len() as u32);
        assert_eq!(reader.samples::<i32>().count(), samples.len());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    #[ignore = "runs the production FFmpeg mix filter against synthetic audio"]
    fn calibrated_mix_alignment_stays_within_fifty_milliseconds() {
        const SAMPLE_RATE: u32 = 48_000;
        const LATENCY_SECONDS: f64 = 0.135;
        const TARGET_SECONDS: f64 = 2.0;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir();
        let instrumental = root.join(format!("nightingale-alignment-{nonce}-instrumental.wav"));
        let vocal = root.join(format!("nightingale-alignment-{nonce}-vocal.wav"));
        let output = root.join(format!("nightingale-alignment-{nonce}-mix.wav"));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 24,
            sample_format: hound::SampleFormat::Int,
        };

        let mut instrumental_writer = hound::WavWriter::create(&instrumental, spec).unwrap();
        for _ in 0..SAMPLE_RATE as usize * 5 {
            instrumental_writer.write_sample(0_i32).unwrap();
        }
        instrumental_writer.finalize().unwrap();

        let trim_samples =
            SAMPLE_RATE as usize + (SAMPLE_RATE as f64 * LATENCY_SECONDS).round() as usize;
        let mut vocal_writer = hound::WavWriter::create(&vocal, spec).unwrap();
        for index in 0..(trim_samples + SAMPLE_RATE as usize) {
            let sample = if (trim_samples..trim_samples + 960).contains(&index) {
                let phase = (index - trim_samples) as f64 * 1_000.0 * std::f64::consts::TAU
                    / SAMPLE_RATE as f64;
                (phase.sin() * 4_000_000.0) as i32
            } else {
                0
            };
            vocal_writer.write_sample(sample).unwrap();
        }
        vocal_writer.finalize().unwrap();

        let take = RecordingTake {
            id: "take".into(),
            session_id: "session".into(),
            song_hash: "song".into(),
            profile: "Guest".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            vocal_path: vocal.to_string_lossy().into_owned(),
            partial_path: String::new(),
            mix_path: None,
            video_path: None,
            status: "recorded".into(),
            sample_rate: SAMPLE_RATE,
            pre_roll_samples: SAMPLE_RATE as u64,
            recorded_samples: SAMPLE_RATE as u64,
            playback_start_sec: TARGET_SECONDS,
            created_at: 0,
            error: None,
        };
        let request = ExportRecordingRequest {
            take_id: take.id.clone(),
            latency_compensation_sec: LATENCY_SECONDS,
            vocal_gain: 1.0,
            video_path: None,
            transport_segments: vec![TransportSegment {
                source_start: TARGET_SECONDS,
                source_end: TARGET_SECONDS + 1.0,
                recorded_start: 0.0,
                recorded_end: 1.0,
            }],
        };
        let filter = recording_mix_filter(&take, &request);
        let status = silent_command(ffmpeg_path())
            .args(["-y", "-i"])
            .arg(&instrumental)
            .args(["-i"])
            .arg(&vocal)
            .args([
                "-filter_complex",
                &filter,
                "-map",
                "[out]",
                "-c:a",
                "pcm_s16le",
                "-v",
                "error",
            ])
            .arg(&output)
            .status()
            .unwrap();
        assert!(status.success());

        let mut reader = hound::WavReader::open(&output).unwrap();
        let first_signal = reader
            .samples::<i16>()
            .enumerate()
            .find_map(|(index, sample)| (sample.unwrap().abs() > 200).then_some(index))
            .expect("mixed impulse was not found");
        let aligned_seconds = first_signal as f64 / reader.spec().sample_rate as f64;
        assert!(
            (aligned_seconds - TARGET_SECONDS).abs() <= 0.05,
            "impulse landed at {aligned_seconds:.6}s instead of {TARGET_SECONDS:.6}s"
        );

        for path in [instrumental, vocal, output] {
            std::fs::remove_file(path).unwrap();
        }
    }
}
