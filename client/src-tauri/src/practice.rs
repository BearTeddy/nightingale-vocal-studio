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

#[tauri::command]
pub fn load_learning_state(profile: String) -> Result<app_core::LearningState, String> {
    app_core::load_learning_state(&profile)
}

#[tauri::command]
pub fn save_learning_attempt(request: app_core::SaveLearningAttemptRequest) -> Result<(), String> {
    app_core::save_learning_attempt(request)
}

#[tauri::command]
pub fn save_learner_profile(request: app_core::SaveLearnerProfileRequest) -> Result<(), String> {
    app_core::save_learner_profile(request)
}

#[tauri::command]
pub fn list_learning_attempts(
    query: app_core::ListLearningAttemptsQuery,
) -> Result<app_core::LearningAttemptPage, String> {
    app_core::list_learning_attempts(query)
}

#[tauri::command]
pub fn delete_learning_state(profile: String) -> Result<(), String> {
    app_core::delete_learning_state(&profile)
}
