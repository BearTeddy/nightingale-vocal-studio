use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use app_core::{
    install_offline_model_bundle, install_offline_vendor_bundle,
    split_existing_offline_vendor_bundle, stage_offline_model_bundle, stage_offline_vendor_bundle,
    verify_offline_vendor_runtime, OfflineModelBundle, OfflineVendorBundle, StagedOfflineVendor,
};
use nightingale_offline_installer::{
    activate_atomic_directory_swap, install_sidecar_payload, pack_offline_installer,
    pack_offline_installer_with_models, prepare_atomic_directory_swap, sha256_file, PackedIndex,
    PackedRole, VerifiedSidecarPayload,
};

const MAX_WINDOWS_EXECUTABLE_BYTES: u64 = 4_000_000_000;

struct OfflineInputs {
    vendor: PathBuf,
    output: PathBuf,
    models: Option<PathBuf>,
    models_output: Option<PathBuf>,
    tauri_args: Vec<String>,
}

fn needs_unsigned_build_config(command: &str, args: &[String], signing_key_present: bool) -> bool {
    command == "build"
        && !signing_key_present
        && !args
            .iter()
            .any(|argument| argument == "--config" || argument.starts_with("--config="))
}

fn pnpm_program() -> &'static str {
    if cfg!(windows) {
        "pnpm.cmd"
    } else {
        "pnpm"
    }
}

fn workspace_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live one level below workspace root")
}

fn run_tauri(command: &str, args: &[String]) -> ExitCode {
    match run_tauri_checked(command, args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run_tauri_checked(command: &str, args: &[String]) -> Result<(), String> {
    let mut process = Command::new(pnpm_program());
    process
        .current_dir(workspace_root().join("client"))
        .arg("tauri")
        .arg(command);
    if needs_unsigned_build_config(
        command,
        args,
        std::env::var_os("TAURI_SIGNING_PRIVATE_KEY").is_some(),
    ) {
        process
            .arg("--config")
            .arg("src-tauri/tauri.local.conf.json");
    }
    process.args(args);

    match process.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!(
            "Tauri {command} failed with exit code {}",
            status.code().unwrap_or(-1)
        )),
        Err(error) => Err(format!("Failed to run pnpm: {error}")),
    }
}

fn split_offline_args(args: &[String]) -> Result<OfflineInputs, String> {
    let mut vendor = None;
    let mut output = None;
    let mut models = None;
    let mut models_output = None;
    let mut tauri_args = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--vendor" => {
                index += 1;
                vendor = Some(
                    args.get(index)
                        .ok_or_else(|| "--vendor requires a path".to_string())?
                        .into(),
                );
            }
            "--output" => {
                index += 1;
                output = Some(
                    args.get(index)
                        .ok_or_else(|| "--output requires a path".to_string())?
                        .into(),
                );
            }
            "--models" => {
                index += 1;
                models = Some(
                    args.get(index)
                        .ok_or_else(|| "--models requires a path".to_string())?
                        .into(),
                );
            }
            "--models-output" => {
                index += 1;
                models_output = Some(
                    args.get(index)
                        .ok_or_else(|| "--models-output requires a path".to_string())?
                        .into(),
                );
            }
            "--" => {
                tauri_args.extend_from_slice(&args[index + 1..]);
                break;
            }
            argument => {
                return Err(format!(
                    "Unknown offline option '{argument}'. Put Tauri options after --"
                ));
            }
        }
        index += 1;
    }

    let vendor = vendor.unwrap_or_else(app_core::vendor_dir);
    let output = output.unwrap_or_else(|| {
        workspace_root()
            .join("target")
            .join("offline-vendor")
            .join(format!(
                "{}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ))
    });
    if models.is_none() && models_output.is_some() {
        return Err("--models-output requires --models".to_string());
    }
    let models_output = models
        .as_ref()
        .map(|_| models_output.unwrap_or_else(default_offline_models_root));
    Ok(OfflineInputs {
        vendor,
        output,
        models,
        models_output,
        tauri_args,
    })
}

fn write_offline_tauri_config(
    staged: &StagedOfflineVendor,
    staged_models: Option<&StagedOfflineVendor>,
    output: &Path,
) -> Result<PathBuf, String> {
    let tauri_path = |path: &Path| {
        let value = path.to_string_lossy();
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    };
    let mut resources = serde_json::Map::new();
    let mut payloads = vec![(staged, "offline-vendor")];
    if let Some(models) = staged_models {
        payloads.push((models, "offline-models"));
    }
    for (payload, resource_directory) in payloads {
        for archive in &payload.archives {
            let canonical = archive.canonicalize().map_err(|error| {
                format!(
                    "Could not resolve staged archive {}: {error}",
                    archive.display()
                )
            })?;
            let file_name = archive
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("Offline archive name is invalid: {}", archive.display()))?;
            resources.insert(
                tauri_path(&canonical),
                serde_json::Value::String(format!("{resource_directory}/{file_name}")),
            );
        }
        let manifest = payload.manifest.canonicalize().map_err(|error| {
            format!(
                "Could not resolve staged manifest {}: {error}",
                payload.manifest.display()
            )
        })?;
        resources.insert(
            tauri_path(&manifest),
            serde_json::Value::String(format!("{resource_directory}/manifest.json")),
        );
    }
    let config = serde_json::json!({
        "$schema": "https://schema.tauri.app/config/2",
        "bundle": {
            "createUpdaterArtifacts": false,
            "resources": resources,
            "windows": {
                "nsis": {
                    "compression": "none"
                }
            }
        }
    });
    let path = output.join("tauri.offline.conf.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&config)
            .map_err(|error| format!("Could not serialize Tauri config: {error}"))?,
    )
    .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(path)
}

