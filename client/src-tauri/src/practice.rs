#[tauri::command]
pub async fn export_recording(
    request: app_core::ExportRecordingRequest,
) -> Result<app_core::RecordingTake, String> {
    tauri::async_runtime::spawn_blocking(move || app_core::export_recording(request))
        .await
        .map_err(|error| format!("Recording export task failed: {error}"))?
}

#[tauri::command]
pub fn save_practice_session(session: app_core::SavePracticeSession) -> Result<(), String> {
    app_core::save_practice_session(session)
}

#[tauri::command]
pub fn list_practice_sessions(
    profile: Option<String>,
) -> Result<Vec<app_core::PracticeSession>, String> {
    app_core::list_practice_sessions(profile.as_deref())
}

#[tauri::command]
pub fn load_recording_take(id: String) -> Result<Option<app_core::RecordingTake>, String> {
    app_core::load_recording_take(&id)
}
