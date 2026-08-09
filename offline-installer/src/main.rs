use std::{
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use nightingale_offline_installer::{
    PackedEntry, PackedRole, activate_atomic_directory_swap, extract_packed_entry,
    install_sidecar_payload, prepare_atomic_directory_swap, verify_packed_installer,
    verify_sidecar_payload,
};

fn install_directory() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};

        if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Nightingale")
            && let Ok(value) = key.get_value::<String, _>("InstallLocation")
        {
            let path = PathBuf::from(value.trim_matches('"'));
            if path.is_dir() {
                return Ok(path);
            }
        }
    }

    let local = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "LOCALAPPDATA is unavailable".to_string())?;
    Ok(PathBuf::from(local).join("Nightingale"))
}

#[cfg(windows)]
fn directory_bytes(root: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory)
            .map_err(|error| format!("Could not inspect {}: {error}", directory.display()))?
        {
            let entry = entry.map_err(|error| {
                format!(
                    "Could not inspect a file in {}: {error}",
                    directory.display()
                )
            })?;
            let metadata = entry.metadata().map_err(|error| {
                format!("Could not inspect {}: {error}", entry.path().display())
            })?;
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn update_installed_size(payloads: &[PathBuf]) -> Result<(), String> {
    #[cfg(windows)]
    {
        use winreg::{
            RegKey,
            enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE},
        };

        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Nightingale",
                KEY_READ | KEY_WRITE,
            )
            .map_err(|error| format!("Could not update Nightingale install metadata: {error}"))?;
        let base_kib = key.get_value::<u32, _>("EstimatedSize").unwrap_or(0);
        let payload_bytes = payloads.iter().try_fold(0u64, |total, payload| {
            directory_bytes(payload).map(|bytes| total.saturating_add(bytes))
        })?;
        let payload_kib = payload_bytes.div_ceil(1024);
        let total_kib = u64::from(base_kib)
            .saturating_add(payload_kib)
            .min(u64::from(u32::MAX)) as u32;
        key.set_value("EstimatedSize", &total_kib)
            .map_err(|error| format!("Could not update Nightingale install size: {error}"))?;
    }
    #[cfg(not(windows))]
    let _ = payloads;
    Ok(())
}

fn bootstrap_entry(entries: &[PackedEntry]) -> Result<&PackedEntry, String> {
    entries
        .iter()
        .find(|entry| entry.role == PackedRole::Bootstrap && entry.name != "installer-stub.exe")
        .ok_or_else(|| "Offline installer bootstrap is missing".to_string())
}

fn install_payload(
    installer: &Path,
    entries: &[PackedEntry],
    install_dir: &Path,
    role: PackedRole,
    directory_name: &str,
    label: &str,
    required: bool,
) -> Result<Option<PathBuf>, String> {
    let destination = install_dir.join(directory_name);
    let swap = prepare_atomic_directory_swap(&destination)?;
    if !entries.iter().any(|entry| entry.role == role) {
        return if required {
            Err(format!("Offline installer {label} payload is missing"))
        } else {
            Ok(None)
        };
    }
    std::fs::create_dir_all(&swap.partial)
        .map_err(|error| format!("Could not create {}: {error}", swap.partial.display()))?;

    let result = (|| {
        for entry in entries.iter().filter(|entry| entry.role == role) {
            println!("Installing offline {label} component {}...", entry.name);
            extract_packed_entry(installer, entry, swap.partial.join(&entry.name))?;
        }
        if !swap.partial.join("manifest.json").is_file() {
            return Err(format!("Offline {label} manifest was not installed"));
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&swap.partial);
        return Err(error);
    }
    activate_atomic_directory_swap(&destination, &swap)?;
    Ok(Some(destination))
}

fn hydrate_model_cache(install_dir: &Path, payload: &Path) -> Result<(), String> {
    println!("Expanding offline models into the configured model cache...");
    let app = install_dir.join("Nightingale.exe");
    let status = Command::new(&app)
        .arg("--install-offline-models")
        .arg(payload)
        .status()
        .map_err(|error| format!("Could not start {}: {error}", app.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Nightingale model installation exited with {}",
            status.code().unwrap_or(-1)
        ))
    }
}

