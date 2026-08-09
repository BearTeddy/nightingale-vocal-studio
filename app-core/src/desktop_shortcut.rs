use std::path::{Path, PathBuf};

#[cfg(windows)]
const SHORTCUT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('NIGHTINGALE_SHORTCUT_TARGET', 'Process')
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Shortcut target is empty' }
[IO.Directory]::CreateDirectory($target) | Out-Null
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
if ([string]::IsNullOrWhiteSpace($desktop)) { throw 'Desktop folder is unavailable' }
$shortcutPath = Join-Path $desktop 'Nightingale Data.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $target
$shortcut.Description = 'Nightingale data, recordings, and analysis files'
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,3"
$shortcut.Save()
"#;

pub fn ensure_data_shortcut(data_path: &Path) -> Result<Option<PathBuf>, String> {
    std::fs::create_dir_all(data_path).map_err(|error| {
        format!(
            "Failed to create Nightingale data folder {}: {error}",
            data_path.display()
        )
    })?;

    #[cfg(windows)]
    {
        let status = crate::vendor::silent_command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                SHORTCUT_SCRIPT,
            ])
            .env("NIGHTINGALE_SHORTCUT_TARGET", data_path)
            .status()
            .map_err(|error| format!("Failed to start Desktop shortcut setup: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Desktop shortcut setup exited with status {status}"
            ));
        }
        let desktop =
            dirs::desktop_dir().ok_or_else(|| "Desktop folder is unavailable".to_string())?;
        return Ok(Some(desktop.join("Nightingale Data.lnk")));
    }

    #[cfg(not(windows))]
    Ok(None)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn shortcut_script_uses_process_environment_for_unicode_safe_target() {
        assert!(super::SHORTCUT_SCRIPT.contains("NIGHTINGALE_SHORTCUT_TARGET"));
        assert!(super::SHORTCUT_SCRIPT.contains("Nightingale Data.lnk"));
        assert!(!super::SHORTCUT_SCRIPT.contains("D:\\"));
    }
}
