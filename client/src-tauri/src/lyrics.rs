use app_core::{
    LrclibCandidate, LyricsFile, LyricsSearchOptions, apply_timed_lyrics_with_language,
    load_lyrics_file, provide_lrc_with_language, save_lyrics_with_language, search_lyrics_for_hash,
};

#[tauri::command]
pub fn load_lyrics(file_hash: String) -> Option<LyricsFile> {
    load_lyrics_file(&file_hash)
}

#[tauri::command]
pub async fn search_lrclib_lyrics(
    file_hash: String,
    options: Option<LyricsSearchOptions>,
) -> Result<Vec<LrclibCandidate>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_lyrics_for_hash(&file_hash, options.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn save_lyrics(
    file_hash: String,
    lines: Vec<String>,
    language: Option<String>,
) -> Result<(), String> {
    save_lyrics_with_language(&file_hash, lines, language)
}

#[tauri::command]
pub fn provide_lrc(
    file_hash: String,
    lrc_text: String,
    separate_stems: bool,
    language: Option<String>,
) -> Result<(), String> {
    provide_lrc_with_language(&file_hash, &lrc_text, separate_stems, language)
}

#[tauri::command]
pub fn apply_timed_lyrics(
    file_hash: String,
    lrc_text: String,
    language: Option<String>,
) -> Result<(), String> {
    apply_timed_lyrics_with_language(&file_hash, &lrc_text, language)
}