fn run_staging_worker<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name("offline-vendor-staging".to_string())
        .stack_size(32 * 1024 * 1024)
        .spawn(work)
        .map_err(|error| format!("Could not start offline staging worker: {error}"))?
        .join()
        .map_err(|_| "Offline staging worker stopped unexpectedly".to_string())
}

fn stage_offline(
    args: &[String],
) -> Result<
    (
        StagedOfflineVendor,
        Option<StagedOfflineVendor>,
        PathBuf,
        Vec<String>,
    ),
    String,
> {
    let OfflineInputs {
        vendor,
        output,
        models,
        models_output,
        tauri_args,
    } = split_offline_args(args)?;
    println!("Staging offline vendor from {}", vendor.display());
    let worker_vendor = vendor.clone();
    let worker_output = output.clone();
    let staged =
        run_staging_worker(move || stage_offline_vendor_bundle(&worker_vendor, &worker_output))??;
    let staged_models = match (models, models_output) {
        (Some(models), Some(models_output)) => {
            println!("Staging offline models from {}", models.display());
            let worker_models = models.clone();
            let worker_output = models_output.clone();
            let staged_models = run_staging_worker(move || {
                stage_offline_model_bundle(&worker_models, &worker_output)
            })??;
            println!(
                "Staged {} model files ({:.2} GB -> {:.2} GB in {} parts) at {}",
                staged_models.metadata.file_count,
                staged_models.metadata.uncompressed_bytes as f64 / 1_000_000_000.0,
                staged_models.metadata.archive_bytes as f64 / 1_000_000_000.0,
                staged_models.archives.len(),
                models_output.display()
            );
            Some(staged_models)
        }
        (None, None) => None,
        _ => return Err("Model staging paths are incomplete".to_string()),
    };
    let config = write_offline_tauri_config(&staged, staged_models.as_ref(), &output)?;
    println!(
        "Staged {} files ({:.2} GB -> {:.2} GB in {} parts) at {}",
        staged.metadata.file_count,
        staged.metadata.uncompressed_bytes as f64 / 1_000_000_000.0,
        staged.metadata.archive_bytes as f64 / 1_000_000_000.0,
        staged.archives.len(),
        output.display()
    );
    println!("Tauri override: {}", config.display());
    Ok((staged, staged_models, config, tauri_args))
}

fn default_offline_bundle() -> &'static str {
    if cfg!(windows) {
        "nsis"
    } else if cfg!(target_os = "macos") {
        "dmg"
    } else {
        "appimage"
    }
}

fn default_offline_root() -> PathBuf {
    workspace_root()
        .join("target")
        .join("offline-vendor")
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
}

