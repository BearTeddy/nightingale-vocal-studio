use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

use lofty::{
    file::{AudioFile, TaggedFileExt},
    tag::Accessor,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use blake3::Hasher;
use std::{fs::File, io::Read};

use crate::{cache::CacheDir, error::NightingaleError, usdx::UsdxBundle};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum TranscriptSource {
    Lyrics,
    Generated,
    Usdx,
    /// Timing came directly from a provided LRC / Enhanced LRC file (no AI
    /// transcription or alignment).
    Lrc,
}

/// Where the bytes for a song actually live. `LocalFile` means `Song.path` is the
/// real source-of-truth on disk; the remote variants (`Jellyfin`, `Navidrome`,
/// `Plex`) mean `Song.path` is a placeholder inside `cache/sources/` that the source
/// adapter will materialise on demand.
///
/// The server's base URL deliberately does NOT live on the origin: it lives on
/// the active `AppConfig.library_source` and would otherwise go stale the next
/// time the user reconnects to a different host.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum SongOrigin {
    LocalFile,
    Jellyfin {
        item_id: String,
        #[serde(default)]
        container: Option<String>,
        /// Jellyfin's `ImageTags.Primary` for this item, captured at scan
        /// time. We re-fetch the cover only when this value changes.
        #[serde(default)]
        cover_tag: Option<String>,
    },
    Navidrome {
        item_id: String,
        #[serde(default)]
        container: Option<String>,
        /// Subsonic `coverArt` id for this song, captured at scan time. We
        /// re-fetch the cover only when this value changes.
        #[serde(default)]
        cover_tag: Option<String>,
    },
    Plex {
        item_id: String,
        /// Server-relative original-media part key. Keeping it relative lets
        /// the backend authenticate without exposing a token-bearing URL.
        part_key: String,
        #[serde(default)]
        container: Option<String>,
        /// Server-relative Plex thumb path used for cover invalidation.
        #[serde(default)]
        cover_tag: Option<String>,
    },
}

pub(crate) fn default_origin() -> SongOrigin {
    SongOrigin::LocalFile
}

