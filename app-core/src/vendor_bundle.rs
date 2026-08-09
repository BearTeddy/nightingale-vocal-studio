use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const OFFLINE_VENDOR_ARCHIVE: &str = "vendor.tar.zst";
pub const OFFLINE_VENDOR_MANIFEST: &str = "manifest.json";
pub const OFFLINE_MODELS_ARCHIVE: &str = "models.tar.zst";
const OFFLINE_VENDOR_FORMAT_VERSION: u32 = 2;
const OFFLINE_VENDOR_PART_BYTES: u64 = 950_000_000;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OfflinePayloadKind {
    #[default]
    Vendor,
    Models,
}

impl OfflinePayloadKind {
    fn archive_name(self) -> &'static str {
        match self {
            Self::Vendor => OFFLINE_VENDOR_ARCHIVE,
            Self::Models => OFFLINE_MODELS_ARCHIVE,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Vendor => "vendor",
            Self::Models => "models",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OfflineVendorBundle {
    pub archives: Vec<PathBuf>,
    pub manifest: PathBuf,
}

impl OfflineVendorBundle {
    pub fn from_directory(root: impl AsRef<Path>) -> Option<Self> {
        let root = root.as_ref();
        let manifest_path = root.join(OFFLINE_VENDOR_MANIFEST);
        let manifest: OfflineVendorManifest =
            serde_json::from_slice(&std::fs::read(&manifest_path).ok()?).ok()?;
        let archive_names = if manifest.parts.is_empty() {
            vec![manifest.archive.clone()]
        } else {
            manifest
                .parts
                .iter()
                .map(|part| part.file.clone())
                .collect()
        };
        let archives = archive_names
            .into_iter()
            .map(|name| root.join(name))
            .collect::<Vec<_>>();
        archives.iter().all(|path| path.is_file()).then_some(Self {
            archives,
            manifest: manifest_path,
        })
    }

    pub fn from_resource_root(root: impl AsRef<Path>) -> Option<Self> {
        Self::from_directory(root.as_ref().join("offline-vendor"))
    }
}

#[derive(Debug, Clone)]
pub struct OfflineModelBundle {
    pub archives: Vec<PathBuf>,
    pub manifest: PathBuf,
}

impl OfflineModelBundle {
    pub fn from_directory(root: impl AsRef<Path>) -> Option<Self> {
        OfflineVendorBundle::from_directory(root).map(|bundle| Self {
            archives: bundle.archives,
            manifest: bundle.manifest,
        })
    }

    pub fn from_resource_root(root: impl AsRef<Path>) -> Option<Self> {
        Self::from_directory(root.as_ref().join("offline-models"))
    }

    fn as_payload_bundle(&self) -> OfflineVendorBundle {
        OfflineVendorBundle {
            archives: self.archives.clone(),
            manifest: self.manifest.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfflineVendorManifest {
    pub format_version: u32,
    #[serde(default)]
    pub payload_kind: OfflinePayloadKind,
    pub app_version: String,
    pub platform: String,
    pub architecture: String,
    pub archive: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub uncompressed_bytes: u64,
    pub file_count: u64,
    #[serde(default)]
    pub parts: Vec<OfflineVendorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OfflineVendorPart {
    pub file: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct StagedOfflineVendor {
    pub archives: Vec<PathBuf>,
    pub manifest: PathBuf,
    pub metadata: OfflineVendorManifest,
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path)
        .map_err(|error| format!("Could not open {} for hashing: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not hash {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn remove_old_archive_parts(output_root: &Path, archive_name: &str) -> Result<(), String> {
    let entries = std::fs::read_dir(output_root)
        .map_err(|error| format!("Could not inspect {}: {error}", output_root.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(&format!("{archive_name}.part")) {
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("Could not remove old archive part {name}: {error}"))?;
        }
    }
    Ok(())
}

fn split_archive(
    archive: &Path,
    output_root: &Path,
    archive_name: &str,
) -> Result<(Vec<PathBuf>, Vec<OfflineVendorPart>), String> {
    remove_old_archive_parts(output_root, archive_name)?;
    let mut source = BufReader::with_capacity(
        8 * 1024 * 1024,
        File::open(archive)
            .map_err(|error| format!("Could not open {}: {error}", archive.display()))?,
    );
    let mut paths = Vec::new();
    let mut parts = Vec::new();
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    let mut part_index = 1u32;

    loop {
        let file_name = format!("{archive_name}.part{part_index:03}");
        let final_path = output_root.join(&file_name);
        let partial_path = output_root.join(format!("{file_name}.partial"));
        let _ = std::fs::remove_file(&partial_path);
        let file = File::create(&partial_path)
            .map_err(|error| format!("Could not create {}: {error}", partial_path.display()))?;
        let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
        let mut digest = Sha256::new();
        let mut written = 0u64;
        while written < OFFLINE_VENDOR_PART_BYTES {
            let remaining = (OFFLINE_VENDOR_PART_BYTES - written) as usize;
            let read_len = buffer.len().min(remaining);
            let read = source
                .read(&mut buffer[..read_len])
                .map_err(|error| format!("Could not split {}: {error}", archive.display()))?;
            if read == 0 {
                break;
            }
            writer
                .write_all(&buffer[..read])
                .map_err(|error| format!("Could not write {file_name}: {error}"))?;
            digest.update(&buffer[..read]);
            written += read as u64;
        }
        writer
            .flush()
            .map_err(|error| format!("Could not finish {file_name}: {error}"))?;
        drop(writer);

        if written == 0 {
            let _ = std::fs::remove_file(&partial_path);
            break;
        }
        if final_path.exists() {
            std::fs::remove_file(&final_path)
                .map_err(|error| format!("Could not replace {file_name}: {error}"))?;
        }
        std::fs::rename(&partial_path, &final_path)
            .map_err(|error| format!("Could not finalize {file_name}: {error}"))?;
        paths.push(final_path);
        parts.push(OfflineVendorPart {
            file: file_name,
            sha256: format!("{:x}", digest.finalize()),
            bytes: written,
        });
        part_index += 1;
        if written < OFFLINE_VENDOR_PART_BYTES {
            break;
        }
    }

    if parts.is_empty() {
        return Err("Offline payload archive is empty".to_string());
    }
    Ok((paths, parts))
}

fn archive_mode(path: &Path, metadata: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode();
    }

    #[cfg(not(unix))]
    {
        if metadata.is_dir()
            || path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            0o755
        } else {
            0o644
        }
    }
}

fn excluded_vendor_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name) if name == "__pycache__")
    }) || path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pyc") || extension.eq_ignore_ascii_case("pyo"))
        || path.components().next().is_some_and(
            |component| matches!(component, Component::Normal(name) if name.to_string_lossy().starts_with("_tmp_")),
        )
}

fn excluded_model_path(path: &Path) -> bool {
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>();
    components.iter().any(|component| component == ".locks")
        || components
            .windows(3)
            .any(|parts| parts[0] == "huggingface" && parts[1] == "xet" && parts[2] == "logs")
        || path.extension().is_some_and(|extension| {
            extension.eq_ignore_ascii_case("lock")
                || extension.eq_ignore_ascii_case("incomplete")
                || extension.eq_ignore_ascii_case("tmp")
        })
        || path
            .file_name()
            .is_some_and(|name| name == ".agent_harnesses.json")
}

fn excluded_payload_path(path: &Path, kind: OfflinePayloadKind) -> bool {
    match kind {
        OfflinePayloadKind::Vendor => excluded_vendor_path(path),
        OfflinePayloadKind::Models => excluded_model_path(path),
    }
}

fn append_payload_entry(
    archive: &mut tar::Builder<zstd::Encoder<'static, BufWriter<File>>>,
    source: &Path,
    relative: &Path,
) -> Result<(u64, u64), String> {
    let metadata = std::fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?;
    let mut header = tar::Header::new_gnu();
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_mode(archive_mode(source, &metadata));

    if metadata.file_type().is_symlink() {
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        let target = std::fs::read_link(source)
            .map_err(|error| format!("Could not read link {}: {error}", source.display()))?;
        header
            .set_link_name(&target)
            .map_err(|error| format!("Could not archive link {}: {error}", source.display()))?;
        header.set_cksum();
        archive
            .append_data(&mut header, relative, std::io::empty())
            .map_err(|error| format!("Could not archive {}: {error}", source.display()))?;
        return Ok((1, 0));
    }

    if metadata.is_dir() {
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_cksum();
        archive
            .append_data(&mut header, relative, std::io::empty())
            .map_err(|error| format!("Could not archive {}: {error}", source.display()))?;
        return Ok((0, 0));
    }

    if !metadata.is_file() {
        return Ok((0, 0));
    }

    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(metadata.len());
    header.set_cksum();
    let mut file = File::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?;
    archive
        .append_data(&mut header, relative, &mut file)
        .map_err(|error| format!("Could not archive {}: {error}", source.display()))?;
    Ok((1, metadata.len()))
}

fn stage_offline_payload_bundle(
    payload_root: impl AsRef<Path>,
    output_root: impl AsRef<Path>,
    kind: OfflinePayloadKind,
) -> Result<StagedOfflineVendor, String> {
    let payload_root = payload_root.as_ref();
    validate_payload_layout(payload_root, kind)?;
    let output_root = output_root.as_ref();
    std::fs::create_dir_all(output_root).map_err(|error| {
        format!(
            "Could not create offline bundle folder {}: {error}",
            output_root.display()
        )
    })?;

    let archive_name = kind.archive_name();
    let archive_path = output_root.join(archive_name);
    let partial_path = output_root.join(format!("{archive_name}.partial"));
    let _ = std::fs::remove_file(&partial_path);
    let result = (|| {
        let file = File::create(&partial_path).map_err(|error| {
            format!(
                "Could not create offline archive {}: {error}",
                partial_path.display()
            )
        })?;
        let writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
        let mut encoder = zstd::Encoder::new(writer, 3)
            .map_err(|error| format!("Could not start zstd compression: {error}"))?;
        let workers = std::thread::available_parallelism()
            .map(|parallelism| parallelism.get())
            .unwrap_or(2)
            .clamp(1, 4) as u32;
        encoder
            .multithread(workers)
            .map_err(|error| format!("Could not enable parallel zstd compression: {error}"))?;
        encoder
            .include_checksum(true)
            .map_err(|error| format!("Could not configure zstd compression: {error}"))?;
        let mut archive = tar::Builder::new(encoder);
        let mut entries = walkdir::WalkDir::new(payload_root)
            .follow_links(false)
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not scan {}: {error}", payload_root.display()))?;
        entries.sort_by(|left, right| left.path().cmp(right.path()));

        let mut file_count = 0u64;
        let mut uncompressed_bytes = 0u64;
        for entry in entries.into_iter().skip(1) {
            let relative = entry.path().strip_prefix(payload_root).map_err(|error| {
                format!("Could not relativize {}: {error}", entry.path().display())
            })?;
            if excluded_payload_path(relative, kind) {
                continue;
            }
            let (files, bytes) = append_payload_entry(&mut archive, entry.path(), relative)?;
            file_count += files;
            uncompressed_bytes += bytes;
        }

        let encoder = archive
            .into_inner()
            .map_err(|error| format!("Could not finish offline tar archive: {error}"))?;
        encoder
            .finish()
            .map_err(|error| format!("Could not finish offline compression: {error}"))?;

        Ok::<_, String>((file_count, uncompressed_bytes))
    })();

    let (file_count, uncompressed_bytes) = match result {
        Ok(summary) => summary,
        Err(error) => {
            let _ = std::fs::remove_file(&partial_path);
            return Err(error);
        }
    };
    if archive_path.exists() {
        std::fs::remove_file(&archive_path).map_err(|error| {
            format!(
                "Could not replace offline archive {}: {error}",
                archive_path.display()
            )
        })?;
    }
    std::fs::rename(&partial_path, &archive_path).map_err(|error| {
        format!(
            "Could not finalize offline archive {}: {error}",
            archive_path.display()
        )
    })?;

    let archive_bytes = archive_path
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", archive_path.display()))?
        .len();
    let archive_sha256 = sha256_file(&archive_path)?;
    let (archives, parts) = split_archive(&archive_path, output_root, archive_name)?;
    let metadata = OfflineVendorManifest {
        format_version: OFFLINE_VENDOR_FORMAT_VERSION,
        payload_kind: kind,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        architecture: std::env::consts::ARCH.to_string(),
        archive: archive_name.to_string(),
        archive_sha256,
        archive_bytes,
        uncompressed_bytes,
        file_count,
        parts,
    };
    let manifest_path = output_root.join(OFFLINE_VENDOR_MANIFEST);
    let manifest_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Could not serialize offline manifest: {error}"))?;
    std::fs::write(&manifest_path, manifest_json).map_err(|error| {
        format!(
            "Could not write offline manifest {}: {error}",
            manifest_path.display()
        )
    })?;
    std::fs::remove_file(&archive_path).map_err(|error| {
        format!(
            "Could not remove completed monolithic archive {}: {error}",
            archive_path.display()
        )
    })?;

    Ok(StagedOfflineVendor {
        archives,
        manifest: manifest_path,
        metadata,
    })
}

pub fn stage_offline_vendor_bundle(
    vendor_root: impl AsRef<Path>,
    output_root: impl AsRef<Path>,
) -> Result<StagedOfflineVendor, String> {
    stage_offline_payload_bundle(vendor_root, output_root, OfflinePayloadKind::Vendor)
}

pub fn stage_offline_model_bundle(
    models_root: impl AsRef<Path>,
    output_root: impl AsRef<Path>,
) -> Result<StagedOfflineVendor, String> {
    stage_offline_payload_bundle(models_root, output_root, OfflinePayloadKind::Models)
}

fn read_and_verify_manifest(
    bundle: &OfflineVendorBundle,
    expected_kind: OfflinePayloadKind,
) -> Result<OfflineVendorManifest, String> {
    let bytes = std::fs::read(&bundle.manifest).map_err(|error| {
        format!(
            "Could not read offline manifest {}: {error}",
            bundle.manifest.display()
        )
    })?;
    let manifest: OfflineVendorManifest = serde_json::from_slice(&bytes).map_err(|error| {
        format!(
            "Offline {} manifest is invalid: {error}",
            expected_kind.label()
        )
    })?;
    if manifest.format_version != 1 && manifest.format_version != OFFLINE_VENDOR_FORMAT_VERSION {
        return Err(format!(
            "Offline {} format {} is unsupported",
            expected_kind.label(),
            manifest.format_version
        ));
    }
    if manifest.app_version != env!("CARGO_PKG_VERSION") {
        return Err(format!(
            "Offline {} payload is for Nightingale {}, not {}",
            expected_kind.label(),
            manifest.app_version,
            env!("CARGO_PKG_VERSION")
        ));
    }
    if manifest.platform != std::env::consts::OS || manifest.architecture != std::env::consts::ARCH
    {
        return Err(format!(
            "Offline {} payload is for {}-{}, not {}-{}",
            expected_kind.label(),
            manifest.platform,
            manifest.architecture,
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }
    if manifest.payload_kind != expected_kind {
        return Err(format!(
            "Offline payload contains {}, not {}",
            manifest.payload_kind.label(),
            expected_kind.label()
        ));
    }
    if manifest.archive != expected_kind.archive_name() {
        return Err(format!(
            "Offline {} archive name is invalid",
            expected_kind.label()
        ));
    }
    if manifest.parts.is_empty() {
        if bundle.archives.len() != 1 {
            return Err(format!(
                "Offline {} monolithic archive is missing",
                expected_kind.label()
            ));
        }
        let archive = &bundle.archives[0];
        let archive_bytes = archive
            .metadata()
            .map_err(|error| {
                format!(
                    "Could not inspect offline archive {}: {error}",
                    archive.display()
                )
            })?
            .len();
        if archive_bytes != manifest.archive_bytes {
            return Err(format!(
                "Offline {} archive size does not match its manifest",
                expected_kind.label()
            ));
        }
        let digest = sha256_file(archive)?;
        if !digest.eq_ignore_ascii_case(&manifest.archive_sha256) {
            return Err(format!(
                "Offline {} archive checksum does not match its manifest",
                expected_kind.label()
            ));
        }
        return Ok(manifest);
    }

    if manifest.format_version != OFFLINE_VENDOR_FORMAT_VERSION
        || bundle.archives.len() != manifest.parts.len()
    {
        return Err(format!(
            "Offline {} multipart manifest is incomplete",
            expected_kind.label()
        ));
    }
    let mut total_bytes = 0u64;
    for (part, path) in manifest.parts.iter().zip(&bundle.archives) {
        let part_path = Path::new(&part.file);
        if part_path.components().count() != 1
            || !matches!(part_path.components().next(), Some(Component::Normal(_)))
            || path.file_name() != part_path.file_name()
        {
            return Err(format!(
                "Offline {} part name is invalid: {}",
                expected_kind.label(),
                part.file
            ));
        }
        let bytes = path
            .metadata()
            .map_err(|error| format!("Could not inspect offline part {}: {error}", path.display()))?
            .len();
        if bytes != part.bytes {
            return Err(format!(
                "Offline {} part {} size does not match its manifest",
                expected_kind.label(),
                part.file
            ));
        }
        let digest = sha256_file(path)?;
        if !digest.eq_ignore_ascii_case(&part.sha256) {
            return Err(format!(
                "Offline {} part {} checksum does not match its manifest",
                expected_kind.label(),
                part.file
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes);
    }
    if total_bytes != manifest.archive_bytes {
        return Err(format!(
            "Offline {} parts do not match the total archive size",
            expected_kind.label()
        ));
    }
    Ok(manifest)
}

struct MultipartReader {
    paths: std::vec::IntoIter<PathBuf>,
    current: Option<BufReader<File>>,
}

impl MultipartReader {
    fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            paths: paths.into_iter(),
            current: None,
        }
    }
}

impl Read for MultipartReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if let Some(current) = self.current.as_mut() {
                let read = current.read(buffer)?;
                if read > 0 {
                    return Ok(read);
                }
                self.current = None;
            }
            let Some(path) = self.paths.next() else {
                return Ok(0);
            };
            self.current = Some(BufReader::with_capacity(8 * 1024 * 1024, File::open(path)?));
        }
    }
}

