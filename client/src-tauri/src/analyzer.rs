use app_core::{
    delete_cache as core_delete_cache, enqueue_all as core_enqueue_all,
    enqueue_one as core_enqueue_one, realign as core_realign,
    reanalyze_force_transcribe as core_reanalyze_force_transcribe,
    reanalyze_full as core_reanalyze_full, reanalyze_transcript as core_reanalyze_transcript,
    remove_song as core_remove_song, shift_key_done_payload, shift_tempo_done_payload,
    LibraryMenuFilters, RemoveSongResult,
};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn enqueue_one(file_hash: String) {
    core_enqueue_one(&file_hash);
}

#[tauri::command]
pub fn enqueue_all(filters: LibraryMenuFilters) {
    core_enqueue_all(&filters);
}

#[tauri::command]
pub fn delete_song_cache(file_hash: String) {
    core_delete_cache(&file_hash);
}

#[tauri::command]
pub fn remove_song(
    file_hash: String,
    path: String,
    delete_source: bool,
) -> Result<RemoveSongResult, String> {
    core_remove_song(&file_hash, &path, delete_source)
}

#[tauri::command]
pub fn reanalyze_transcript(file_hash: String, language: Option<String>) {
    core_reanalyze_transcript(&file_hash, language);
}

#[tauri::command]
pub fn reanalyze_full(file_hash: String) {
    core_reanalyze_full(&file_hash);
}

#[tauri::command]
pub fn realign(file_hash: String, language: Option<String>) {
    core_realign(&file_hash, language);
}

#[tauri::command]
pub fn reanalyze_force_transcribe(file_hash: String) {
    core_reanalyze_force_transcribe(&file_hash);
}

#[tauri::command]
pub fn shift_key(
    app: AppHandle,
    file_hash: String,
    key: String,
    pitch_ratio: f64,
    key_offset: i32,
) {
    std::thread::spawn(move || {
        let payload = shift_key_done_payload(file_hash, key, pitch_ratio, key_offset);
        let _ = app.emit("shift-key-done", payload);
    });
}

#[tauri::command]
pub fn shift_tempo(app: AppHandle, file_hash: String, tempo: f64) {
    std::thread::spawn(move || {
        let payload = shift_tempo_done_payload(file_hash, tempo);
        let _ = app.emit("shift-tempo-done", payload);
    });
}