impl SongOrigin {
    /// Mutable handle to the `cover_tag` slot on any remote-origin variant.
    /// `library_db::remote::refresh_remote_cover_for_item` uses this to clear
    /// the stored tag when the upstream cover disappears, without needing to
    /// know which remote source it's dealing with.
    pub fn cover_tag_mut(&mut self) -> Option<&mut Option<String>> {
        match self {
            Self::LocalFile => None,
            Self::Jellyfin { cover_tag, .. }
            | Self::Navidrome { cover_tag, .. }
            | Self::Plex { cover_tag, .. } => Some(cover_tag),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Song {
    pub path: PathBuf,
    pub file_hash: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: f64,
    pub album_art_path: Option<PathBuf>,
    pub is_analyzed: bool,
    pub language: Option<String>,
    #[serde(default)]
    pub transcript_source: Option<TranscriptSource>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub override_key: Option<String>,
    #[serde(default = "default_tempo")]
    pub tempo: f64,
    #[serde(default)]
    pub key_offset: i32,
    pub is_video: bool,
    #[serde(default)]
    pub usdx: Option<UsdxBundle>,
    #[serde(default = "default_origin")]
    pub origin: SongOrigin,
    /// True when the song was made playable from provided LRC without stem
    /// separation: playback uses the original mix and the guide control is
    /// hidden. Defaults to `false` for stem-separated songs.
    #[serde(default)]
    pub no_stems: bool,
}

fn default_tempo() -> f64 {
    1.0
}

#[derive(Debug, Clone)]
pub struct TranscriptMetaInfo {
    pub source: TranscriptSource,
    pub language: Option<String>,
    pub key: Option<String>,
    pub tempo: f64,
    pub no_stems: bool,
}

impl Song {
    pub fn from_path(
        path: &Path,
        file_hash: String,
        cache: &CacheDir,
        is_analyzed: bool,
        language: Option<String>,
        transcript_source: Option<TranscriptSource>,
        key: Option<String>,
        override_key: Option<String>,
        tempo: f64,
        key_offset: i32,
        is_video: bool,
        usdx: Option<UsdxBundle>,
        origin: SongOrigin,
    ) -> Self {
        let (mut title, mut artist, mut album, duration_secs, cover_bytes) = if is_video {
            read_video_metadata(path)
        } else {
            read_metadata(path)
        };

        if title.is_empty() {
            title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Unknown")
                .to_string();
        }
        if artist.is_empty() {
            artist = "Unknown Artist".to_string();
        }
        if album.is_empty() {
            album = "Unknown Album".to_string();
        }

        let album_art_path = cover_bytes.and_then(|bytes| store_cover(cache, &bytes));

        Self {
            path: path.to_path_buf(),
            file_hash,
            title,
            artist,
            album,
            duration_secs,
            album_art_path,
            is_analyzed,
            language,
            transcript_source,
            key,
            override_key,
            tempo,
            key_offset,
            is_video,
            usdx,
            origin,
            no_stems: false,
        }
    }
}

pub(crate) fn compute_file_hash(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Hasher::new();
    let mut buf = [0u8; 8192];

    loop {
        let n = file.read(&mut buf)?;

        if n == 0 {
            break;
        }

        hasher.update(&buf[..n]);
    }

    Ok(hasher.finalize().to_hex()[..32].to_string())
}

pub fn build_song(path: &Path, cache: &CacheDir, is_video: bool) -> Result<Song, NightingaleError> {
    let file_hash = compute_file_hash(path)?;

    let is_analyzed = cache.transcript_exists(&file_hash);
    let (transcript_source, language, key, tempo, no_stems) = if is_analyzed {
        let meta = read_transcript_meta(cache, &file_hash);
        (
            Some(meta.source),
            meta.language,
            meta.key,
            meta.tempo,
            meta.no_stems,
        )
    } else {
        (None, None, None, default_tempo(), false)
    };

    let mut song = Song::from_path(
        path,
        file_hash,
        cache,
        is_analyzed,
        language,
        transcript_source,
        key,
        None,
        tempo,
        0,
        is_video,
        None,
        SongOrigin::LocalFile,
    );
    song.no_stems = no_stems;
    Ok(song)
}

pub fn read_transcript_meta(cache: &CacheDir, hash: &str) -> TranscriptMetaInfo {
    #[derive(serde::Deserialize)]
    struct TranscriptMeta {
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        language: Option<String>,
        #[serde(default)]
        key: Option<String>,
        #[serde(default = "default_tempo")]
        tempo: f64,
        #[serde(default)]
        no_stems: bool,
    }
    let path = cache.transcript_path(hash);
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = serde_json::from_str::<TranscriptMeta>(&data) {
            let src = match parsed.source.as_deref() {
                Some("lyrics") => TranscriptSource::Lyrics,
                Some("usdx") => TranscriptSource::Usdx,
                Some("lrc") => TranscriptSource::Lrc,
                _ => TranscriptSource::Generated,
            };
            return TranscriptMetaInfo {
                source: src,
                language: parsed.language,
                key: parsed.key,
                tempo: parsed.tempo,
                no_stems: parsed.no_stems,
            };
        }
    }
    TranscriptMetaInfo {
        source: TranscriptSource::Generated,
        language: None,
        key: None,
        tempo: default_tempo(),
        no_stems: false,
    }
}

fn read_metadata(path: &Path) -> (String, String, String, f64, Option<Vec<u8>>) {
    let tagged = match lofty::read_from_path(path) {
        Ok(t) => t,
        Err(_) => return (String::new(), String::new(), String::new(), 0.0, None),
    };

    let properties = tagged.properties();
    let duration_secs = properties.duration().as_secs_f64();

    let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
        Some(t) => t,
        None => {
            return (
                String::new(),
                String::new(),
                String::new(),
                duration_secs,
                None,
            );
        }
    };

    let title = tag.title().map(|s| s.to_string()).unwrap_or_default();
    let artist = tag.artist().map(|s| s.to_string()).unwrap_or_default();
    let album = tag.album().map(|s| s.to_string()).unwrap_or_default();

    let album_art = tag.pictures().first().map(|pic| pic.data().to_vec());

    (title, artist, album, duration_secs, album_art)
}

const MAX_YOUTUBE_INFO_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Default, Deserialize)]
struct YoutubeInfoJson {
    title: Option<String>,
    fulltitle: Option<String>,
    track: Option<String>,
    artist: Option<String>,
    creator: Option<String>,
    uploader: Option<String>,
    channel: Option<String>,
    album: Option<String>,
    playlist_title: Option<String>,
    duration: Option<f64>,
}

