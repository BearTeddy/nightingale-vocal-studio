use std::process::{Command, ExitCode};

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

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let (cmd, tauri_args) = match args.first().map(|s| s.as_str()) {
        Some("dev") => ("dev", &args[1..]),
        Some("build") => ("build", &args[1..]),
        _ => {
            eprintln!("Usage: cargo desktop <dev|build> [extra tauri args...]");
            return ExitCode::FAILURE;
        }
    };

    let workspace_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask must live one level below workspace root");

    let mut command = Command::new(pnpm_program());
    command
        .current_dir(workspace_root.join("client"))
        .arg("tauri")
        .arg(cmd);
    if needs_unsigned_build_config(
        cmd,
        tauri_args,
        std::env::var_os("TAURI_SIGNING_PRIVATE_KEY").is_some(),
    ) {
        command
            .arg("--config")
            .arg("src-tauri/tauri.local.conf.json");
    }
    command.args(tauri_args);

    match command.status() {
        Ok(status) => {
            if status.success() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            }
        }
        Err(e) => {
            eprintln!("Failed to run pnpm: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{needs_unsigned_build_config, pnpm_program};

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
}
