use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;
use url::Url;

use crate::cache::vendor_dir;
use crate::config::{AppConfig, LibrarySource};
use crate::vendor::ffmpeg_path;

const OUTPUT_TEMPLATE: &str = concat!(
    "%(artist,creator,uploader,channel|Unknown Artist).38U/",
    "%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s - ",
    "%(track,title|Unknown Title).52U/",
    "%(artist,creator,uploader,channel|Unknown Artist).38U - ",
    "%(track,title|Unknown Title).52U ",
    "(%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s) ",
    "[%(id)s].%(ext)s"
);

const TITLE_NOISE_PATTERN: &str = concat!(
    r"(?i)\s*(?:\(|\[)(?:official(?:\s+music)?\s+video|official\s+audio|",
    r"lyrics?|lyric\s+video|visualizer|full|hd|4k)[^)\]]*(?:\)|\])\s*$"
);

#[derive(Debug, Clone, Serialize)]
pub struct YoutubeImportResult {
    pub downloaded: Vec<PathBuf>,
    pub library_path: PathBuf,
    pub warnings: Vec<String>,
}

pub fn import_youtube(url: &str) -> Result<YoutubeImportResult, String> {
    validate_youtube_url(url)?;

    let config = AppConfig::load();
    let library_path = match config.library_source.as_ref() {
        Some(LibrarySource::Folder { path }) => path.clone(),
        Some(_) => {
            return Err(
                "YouTube imports require a local folder library. Select a folder first.".into(),
            );
        }
        None => return Err("Select a local library folder before importing from YouTube.".into()),
    };

    fs::create_dir_all(&library_path).map_err(|error| {
        format!(
            "Failed to create library folder {}: {error}",
            library_path.display()
        )
    })?;

    let yt_dlp = ensure_yt_dlp()?;
    let ffmpeg = ffmpeg_path();
    if !ffmpeg.is_file() {
        return Err("Nightingale's ffmpeg is not installed. Finish app setup first.".into());
    }

    let data_path = config.effective_data_path();
    fs::create_dir_all(&data_path).map_err(|error| {
        format!(
            "Failed to create Nightingale data folder {}: {error}",
            data_path.display()
        )
    })?;

    let run_id = rand::random::<u64>();
    let result_file = data_path.join(format!("youtube-import-{run_id}.jsonl"));
    let archive_file = data_path.join("youtube-download-archive.txt");
    let output_template = library_path.join(OUTPUT_TEMPLATE);

    let mut command = silent_command(&yt_dlp);
    command
        .arg("--yes-playlist")
        .arg("--ignore-errors")
        .arg("--continue")
        .arg("--no-overwrites")
        .arg("--no-restrict-filenames")
        .arg("--windows-filenames")
        .args(["--encoding", "utf-8"])
        .arg("--download-archive")
        .arg(&archive_file)
        .arg("--ffmpeg-location")
        .arg(&ffmpeg)
        .arg("--format")
        .arg("bv*+ba/b")
        .arg("--merge-output-format")
        .arg("mkv")
        .arg("--output")
        .arg(&output_template)
        .arg("--trim-filenames")
        .arg("180")
        .arg("--no-write-playlist-metafiles")
        .arg("--concurrent-fragments")
        .arg("4")
        .arg("--write-info-json")
        .arg("--write-thumbnail")
        .arg("--convert-thumbnails")
        .arg("jpg")
        .arg("--embed-metadata")
        .arg("--write-link")
        .arg("--parse-metadata")
        .arg("title:%(artist)s - %(title)s")
        .arg("--replace-in-metadata")
        .arg("title,track")
        .arg(TITLE_NOISE_PATTERN)
        .arg("")
        .arg("--replace-in-metadata")
        .arg("artist,uploader,channel")
        .arg(r"(?i)\s+-\s+Topic$")
        .arg("")
        .arg("--print-to-file")
        .arg("after_move:%(filepath)j")
        .arg(&result_file)
        .arg("--newline")
        .arg(url.trim());

    let output = command
        .output()
        .map_err(|error| format!("Failed to start yt-dlp: {error}"))?;
    let mut downloaded = read_downloaded_paths(&result_file);
    let _ = fs::remove_file(&result_file);

    downloaded.retain(|path| path.is_file());
    downloaded.sort();
    downloaded.dedup();

    let warnings = output_warnings(&output);
    if !output.status.success() && downloaded.is_empty() {
        let details = output_details(&output);
        return Err(if details.is_empty() {
            format!("yt-dlp exited with status {}", output.status)
        } else {
            format!("yt-dlp could not complete the import:\n{details}")
        });
    }

    Ok(YoutubeImportResult {
        downloaded,
        library_path,
        warnings,
    })
}

