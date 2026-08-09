use app_core::{ensure_mp3_stems_ready_payload, AudioPaths, PixabayVideoDownloaded};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub fn load_transcript(file_hash: String) -> Result<serde_json::Value, String> {
    app_core::load_transcript(&file_hash).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_melody_map(file_hash: String) -> Option<app_core::MelodyMap> {
    app_core::load_melody_map(&file_hash)
}

#[tauri::command]
pub fn save_melody_map(file_hash: String, melody: app_core::MelodyMap) -> Result<(), String> {
    app_core::save_melody_map(&file_hash, melody)
}

#[tauri::command]
pub async fn rebuild_melody_map(file_hash: String) -> Result<app_core::MelodyMap, String> {
    tauri::async_runtime::spawn_blocking(move || app_core::rebuild_melody_map(&file_hash))
        .await
        .map_err(|error| format!("Pitch-guide task failed: {error}"))?
}

#[tauri::command]
pub fn get_audio_paths(file_hash: String) -> AudioPaths {
    app_core::get_audio_paths(&file_hash)
}

#[tauri::command]
pub fn ensure_mp3_stems(app: AppHandle, file_hash: String) {
    std::thread::spawn(move || {
        let _ = app.emit("stems-ready", ensure_mp3_stems_ready_payload(file_hash));
    });
}

#[tauri::command]
pub fn ensure_playable_source_video(file_hash: String) -> Option<String> {
    app_core::ensure_playable_source_video(&file_hash)
        .ok()
        .flatten()
}

#[tauri::command]
pub fn fetch_pixabay_videos(app: AppHandle, flavor: String) -> Vec<String> {
    let cached = app_core::get_cached_pixabay_videos(&flavor);

    let flavor_clone = flavor.clone();
    std::thread::spawn(move || {
        app_core::download_pixabay_videos(&flavor_clone, move |path, evicted_path| {
            let _ = app.emit(
                "pixabay-video-downloaded",
                PixabayVideoDownloaded::new(flavor.clone(), path, evicted_path),
            );
        });
    });

    cached
}