pub fn split_existing_offline_vendor_bundle(
    root: impl AsRef<Path>,
) -> Result<StagedOfflineVendor, String> {
    let root = root.as_ref();
    let bundle = OfflineVendorBundle::from_directory(root)
        .ok_or_else(|| format!("Offline bundle is incomplete in {}", root.display()))?;
    let mut metadata = read_and_verify_manifest(&bundle, OfflinePayloadKind::Vendor)?;
    if !metadata.parts.is_empty() {
        return Ok(StagedOfflineVendor {
            archives: bundle.archives,
            manifest: bundle.manifest,
            metadata,
        });
    }
    let archive = bundle
        .archives
        .first()
        .ok_or_else(|| "Offline vendor archive is missing".to_string())?;
    let (archives, parts) = split_archive(archive, root, OFFLINE_VENDOR_ARCHIVE)?;
    metadata.format_version = OFFLINE_VENDOR_FORMAT_VERSION;
    metadata.parts = parts;
    let manifest_json = serde_json::to_vec_pretty(&metadata)
        .map_err(|error| format!("Could not serialize offline manifest: {error}"))?;
    std::fs::write(&bundle.manifest, manifest_json).map_err(|error| {
        format!(
            "Could not update offline manifest {}: {error}",
            bundle.manifest.display()
        )
    })?;
    std::fs::remove_file(archive)
        .map_err(|error| format!("Could not remove {}: {error}", archive.display()))?;
    Ok(StagedOfflineVendor {
        archives,
        manifest: bundle.manifest,
        metadata,
    })
}