fn default_offline_models_root() -> PathBuf {
    workspace_root()
        .join("target")
        .join("offline-models")
        .join(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
}

fn offline_split(args: &[String]) -> ExitCode {
    let mut bundle_root = default_offline_root();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--bundle" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--bundle requires a path");
                    return ExitCode::FAILURE;
                };
                bundle_root = value.into();
            }
            argument => {
                eprintln!("Unknown offline split option '{argument}'");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }

    let worker_root = bundle_root.clone();
    let result = run_staging_worker(move || split_existing_offline_vendor_bundle(&worker_root));
    match result {
        Ok(Ok(staged)) => match write_offline_tauri_config(&staged, None, &bundle_root) {
            Ok(config) => {
                println!(
                    "Offline analyzer is ready as {} verified parts ({:.2} GB) at {}",
                    staged.archives.len(),
                    staged.metadata.archive_bytes as f64 / 1_000_000_000.0,
                    bundle_root.display()
                );
                println!("Tauri override: {}", config.display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Offline config generation failed: {error}");
                ExitCode::FAILURE
            }
        },
        Ok(Err(error)) | Err(error) => {
            eprintln!("Offline archive splitting failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn offline_build(args: &[String]) -> ExitCode {
    let (staged, staged_models, config, mut tauri_args) = match stage_offline(args) {
        Ok(result) => result,
        Err(error) => {
            eprintln!("Offline staging failed: {error}");
            return ExitCode::FAILURE;
        }
    };
    let has_bundle = tauri_args
        .iter()
        .any(|argument| argument == "--bundles" || argument.starts_with("--bundles="));
    if !has_bundle {
        tauri_args.push("--bundles".to_string());
        tauri_args.push(default_offline_bundle().to_string());
    }

    if cfg!(windows) {
        if let Err(error) = run_tauri_checked("build", &tauri_args) {
            eprintln!("Desktop installer build failed: {error}");
            return ExitCode::FAILURE;
        }
        let Some(bundle_root) = staged.manifest.parent() else {
            eprintln!("Offline bundle path is invalid");
            return ExitCode::FAILURE;
        };
        let models_bundle_root = staged_models
            .as_ref()
            .and_then(|models| models.manifest.parent());
        return match wrap_offline_installer(bundle_root, models_bundle_root, None, None, None) {
            Ok(path) => {
                println!("Offline installer: {}", path.display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Offline installer wrapping failed: {error}");
                ExitCode::FAILURE
            }
        };
    }

    tauri_args.push("--config".to_string());
    tauri_args.push(config.to_string_lossy().into_owned());
    run_tauri("build", &tauri_args)
}

fn newest_bootstrap_setup() -> Result<PathBuf, String> {
    let root = workspace_root()
        .join("target")
        .join("release")
        .join("bundle")
        .join("nsis");
    let mut candidates = std::fs::read_dir(&root)
        .map_err(|error| format!("Could not inspect {}: {error}", root.display()))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy();
            (path.is_file() && name.ends_with("-setup.exe") && !name.contains("-offline-"))
                .then_some(path)
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        path.metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
    });
    candidates.pop().ok_or_else(|| {
        format!(
            "No standard NSIS setup executable was found in {}",
            root.display()
        )
    })
}

fn manifest_archive_bytes(root: &Path) -> Result<u64, String> {
    let path = root.join("manifest.json");
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("Offline manifest {} is invalid: {error}", path.display()))?;
    value
        .get("archive_bytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| format!("Offline manifest {} has no archive size", path.display()))
}

fn sidecar_package_root(output: &Path) -> Result<PathBuf, String> {
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            format!(
                "Offline installer filename is invalid: {}",
                output.display()
            )
        })?;
    Ok(output.with_file_name(stem))
}

fn checksum_relative_path(path: &Path) -> Result<String, String> {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.contains('\r') || value.contains('\n') {
        return Err(format!(
            "Offline package filename cannot be represented in SHA256SUMS.txt: {}",
            path.display()
        ));
    }
    Ok(value)
}

fn write_complete_package_checksums(
    package_root: &Path,
    launcher_name: &OsStr,
    models: &VerifiedSidecarPayload,
) -> Result<(), String> {
    let launcher_relative = PathBuf::from(launcher_name);
    let readme_relative = PathBuf::from("README.txt");
    let mut checksums = vec![
        (
            checksum_relative_path(&launcher_relative)?,
            sha256_file(package_root.join(&launcher_relative))?,
        ),
        (
            checksum_relative_path(&readme_relative)?,
            sha256_file(package_root.join(&readme_relative))?,
        ),
    ];
    checksums.extend(
        models
            .entries
            .iter()
            .map(|entry| {
                let relative = Path::new("offline-models").join(&entry.name);
                checksum_relative_path(&relative).map(|relative| (relative, entry.sha256.clone()))
            })
            .collect::<Result<Vec<_>, _>>()?,
    );
    checksums.sort_by(|left, right| left.0.cmp(&right.0));

    let manifest = checksums
        .into_iter()
        .map(|(name, sha256)| format!("{sha256}  {name}\n"))
        .collect::<String>();
    std::fs::write(package_root.join("SHA256SUMS.txt"), manifest)
        .map_err(|error| format!("Could not write offline package checksums: {error}"))
}