#[derive(Debug, PartialEq)]
struct YoutubeSidecarMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    duration_secs: Option<f64>,
}

fn youtube_info_path(media_path: &Path) -> PathBuf {
    media_path.with_extension("info.json")
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn clean_video_title(mut value: String) -> String {
    const NOISE: &[&str] = &[
        "official video",
        "official music video",
        "official audio",
        "lyric",
        "lyrics",
        "visualizer",
        "full",
        "hd",
        "4k",
    ];
    loop {
        let trimmed = value.trim_end();
        let (open, close) = if trimmed.ends_with(')') {
            ('(', ')')
        } else if trimmed.ends_with(']') {
            ('[', ']')
        } else {
            break;
        };
        let Some(start) = trimmed.rfind(open) else {
            break;
        };
        let inner = trimmed[start + open.len_utf8()..trimmed.len() - close.len_utf8()]
            .trim()
            .to_ascii_lowercase();
        if !NOISE.iter().any(|noise| inner.contains(noise)) {
            break;
        }
        value.truncate(start);
    }
    value.trim().to_string()
}

fn split_artist_title(value: &str) -> Option<(String, String)> {
    for separator in [" - ", " – ", " — ", " | ", " ｜ "] {
        let Some((artist, title)) = value.split_once(separator) else {
            continue;
        };
        let artist = artist.trim();
        let title = clean_video_title(title.trim().to_string());
        if !artist.is_empty() && !title.is_empty() {
            return Some((artist.to_string(), title));
        }
    }
    None
}

fn read_youtube_sidecar_metadata(media_path: &Path) -> Option<YoutubeSidecarMetadata> {
    let path = youtube_info_path(media_path);
    if std::fs::metadata(&path).ok()?.len() > MAX_YOUTUBE_INFO_BYTES {
        return None;
    }
    let info: YoutubeInfoJson = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let raw_title = non_empty(info.track).or_else(|| non_empty(info.title));
    let explicit_artist = non_empty(info.artist).or_else(|| non_empty(info.creator));
    let split = info
        .fulltitle
        .as_deref()
        .and_then(split_artist_title)
        .or_else(|| raw_title.as_deref().and_then(split_artist_title));
    let inferred = explicit_artist.is_none().then_some(split).flatten();
    let title = inferred
        .as_ref()
        .map(|(_, title)| title.clone())
        .or_else(|| raw_title.map(clean_video_title));
    let artist = explicit_artist
        .or_else(|| inferred.map(|(artist, _)| artist))
        .or_else(|| non_empty(info.uploader))
        .or_else(|| non_empty(info.channel));
    let album = non_empty(info.album).or_else(|| non_empty(info.playlist_title));
    let duration_secs = info
        .duration
        .filter(|duration| duration.is_finite() && *duration > 0.0);
    Some(YoutubeSidecarMetadata {
        title,
        artist,
        album,
        duration_secs,
    })
}

fn read_youtube_sidecar_cover(media_path: &Path) -> Option<Vec<u8>> {
    ["jpg", "jpeg", "png", "webp"]
        .into_iter()
        .find_map(|extension| std::fs::read(media_path.with_extension(extension)).ok())
        .filter(|bytes| !bytes.is_empty())
}

fn store_cover(cache: &CacheDir, bytes: &[u8]) -> Option<PathBuf> {
    let cover_hash = blake3::hash(bytes).to_hex()[..32].to_string();
    let cover_path = cache.cover_path(&cover_hash);
    if !cover_path.exists() {
        std::fs::write(&cover_path, bytes).ok()?;
    }
    Some(cover_path)
}

pub(crate) fn refresh_youtube_sidecar_metadata(song: &mut Song, cache: &CacheDir) -> bool {
    if !song.is_video {
        return false;
    }
    let Some(metadata) = read_youtube_sidecar_metadata(&song.path) else {
        return false;
    };
    let before = (
        song.title.clone(),
        song.artist.clone(),
        song.album.clone(),
        song.duration_secs,
        song.album_art_path.clone(),
    );
    if let Some(title) = metadata.title {
        song.title = title;
    }
    if let Some(artist) = metadata.artist {
        song.artist = artist;
    }
    if let Some(album) = metadata.album {
        song.album = album;
    }
    if let Some(duration_secs) = metadata.duration_secs {
        song.duration_secs = duration_secs;
    }
    if song.album_art_path.is_none() {
        song.album_art_path =
            read_youtube_sidecar_cover(&song.path).and_then(|bytes| store_cover(cache, &bytes));
    }
    before
        != (
            song.title.clone(),
            song.artist.clone(),
            song.album.clone(),
            song.duration_secs,
            song.album_art_path.clone(),
        )
}

fn read_video_metadata(path: &Path) -> (String, String, String, f64, Option<Vec<u8>>) {
    let ffmpeg = crate::vendor::ffmpeg_path();

    // Just probe the header -- no output file means ffmpeg reads metadata and exits immediately.
    let probe = crate::vendor::silent_command(&ffmpeg)
        .args(["-i", &path.to_string_lossy()])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    let mut title = String::new();
    let mut artist = String::new();
    let mut album = String::new();
    let mut duration_secs = 0.0;

    if let Ok(output) = probe {
        let stderr = String::from_utf8_lossy(&output.stderr);
        for line in stderr.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("Duration:") {
                if let Some(ts) = rest.split(',').next() {
                    duration_secs = parse_ffmpeg_duration(ts.trim());
                }
            }
            if let Some(val) = strip_meta_tag(trimmed, "title") {
                title = val;
            }
            if let Some(val) = strip_meta_tag(trimmed, "artist") {
                artist = val;
            }
            if let Some(val) = strip_meta_tag(trimmed, "album") {
                album = val;
            }
        }
    }

    if let Some(metadata) = read_youtube_sidecar_metadata(path) {
        if let Some(value) = metadata.title {
            title = value;
        }
        if let Some(value) = metadata.artist {
            artist = value;
        }
        if let Some(value) = metadata.album {
            album = value;
        }
        if let Some(value) = metadata.duration_secs {
            duration_secs = value;
        }
    }

    let album_art =
        read_youtube_sidecar_cover(path).or_else(|| extract_video_thumbnail(&ffmpeg, path));

    (title, artist, album, duration_secs, album_art)
}

