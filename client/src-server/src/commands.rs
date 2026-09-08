use app_core::{
    AnalysisQueue, AppConfig, CacheStats, LibraryMenuFilters, LibraryMenuItems, LibrarySource,
    LoadSongsParams, PixabayVideoDownloaded, ProfileStore, SongsStore,
    ensure_mp3_stems_ready_payload, load_lyrics_file, shift_key_done_payload,
    shift_tempo_done_payload,
};
use axum::{
    Json,
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::events::EventBus;
use crate::state::AppState;

/// HTTP error wrapper. JSON body matches what `webInvoke` reads on non-2xx.
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    fn bad_request(msg: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, msg.into())
    }

    fn internal(msg: impl Into<String>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, msg.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, self.1).into_response()
    }
}

pub type CmdResult = Result<Value, ApiError>;

/// Generic dispatcher that mirrors Tauri's `generate_handler!` table.
pub async fn handle_cmd(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let payload = body.map(|Json(v)| v).unwrap_or(Value::Null);
    let value = dispatch(state.events.clone(), &name, payload).await?;
    Ok(Json(value))
}

async fn dispatch(events: std::sync::Arc<EventBus>, name: &str, payload: Value) -> CmdResult {
    match name {
        // ── Init/window stubs ────────────────────────────────────────────
        "frontend_ready" | "window_immersive" | "minimize_window" => Ok(Value::Null),

        // ── Config ───────────────────────────────────────────────────────
        "load_config" => Ok(serde_json::to_value(AppConfig::load()).map_err(serde_err)?),
        "save_config" => save_config_cmd(payload),

        // ── Cache ────────────────────────────────────────────────────────
        "calculate_cache_stats" => {
            Ok(serde_json::to_value(CacheStats::calculate()).map_err(serde_err)?)
        }
        "clear_videos_command" => {
            app_core::clear_videos();
            Ok(Value::Null)
        }
        "clear_models_command" => {
            app_core::clear_models();
            Ok(Value::Null)
        }
        "clear_all" => {
            app_core::clear_models();
            app_core::clear_videos();
            Ok(Value::Null)
        }
        "remove_song" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                path: String,
                delete_source: bool,
            }
            let args: Args = deserialize(payload)?;
            let result = app_core::remove_song(&args.file_hash, &args.path, args.delete_source)
                .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }

        // ── Profile ──────────────────────────────────────────────────────
        "load_profiles" => Ok(serde_json::to_value(ProfileStore::load()).map_err(serde_err)?),
        "create_profile" => {
            let args: NameArgs = deserialize(payload)?;
            let mut store = ProfileStore::load();
            store.create_profile(args.name);
            Ok(Value::Null)
        }
        "switch_profile" => {
            let args: NameArgs = deserialize(payload)?;
            let mut store = ProfileStore::load();
            store.switch_profile(&args.name);
            Ok(Value::Null)
        }
        "delete_profile" => {
            let args: NameArgs = deserialize(payload)?;
            let mut store = ProfileStore::load();
            store.delete_profile(&args.name);
            Ok(Value::Null)
        }
        "add_score" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                song_hash: String,
                score: u32,
                difficulty: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            let mut store = ProfileStore::load();
            store.add_score(
                &args.song_hash,
                args.score,
                args.difficulty.as_deref().unwrap_or("medium"),
            );
            Ok(Value::Null)
        }

        // ── Scanner ──────────────────────────────────────────────────────
        "trigger_scan" => {
            app_core::start_scan();
            Ok(Value::Null)
        }
        "import_youtube" => {
            #[derive(Deserialize)]
            struct Args {
                url: String,
            }
            let args: Args = deserialize(payload)?;
            let result = tokio::task::spawn_blocking(move || app_core::import_youtube(&args.url))
                .await
                .map_err(|error| {
                    ApiError::internal(format!("YouTube import task failed: {error}"))
                })?
                .map_err(ApiError::bad_request)?;
            app_core::start_scan();
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "set_library_source" => {
            #[derive(Deserialize)]
            struct Args {
                source: LibrarySource,
            }
            let args: Args = deserialize(payload)?;
            let mut config = AppConfig::load();
            config.library_source = Some(args.source);
            config.last_folder = None;
            config.save();
            app_core::start_scan();
            Ok(serde_json::to_value(config).map_err(serde_err)?)
        }
        "clear_library_source" => {
            let mut config = AppConfig::load();
            config.library_source = None;
            config.last_folder = None;
            config.save();
            Ok(serde_json::to_value(config).map_err(serde_err)?)
        }
        "jellyfin_login" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                base_url: String,
                username: String,
                password: String,
            }
            let args: Args = deserialize(payload)?;
            let result =
                app_core::jellyfin_login(&args.base_url, &args.username, &args.password, None)
                    .map_err(|e| ApiError::bad_request(e.to_string()))?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "jellyfin_ping" => {
            Ok(serde_json::to_value(app_core::jellyfin_ping_current()).map_err(serde_err)?)
        }
        "navidrome_login" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                base_url: String,
                username: String,
                password: String,
            }
            let args: Args = deserialize(payload)?;
            let result = app_core::navidrome_login(&args.base_url, &args.username, &args.password)
                .map_err(|e| ApiError::bad_request(e.to_string()))?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "navidrome_ping" => {
            Ok(serde_json::to_value(app_core::navidrome_ping_current()).map_err(serde_err)?)
        }
        "plex_begin_pin" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                #[serde(default)]
                client_id: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            let result =
                tokio::task::spawn_blocking(move || app_core::plex_begin_pin(args.client_id))
                    .await
                    .map_err(blocking_task_err)?
                    .map_err(|error| ApiError::bad_request(error.to_string()))?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "plex_poll_pin" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                pin_id: String,
                client_id: String,
            }
            let args: Args = deserialize(payload)?;
            let result = tokio::task::spawn_blocking(move || {
                app_core::plex_poll_pin(&args.pin_id, &args.client_id)
            })
            .await
            .map_err(blocking_task_err)?
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "plex_manual_login" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                base_url: String,
                access_token: String,
                #[serde(default)]
                client_id: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            let result = tokio::task::spawn_blocking(move || {
                app_core::plex_manual_login(&args.base_url, &args.access_token, args.client_id)
            })
            .await
            .map_err(blocking_task_err)?
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "plex_ping" => {
            let result = tokio::task::spawn_blocking(app_core::plex_ping_current)
                .await
                .map_err(blocking_task_err)?;
            Ok(serde_json::to_value(result).map_err(serde_err)?)
        }
        "load_songs" => {
            #[derive(Deserialize)]
            struct Args {
                params: LoadSongsParams,
            }
            let args: Args = deserialize(payload)?;
            Ok(serde_json::to_value(SongsStore::load(&args.params)).map_err(serde_err)?)
        }
        "load_songs_by_hashes" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hashes: Vec<String>,
            }
            let args: Args = deserialize(payload)?;
            Ok(
                serde_json::to_value(SongsStore::load_by_hashes(&args.file_hashes))
                    .map_err(serde_err)?,
            )
        }
        "load_songs_meta" => Ok(serde_json::to_value(SongsStore::load_meta()).map_err(serde_err)?),
        "load_analysis_queue" => {
            Ok(serde_json::to_value(AnalysisQueue::load()).map_err(serde_err)?)
        }
        "load_library_menu_items" => {
            let items: LibraryMenuItems = app_core::load_library_menu_items()
                .map_err(|e| ApiError::internal(e.to_string()))?;
            Ok(serde_json::to_value(items).map_err(serde_err)?)
        }

        // ── Analyzer ─────────────────────────────────────────────────────
        "enqueue_one" => {
            let args: FileHashArgs = deserialize(payload)?;
            app_core::enqueue_one(&args.file_hash);
            Ok(Value::Null)
        }
        "enqueue_all" => {
            #[derive(Deserialize)]
            struct Args {
                filters: LibraryMenuFilters,
            }
            let args: Args = deserialize(payload)?;
            app_core::enqueue_all(&args.filters);
            Ok(Value::Null)
        }
        "delete_song_cache" => {
            let args: FileHashArgs = deserialize(payload)?;
            app_core::delete_cache(&args.file_hash);
            Ok(Value::Null)
        }
        "reanalyze_transcript" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                #[serde(default)]
                language: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            app_core::reanalyze_transcript(&args.file_hash, args.language);
            Ok(Value::Null)
        }
        "reanalyze_full" => {
            let args: FileHashArgs = deserialize(payload)?;
            app_core::reanalyze_full(&args.file_hash);
            Ok(Value::Null)
        }
        "realign" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                #[serde(default)]
                language: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            app_core::realign(&args.file_hash, args.language);
            Ok(Value::Null)
        }
        "reanalyze_force_transcribe" => {
            let args: FileHashArgs = deserialize(payload)?;
            app_core::reanalyze_force_transcribe(&args.file_hash);
            Ok(Value::Null)
        }
        "shift_key" => shift_key_cmd(events, payload),
        "shift_tempo" => shift_tempo_cmd(events, payload),

        // ── Lyrics ───────────────────────────────────────────────────────
        "load_lyrics" => {
            let args: FileHashArgs = deserialize(payload)?;
            Ok(serde_json::to_value(load_lyrics_file(&args.file_hash)).map_err(serde_err)?)
        }
        "search_lrclib_lyrics" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                options: Option<app_core::LyricsSearchOptions>,
            }
            let args: Args = deserialize(payload)?;
            let candidates = tokio::task::spawn_blocking(move || {
                app_core::search_lyrics_for_hash(&args.file_hash, args.options.unwrap_or_default())
            })
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?
            .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(candidates).map_err(serde_err)?)
        }
        "save_lyrics" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                lines: Vec<String>,
                language: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            app_core::save_lyrics_with_language(&args.file_hash, args.lines, args.language)
                .map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "provide_lrc" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                lrc_text: String,
                separate_stems: bool,
                language: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            app_core::provide_lrc_with_language(
                &args.file_hash,
                &args.lrc_text,
                args.separate_stems,
                args.language,
            )
            .map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "apply_timed_lyrics" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                lrc_text: String,
                language: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            app_core::apply_timed_lyrics_with_language(
                &args.file_hash,
                &args.lrc_text,
                args.language,
            )
            .map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }

        // ── Playback ─────────────────────────────────────────────────────
        "load_transcript" => {
            let args: FileHashArgs = deserialize(payload)?;
            tokio::task::spawn_blocking(move || app_core::load_transcript(&args.file_hash))
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?
                .map_err(|e| ApiError::internal(e.to_string()))
        }
        "load_melody_map" => {
            let args: FileHashArgs = deserialize(payload)?;
            Ok(
                serde_json::to_value(app_core::load_melody_map(&args.file_hash))
                    .map_err(serde_err)?,
            )
        }
        "rebuild_melody_map" => {
            let args: FileHashArgs = deserialize(payload)?;
            let map =
                tokio::task::spawn_blocking(move || app_core::rebuild_melody_map(&args.file_hash))
                    .await
                    .map_err(blocking_task_err)?
                    .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(map).map_err(serde_err)?)
        }
        "verify_melody_map" => {
            let args: FileHashArgs = deserialize(payload)?;
            let map =
                tokio::task::spawn_blocking(move || app_core::verify_melody_map(&args.file_hash))
                    .await
                    .map_err(blocking_task_err)?
                    .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(map).map_err(serde_err)?)
        }
        "save_melody_map" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Args {
                file_hash: String,
                melody: app_core::MelodyMap,
            }
            let args: Args = deserialize(payload)?;
            app_core::save_melody_map(&args.file_hash, args.melody)
                .map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "get_audio_paths" => {
            let args: FileHashArgs = deserialize(payload)?;
            Ok(
                serde_json::to_value(app_core::get_audio_paths(&args.file_hash))
                    .map_err(serde_err)?,
            )
        }
        "ensure_mp3_stems" => ensure_mp3_stems_cmd(events, payload),
        "ensure_playable_source_video" => {
            let args: FileHashArgs = deserialize(payload)?;
            let path = app_core::ensure_playable_source_video(&args.file_hash)
                .ok()
                .flatten();
            Ok(serde_json::to_value(path).map_err(serde_err)?)
        }
        "fetch_pixabay_videos" => fetch_pixabay_videos_cmd(events, payload),

        // ── Vendor ───────────────────────────────────────────────────────
        "is_ready" => Ok(Value::Bool(app_core::is_ready())),
        "trigger_setup" => crate::commands::vendor::trigger_setup(events, payload),

        // ── Mic (browser-side; no server-side state) ────────────────────
        "list_microphones" => Ok(Value::Array(vec![])),
        "start_mic_capture" | "stop_mic_capture" => Ok(Value::Null),
        "start_vocal_recording"
        | "pause_vocal_recording"
        | "resume_vocal_recording"
        | "stop_vocal_recording" => Err(ApiError::bad_request(
            "Vocal recording is available in the Nightingale desktop app",
        )),
        "export_recording" => {
            #[derive(Deserialize)]
            struct Args {
                request: app_core::ExportRecordingRequest,
            }
            let args: Args = deserialize(payload)?;
            let take =
                tokio::task::spawn_blocking(move || app_core::export_recording(args.request))
                    .await
                    .map_err(blocking_task_err)?
                    .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(take).map_err(serde_err)?)
        }
        "save_practice_session" => {
            #[derive(Deserialize)]
            struct Args {
                session: app_core::SavePracticeSession,
            }
            let args: Args = deserialize(payload)?;
            app_core::save_practice_session(args.session).map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "list_practice_sessions" => {
            #[derive(Deserialize)]
            struct Args {
                profile: Option<String>,
            }
            let args: Args = deserialize(payload)?;
            let sessions = app_core::list_practice_sessions(args.profile.as_deref())
                .map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(sessions).map_err(serde_err)?)
        }
        "load_recording_take" => {
            #[derive(Deserialize)]
            struct Args {
                id: String,
            }
            let args: Args = deserialize(payload)?;
            let take = app_core::load_recording_take(&args.id).map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(take).map_err(serde_err)?)
        }
        "load_learning_state" => {
            #[derive(Deserialize)]
            struct Args {
                profile: String,
            }
            let args: Args = deserialize(payload)?;
            let state =
                app_core::load_learning_state(&args.profile).map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(state).map_err(serde_err)?)
        }
        "save_learning_attempt" => {
            #[derive(Deserialize)]
            struct Args {
                request: app_core::SaveLearningAttemptRequest,
            }
            let args: Args = deserialize(payload)?;
            app_core::save_learning_attempt(args.request).map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "save_learner_profile" => {
            #[derive(Deserialize)]
            struct Args {
                request: app_core::SaveLearnerProfileRequest,
            }
            let args: Args = deserialize(payload)?;
            app_core::save_learner_profile(args.request).map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }
        "list_learning_attempts" => {
            #[derive(Deserialize)]
            struct Args {
                query: app_core::ListLearningAttemptsQuery,
            }
            let args: Args = deserialize(payload)?;
            let page =
                app_core::list_learning_attempts(args.query).map_err(ApiError::bad_request)?;
            Ok(serde_json::to_value(page).map_err(serde_err)?)
        }
        "delete_learning_state" => {
            #[derive(Deserialize)]
            struct Args {
                profile: String,
            }
            let args: Args = deserialize(payload)?;
            app_core::delete_learning_state(&args.profile).map_err(ApiError::bad_request)?;
            Ok(Value::Null)
        }

        _ => Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("unknown command {name}"),
        )),
    }
}

