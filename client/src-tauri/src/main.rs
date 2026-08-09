// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn install_offline_models_from_args() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--install-offline-models")) {
        return None;
    }
    let Some(root) = args.next() else {
        return Some(2);
    };
    if args.next().is_some() {
        return Some(2);
    }
    let root = std::path::PathBuf::from(root);
    let worker = std::thread::Builder::new()
        .name("offline-model-install".to_string())
        .stack_size(32 * 1024 * 1024)
        .spawn(move || {
            let bundle = app_core::OfflineModelBundle::from_directory(root)?;
            app_core::install_offline_model_bundle(&bundle, app_core::models_dir()).ok()
        });
    match worker.and_then(|worker| {
        worker
            .join()
            .map_err(|_| std::io::Error::other("model installer stopped unexpectedly"))
    }) {
        Ok(Some(_)) => Some(0),
        Ok(None) => Some(3),
        Err(_) => Some(4),
    }
}

fn main() {
    if let Some(code) = install_offline_models_from_args() {
        std::process::exit(code);
    }

    #[cfg(target_os = "linux")]
    unsafe {
        std::env::set_var("__GL_THREADED_OPTIMIZATIONS", "0");
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
    }

    client_lib::run()
}