fn run() -> Result<(), String> {
    if !cfg!(windows) {
        return Err("This offline installer is for Windows only".to_string());
    }
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let verify_only = args.iter().any(|argument| argument == "--verify-only");
    let no_launch = args.iter().any(|argument| argument == "--no-launch");
    if args
        .iter()
        .any(|argument| argument != "--verify-only" && argument != "--no-launch")
    {
        return Err("Supported options: --verify-only, --no-launch".to_string());
    }

    let installer = std::env::current_exe()
        .map_err(|error| format!("Could not locate this installer: {error}"))?;
    println!("Verifying Nightingale offline installer...");
    let index = verify_packed_installer(&installer)?;
    let embedded_models = index
        .entries
        .iter()
        .any(|entry| entry.role == PackedRole::Models);
    let sidecar_models = if embedded_models {
        None
    } else {
        let root = installer
            .parent()
            .ok_or_else(|| "Offline installer directory is unavailable".to_string())?
            .join("offline-models");
        root.is_dir().then_some(root)
    };
    if let Some(models) = sidecar_models.as_ref() {
        let verified = verify_sidecar_payload(models, &index.app_version, PackedRole::Models)?;
        println!(
            "Verified {} sidecar model components.",
            verified.entries.len()
        );
    }
    println!(
        "Verified Nightingale {} with {} embedded components.",
        index.app_version,
        index.entries.len() - 1
    );
    if verify_only {
        return Ok(());
    }

    let temp = std::env::temp_dir().join(format!(
        "Nightingale-offline-installer-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp)
        .map_err(|error| format!("Could not create {}: {error}", temp.display()))?;
    let bootstrap = bootstrap_entry(&index.entries)?;
    let setup = temp.join(&bootstrap.name);
    extract_packed_entry(&installer, bootstrap, &setup)?;

    println!("Installing Nightingale desktop application...");
    let status = Command::new(&setup)
        .arg("/S")
        .status()
        .map_err(|error| format!("Could not start {}: {error}", setup.display()))?;
    let _ = std::fs::remove_dir_all(&temp);
    if !status.success() {
        return Err(format!(
            "Nightingale desktop installer exited with {}",
            status.code().unwrap_or(-1)
        ));
    }

    let install_dir = install_directory()?;
    if !install_dir.join("Nightingale.exe").is_file() {
        return Err(format!(
            "Nightingale was not found after installation at {}",
            install_dir.display()
        ));
    }
    let mut installed_payloads = vec![
        install_payload(
            &installer,
            &index.entries,
            &install_dir,
            PackedRole::Vendor,
            "offline-vendor",
            "analyzer",
            true,
        )?
        .expect("required analyzer payload"),
    ];
    let installed_models = if let Some(models) = install_payload(
        &installer,
        &index.entries,
        &install_dir,
        PackedRole::Models,
        "offline-models",
        "model",
        false,
    )? {
        Some(models)
    } else if let Some(models) = sidecar_models {
        let destination = install_dir.join("offline-models");
        println!("Installing verified offline model sidecars...");
        install_sidecar_payload(
            &models,
            &destination,
            &index.app_version,
            PackedRole::Models,
        )?;
        Some(destination)
    } else {
        None
    };
    if let Some(models) = installed_models {
        hydrate_model_cache(&install_dir, &models)?;
        installed_payloads.push(models);
    }
    update_installed_size(&installed_payloads)?;

    if !no_launch {
        Command::new(install_dir.join("Nightingale.exe"))
            .spawn()
            .map_err(|error| format!("Nightingale installed but could not launch: {error}"))?;
    }
    println!("Nightingale offline installation completed successfully.");
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Nightingale offline installation failed: {error}");
            ExitCode::FAILURE
        }
    }
}
