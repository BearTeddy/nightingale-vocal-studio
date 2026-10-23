use app_core::ProfileStore;

#[tauri::command]
pub fn load_profiles() -> ProfileStore {
    ProfileStore::load()
}

#[tauri::command]
pub fn create_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.create_profile(name);
}

#[tauri::command]
pub fn switch_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.switch_profile(&name);
}

#[tauri::command]
pub fn delete_profile(name: String) {
    let mut profile_store = ProfileStore::load();

    profile_store.delete_profile(&name);
}

#[tauri::command]
pub fn add_score(
    song_hash: String,
    score: u32,
    difficulty: Option<String>,
    pitch_tolerance_factor: Option<f64>,
) {
    let mut profile_store = ProfileStore::load();

    profile_store.add_score(
        &song_hash,
        score,
        difficulty.as_deref().unwrap_or("medium"),
        pitch_tolerance_factor.unwrap_or(1.0),
    );
}