fn python_in(root: &Path) -> PathBuf {
    if cfg!(windows) {
        root.join("venv").join("Scripts").join("python.exe")
    } else {
        root.join("venv").join("bin").join("python")
    }
}

fn ffmpeg_in(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    })
}

fn uv_in(root: &Path) -> PathBuf {
    root.join(if cfg!(windows) { "uv.exe" } else { "uv" })
}

fn validate_vendor_layout(root: &Path) -> Result<(), String> {
    let required = [
        root.join(".ready"),
        ffmpeg_in(root),
        uv_in(root),
        python_in(root),
        root.join("analyzer").join("analyze.py"),
        root.join("python"),
    ];
    let missing = required
        .iter()
        .filter(|path| !path.exists())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Offline vendor payload is incomplete; missing {}",
            missing.join(", ")
        ))
    }
}

fn validate_model_layout(root: &Path) -> Result<(), String> {
    let required = [root.join("huggingface"), root.join("audio_separator")];
    let missing = required
        .iter()
        .filter(|path| !path.is_dir())
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "Offline model payload is incomplete; missing {}",
            missing.join(", ")
        ));
    }
    let has_file = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| entry.file_type().is_file() && !excluded_model_path(entry.path()));
    if has_file {
        Ok(())
    } else {
        Err("Offline model payload contains no model files".to_string())
    }
}

