use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::cache::vendor_dir;
use crate::config::{AppConfig, LibrarySource};
use crate::vendor::{ffmpeg_path, validate_ffmpeg};

const OUTPUT_TEMPLATE: &str = concat!(
    "%(artist,creator,uploader,channel|Unknown Artist).60B/",
    "%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s - ",
    "%(track,title|Unknown Title).100B/",
    "%(artist,creator,uploader,channel|Unknown Artist).30B - ",
    "%(track,title|Unknown Title).80B ",
    "(%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s) ",
    "[%(id)s].%(ext)s"
);

// WebKit playback needs compatible codecs, not just an .mp4 extension. Never
// fall back to an audio-only stream or an AV1/Opus file renamed to MP4.
const MP4_FORMAT: &str =
    "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a][acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][acodec^=mp4a]";

const TITLE_NOISE_PATTERN: &str = concat!(
    r"(?i)\s*(?:\(|\[)(?:official(?:\s+music)?\s+video|official\s+audio|",
    r"lyrics?|lyric\s+video|visualizer|full|hd|4k)[^)\]]*(?:\)|\])\s*$"
);

const EMBED_METADATA_RULES: &[&str] = &[
    "%(artist,creator,uploader,channel|Unknown Artist)s:%(meta_artist)s",
    "%(track,title|Unknown Title)s:%(meta_title)s",
    "%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s:%(meta_date)s",
    "%(album,playlist_title|)s:%(meta_album)s",
];

const YT_DLP_RELEASE_BASE: &str =
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download";
const MAX_CHECKSUM_BYTES: u64 = 64 * 1024;
static IMPORT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize)]
pub struct YoutubeImportResult {
    pub downloaded: Vec<PathBuf>,
    pub library_path: PathBuf,
    pub warnings: Vec<String>,
}

pub fn import_youtube(url: &str) -> Result<YoutubeImportResult, String> {
    let _import = IMPORT_LOCK.try_lock().map_err(|_| {
        "Another YouTube import is already running. Wait for it to finish.".to_string()
    })?;
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

    let ffmpeg = ffmpeg_path();
    validate_ffmpeg(&ffmpeg)?;
    let yt_dlp = ensure_yt_dlp()?;

    let data_path = config.effective_data_path();
    fs::create_dir_all(&data_path).map_err(|error| {
        format!(
            "Failed to create Nightingale data folder {}: {error}",
            data_path.display()
        )
    })?;

    let run_id = rand::random::<u64>();
    let result_file = data_path.join(format!("youtube-import-{run_id}.jsonl"));
    // The old archive could mark split/failed imports complete. Keep it for
    // recovery, but only use the new archive for completed MP4 downloads.
    let archive_file = data_path.join("youtube-mp4-download-archive.txt");
    let staging_path = data_path.join("youtube-staging");
    fs::create_dir_all(&staging_path)
        .map_err(|error| format!("Failed to create download staging folder: {error}"))?;

    let mut command = download_command(
        &yt_dlp,
        &ffmpeg,
        &library_path,
        &staging_path,
        &archive_file,
        &result_file,
        url,
    );
    let output = command
        .output()
        .map_err(|error| format!("Failed to start yt-dlp: {error}"))?;
    let mut downloaded = read_downloaded_paths(&result_file);
    let _ = fs::remove_file(&result_file);
    downloaded.sort();
    downloaded.dedup();

    let mut warnings = output_warnings(&output);
    let mut valid = Vec::new();
    let mut validation_failed = false;
    for path in downloaded {
        match validate_downloaded_mp4(&ffmpeg, &path) {
            Ok(()) => valid.push(path),
            Err(error) => {
                validation_failed = true;
                warnings.push(error);
            }
        }
    }
    if valid.is_empty() && (!output.status.success() || validation_failed) {
        let details = output_details(&output);
        return Err(format!(
            "No complete playable MP4 was imported.\n{}\n{details}",
            warnings.join("\n")
        ));
    }
    if !output.status.success() && !valid.is_empty() {
        warnings.push("Some videos could not be imported. Only completed MP4s were added.".into());
    }

    Ok(YoutubeImportResult {
        downloaded: valid,
        library_path,
        warnings,
    })
}

