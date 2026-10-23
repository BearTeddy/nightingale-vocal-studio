mod analyzer;
mod cache;
mod config;
mod desktop_shortcut;
mod error;
mod learning;
mod library_db;
mod library_menu;
mod library_model;
mod lrc;
mod lyric_readings;
mod lyrics;
pub mod media_server;
mod melody;
mod multiplayer;
mod playback;
mod profile;
mod recording;
mod scanner;
mod secret;
mod song;
mod song_removal;
mod source;
mod usdx;
mod vendor;
mod vendor_bundle;
mod vendor_scripts;
mod youtube;

pub use analyzer::{
    AnalysisQueue, delete_cache, enqueue_all, enqueue_one, realign, reanalyze_force_transcribe,
    reanalyze_full, reanalyze_transcript, shutdown_server,
};
pub use cache::{
    CacheDir, CachePaths, CacheStats, cache_roots, change_app_data_path, clear_models,
    clear_videos, default_nightingale_dir, models_dir, nightingale_dir, normalized_target_path,
    same_path, vendor_dir,
};
pub use config::{AppConfig, LibrarySource};
pub use desktop_shortcut::ensure_data_shortcut;
pub use learning::{
    LearnerProfile, LearnerProgress, LearningAttempt, LearningAttemptPage, LearningState,
    ListLearningAttemptsQuery, SaveLearnerProfileRequest, SaveLearningAttemptRequest,
    TechniquePreference, delete_learning_state, list_learning_attempts, load_learning_state,
    save_learner_profile, save_learning_attempt,
};
pub use library_db::{init_library, library_db_path};
pub use library_menu::{LibraryMenuItem, LibraryMenuItems, load_library_menu_items};
pub use library_model::{LibraryMenuFilters, LoadSongsParams, SongsMeta, SongsStore};
pub use lyrics::{
    LrclibCandidate, LyricsFile, LyricsSearchOptions, apply_timed_lyrics,
    apply_timed_lyrics_with_language, load_lyrics_file, provide_lrc, provide_lrc_with_language,
    save_lyrics_and_realign, save_lyrics_with_language, search_lrclib_for_hash,
    search_lyrics_for_hash,
};
pub use media_server::MediaEndpoint;
pub use melody::{
    MelodyMap, TargetNote, load_melody_map, rebuild_melody_map, save_melody_map, verify_melody_map,
};
pub use multiplayer::{
    MultiplayerPlayer, MultiplayerScore, add_multiplayer_scores, save_multiplayer_players,
    validate_multiplayer_players,
};
pub use playback::{
    AudioPaths, PixabayVideoDownloaded, ShiftDone, ShiftResult, StemsReady,
    download_pixabay_videos, ensure_mp3_stems, ensure_mp3_stems_ready_payload,
    ensure_playable_source_video, get_audio_paths, get_cached_pixabay_videos, load_transcript,
    prefetch_one_per_flavor, shift_key, shift_key_done_payload, shift_tempo,
    shift_tempo_done_payload,
};
pub use profile::ProfileStore;
pub use recording::{
    ExportRecordingRequest, PracticeSession, RecordingRequest, RecordingTake, SavePracticeSession,
    TransportSegment, export_recording, list_practice_sessions, load_recording_take,
    new_exercise_session_id, prepare_recording, recover_partial_recordings, save_practice_session,
    update_recording_take,
};
pub use scanner::{start_scan, start_scan_and_analyze};
pub use song::{Song, SongOrigin};
pub use song_removal::{RemoveSongResult, remove_song};
pub use source::{
    JellyfinAuth, JellyfinSource, MediaSource, NavidromeAuth, NavidromeSource, PlexAuth,
    PlexSource, SourceKind, active_source,
    jellyfin::{
        JellyfinHealth, JellyfinLibrary, JellyfinLoginResult, login as jellyfin_login,
        ping as jellyfin_ping, ping_current as jellyfin_ping_current,
    },
    navidrome::{
        NavidromeHealth, NavidromeLoginResult, login as navidrome_login, ping as navidrome_ping,
        ping_current as navidrome_ping_current,
    },
    plex::{
        PlexHealth, PlexPinPollResult, PlexPinStart, PlexSection, PlexServer,
        begin_pin as plex_begin_pin, manual_login as plex_manual_login, ping as plex_ping,
        ping_current as plex_ping_current, poll_pin as plex_poll_pin,
    },
};
pub use vendor::{
    SetupFolders, SetupProgress, SetupStep, clear_vendor_dir, is_ready, mark_ready,
    refresh_analyzer_scripts_if_ready, resolve_data_path_input, run_vendor_setup,
    run_vendor_setup_with_bundle, run_vendor_setup_with_bundles, step_create_venv,
    step_download_ffmpeg, step_download_uv, step_extract_scripts, step_install_packages,
    step_install_python,
};
pub use vendor_bundle::{
    OfflineModelBundle, OfflinePayloadKind, OfflineVendorBundle, OfflineVendorManifest,
    OfflineVendorPart, StagedOfflineVendor, install_offline_model_bundle,
    install_offline_vendor_bundle, split_existing_offline_vendor_bundle,
    stage_offline_model_bundle, stage_offline_vendor_bundle, verify_offline_vendor_runtime,
};
pub use youtube::{YoutubeImportResult, import_youtube};

pub fn startup() -> Result<(), String> {
    init_library().map_err(|e| e.to_string())?;

    AnalysisQueue::clear();

    let cache = CacheDir::new();

    let mut songs = library_db::load_all_songs().unwrap_or_default();
    source::folder::refresh_local_video_sidecars(&mut songs, &cache);

    if let Err(e) = library_db::rewrite_legacy_jellyfin_paths(&cache.path) {
        tracing::warn!("Failed to migrate legacy Jellyfin paths: {e}");
    }

    if let Err(e) = refresh_analyzer_scripts_if_ready() {
        tracing::warn!("Failed to refresh analyzer scripts: {e}");
    }

    let config = AppConfig::load();
    if let Err(error) = ensure_data_shortcut(&config.effective_data_path()) {
        tracing::warn!("Failed to create Nightingale Desktop shortcut: {error}");
    }

    if config.auto_analyze() {
        analyzer::enqueue_all(&LibraryMenuFilters::default());
    }

    recover_partial_recordings();

    Ok(())
}