fn validate_payload_layout(root: &Path, kind: OfflinePayloadKind) -> Result<(), String> {
    match kind {
        OfflinePayloadKind::Vendor => validate_vendor_layout(root),
        OfflinePayloadKind::Models => validate_model_layout(root),
    }
}

fn find_payload_python_runtime(root: &Path) -> Option<PathBuf> {
    let expected = if cfg!(windows) {
        "python.exe"
    } else {
        "python3.10"
    };
    walkdir::WalkDir::new(root.join("python"))
        .max_depth(5)
        .into_iter()
        .flatten()
        .find(|entry| entry.file_type().is_file() && entry.file_name() == expected)
        .map(walkdir::DirEntry::into_path)
}

fn rewrite_payload_venv_home(config: &str, home: &Path) -> String {
    let home_line = format!("home = {}", home.display());
    let mut replaced = false;
    let mut lines = config
        .lines()
        .map(|line| {
            if line.trim_start().starts_with("home =") {
                replaced = true;
                home_line.clone()
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>();
    if !replaced {
        lines.insert(0, home_line);
    }
    format!("{}\n", lines.join("\n"))
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn verify_offline_vendor_runtime(root: impl AsRef<Path>) -> Result<(), String> {
    let root = root.as_ref();
    validate_vendor_layout(root)?;
    let runtime_python = find_payload_python_runtime(root)
        .ok_or_else(|| "Offline vendor Python runtime is missing".to_string())?;
    let runtime_home = runtime_python
        .parent()
        .ok_or_else(|| "Offline vendor Python runtime path is invalid".to_string())?;
    let venv_config = root.join("venv").join("pyvenv.cfg");
    let config = std::fs::read_to_string(&venv_config).map_err(|error| {
        format!(
            "Could not read extracted Python environment {}: {error}",
            venv_config.display()
        )
    })?;
    std::fs::write(
        &venv_config,
        rewrite_payload_venv_home(&config, runtime_home),
    )
    .map_err(|error| {
        format!(
            "Could not relocate extracted Python environment {}: {error}",
            venv_config.display()
        )
    })?;

    let imports = concat!(
        "import librosa, onnxruntime, soundfile, torch, torchaudio, torchcrepe, transformers, whisperx; ",
        "print(torch.__version__); print(transformers.__version__)",
    );
    let output = hidden_command(python_in(root))
        .args(["-c", imports])
        .output()
        .map_err(|error| format!("Could not start extracted Python runtime: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Extracted analyzer imports failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let output = hidden_command(ffmpeg_in(root))
        .arg("-version")
        .output()
        .map_err(|error| format!("Could not start extracted ffmpeg: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Extracted ffmpeg failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn sibling_path(destination: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Vendor destination has no parent folder".to_string())?;
    let name = destination
        .file_name()
        .ok_or_else(|| "Vendor destination has no folder name".to_string())?
        .to_string_lossy();
    Ok(parent.join(format!(".{name}.{suffix}")))
}

fn recover_atomic_directory(
    destination: &Path,
    partial: &Path,
    backup: &Path,
) -> Result<(), String> {
    if !destination.exists() && backup.exists() {
        std::fs::rename(backup, destination).map_err(|error| {
            format!(
                "Could not restore interrupted offline directory {} from {}: {error}",
                destination.display(),
                backup.display()
            )
        })?;
    } else if destination.exists() && backup.exists() {
        std::fs::remove_dir_all(backup).map_err(|error| {
            format!(
                "Could not remove stale offline directory backup {}: {error}",
                backup.display()
            )
        })?;
    }
    if partial.exists() {
        std::fs::remove_dir_all(partial).map_err(|error| {
            format!(
                "Could not remove interrupted offline directory {}: {error}",
                partial.display()
            )
        })?;
    }
    Ok(())
}

fn install_offline_payload_bundle(
    bundle: &OfflineVendorBundle,
    destination: impl AsRef<Path>,
    kind: OfflinePayloadKind,
) -> Result<OfflineVendorManifest, String> {
    let destination = destination.as_ref();
    let parent = destination
        .parent()
        .ok_or_else(|| "Vendor destination has no parent folder".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    let partial = sibling_path(destination, "offline-partial")?;
    let backup = sibling_path(destination, "offline-backup")?;
    recover_atomic_directory(destination, &partial, &backup)?;
    let manifest = read_and_verify_manifest(bundle, kind)?;
    std::fs::create_dir_all(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;

    let extraction = (|| {
        let decoder = zstd::Decoder::new(MultipartReader::new(bundle.archives.clone()))
            .map_err(|error| format!("Could not open offline compression stream: {error}"))?;
        let mut archive = tar::Archive::new(decoder);
        for entry in archive
            .entries()
            .map_err(|error| format!("Could not read offline archive: {error}"))?
        {
            let mut entry =
                entry.map_err(|error| format!("Could not read offline archive entry: {error}"))?;
            let path = entry
                .path()
                .map_err(|error| format!("Offline archive contains an invalid path: {error}"))?
                .into_owned();
            if path.is_absolute()
                || path.components().any(|component| {
                    matches!(component, Component::ParentDir | Component::Prefix(_))
                })
            {
                return Err(format!(
                    "Offline archive contains an unsafe path: {}",
                    path.display()
                ));
            }
            if !entry
                .unpack_in(&partial)
                .map_err(|error| format!("Could not extract {}: {error}", path.display()))?
            {
                return Err(format!(
                    "Offline archive entry escaped its destination: {}",
                    path.display()
                ));
            }
        }
        validate_payload_layout(&partial, kind)
    })();
    if let Err(error) = extraction {
        let _ = std::fs::remove_dir_all(&partial);
        return Err(error);
    }

    if destination.exists() {
        std::fs::rename(destination, &backup).map_err(|error| {
            format!(
                "Could not preserve existing {} folder {}: {error}",
                kind.label(),
                destination.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(&partial, destination) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, destination);
        }
        return Err(format!(
            "Could not activate offline {} folder {}: {error}",
            kind.label(),
            destination.display()
        ));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(manifest)
}

pub fn install_offline_vendor_bundle(
    bundle: &OfflineVendorBundle,
    destination: impl AsRef<Path>,
) -> Result<OfflineVendorManifest, String> {
    install_offline_payload_bundle(bundle, destination, OfflinePayloadKind::Vendor)
}

pub fn install_offline_model_bundle(
    bundle: &OfflineModelBundle,
    destination: impl AsRef<Path>,
) -> Result<OfflineVendorManifest, String> {
    install_offline_payload_bundle(
        &bundle.as_payload_bundle(),
        destination,
        OfflinePayloadKind::Models,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        OfflineModelBundle, OfflinePayloadKind, OfflineVendorBundle, install_offline_model_bundle,
        install_offline_vendor_bundle, sibling_path, stage_offline_model_bundle,
        stage_offline_vendor_bundle,
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nightingale-{label}-{nonce}"))
    }

    fn create_fixture(root: &std::path::Path) {
        let python = if cfg!(windows) {
            root.join("venv").join("Scripts").join("python.exe")
        } else {
            root.join("venv").join("bin").join("python")
        };
        for path in [
            root.join(".ready"),
            root.join(if cfg!(windows) {
                "ffmpeg.exe"
            } else {
                "ffmpeg"
            }),
            root.join(if cfg!(windows) { "uv.exe" } else { "uv" }),
            python,
            root.join("analyzer").join("analyze.py"),
            root.join("python").join("runtime.txt"),
            root.join("packages").join("unicode-\u{82b1}\u{675f}.txt"),
            root.join("packages").join("cached.pyc"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"fixture").unwrap();
        }
    }

    fn create_model_fixture(root: &std::path::Path) {
        for path in [
            root.join("huggingface")
                .join("hub")
                .join("models--fixture")
                .join("model.safetensors"),
            root.join("huggingface")
                .join("hub")
                .join("models--fixture")
                .join("unicode-\u{82b1}\u{675f}.json"),
            root.join("audio_separator").join("karaoke.ckpt"),
            root.join("torch")
                .join("hub")
                .join("checkpoints")
                .join("demucs.th"),
            root.join("huggingface")
                .join("xet")
                .join("logs")
                .join("transient.log"),
            root.join("huggingface")
                .join("hub")
                .join(".locks")
                .join("download.lock"),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"model fixture").unwrap();
        }
    }

    #[test]
    fn stages_and_installs_a_verified_unicode_payload() {
        let root = temp_root("offline-stage");
        let source = root.join("source");
        let staged = root.join("staged");
        let destination = root.join("installed").join("vendor");
        create_fixture(&source);

        let bundle = stage_offline_vendor_bundle(&source, &staged).unwrap();
        assert_eq!(bundle.metadata.file_count, 7);
        let installed = install_offline_vendor_bundle(
            &OfflineVendorBundle {
                archives: bundle.archives,
                manifest: bundle.manifest,
            },
            &destination,
        )
        .unwrap();

        assert_eq!(installed.file_count, 7);
        assert!(
            destination
                .join("packages")
                .join("unicode-\u{82b1}\u{675f}.txt")
                .is_file()
        );
        assert!(!destination.join("packages").join("cached.pyc").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_a_corrupted_archive_without_replacing_existing_vendor() {
        let root = temp_root("offline-corrupt");
        let source = root.join("source");
        let staged = root.join("staged");
        let destination = root.join("installed").join("vendor");
        create_fixture(&source);
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("keep.txt"), b"safe").unwrap();

        let bundle = stage_offline_vendor_bundle(&source, &staged).unwrap();
        let mut archive = std::fs::OpenOptions::new()
            .append(true)
            .open(&bundle.archives[0])
            .unwrap();
        use std::io::Write;
        archive.write_all(b"corrupt").unwrap();

        let error = install_offline_vendor_bundle(
            &OfflineVendorBundle {
                archives: bundle.archives,
                manifest: bundle.manifest,
            },
            &destination,
        )
        .unwrap_err();
        assert!(error.contains("size does not match"));
        assert_eq!(
            std::fs::read(destination.join("keep.txt")).unwrap(),
            b"safe"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_a_stranded_backup_before_rejecting_new_media() {
        let root = temp_root("offline-recovery");
        let source = root.join("source");
        let staged = root.join("staged");
        let destination = root.join("installed").join("vendor");
        create_fixture(&source);
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("keep.txt"), b"known good").unwrap();

        let bundle = stage_offline_vendor_bundle(&source, &staged).unwrap();
        let backup = sibling_path(&destination, "offline-backup").unwrap();
        let partial = sibling_path(&destination, "offline-partial").unwrap();
        std::fs::rename(&destination, &backup).unwrap();
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::write(partial.join("incomplete.txt"), b"partial").unwrap();
        let mut archive = std::fs::OpenOptions::new()
            .append(true)
            .open(&bundle.archives[0])
            .unwrap();
        use std::io::Write;
        archive.write_all(b"corrupt").unwrap();

        let error = install_offline_vendor_bundle(
            &OfflineVendorBundle {
                archives: bundle.archives,
                manifest: bundle.manifest,
            },
            &destination,
        )
        .unwrap_err();
        assert!(error.contains("size does not match"));
        assert_eq!(
            std::fs::read(destination.join("keep.txt")).unwrap(),
            b"known good"
        );
        assert!(!backup.exists());
        assert!(!partial.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stages_and_atomically_installs_model_caches_without_transient_files() {
        let root = temp_root("offline-models");
        let source = root.join("source");
        let staged = root.join("staged");
        let destination = root.join("installed").join("models");
        create_model_fixture(&source);

        let bundle = stage_offline_model_bundle(&source, &staged).unwrap();
        assert_eq!(bundle.metadata.payload_kind, OfflinePayloadKind::Models);
        assert_eq!(bundle.metadata.archive, "models.tar.zst");
        assert_eq!(bundle.metadata.file_count, 4);
        let installed = install_offline_model_bundle(
            &OfflineModelBundle {
                archives: bundle.archives,
                manifest: bundle.manifest,
            },
            &destination,
        )
        .unwrap();

        assert_eq!(installed.file_count, 4);
        assert!(
            destination
                .join("huggingface")
                .join("hub")
                .join("models--fixture")
                .join("unicode-\u{82b1}\u{675f}.json")
                .is_file()
        );
        assert!(
            destination
                .join("audio_separator")
                .join("karaoke.ckpt")
                .is_file()
        );
        assert!(
            !destination
                .join("huggingface")
                .join("xet")
                .join("logs")
                .exists()
        );
        assert!(
            !destination
                .join("huggingface")
                .join("hub")
                .join(".locks")
                .exists()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rewrites_a_staged_environment_for_its_extracted_runtime() {
        let config = "home = C:\\old\\python\nversion_info = 3.10.20\n";
        let updated = super::rewrite_payload_venv_home(
            config,
            std::path::Path::new("D:\\Nightingale\\vendor\\python"),
        );
        assert!(updated.starts_with("home = D:\\Nightingale\\vendor\\python\n"));
        assert!(updated.contains("version_info = 3.10.20"));
    }
}