fn pack_windows_sidecar_installer(
    stub: &Path,
    setup: &Path,
    vendor_root: &Path,
    models_root: &Path,
    output: &Path,
) -> Result<(PathBuf, PackedIndex), String> {
    let package_root = sidecar_package_root(output)?;
    let parent = package_root.parent().ok_or_else(|| {
        format!(
            "Offline package destination is invalid: {}",
            package_root.display()
        )
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let swap = prepare_atomic_directory_swap(&package_root)?;
    std::fs::create_dir_all(&swap.partial)
        .map_err(|error| format!("Could not create {}: {error}", swap.partial.display()))?;
    let launcher_name = output.file_name().ok_or_else(|| {
        format!(
            "Offline installer filename is invalid: {}",
            output.display()
        )
    })?;
    let launcher = swap.partial.join(launcher_name);

    let result = (|| {
        let index = pack_offline_installer(stub, setup, vendor_root, &launcher)?;
        let models = install_sidecar_payload(
            models_root,
            swap.partial.join("offline-models"),
            &index.app_version,
            PackedRole::Models,
        )?;
        std::fs::write(
            swap.partial.join("README.txt"),
            concat!(
                "Nightingale complete offline installer\n\n",
                "Keep this folder together and run the .exe inside it.\n",
                "The launcher verifies every analyzer and model component before installation.\n",
                "SHA256SUMS.txt verifies every distributed file in this folder.\n",
                "Use --verify-only from a terminal to check the media without installing.\n",
            ),
        )
        .map_err(|error| format!("Could not write offline package instructions: {error}"))?;
        write_complete_package_checksums(&swap.partial, launcher_name, &models)?;
        Ok::<_, String>(index)
    })();
    let index = match result {
        Ok(index) => index,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&swap.partial);
            return Err(error);
        }
    };
    activate_atomic_directory_swap(&package_root, &swap)?;
    if output.is_file() {
        std::fs::remove_file(output)
            .map_err(|error| format!("Could not remove unusable {}: {error}", output.display()))?;
    }
    Ok((package_root.join(launcher_name), index))
}

fn wrap_offline_installer(
    bundle_root: &Path,
    models_bundle_root: Option<&Path>,
    setup: Option<PathBuf>,
    stub: Option<PathBuf>,
    output: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let stub = if let Some(stub) = stub {
        stub
    } else {
        let status = Command::new("cargo")
            .current_dir(workspace_root())
            .args(["build", "--release", "-p", "nightingale-offline-installer"])
            .status()
            .map_err(|error| format!("Could not build offline installer stub: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Offline installer stub build failed with exit code {}",
                status.code().unwrap_or(-1)
            ));
        }
        workspace_root()
            .join("target")
            .join("release")
            .join(if cfg!(windows) {
                "nightingale-offline-installer.exe"
            } else {
                "nightingale-offline-installer"
            })
    };
    let setup = setup.map(Ok).unwrap_or_else(newest_bootstrap_setup)?;
    let output = output.unwrap_or_else(|| {
        let name = setup
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Nightingale-setup.exe")
            .replace(
                "-setup.exe",
                if models_bundle_root.is_some() {
                    "-complete-offline-setup.exe"
                } else {
                    "-offline-setup.exe"
                },
            );
        setup.with_file_name(name)
    });
    if let Some(models) = models_bundle_root {
        println!(
            "Wrapping {}, {}, and {} into {}",
            setup.display(),
            bundle_root.display(),
            models.display(),
            output.display()
        );
    } else {
        println!(
            "Wrapping {} and {} into {}",
            setup.display(),
            bundle_root.display(),
            output.display()
        );
    }
    if cfg!(windows) {
        if let Some(models) = models_bundle_root {
            let projected_bytes = stub
                .metadata()
                .and_then(|metadata| setup.metadata().map(|setup| metadata.len() + setup.len()))
                .map_err(|error| format!("Could not inspect installer inputs: {error}"))?
                .saturating_add(manifest_archive_bytes(bundle_root)?)
                .saturating_add(manifest_archive_bytes(models)?);
            if projected_bytes >= MAX_WINDOWS_EXECUTABLE_BYTES {
                println!(
                    "The complete payload is {:.2} GB, above the Windows executable limit; creating verified sidecar media instead.",
                    projected_bytes as f64 / 1_000_000_000.0
                );
                let (launcher, index) =
                    pack_windows_sidecar_installer(&stub, &setup, bundle_root, models, &output)?;
                println!(
                    "Packed Nightingale {} with {} embedded components and verified model sidecars",
                    index.app_version,
                    index.entries.len() - 1
                );
                return Ok(launcher);
            }
        }
    }
    let index = pack_offline_installer_with_models(
        &stub,
        &setup,
        bundle_root,
        models_bundle_root,
        &output,
    )?;
    let bytes = output
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", output.display()))?
        .len();
    println!(
        "Packed Nightingale {} with {} components ({:.2} GB)",
        index.app_version,
        index.entries.len() - 1,
        bytes as f64 / 1_000_000_000.0
    );
    Ok(output)
}

