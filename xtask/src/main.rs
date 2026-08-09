use std::{
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

use app_core::{
    install_offline_vendor_bundle, split_existing_offline_vendor_bundle,
    stage_offline_vendor_bundle, verify_offline_vendor_runtime, OfflineVendorBundle,
    StagedOfflineVendor,
};
use nightingale_offline_installer::pack_offline_installer;

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

fn split_offline_args(args: &[String]) -> Result<(PathBuf, PathBuf, Vec<String>), String> {
    let mut vendor = None;
    let mut output = None;
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
    Ok((vendor, output, tauri_args))
}

fn write_offline_tauri_config(
    staged: &StagedOfflineVendor,
    output: &Path,
) -> Result<PathBuf, String> {
    let manifest = staged.manifest.canonicalize().map_err(|error| {
        format!(
            "Could not resolve staged manifest {}: {error}",
            staged.manifest.display()
        )
    })?;
    let tauri_path = |path: &Path| {
        let value = path.to_string_lossy();
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    };
    let mut resources = serde_json::Map::new();
    for archive in &staged.archives {
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
            serde_json::Value::String(format!("offline-vendor/{file_name}")),
        );
    }
    resources.insert(
        tauri_path(&manifest),
        serde_json::Value::String("offline-vendor/manifest.json".to_string()),
    );
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

fn stage_offline(args: &[String]) -> Result<(StagedOfflineVendor, PathBuf, Vec<String>), String> {
    let (vendor, output, tauri_args) = split_offline_args(args)?;
    println!("Staging offline vendor from {}", vendor.display());
    let worker_vendor = vendor.clone();
    let worker_output = output.clone();
    let staged =
        run_staging_worker(move || stage_offline_vendor_bundle(&worker_vendor, &worker_output))??;
    let config = write_offline_tauri_config(&staged, &output)?;
    println!(
        "Staged {} files ({:.2} GB -> {:.2} GB in {} parts) at {}",
        staged.metadata.file_count,
        staged.metadata.uncompressed_bytes as f64 / 1_000_000_000.0,
        staged.metadata.archive_bytes as f64 / 1_000_000_000.0,
        staged.archives.len(),
        output.display()
    );
    println!("Tauri override: {}", config.display());
    Ok((staged, config, tauri_args))
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
        Ok(Ok(staged)) => match write_offline_tauri_config(&staged, &bundle_root) {
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
    let (staged, config, mut tauri_args) = match stage_offline(args) {
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
        return match wrap_offline_installer(bundle_root, None, None, None) {
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

fn wrap_offline_installer(
    bundle_root: &Path,
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
            .replace("-setup.exe", "-offline-setup.exe");
        setup.with_file_name(name)
    });
    println!(
        "Wrapping {} and {} into {}",
        setup.display(),
        bundle_root.display(),
        output.display()
    );
    let index = pack_offline_installer(&stub, &setup, bundle_root, &output)?;
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

    match wrap_offline_installer(&bundle_root, setup, stub, output) {
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
    eprintln!("  cargo desktop offline-split [--bundle PATH]");
    eprintln!("  cargo desktop offline-wrap [--bundle PATH] [--setup PATH] [--output PATH]");
    eprintln!("  cargo desktop offline-verify [--bundle PATH] [--destination PATH]");
    eprintln!("  cargo desktop offline-build [--vendor PATH] [--output PATH] [-- Tauri options]");
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
        Some("offline-wrap") => offline_wrap(&args[1..]),
        Some("offline-verify") => offline_verify(&args[1..]),
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
        split_offline_args,
    };

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
        let (vendor, output, tauri) = split_offline_args(&[
            "--vendor".into(),
            "D:\\vendor".into(),
            "--output".into(),
            "D:\\bundle".into(),
            "--".into(),
            "--target".into(),
            "x86_64-pc-windows-msvc".into(),
        ])
        .unwrap();
        assert_eq!(vendor, std::path::PathBuf::from("D:\\vendor"));
        assert_eq!(output, std::path::PathBuf::from("D:\\bundle"));
        assert_eq!(
            tauri,
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
    fn offline_staging_runs_on_the_large_stack_worker() {
        let thread_name =
            run_staging_worker(|| std::thread::current().name().map(str::to_string)).unwrap();
        assert_eq!(thread_name.as_deref(), Some("offline-vendor-staging"));
    }
}