fn download_command(
    yt_dlp: &Path,
    ffmpeg: &Path,
    library: &Path,
    staging: &Path,
    archive: &Path,
    results: &Path,
    url: &str,
) -> Command {
    let mut command = silent_command(yt_dlp);
    if let Some(node) = supported_node_runtime() {
        // GUI launches do not inherit Homebrew's PATH. Enable the installed
        // runtime explicitly so yt-dlp can solve YouTube's JS challenges.
        command
            .arg("--js-runtimes")
            .arg(format!("node:{}", node.display()));
    }
    command
        .arg("--ignore-config")
        // A watch URL with list=RD... is one video, not an accidental radio mix.
        // Explicit /playlist URLs still import the playlist.
        .arg("--no-playlist")
        .arg("--abort-on-error")
        .arg("--continue")
        .arg("--no-overwrites")
        .arg("--no-restrict-filenames")
        .arg("--windows-filenames")
        .args(["--encoding", "utf-8"])
        .arg("--download-archive")
        .arg(archive)
        .arg("--ffmpeg-location")
        .arg(ffmpeg)
        .arg("--format")
        .arg(MP4_FORMAT)
        .arg("--merge-output-format")
        .arg("mp4")
        .args(["--remux-video", "mp4"])
        // Output MUST be relative: absolute templates bypass --paths temp and
        // expose half-finished video/audio streams to the library scanner.
        .arg("--paths")
        .arg(format!("home:{}", library.display()))
        .arg("--paths")
        .arg(format!("temp:{}", staging.display()))
        .arg("--output")
        .arg(OUTPUT_TEMPLATE)
        .args([
            "--socket-timeout",
            "30",
            "--retries",
            "3",
            "--fragment-retries",
            "3",
        ])
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
        .arg("");
    for rule in EMBED_METADATA_RULES {
        command.arg("--parse-metadata").arg(rule);
    }
    command
        .arg("--print-to-file")
        .arg("after_move:%(filepath)j")
        .arg(results)
        .arg("--newline")
        .arg(url.trim());

    command
}

fn supported_node_runtime() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut candidates = vec![vendor_dir().join(name)];
    if cfg!(target_os = "macos") {
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ]);
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    candidates.into_iter().find(|path| {
        path.is_file()
            && silent_command(path)
                .arg("--version")
                .output()
                .is_ok_and(|output| {
                    output.status.success()
                        && supported_node_version(&String::from_utf8_lossy(&output.stdout))
                })
    })
}

fn supported_node_version(version: &str) -> bool {
    version
        .trim()
        .strip_prefix('v')
        .and_then(|v| v.split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 22)
}