fn offline_wrap(args: &[String]) -> ExitCode {
    let mut bundle_root = default_offline_root();
    let mut models_bundle_root = None;
    let mut setup = None;
    let mut stub = None;
    let mut output = None;
    let mut index = 0;
    while index < args.len() {
        let option = args[index].clone();
        index += 1;
        let Some(value) = args.get(index) else {
            eprintln!("{option} requires a path");
            return ExitCode::FAILURE;
        };
        match option.as_str() {
            "--bundle" => bundle_root = value.into(),
            "--models-bundle" => models_bundle_root = Some(PathBuf::from(value)),
            "--setup" => setup = Some(value.into()),
            "--stub" => stub = Some(value.into()),
            "--output" => output = Some(value.into()),
            argument => {
                eprintln!("Unknown offline wrap option '{argument}'");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }

    match wrap_offline_installer(
        &bundle_root,
        models_bundle_root.as_deref(),
        setup,
        stub,
        output,
    ) {
        Ok(path) => {
            println!("Offline installer: {}", path.display());
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Offline installer wrapping failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn offline_models_stage(args: &[String]) -> ExitCode {
    let mut models = app_core::models_dir();
    let mut output = default_offline_models_root();
    let mut index = 0;
    while index < args.len() {
        let option = args[index].clone();
        index += 1;
        let Some(value) = args.get(index) else {
            eprintln!("{option} requires a path");
            return ExitCode::FAILURE;
        };
        match option.as_str() {
            "--models" => models = value.into(),
            "--output" => output = value.into(),
            argument => {
                eprintln!("Unknown offline model staging option '{argument}'");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }

    println!("Staging offline models from {}", models.display());
    let worker_models = models.clone();
    let worker_output = output.clone();
    match run_staging_worker(move || stage_offline_model_bundle(&worker_models, &worker_output)) {
        Ok(Ok(staged)) => {
            println!(
                "Offline models are ready as {} verified parts ({:.2} GB) at {}",
                staged.archives.len(),
                staged.metadata.archive_bytes as f64 / 1_000_000_000.0,
                output.display()
            );
            ExitCode::SUCCESS
        }
        Ok(Err(error)) | Err(error) => {
            eprintln!("Offline model staging failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn offline_models_verify(args: &[String]) -> ExitCode {
    let default_bundle = default_offline_models_root();
    let mut bundle_root = default_bundle.clone();
    let mut destination = default_bundle.join("verified-models");
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--bundle" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--bundle requires a path");
                    return ExitCode::FAILURE;
                };
                bundle_root = value.into();
            }
            "--destination" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--destination requires a path");
                    return ExitCode::FAILURE;
                };
                destination = value.into();
            }
            argument => {
                eprintln!("Unknown offline model verification option '{argument}'");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }

    let Some(bundle) = OfflineModelBundle::from_directory(&bundle_root) else {
        eprintln!(
            "Offline model bundle is incomplete in {}",
            bundle_root.display()
        );
        return ExitCode::FAILURE;
    };
    println!(
        "Extracting and verifying {} offline model part(s)",
        bundle.archives.len()
    );
    let worker_destination = destination.clone();
    let result =
        run_staging_worker(move || install_offline_model_bundle(&bundle, &worker_destination));
    match result {
        Ok(Ok(manifest)) => {
            println!(
                "Offline models verified successfully at {} ({} files)",
                destination.display(),
                manifest.file_count
            );
            ExitCode::SUCCESS
        }
        Ok(Err(error)) | Err(error) => {
            eprintln!("Offline model verification failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn offline_verify(args: &[String]) -> ExitCode {
    let default_bundle = default_offline_root();
    let mut bundle_root = default_bundle.clone();
    let mut destination = default_bundle.join("verified-vendor");
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--bundle" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--bundle requires a path");
                    return ExitCode::FAILURE;
                };
                bundle_root = value.into();
            }
            "--destination" => {
                index += 1;
                let Some(value) = args.get(index) else {
                    eprintln!("--destination requires a path");
                    return ExitCode::FAILURE;
                };
                destination = value.into();
            }
            argument => {
                eprintln!("Unknown offline verification option '{argument}'");
                return ExitCode::FAILURE;
            }
        }
        index += 1;
    }

    let Some(bundle) = OfflineVendorBundle::from_directory(&bundle_root) else {
        eprintln!("Offline bundle is incomplete in {}", bundle_root.display());
        return ExitCode::FAILURE;
    };
    println!(
        "Extracting and verifying {} offline analyzer part(s)",
        bundle.archives.len()
    );
    let worker_destination = destination.clone();
    let result = run_staging_worker(move || {
        install_offline_vendor_bundle(&bundle, &worker_destination)?;
        verify_offline_vendor_runtime(&worker_destination)
    });
    match result {
        Ok(Ok(())) => {
            println!(
                "Offline analyzer verified successfully at {}",
                destination.display()
            );
            ExitCode::SUCCESS
        }
        Ok(Err(error)) | Err(error) => {
            eprintln!("Offline analyzer verification failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn print_usage() {
    eprintln!("Usage:");
    eprintln!("  cargo desktop <dev|build> [Tauri options]");
    eprintln!("  cargo desktop offline-stage [--vendor PATH] [--output PATH]");
    eprintln!("  cargo desktop offline-models-stage [--models PATH] [--output PATH]");
    eprintln!("  cargo desktop offline-split [--bundle PATH]");
    eprintln!("  cargo desktop offline-wrap [--bundle PATH] [--models-bundle PATH] [--setup PATH] [--output PATH]");
    eprintln!("  cargo desktop offline-verify [--bundle PATH] [--destination PATH]");
    eprintln!("  cargo desktop offline-models-verify [--bundle PATH] [--destination PATH]");
    eprintln!("  cargo desktop offline-build [--vendor PATH] [--output PATH] [--models PATH] [--models-output PATH] [-- Tauri options]");
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("dev") => run_tauri("dev", &args[1..]),
        Some("build") => run_tauri("build", &args[1..]),
        Some("offline-stage") => match stage_offline(&args[1..]) {
            Ok(_) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("Offline staging failed: {error}");
                ExitCode::FAILURE
            }
        },
        Some("offline-split") => offline_split(&args[1..]),
        Some("offline-models-stage") => offline_models_stage(&args[1..]),
        Some("offline-wrap") => offline_wrap(&args[1..]),
        Some("offline-verify") => offline_verify(&args[1..]),
        Some("offline-models-verify") => offline_models_verify(&args[1..]),
        Some("offline-build") => offline_build(&args[1..]),
        _ => {
            print_usage();
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        default_offline_bundle, needs_unsigned_build_config, pnpm_program, run_staging_worker,
        sidecar_package_root, split_offline_args, write_complete_package_checksums,
    };
    use nightingale_offline_installer::{
        sha256_file, PackedEntry, PackedRole, VerifiedSidecarPayload,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nightingale-{label}-{nonce}"))
    }

    #[test]
    fn uses_the_windows_command_shim_when_required() {
        if cfg!(windows) {
            assert_eq!(pnpm_program(), "pnpm.cmd");
        } else {
            assert_eq!(pnpm_program(), "pnpm");
        }
    }

    #[test]
    fn local_builds_disable_updater_artifacts_without_changing_signed_releases() {
        assert!(needs_unsigned_build_config("build", &[], false));
        assert!(!needs_unsigned_build_config("build", &[], true));
        assert!(!needs_unsigned_build_config("dev", &[], false));
    }

    #[test]
    fn an_explicit_config_always_wins() {
        assert!(!needs_unsigned_build_config(
            "build",
            &["--config".into(), "custom.json".into()],
            false,
        ));
        assert!(!needs_unsigned_build_config(
            "build",
            &["--config=custom.json".into()],
            false,
        ));
    }

    #[test]
    fn offline_options_are_separate_from_tauri_options() {
        let inputs = split_offline_args(&[
            "--vendor".into(),
            "D:\\vendor".into(),
            "--output".into(),
            "D:\\bundle".into(),
            "--models".into(),
            "D:\\models".into(),
            "--models-output".into(),
            "D:\\model-bundle".into(),
            "--".into(),
            "--target".into(),
            "x86_64-pc-windows-msvc".into(),
        ])
        .unwrap();
        assert_eq!(inputs.vendor, std::path::PathBuf::from("D:\\vendor"));
        assert_eq!(inputs.output, std::path::PathBuf::from("D:\\bundle"));
        assert_eq!(inputs.models, Some(std::path::PathBuf::from("D:\\models")));
        assert_eq!(
            inputs.models_output,
            Some(std::path::PathBuf::from("D:\\model-bundle"))
        );
        assert_eq!(
            inputs.tauri_args,
            ["--target", "x86_64-pc-windows-msvc"].map(String::from)
        );
    }

    #[test]
    fn offline_bundle_matches_the_native_installer_type() {
        if cfg!(windows) {
            assert_eq!(default_offline_bundle(), "nsis");
        }
    }

    #[test]
    fn complete_windows_media_uses_a_directory_beside_the_requested_executable() {
        assert_eq!(
            sidecar_package_root(std::path::Path::new(
                "Nightingale_1.0.0_x64-complete-offline-setup.exe"
            ))
            .unwrap(),
            std::path::PathBuf::from("Nightingale_1.0.0_x64-complete-offline-setup")
        );
    }

    #[test]
    fn complete_windows_media_writes_sorted_checksums_for_every_file() {
        let root = temp_root("offline-checksums");
        let models_root = root.join("offline-models");
        std::fs::create_dir_all(&models_root).unwrap();
        std::fs::write(root.join("launcher.exe"), b"launcher").unwrap();
        std::fs::write(root.join("README.txt"), b"instructions").unwrap();
        std::fs::write(models_root.join("manifest.json"), b"manifest").unwrap();
        std::fs::write(models_root.join("models.part001"), b"weights").unwrap();
        let models = VerifiedSidecarPayload {
            app_version: "1.0.0".to_string(),
            entries: vec![
                PackedEntry {
                    role: PackedRole::Models,
                    name: "manifest.json".to_string(),
                    offset: 0,
                    bytes: 8,
                    sha256: sha256_file(models_root.join("manifest.json")).unwrap(),
                },
                PackedEntry {
                    role: PackedRole::Models,
                    name: "models.part001".to_string(),
                    offset: 0,
                    bytes: 7,
                    sha256: sha256_file(models_root.join("models.part001")).unwrap(),
                },
            ],
        };

        write_complete_package_checksums(&root, std::ffi::OsStr::new("launcher.exe"), &models)
            .unwrap();
        let manifest = std::fs::read_to_string(root.join("SHA256SUMS.txt")).unwrap();
        let lines = manifest.lines().collect::<Vec<_>>();
        let names = lines
            .iter()
            .map(|line| line.split_once("  ").unwrap().1)
            .collect::<Vec<_>>();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        assert_eq!(lines.len(), 4);
        assert!(lines.iter().any(|line| line.ends_with("  launcher.exe")));
        assert!(lines
            .iter()
            .any(|line| line.ends_with("  offline-models/manifest.json")));
        assert!(lines
            .iter()
            .any(|line| line.ends_with("  offline-models/models.part001")));
        assert!(lines.iter().any(|line| line.ends_with("  README.txt")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn offline_staging_runs_on_the_large_stack_worker() {
        let thread_name =
            run_staging_worker(|| std::thread::current().name().map(str::to_string)).unwrap();
        assert_eq!(thread_name.as_deref(), Some("offline-vendor-staging"));
    }
}
