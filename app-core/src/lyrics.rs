use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};
use ts_rs::TS;
use unicode_normalization::UnicodeNormalization;

use crate::analyzer::{
    enqueue_one, is_usdx_song, mark_stems_only, prepare_lrc_no_stems, update_song_analyzed,
};
use crate::cache::CacheDir;
use crate::library_db;
use crate::lrc::{self, ParsedLrc};
use crate::song::{Song, TranscriptSource, read_transcript_meta};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LrclibCandidate {
    #[serde(default)]
    pub id: Option<u64>,
    #[serde(default, alias = "trackName")]
    pub track_name: String,
    #[serde(default, alias = "artistName")]
    pub artist_name: String,
    #[serde(default, alias = "albumName")]
    pub album_name: String,
    #[serde(default, alias = "duration")]
    pub duration_secs: f64,
    #[serde(skip_deserializing, default)]
    pub lines: Vec<String>,
    /// Raw LRC (line-level synced lyrics) from LRCLIB, when available. Exposed
    /// to the frontend so the editor can offer timed lyrics without alignment.
    /// `alias` (not `rename`) so it deserializes from LRCLIB's `syncedLyrics`
    /// but still serializes as `synced_lyrics` for the frontend type.
    #[serde(default, alias = "syncedLyrics")]
    pub synced_lyrics: Option<String>,
    #[serde(default, rename = "plainLyrics", skip_serializing)]
    #[ts(skip)]
    plain_lyrics: Option<String>,
    #[serde(skip_deserializing, default)]
    pub match_score: u32,
    #[serde(skip_deserializing, default)]
    pub match_notes: Vec<String>,
    #[serde(skip_deserializing, default)]
    pub source_url: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsSearchOptions {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub language: Option<String>,
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LyricsFile {
    pub lines: Vec<String>,
    #[serde(default)]
    pub language: Option<String>,
}

pub fn lrclib_candidates(song: &Song) -> Vec<LrclibCandidate> {
    search_candidates(song, &LyricsSearchOptions::default()).unwrap_or_else(|error| {
        warn!("[lrclib] {error}");
        Vec::new()
    })
}

fn normalized_match(text: &str) -> String {
    text.nfkc()
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn text_similarity(left: &str, right: &str) -> f64 {
    let a: Vec<char> = normalized_match(left).chars().take(30_000).collect();
    let b: Vec<char> = normalized_match(right).chars().take(30_000).collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let a: HashSet<_> = a.windows(2).map(|w| (w[0], w[1])).collect();
    let b: HashSet<_> = b.windows(2).map(|w| (w[0], w[1])).collect();
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    2.0 * a.intersection(&b).count() as f64 / (a.len() + b.len()) as f64
}

fn prepare_candidate(mut candidate: LrclibCandidate) -> Option<LrclibCandidate> {
    candidate.lines = candidate
        .plain_lyrics
        .as_deref()
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    if candidate
        .synced_lyrics
        .as_deref()
        .is_some_and(|s| s.trim().is_empty())
    {
        candidate.synced_lyrics = None;
    }
    // Some records have synced lyrics and null plainLyrics. They are still
    // usable for forced alignment, not just the timed-LRC playback path.
    if candidate.lines.is_empty() {
        if let Some(parsed) = candidate
            .synced_lyrics
            .as_deref()
            .and_then(|text| lrc::parse_lrc(text).ok())
        {
            candidate.lines = parsed
                .segments
                .into_iter()
                .map(|segment| segment.text)
                .collect();
        }
    }
    if candidate.lines.is_empty() {
        return None;
    }
    candidate.source_url = candidate
        .id
        .map(|id| format!("https://lrclib.net/api/get/{id}"))
        .unwrap_or_else(|| "https://lrclib.net".into());
    Some(candidate)
}

fn rank_candidate(candidate: &mut LrclibCandidate, song: &Song, options: &LyricsSearchOptions) {
    let title = options.title.as_deref().unwrap_or(&song.title);
    let artist = options.artist.as_deref().unwrap_or(&song.artist);
    let title_match = text_similarity(title, &candidate.track_name);
    let artist_match = text_similarity(artist, &candidate.artist_name);
    let delta = (song.duration_secs - candidate.duration_secs).abs();
    let mut score = 40.0 * title_match + 30.0 * artist_match;
    candidate.match_notes.clear();
    if title_match == 1.0 && artist_match == 1.0 {
        candidate.match_notes.push("Title and artist match".into());
    }
    if song.duration_secs > 0.0 && candidate.duration_secs > 0.0 && delta.is_finite() {
        score += 20.0 * (1.0 - delta / 30.0).max(0.0);
        candidate.match_notes.push(if delta <= 3.0 {
            "Duration matches".into()
        } else {
            format!("Duration differs by {:.0}s", delta)
        });
    }
    if !song.album.is_empty()
        && normalized_match(&song.album) == normalized_match(&candidate.album_name)
    {
        score += 5.0;
    }
    let text = candidate.lines.join("\n");
    let language = options
        .language
        .as_deref()
        .filter(|value| *value != "auto")
        .or(song.language.as_deref());
    let native = match language {
        Some("ja") => text.chars().any(|c| {
            ('\u{3040}'..='\u{30ff}').contains(&c) || ('\u{4e00}'..='\u{9fff}').contains(&c)
        }),
        Some("ko") => text.chars().any(|c| ('\u{ac00}'..='\u{d7af}').contains(&c)),
        _ => false,
    };
    if native {
        score += 5.0;
        candidate
            .match_notes
            .push("Original Japanese / Korean script".into());
    } else if matches!(language, Some("ja" | "ko")) {
        score -= 25.0;
        candidate
            .match_notes
            .push("Original script not found — check this version".into());
    }
    if let Some(reference) = options
        .reference
        .as_deref()
        .filter(|s| normalized_match(s).len() >= 12)
    {
        let input_is_latin = reference
            .chars()
            .filter(|c| c.is_alphabetic())
            .all(|c| c.is_ascii());
        if native && input_is_latin {
            candidate
                .match_notes
                .push("Input uses a different script — compare the original lyrics".into());
        } else {
            let similarity = text_similarity(reference, &text);
            score = score * 0.7 + similarity * 30.0;
            candidate.match_notes.push(format!(
                "{}% text overlap with your input",
                (similarity * 100.0).round() as u32
            ));
        }
    }
    candidate.match_score = score.round().clamp(0.0, 100.0) as u32;
}

fn search_candidates(
    song: &Song,
    options: &LyricsSearchOptions,
) -> Result<Vec<LrclibCandidate>, String> {
    let title = options.title.as_deref().unwrap_or(&song.title).trim();
    let artist = options.artist.as_deref().unwrap_or(&song.artist).trim();
    if title.is_empty() {
        return Err("Enter a song title to search for lyrics.".into());
    }
    let artist = if artist == "Unknown Artist" {
        ""
    } else {
        artist
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(12)))
        .build()
        .into();
    let request = |query: &str| -> Result<Vec<LrclibCandidate>, String> {
        agent.get(&format!("https://lrclib.net/api/search?{query}"))
            .header("User-Agent", "NightingaleVocalStudio/1.1 (https://github.com/BearTeddy/nightingale-vocal-studio)")
            .call().map_err(|e| format!("Lyrics search is unavailable: {e}"))?
            .into_body().read_json().map_err(|e| format!("Could not read lyrics search results: {e}"))
    };
    let query = format!(
        "track_name={}&artist_name={}",
        urlencoding::encode(title),
        urlencoding::encode(artist)
    );
    let mut candidates: Vec<_> = request(&query)?
        .into_iter()
        .filter_map(prepare_candidate)
        .collect();
    if candidates.is_empty() {
        // Flexible metadata search supports imports whose title includes extra
        // video labels or whose artist field is missing.
        let cleaned = clean_search_title(title, artist);
        let query = format!("q={}", urlencoding::encode(&format!("{cleaned} {artist}")));
        candidates = request(&query)?
            .into_iter()
            .filter_map(prepare_candidate)
            .collect();
    }
    let mut seen = HashSet::new();
    candidates.retain(|c| {
        seen.insert((
            c.track_name.clone(),
            c.artist_name.clone(),
            c.lines.join("\n"),
            c.synced_lyrics.clone(),
        ))
    });
    for candidate in &mut candidates {
        rank_candidate(candidate, song, options);
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.match_score));
    candidates.truncate(30);
    Ok(candidates)
}

fn clean_search_title(title: &str, artist: &str) -> String {
    // Video imports often embed the original song name inside Japanese quotes.
    if let Some(start) = title.find('「') {
        if let Some(end) = title[start + '「'.len_utf8()..].find('」') {
            return title[start + '「'.len_utf8()..start + '「'.len_utf8() + end]
                .trim()
                .to_owned();
        }
    }
    let mut cleaned = title.to_owned();
    for label in [
        "(Official Music Video)",
        "(Official Video)",
        "(Official Audio)",
        "[Official Video]",
        "Music Video",
        "Official Video",
        "/ THE FIRST TAKE",
    ] {
        if let Some(start) = cleaned.to_ascii_lowercase().find(&label.to_ascii_lowercase()) {
            cleaned.truncate(start);
        }
    }
    if !artist.is_empty() {
        if let Some(rest) = cleaned.strip_prefix(artist) {
            cleaned = rest
                .trim_start_matches([' ', '-', '‐', '–', '—'])
                .to_owned();
        }
    }
    if cleaned.trim().is_empty() {
        title.to_owned()
    } else {
        cleaned.trim().to_owned()
    }
}

fn selected_language(language: Option<String>) -> Result<Option<String>, String> {
    let language = language.filter(|s| !s.is_empty() && s != "auto");
    if language
        .as_deref()
        .is_some_and(|s| !matches!(s, "ja" | "ko" | "en"))
    {
        return Err("Choose Auto, Japanese, Korean, or English.".into());
    }
    Ok(language)
}

pub fn search_lyrics_for_hash(
    file_hash: &str,
    options: LyricsSearchOptions,
) -> Result<Vec<LrclibCandidate>, String> {
    let song = library_db::load_song_by_hash(file_hash)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Song not found".to_string())?;
    search_candidates(&song, &options)
}

pub fn search_lrclib_for_hash(file_hash: &str) -> Vec<LrclibCandidate> {
    let Some(song) = library_db::load_song_by_hash(file_hash).ok().flatten() else {
        return Vec::new();
    };
    lrclib_candidates(&song)
}

pub fn load_lyrics_file(file_hash: &str) -> Option<LyricsFile> {
    let cache = CacheDir::new();
    let path = cache.lyrics_path(file_hash);
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<LyricsFile>(&bytes).ok()
}

pub fn save_lyrics_and_realign(file_hash: &str, lines: Vec<String>) -> Result<(), String> {
    save_lyrics_with_language(file_hash, lines, None)
}

pub fn save_lyrics_with_language(
    file_hash: &str,
    lines: Vec<String>,
    language: Option<String>,
) -> Result<(), String> {
    if is_usdx_song(file_hash) {
        return Err("Cannot edit lyrics for USDX songs".to_string());
    }

    let normalized: Vec<String> = lines
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if normalized.is_empty() {
        return Err("Lyrics cannot be empty".to_string());
    }
    let language = selected_language(language)?;

    let cache = CacheDir::new();
    let previous_language = library_db::load_song_by_hash(file_hash)
        .ok()
        .flatten()
        .and_then(|song| song.language);
    let lyrics = LyricsFile {
        lines: normalized,
        language: language.clone(),
    };
    std::fs::write(
        cache.lyrics_path(file_hash),
        serde_json::to_vec_pretty(&lyrics).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to save lyric language: {e}"))?;

    let _ = std::fs::remove_file(cache.transcript_path(file_hash));
    cache.delete_transcript_variants(file_hash);

    update_song_analyzed(
        file_hash,
        false,
        language.or(previous_language),
        None,
        None,
        None,
    );
    enqueue_one(file_hash);
    Ok(())
}

/// Build the transcript JSON (playback shape) from parsed LRC segments.
fn build_lrc_transcript(
    parsed: &ParsedLrc,
    language: Option<&str>,
    key: Option<&str>,
    tempo: f64,
    no_stems: bool,
) -> serde_json::Value {
    serde_json::json!({
        // Leave language null when unknown so it isn't later mistaken for a
        // forced alignment language override (whisperx has no "unknown" model).
        "language": language,
        "source": "lrc",
        "key": key,
        "tempo": tempo,
        "no_stems": no_stems,
        "segments": parsed.segments,
    })
}

fn write_transcript_json(
    cache: &CacheDir,
    file_hash: &str,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    let out = cache.transcript_path(file_hash);
    std::fs::write(&out, serde_json::to_string_pretty(value).unwrap())
}

/// Provide LRC / Enhanced LRC for a not-yet-analyzed song, building the
/// transcript directly and skipping transcription. When `separate_stems` is
/// true, a stems-only analysis pass is queued (guide vocals + karaoke
/// instrumental); otherwise the song plays over its original mix and the guide
/// control is hidden on playback.
pub fn provide_lrc(file_hash: &str, lrc_text: &str, separate_stems: bool) -> Result<(), String> {
    provide_lrc_with_language(file_hash, lrc_text, separate_stems, None)
}

pub fn provide_lrc_with_language(
    file_hash: &str,
    lrc_text: &str,
    separate_stems: bool,
    language: Option<String>,
) -> Result<(), String> {
    let language = selected_language(language)?;
    if is_usdx_song(file_hash) {
        return Err("Cannot provide lyrics for USDX songs".to_string());
    }

    let parsed = lrc::parse_lrc(lrc_text)?;

    let Some(song) = library_db::load_song_by_hash(file_hash).ok().flatten() else {
        return Err("Song not found".to_string());
    };

    let cache = CacheDir::new();
    cache.delete_transcript_variants(file_hash);
    let _ = std::fs::remove_file(cache.lyrics_path(file_hash));

    let language = language.or(song.language.clone());

    if separate_stems {
        let value = build_lrc_transcript(&parsed, language.as_deref(), None, 1.0, false);
        write_transcript_json(&cache, file_hash, &value)
            .map_err(|e| format!("Failed to write transcript: {e}"))?;
        // Stays not-analyzed until stem separation finishes.
        update_song_analyzed(file_hash, false, language, None, None, None);
        mark_stems_only(file_hash);
        enqueue_one(file_hash);
    } else {
        let value = build_lrc_transcript(&parsed, language.as_deref(), None, 1.0, true);
        write_transcript_json(&cache, file_hash, &value)
            .map_err(|e| format!("Failed to write transcript: {e}"))?;
        // Playing over the original mix needs no separation. Prepare everything
        // synchronously (materialize audio, detect the key) and only then mark
        // the song ready — no status-queue pass, and no transient window where
        // playback assets aren't in place yet.
        prepare_lrc_no_stems(file_hash).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Apply provided timed LRC to an already-analyzed song, rebuilding the
/// transcript directly (no realignment) while keeping the existing stems.
pub fn apply_timed_lyrics(file_hash: &str, lrc_text: &str) -> Result<(), String> {
    apply_timed_lyrics_with_language(file_hash, lrc_text, None)
}

pub fn apply_timed_lyrics_with_language(
    file_hash: &str,
    lrc_text: &str,
    language: Option<String>,
) -> Result<(), String> {
    let language = selected_language(language)?;
    if is_usdx_song(file_hash) {
        return Err("Cannot edit lyrics for USDX songs".to_string());
    }

    let parsed = lrc::parse_lrc(lrc_text)?;

    let Some(song) = library_db::load_song_by_hash(file_hash).ok().flatten() else {
        return Err("Song not found".to_string());
    };

    let cache = CacheDir::new();
    let meta = read_transcript_meta(&cache, file_hash);
    // Base (unshifted) key so timings line up with the canonical stems.
    let key = song.key.clone().or(meta.key);
    let no_stems = song.no_stems;
    let language = language.or(song.language.clone());

    // Timing changed: drop any tempo-shifted transcript variants and the plain
    // lyrics sidecar, and reset the song back to its base key/tempo.
    cache.delete_transcript_variants(file_hash);
    let _ = std::fs::remove_file(cache.lyrics_path(file_hash));

    let value = build_lrc_transcript(&parsed, language.as_deref(), key.as_deref(), 1.0, no_stems);
    write_transcript_json(&cache, file_hash, &value)
        .map_err(|e| format!("Failed to write transcript: {e}"))?;

    let mut updated = song;
    updated.is_analyzed = true;
    updated.transcript_source = Some(TranscriptSource::Lrc);
    updated.key = key;
    updated.override_key = None;
    updated.tempo = 1.0;
    updated.key_offset = 0;
    updated.no_stems = no_stems;
    updated.language = language;
    library_db::update_song_fields(file_hash, &updated).map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn write_lyrics_file(
    cache: &CacheDir,
    file_hash: &str,
    lines: &[String],
) -> std::io::Result<PathBuf> {
    let out = cache.lyrics_path(file_hash);
    let lyrics_json = serde_json::json!({ "lines": lines });
    std::fs::write(&out, serde_json::to_string_pretty(&lyrics_json).unwrap())?;
    Ok(out)
}

pub(crate) fn fetch_lrclib_lyrics(song: &Song, cache: &CacheDir) -> Option<PathBuf> {
    let existing = cache.lyrics_path(&song.file_hash);
    if existing.is_file() {
        info!(
            "[lrclib] Using existing lyrics file at {}",
            existing.display()
        );
        return Some(existing);
    }

    let candidates = lrclib_candidates(song);
    let pick = candidates.into_iter().next()?;
    if !can_auto_select(&pick, song) {
        info!("[lrclib] No sufficiently close match; using audio transcription");
        return None;
    }

    info!(
        "[lrclib] Picked \"{}\" from \"{}\" (duration {:.0}s, delta {:.1}s)",
        pick.track_name,
        pick.album_name,
        pick.duration_secs,
        (pick.duration_secs - song.duration_secs).abs()
    );
    info!("[lrclib] Extracted {} lines", pick.lines.len());

    match write_lyrics_file(cache, &song.file_hash, &pick.lines) {
        Ok(out) => {
            info!("[lrclib] Lyrics saved to {}", out.display());
            Some(out)
        }
        Err(e) => {
            warn!("[lrclib] Failed to write lyrics: {e}");
            None
        }
    }
}

fn can_auto_select(candidate: &LrclibCandidate, song: &Song) -> bool {
    candidate.match_score >= 75
        && text_similarity(&candidate.track_name, &song.title) >= 0.92
        && text_similarity(&candidate.artist_name, &song.artist) >= 0.92
        && song.duration_secs > 0.0
        && candidate.duration_secs > 0.0
        && (candidate.duration_secs - song.duration_secs).abs() <= 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song() -> Song {
        serde_json::from_value(serde_json::json!({"path":"test.mp3", "file_hash":"test", "title":"空の練習", "artist":"Test Singer", "album":"Studio", "duration_secs":180.0, "album_art_path":null, "is_analyzed":false, "language":"ja", "is_video":false})).unwrap()
    }

    fn candidate(title: &str, artist: &str, text: &str) -> LrclibCandidate {
        prepare_candidate(serde_json::from_value(serde_json::json!({"id":10, "trackName":title, "artistName":artist, "albumName":"Studio", "duration":180.0, "plainLyrics":text})).unwrap()).unwrap()
    }

    #[test]
    fn handles_null_plain_lyrics_and_synced_only_records() {
        let result = prepare_candidate(serde_json::from_value(serde_json::json!({"plainLyrics":null, "syncedLyrics":"[00:01.00]青い空\n[00:03.00]声を出す"})).unwrap()).unwrap();
        assert_eq!(result.lines, vec!["青い空", "声を出す"]);
    }

    #[test]
    fn metadata_and_native_script_outrank_album_only_matches() {
        let song = song();
        let mut correct = candidate(&song.title, &song.artist, "青い空を見て声を出す");
        let mut wrong = candidate("別の歌", "Other Singer", "青い空を見て声を出す");
        let mut romanized = candidate(&song.title, &song.artist, "aoi sora wo mite koe wo dasu");
        for item in [&mut correct, &mut wrong, &mut romanized] {
            rank_candidate(item, &song, &LyricsSearchOptions::default());
        }
        assert!(correct.match_score > wrong.match_score);
        assert!(correct.match_score > romanized.match_score);
        assert!(can_auto_select(&correct, &song));
        assert!(!can_auto_select(&wrong, &song));
        assert!(!can_auto_select(&romanized, &song));
    }

    #[test]
    fn supplied_words_rank_matching_version_higher() {
        let song = song();
        let mut matching = candidate(
            &song.title,
            &song.artist,
            "青い空を見て声を出す\n今日はゆっくり歌おう",
        );
        let mut different = candidate(
            &song.title,
            &song.artist,
            "赤い花が咲く春の日\n遠い山の向こうへ",
        );
        let options = LyricsSearchOptions {
            reference: Some(matching.lines.join("\n")),
            ..Default::default()
        };
        rank_candidate(&mut matching, &song, &options);
        rank_candidate(&mut different, &song, &options);
        assert!(matching.match_score > different.match_score);
        assert!(
            matching
                .match_notes
                .iter()
                .any(|note| note.contains("100% text overlap"))
        );
    }

    #[test]
    fn unicode_matching_handles_fullwidth_and_decomposed_hangul() {
        assert_eq!(text_similarity("Ｔｅｓｔ", "test"), 1.0);
        assert_eq!(text_similarity("한글", "한글"), 1.0);
    }

    #[test]
    fn live_version_duration_is_never_auto_selected() {
        let song = song();
        let mut live = candidate(&song.title, &song.artist, "青い空を見て声を出す");
        live.duration_secs = 230.0;
        rank_candidate(&mut live, &song, &LyricsSearchOptions::default());
        assert!(!can_auto_select(&live, &song));
    }
}
