use app_core::{
    is_ready as is_vendor_ready, run_vendor_setup_with_bundle, CachePaths, OfflineVendorBundle,
    SetupFolders,
};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
pub fn trigger_setup(app: AppHandle, data_path: Option<String>, cache_paths: Option<CachePaths>) {
    let bundled_vendor = app
        .path()
        .resource_dir()
        .ok()
        .and_then(OfflineVendorBundle::from_resource_root);
    std::thread::spawn(move || {
        if let Some(paths) = cache_paths.as_ref() {
            for path in [&paths.songs, &paths.videos, &paths.models, &paths.vendor]
                .into_iter()
                .flatten()
            {
                let _ = app.asset_protocol_scope().allow_directory(path, true);
            }
        }

        let app_for_progress = app.clone();
        let app_for_migration = app.clone();
        if let Err(e) = run_vendor_setup_with_bundle(
            SetupFolders {
                data_path,
                cache_paths,
            },
            bundled_vendor,
            move |progress| {
                let _ = app_for_progress.emit("setup-progress", progress);
            },
            move |new_path| {
                app_for_migration
                    .asset_protocol_scope()
                    .allow_directory(new_path, true)
                    .map_err(|e| {
                        format!(
                            "Failed to update asset protocol scope for migrated data path {:?}: {e}",
                            new_path
                        )
                    })
            },
        ) {
            let _ = app.emit("setup-error", e);
        }
    });
}

#[tauri::command]
pub fn is_ready() -> bool {
    is_vendor_ready()
}