fn extract_video_thumbnail(ffmpeg: &Path, video_path: &Path) -> Option<Vec<u8>> {
    let output = crate::vendor::silent_command(ffmpeg)
        .args([
            "-i",
            &video_path.to_string_lossy(),
            "-vframes",
            "1",
            "-f",
            "image2pipe",
            "-c:v",
            "mjpeg",
            "-vf",
            "scale=300:-1",
            "-v",
            "error",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if output.status.success() && !output.stdout.is_empty() {
        Some(output.stdout)
    } else {
        None
    }
}

fn strip_meta_tag(line: &str, tag: &str) -> Option<String> {
    let lower = line.to_lowercase();
    if lower.starts_with(tag) {
        let after = &line[tag.len()..];
        let after = after.trim_start();
        if let Some(val) = after.strip_prefix(':') {
            let val = val.trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn parse_ffmpeg_duration(s: &str) -> f64 {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: f64 = parts[0].parse().unwrap_or(0.0);
        let m: f64 = parts[1].parse().unwrap_or(0.0);
        let s: f64 = parts[2].parse().unwrap_or(0.0);
        h * 3600.0 + m * 60.0 + s
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Song, SongOrigin, TranscriptSource, YoutubeSidecarMetadata, read_youtube_sidecar_metadata,
        refresh_youtube_sidecar_metadata, split_artist_title,
    };
    use crate::cache::CacheDir;
    use std::fs;

    fn sidecar_fixture(name: &str, payload: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "nightingale-youtube-metadata-{}-{}",
            name,
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        let media = root.join(format!("{name}.mkv"));
        fs::write(media.with_extension("info.json"), payload.as_bytes()).unwrap();
        media
    }

    fn remove_fixture(media: &std::path::Path) {
        if let Some(parent) = media.parent() {
            let _ = fs::remove_dir_all(parent);
        }
    }

    #[test]
    fn reads_unicode_song_fields_from_yt_dlp_sidecars() {
        let media = sidecar_fixture(
            "unicode",
            r#"{"title":"花束","fulltitle":"back number - 花束 (full)","artist":"back number","playlist_title":"日本語プレイリスト","duration":302.5}"#,
        );
        let metadata = read_youtube_sidecar_metadata(&media);
        remove_fixture(&media);
        assert_eq!(
            metadata,
            Some(YoutubeSidecarMetadata {
                title: Some("花束".into()),
                artist: Some("back number".into()),
                album: Some("日本語プレイリスト".into()),
                duration_secs: Some(302.5),
            })
        );
    }

    #[test]
    fn infers_artist_and_cleans_noise_when_the_uploader_did_not_tag_music() {
        let media = sidecar_fixture(
            "inferred",
            r#"{"title":"Ado – 新時代 (Official Music Video)","fulltitle":"Ado – 新時代 (Official Music Video)","uploader":"Fan Channel"}"#,
        );
        let metadata = read_youtube_sidecar_metadata(&media);
        remove_fixture(&media);
        assert_eq!(
            metadata,
            Some(YoutubeSidecarMetadata {
                title: Some("新時代".into()),
                artist: Some("Ado".into()),
                album: None,
                duration_secs: None,
            })
        );
        assert_eq!(
            split_artist_title("米津玄師 | Lemon [Lyrics]"),
            Some(("米津玄師".into(), "Lemon".into()))
        );
    }

    #[test]
    fn refreshes_existing_video_metadata_without_resetting_analysis_state() {
        let media = sidecar_fixture(
            "refresh",
            r#"{"title":"花束","artist":"back number","album":"アンコール","duration":301.25}"#,
        );
        fs::write(media.with_extension("jpg"), b"cover-bytes").unwrap();
        let cache = CacheDir {
            path: media.parent().unwrap().join("cache"),
        };
        fs::create_dir_all(&cache.path).unwrap();
        let mut song = Song {
            path: media.clone(),
            file_hash: "existing-hash".into(),
            title: "èŠ±æŸ".into(),
            artist: "back number".into(),
            album: "Unknown Album".into(),
            duration_secs: 1.0,
            album_art_path: None,
            is_analyzed: true,
            language: Some("ja".into()),
            transcript_source: Some(TranscriptSource::Lyrics),
            key: Some("C".into()),
            override_key: Some("D".into()),
            tempo: 0.9,
            key_offset: 2,
            is_video: true,
            usdx: None,
            origin: SongOrigin::LocalFile,
            no_stems: true,
        };

        assert!(refresh_youtube_sidecar_metadata(&mut song, &cache));
        assert_eq!(song.title, "花束");
        assert_eq!(song.artist, "back number");
        assert_eq!(song.album, "アンコール");
        assert_eq!(song.duration_secs, 301.25);
        assert!(
            song.album_art_path
                .as_ref()
                .is_some_and(|path| path.is_file())
        );
        assert!(song.is_analyzed);
        assert_eq!(song.language.as_deref(), Some("ja"));
        assert_eq!(song.transcript_source, Some(TranscriptSource::Lyrics));
        assert_eq!(song.key.as_deref(), Some("C"));
        assert_eq!(song.override_key.as_deref(), Some("D"));
        assert_eq!(song.tempo, 0.9);
        assert_eq!(song.key_offset, 2);
        assert!(song.no_stems);

        remove_fixture(&media);
    }
}