fn serde_err(e: serde_json::Error) -> ApiError {
    ApiError::internal(format!("serialise: {e}"))
}

fn blocking_task_err(error: tokio::task::JoinError) -> ApiError {
    ApiError::internal(format!("blocking command failed: {error}"))
}

fn deserialize<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, ApiError> {
    serde_json::from_value(value).map_err(|e| ApiError::bad_request(format!("invalid args: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameArgs {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHashArgs {
    file_hash: String,
}

#[derive(Deserialize)]
struct SaveConfigArgs {
    config: AppConfig,
}

fn save_config_cmd(payload: Value) -> CmdResult {
    let SaveConfigArgs { config } = deserialize(payload)?;
    let was_auto_analyze = AppConfig::load().auto_analyze();
    config.save();
    if config.auto_analyze() && !was_auto_analyze {
        app_core::enqueue_all(&app_core::LibraryMenuFilters::default());
    }
    // Web mode has no server-side cpal monitor stream, so `mic_monitor_gain`
    // is consumed entirely by the browser's monitor GainNode.
    serde_json::to_value(config).map_err(serde_err)
}

fn shift_key_cmd(events: std::sync::Arc<EventBus>, payload: Value) -> CmdResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        file_hash: String,
        key: String,
        pitch_ratio: f64,
        key_offset: i32,
    }
    let args: Args = deserialize(payload)?;
    std::thread::spawn(move || {
        let payload =
            shift_key_done_payload(args.file_hash, args.key, args.pitch_ratio, args.key_offset);
        events.emit("shift-key-done", &payload);
    });
    Ok(Value::Null)
}

fn shift_tempo_cmd(events: std::sync::Arc<EventBus>, payload: Value) -> CmdResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        file_hash: String,
        tempo: f64,
    }
    let args: Args = deserialize(payload)?;
    std::thread::spawn(move || {
        let payload = shift_tempo_done_payload(args.file_hash, args.tempo);
        events.emit("shift-tempo-done", &payload);
    });
    Ok(Value::Null)
}

fn ensure_mp3_stems_cmd(events: std::sync::Arc<EventBus>, payload: Value) -> CmdResult {
    let args: FileHashArgs = deserialize(payload)?;
    std::thread::spawn(move || {
        events.emit(
            "stems-ready",
            &ensure_mp3_stems_ready_payload(args.file_hash),
        );
    });
    Ok(Value::Null)
}

fn fetch_pixabay_videos_cmd(events: std::sync::Arc<EventBus>, payload: Value) -> CmdResult {
    #[derive(Deserialize)]
    struct Args {
        flavor: String,
    }
    let args: Args = deserialize(payload)?;
    let cached = app_core::get_cached_pixabay_videos(&args.flavor);

    let flavor_for_thread = args.flavor.clone();
    let events_clone = events.clone();
    std::thread::spawn(move || {
        let flavor_for_emit = flavor_for_thread.clone();
        app_core::download_pixabay_videos(&flavor_for_thread, move |path, evicted_path| {
            events_clone.emit(
                "pixabay-video-downloaded",
                &PixabayVideoDownloaded::new(flavor_for_emit.clone(), path, evicted_path),
            );
        });
    });

    Ok(json!(cached))
}

pub mod vendor;