fn validate_downloaded_mp4(ffmpeg: &Path, path: &Path) -> Result<(), String> {
    if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("mp4") {
        return Err(format!("The completed MP4 is missing: {}", path.display()));
    }
    // Decode a short sample and require BOTH streams. A file extension or a
    // successful downloader exit alone does not prove a playable karaoke file.
    let output = silent_command(ffmpeg)
        .args(["-nostdin", "-v", "error", "-xerror", "-i"])
        .arg(path)
        .args([
            "-map", "0:v:0", "-map", "0:a:0", "-t", "0.1", "-f", "null", "-",
        ])
        .output()
        .map_err(|error| format!("Could not validate downloaded MP4: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Downloaded MP4 does not contain decodable video and audio: {}\n{}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
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
    let checksum_path = yt_dlp_checksum_path(&target);
    if target.is_file()
        && checksum_path.is_file()
        && checksum_file_matches(&target, &checksum_path)?
        && yt_dlp_is_usable(&target)
    {
        return Ok(target);
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
    let expected = download_verified_yt_dlp(&temporary)?;
    if let Err(error) = mark_executable(&temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if !yt_dlp_is_usable(&temporary) {
        let _ = fs::remove_file(&temporary);
        return Err("The downloaded yt-dlp executable could not start and was removed.".into());
    }
    install_verified_yt_dlp(&temporary, &target, &checksum_path, &expected)?;

    Ok(target)
}

fn download_verified_yt_dlp(destination: &Path) -> Result<String, String> {
    let asset_name = yt_dlp_asset_name()?;
    let url = yt_dlp_download_url()?;
    let mut mismatch = None;

    // The `latest` release alias can move between the checksum and binary requests.
    // Retry once so a release published mid-download does not become a false failure.
    for _ in 0..2 {
        let expected = download_expected_checksum(asset_name)?;
        let actual = match download_file_sha256(&url, destination) {
            Ok(actual) => actual,
            Err(error) => {
                let _ = fs::remove_file(destination);
                return Err(error);
            }
        };
        if actual == expected {
            return Ok(expected);
        }
        mismatch = Some((expected, actual));
        let _ = fs::remove_file(destination);
    }

    let (expected, actual) = mismatch.expect("the verification loop always runs");
    Err(format!(
        "Downloaded yt-dlp failed its SHA-256 integrity check (expected {expected}, got {actual})"
    ))
}

fn install_verified_yt_dlp(
    temporary: &Path,
    target: &Path,
    checksum_path: &Path,
    expected: &str,
) -> Result<(), String> {
    let staged_checksum = checksum_path.with_extension("sha256.download");
    let backup = target.with_extension("previous");
    let checksum_backup = checksum_path.with_extension("sha256.previous");

    for stale in [&staged_checksum, &backup, &checksum_backup] {
        let _ = fs::remove_file(stale);
    }
    if let Err(error) = fs::write(&staged_checksum, format!("{expected}\n")) {
        let _ = fs::remove_file(temporary);
        return Err(format!(
            "Failed to stage yt-dlp integrity metadata at {}: {error}",
            staged_checksum.display()
        ));
    }

    if target.is_file() {
        fs::rename(target, &backup).map_err(|error| {
            let _ = fs::remove_file(temporary);
            let _ = fs::remove_file(&staged_checksum);
            format!("Nightingale's existing yt-dlp installation could not be replaced: {error}")
        })?;
    }
    if checksum_path.is_file()
        && let Err(error) = fs::rename(checksum_path, &checksum_backup)
    {
        let _ = restore_file(&backup, target);
        let _ = fs::remove_file(temporary);
        let _ = fs::remove_file(&staged_checksum);
        return Err(format!(
            "Nightingale's yt-dlp integrity metadata could not be replaced: {error}"
        ));
    }

    let install_result =
        fs::rename(temporary, target).and_then(|_| fs::rename(&staged_checksum, checksum_path));
    if let Err(error) = install_result {
        let _ = fs::remove_file(target);
        let _ = fs::remove_file(checksum_path);
        let _ = restore_file(&backup, target);
        let _ = restore_file(&checksum_backup, checksum_path);
        let _ = fs::remove_file(temporary);
        let _ = fs::remove_file(&staged_checksum);
        return Err(format!(
            "Failed to install verified yt-dlp at {}: {error}",
            target.display()
        ));
    }

    let _ = fs::remove_file(backup);
    let _ = fs::remove_file(checksum_backup);
    Ok(())
}

fn restore_file(backup: &Path, target: &Path) -> std::io::Result<()> {
    if backup.is_file() {
        fs::rename(backup, target)?;
    }
    Ok(())
}

fn yt_dlp_checksum_path(binary_path: &Path) -> PathBuf {
    binary_path.with_extension("sha256")
}

fn checksum_file_matches(binary_path: &Path, checksum_path: &Path) -> Result<bool, String> {
    let expected = fs::read_to_string(checksum_path)
        .map_err(|error| format!("Failed to read yt-dlp integrity metadata: {error}"))?;
    let expected = expected.trim().to_ascii_lowercase();
    if !is_sha256(&expected) {
        return Ok(false);
    }
    Ok(sha256_file(binary_path)? == expected)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| {
        format!(
            "Failed to open {} for verification: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to verify {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn download_file_sha256(url: &str, destination: &Path) -> Result<String, String> {
    let response = ureq::get(url)
        .header("User-Agent", "Nightingale/1.0")
        .call()
        .map_err(|error| format!("Failed to download yt-dlp: {error}"))?;
    let mut reader = response.into_body().into_reader();
    let mut file = fs::File::create(destination)
        .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed while downloading yt-dlp: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Failed while saving yt-dlp: {error}"))?;
        hasher.update(&buffer[..read]);
    }
    file.sync_all()
        .map_err(|error| format!("Failed to flush yt-dlp to disk: {error}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn download_expected_checksum(asset_name: &str) -> Result<String, String> {
    let response = ureq::get(&format!("{YT_DLP_RELEASE_BASE}/SHA2-256SUMS"))
        .header("User-Agent", "Nightingale/1.0")
        .call()
        .map_err(|error| format!("Failed to download yt-dlp checksums: {error}"))?;
    let mut reader = response
        .into_body()
        .into_reader()
        .take(MAX_CHECKSUM_BYTES + 1);
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read yt-dlp checksums: {error}"))?;
    if bytes.len() as u64 > MAX_CHECKSUM_BYTES {
        return Err("The yt-dlp checksum file was unexpectedly large".into());
    }
    let checksums = String::from_utf8(bytes)
        .map_err(|_| "The yt-dlp checksum file was not valid UTF-8".to_string())?;
    parse_expected_checksum(&checksums, asset_name)
        .ok_or_else(|| format!("The yt-dlp checksum file did not contain {asset_name}"))
}

fn parse_expected_checksum(checksums: &str, asset_name: &str) -> Option<String> {
    checksums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let digest = fields.next()?;
        let filename = fields.next()?.trim_start_matches('*');
        (filename == asset_name && fields.next().is_none() && is_sha256(digest))
            .then(|| digest.to_ascii_lowercase())
    })
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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

fn yt_dlp_asset_name_for(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("windows", "x86_64") => Ok("yt-dlp.exe"),
        ("windows", "aarch64") => Ok("yt-dlp_arm64.exe"),
        ("macos", _) => Ok("yt-dlp_macos"),
        ("linux", "x86_64") => Ok("yt-dlp_linux"),
        ("linux", "aarch64") => Ok("yt-dlp_linux_aarch64"),
        (os, arch) => Err(format!("yt-dlp is not available for {os}/{arch}.")),
    }
}

fn yt_dlp_asset_name() -> Result<&'static str, String> {
    yt_dlp_asset_name_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn yt_dlp_download_url() -> Result<String, String> {
    Ok(format!("{YT_DLP_RELEASE_BASE}/{}", yt_dlp_asset_name()?))
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
    use super::{
        EMBED_METADATA_RULES, MP4_FORMAT, OUTPUT_TEMPLATE, checksum_file_matches, download_command,
        download_verified_yt_dlp, install_verified_yt_dlp, parse_expected_checksum, sha256_file,
        validate_youtube_url, yt_dlp_asset_name_for,
    };
    use std::path::Path;

    #[test]
    fn youtube_runtime_requires_node_22_or_newer() {
        assert!(super::supported_node_version("v22.0.0\n"));
        assert!(super::supported_node_version("v26.7.0"));
        assert!(!super::supported_node_version("v20.19.0"));
        assert!(!super::supported_node_version("not a version"));
    }

    #[test]
    fn download_requires_compatible_mp4_and_keeps_fragments_outside_library() {
        let command = download_command(
            Path::new("yt-dlp"),
            Path::new("ffmpeg"),
            Path::new("/library"),
            Path::new("/data/staging"),
            Path::new("/data/archive"),
            Path::new("/data/results"),
            "https://youtube.com/watch?v=video&list=RDvideo",
        );
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy())
            .collect();
        assert!(args.iter().any(|arg| arg == "--no-playlist"));
        assert!(args.iter().any(|arg| arg == "--abort-on-error"));
        assert!(args.iter().any(|arg| arg == "--ignore-config"));
        assert!(
            !args
                .iter()
                .any(|arg| arg == "--yes-playlist" || arg == "--ignore-errors")
        );
        assert!(args.windows(2).any(|pair| pair == ["--format", MP4_FORMAT]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--merge-output-format", "mp4"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--paths", "home:/library"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--paths", "temp:/data/staging"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--output", OUTPUT_TEMPLATE])
        );
        assert!(!Path::new(OUTPUT_TEMPLATE).is_absolute());
        // Byte limits leave room for the complete ID, extension and sidecars.
        assert!(OUTPUT_TEMPLATE.contains("[%(id)s].%(ext)s"));
        assert!(!args.iter().any(|arg| arg == "--trim-filenames"));
    }

    #[test]
    #[ignore = "explicit opt-in: downloads NIGHTINGALE_TEST_YOUTUBE_URL into the configured library"]
    fn imports_requested_video_into_configured_library() {
        let url =
            std::env::var("NIGHTINGALE_TEST_YOUTUBE_URL").expect("provide a single video URL");
        let result = super::import_youtube(&url).unwrap();
        assert_eq!(result.downloaded.len(), 1, "expected one completed MP4");
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    }

    #[test]
    #[ignore = "requires a working NIGHTINGALE_TEST_FFMPEG executable"]
    fn mp4_validation_requires_audio_and_video() {
        let ffmpeg = std::env::var("NIGHTINGALE_TEST_FFMPEG").expect("provide ffmpeg path");
        let root = std::env::temp_dir().join(format!(
            "nightingale-mp4-validation-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        for (name, audio) in [("complete.mp4", true), ("silent.mp4", false)] {
            let path = root.join(name);
            let mut command = super::silent_command(Path::new(&ffmpeg));
            command.args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=size=64x64:rate=10",
            ]);
            if audio {
                command.args([
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=44100",
                    "-c:a",
                    "aac",
                ]);
            }
            let status = command
                .args(["-t", "0.2", "-c:v", "libx264"])
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success());
            assert_eq!(
                super::validate_downloaded_mp4(Path::new(&ffmpeg), &path).is_ok(),
                audio
            );
        }
        assert!(
            super::validate_downloaded_mp4(Path::new(&ffmpeg), &root.join("missing.mp4")).is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

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

    #[test]
    fn maps_normalized_song_fields_into_embedded_media_tags() {
        assert_eq!(
            EMBED_METADATA_RULES,
            [
                "%(artist,creator,uploader,channel|Unknown Artist)s:%(meta_artist)s",
                "%(track,title|Unknown Title)s:%(meta_title)s",
                "%(release_year,release_date>%Y,upload_date>%Y|Unknown Year)s:%(meta_date)s",
                "%(album,playlist_title|)s:%(meta_album)s",
            ]
        );
    }

    #[test]
    fn parses_only_the_requested_official_checksum_entry() {
        let checksums = concat!(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp\n",
            "BBF2DEADBEEF0000000000000000000000000000000000000000000000000000 *yt-dlp.exe\n",
        );
        assert_eq!(
            parse_expected_checksum(checksums, "yt-dlp.exe").as_deref(),
            Some("bbf2deadbeef0000000000000000000000000000000000000000000000000000")
        );
        assert_eq!(parse_expected_checksum(checksums, "missing"), None);
        assert_eq!(
            parse_expected_checksum("not-a-digest  yt-dlp.exe", "yt-dlp.exe"),
            None
        );
    }

    #[test]
    fn selects_the_packaged_asset_for_each_supported_platform() {
        assert_eq!(
            yt_dlp_asset_name_for("windows", "x86_64").unwrap(),
            "yt-dlp.exe"
        );
        assert_eq!(
            yt_dlp_asset_name_for("windows", "aarch64").unwrap(),
            "yt-dlp_arm64.exe"
        );
        assert_eq!(
            yt_dlp_asset_name_for("macos", "aarch64").unwrap(),
            "yt-dlp_macos"
        );
        assert_eq!(
            yt_dlp_asset_name_for("linux", "x86_64").unwrap(),
            "yt-dlp_linux"
        );
        assert_eq!(
            yt_dlp_asset_name_for("linux", "aarch64").unwrap(),
            "yt-dlp_linux_aarch64"
        );
        assert!(yt_dlp_asset_name_for("freebsd", "x86_64").is_err());
    }

    #[test]
    fn verifies_cached_binaries_against_their_saved_digest() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-ytdlp-integrity-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("yt-dlp.exe");
        let checksum = root.join("yt-dlp.sha256");
        std::fs::write(&binary, b"nightingale").unwrap();
        let digest = sha256_file(&binary).unwrap();
        std::fs::write(&checksum, format!("{digest}\n")).unwrap();

        assert!(checksum_file_matches(&binary, &checksum).unwrap());
        std::fs::write(&binary, b"changed").unwrap();
        assert!(!checksum_file_matches(&binary, &checksum).unwrap());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replaces_a_cached_binary_and_its_digest_as_one_install() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-ytdlp-install-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("yt-dlp.exe");
        let checksum = root.join("yt-dlp.sha256");
        let temporary = root.join("yt-dlp.download");
        std::fs::write(&target, b"old binary").unwrap();
        std::fs::write(&checksum, "old digest\n").unwrap();
        std::fs::write(&temporary, b"verified binary").unwrap();
        let digest = sha256_file(&temporary).unwrap();

        install_verified_yt_dlp(&temporary, &target, &checksum, &digest).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"verified binary");
        assert_eq!(
            std::fs::read_to_string(&checksum).unwrap(),
            format!("{digest}\n")
        );
        assert!(!root.join("yt-dlp.previous").exists());
        assert!(!root.join("yt-dlp.sha256.previous").exists());
        assert!(!temporary.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "downloads the current official yt-dlp nightly binary"]
    fn verifies_the_current_official_binary_over_the_network() {
        let destination = std::env::temp_dir().join(format!(
            "nightingale-ytdlp-network-{}",
            rand::random::<u64>()
        ));
        let expected = download_verified_yt_dlp(&destination).unwrap();
        assert_eq!(sha256_file(&destination).unwrap(), expected);
        std::fs::remove_file(destination).unwrap();
    }
}