fn validate_youtube_url(input: &str) -> Result<(), String> {
    let url = Url::parse(input.trim()).map_err(|_| "Enter a valid YouTube URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The YouTube URL must start with http:// or https://.".into());
    }

    let host = url
        .host_str()
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Enter a valid YouTube URL.".to_string())?;
    let is_youtube = host == "youtube.com"
        || host.ends_with(".youtube.com")
        || host == "youtu.be"
        || host.ends_with(".youtu.be");
    if !is_youtube {
        return Err("Only YouTube video and playlist URLs are supported.".into());
    }

    Ok(())
}

fn ensure_yt_dlp() -> Result<PathBuf, String> {
    let target = vendor_dir().join(yt_dlp_binary_name());
    if target.is_file() && yt_dlp_is_usable(&target) {
        return Ok(target);
    }
    if target.is_file() {
        fs::remove_file(&target).map_err(|error| {
            format!(
                "Nightingale's yt-dlp installation is damaged and could not be replaced: {error}"
            )
        })?;
    }

    let parent = target
        .parent()
        .ok_or_else(|| "Could not resolve Nightingale's vendor folder.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Failed to create vendor folder {}: {error}",
            parent.display()
        )
    })?;

    let temporary = target.with_extension("download");
    let response = ureq::get(yt_dlp_download_url()?)
        .call()
        .map_err(|error| format!("Failed to download yt-dlp: {error}"))?;
    let mut reader = response.into_body().into_reader();
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("Failed to create {}: {error}", temporary.display()))?;
    if let Err(error) = io::copy(&mut reader, &mut file) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Failed while downloading yt-dlp: {error}"));
    }
    drop(file);

    mark_executable(&temporary)?;
    fs::rename(&temporary, &target).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Failed to install yt-dlp at {}: {error}", target.display())
    })?;

    if !yt_dlp_is_usable(&target) {
        let _ = fs::remove_file(&target);
        return Err("The downloaded yt-dlp executable could not start and was removed.".into());
    }

    Ok(target)
}

fn yt_dlp_is_usable(path: &Path) -> bool {
    silent_command(path)
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

fn yt_dlp_binary_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn yt_dlp_download_url() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok(
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe",
        ),
        ("windows", "aarch64") => Ok(
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_arm64.exe",
        ),
        ("macos", _) => Ok(
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_macos",
        ),
        ("linux", "x86_64") => Ok(
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux",
        ),
        ("linux", "aarch64") => Ok(
            "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp_linux_aarch64",
        ),
        (os, arch) => Err(format!("yt-dlp is not available for {os}/{arch}.")),
    }
}

fn read_downloaded_paths(path: &Path) -> Vec<PathBuf> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };

    content
        .lines()
        .filter_map(|line| {
            serde_json::from_str::<String>(line)
                .ok()
                .or_else(|| (!line.trim().is_empty()).then(|| line.trim().to_string()))
        })
        .map(PathBuf::from)
        .collect()
}

fn output_warnings(output: &Output) -> Vec<String> {
    output_lines(output)
        .into_iter()
        .filter(|line| line.contains("WARNING:") || line.contains("ERROR:"))
        .take(12)
        .collect()
}

fn output_details(output: &Output) -> String {
    let lines = output_lines(output);
    let start = lines.len().saturating_sub(24);
    lines[start..].join("\n")
}

fn output_lines(output: &Output) -> Vec<String> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

fn silent_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn mark_executable(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Failed to mark yt-dlp executable: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_youtube_url;

    #[test]
    fn accepts_video_and_playlist_urls() {
        assert!(validate_youtube_url("https://youtu.be/meZPD28Y7xE").is_ok());
        assert!(validate_youtube_url("https://www.youtube.com/playlist?list=example").is_ok());
        assert!(validate_youtube_url("https://music.youtube.com/watch?v=example").is_ok());
    }

    #[test]
    fn rejects_non_youtube_urls() {
        assert!(validate_youtube_url("https://example.com/watch?v=example").is_err());
        assert!(validate_youtube_url("not a url").is_err());
    }
}
