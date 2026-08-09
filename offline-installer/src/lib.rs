use std::{
    ffi::OsString,
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const FORMAT_VERSION: u32 = 1;
const FOOTER_MAGIC: &[u8; 16] = b"NIGHTINGALE-OFF1";
const FOOTER_BYTES: u64 = 24;
const MAX_INDEX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackedRole {
    Bootstrap,
    Vendor,
    Models,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackedEntry {
    pub role: PackedRole,
    pub name: String,
    pub offset: u64,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PackedIndex {
    pub format_version: u32,
    pub app_version: String,
    pub entries: Vec<PackedEntry>,
}

#[derive(Debug, Clone, Deserialize)]
struct VendorManifest {
    #[serde(default)]
    payload_kind: Option<String>,
    app_version: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    architecture: Option<String>,
    archive: String,
    archive_sha256: String,
    archive_bytes: u64,
    #[serde(default)]
    parts: Vec<VendorPart>,
}

#[derive(Debug, Clone, Deserialize)]
struct VendorPart {
    file: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedSidecarPayload {
    pub app_version: String,
    pub entries: Vec<PackedEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtomicDirectorySwap {
    pub partial: PathBuf,
    pub backup: PathBuf,
}

fn safe_file_name(name: &str) -> bool {
    let path = Path::new(name);
    path.components().count() == 1 && matches!(path.components().next(), Some(Component::Normal(_)))
}

fn atomic_sibling_path(destination: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Atomic directory destination is invalid: {}",
            destination.display()
        )
    })?;
    let name = destination.file_name().ok_or_else(|| {
        format!(
            "Atomic directory destination is invalid: {}",
            destination.display()
        )
    })?;
    let mut sibling = OsString::from(".");
    sibling.push(name);
    sibling.push(suffix);
    Ok(parent.join(sibling))
}

pub fn prepare_atomic_directory_swap(
    destination: impl AsRef<Path>,
) -> Result<AtomicDirectorySwap, String> {
    let destination = destination.as_ref();
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "Atomic directory destination is invalid: {}",
            destination.display()
        )
    })?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let swap = AtomicDirectorySwap {
        partial: atomic_sibling_path(destination, ".partial")?,
        backup: atomic_sibling_path(destination, ".backup")?,
    };
    if !destination.exists() && swap.backup.exists() {
        std::fs::rename(&swap.backup, destination).map_err(|error| {
            format!(
                "Could not restore interrupted directory {} from {}: {error}",
                destination.display(),
                swap.backup.display()
            )
        })?;
    } else if destination.exists() && swap.backup.exists() {
        std::fs::remove_dir_all(&swap.backup).map_err(|error| {
            format!(
                "Could not remove stale directory backup {}: {error}",
                swap.backup.display()
            )
        })?;
    }
    if swap.partial.exists() {
        std::fs::remove_dir_all(&swap.partial).map_err(|error| {
            format!(
                "Could not remove interrupted partial directory {}: {error}",
                swap.partial.display()
            )
        })?;
    }
    Ok(swap)
}

pub fn activate_atomic_directory_swap(
    destination: impl AsRef<Path>,
    swap: &AtomicDirectorySwap,
) -> Result<(), String> {
    let destination = destination.as_ref();
    if !swap.partial.is_dir() {
        return Err(format!(
            "Atomic partial directory is missing: {}",
            swap.partial.display()
        ));
    }
    if swap.backup.exists() {
        return Err(format!(
            "Atomic backup directory unexpectedly exists: {}",
            swap.backup.display()
        ));
    }
    if destination.exists() {
        std::fs::rename(destination, &swap.backup).map_err(|error| {
            format!(
                "Could not preserve existing directory {}: {error}",
                destination.display()
            )
        })?;
    }
    if let Err(error) = std::fs::rename(&swap.partial, destination) {
        let restore = if swap.backup.exists() {
            std::fs::rename(&swap.backup, destination).err()
        } else {
            None
        };
        return Err(match restore {
            Some(restore_error) => format!(
                "Could not activate directory {}: {error}; restoring the previous directory also failed: {restore_error}",
                destination.display()
            ),
            None => format!(
                "Could not activate directory {}: {error}",
                destination.display()
            ),
        });
    }
    let _ = std::fs::remove_dir_all(&swap.backup);
    Ok(())
}

fn partial_path(path: &Path) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Output filename is invalid: {}", path.display()))?;
    Ok(path.with_file_name(format!(".{name}.partial-{}", std::process::id())))
}

fn sha256_range(path: &Path, offset: u64, bytes: u64) -> Result<String, String> {
    let mut file = BufReader::with_capacity(
        8 * 1024 * 1024,
        File::open(path).map_err(|error| format!("Could not open {}: {error}", path.display()))?,
    );
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Could not seek {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut remaining = bytes;
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    while remaining > 0 {
        let read_len = buffer.len().min(remaining as usize);
        let read = file
            .read(&mut buffer[..read_len])
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        if read == 0 {
            return Err(format!(
                "{} ended before its packed entry was complete",
                path.display()
            ));
        }
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub fn sha256_file(path: impl AsRef<Path>) -> Result<String, String> {
    let path = path.as_ref();
    let bytes = path
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?
        .len();
    sha256_range(path, 0, bytes)
}

fn append_source(
    writer: &mut BufWriter<File>,
    output_offset: &mut u64,
    source: &Path,
    role: PackedRole,
    name: String,
    expected_sha256: Option<&str>,
    expected_bytes: Option<u64>,
) -> Result<PackedEntry, String> {
    if !safe_file_name(&name) {
        return Err(format!("Packed filename is unsafe: {name}"));
    }
    let file = File::open(source)
        .map_err(|error| format!("Could not open {}: {error}", source.display()))?;
    let actual_bytes = file
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", source.display()))?
        .len();
    if expected_bytes.is_some_and(|expected| expected != actual_bytes) {
        return Err(format!(
            "{} does not match the vendor manifest size",
            source.display()
        ));
    }

    let offset = *output_offset;
    let mut reader = BufReader::with_capacity(8 * 1024 * 1024, file);
    let mut digest = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not pack {}: {error}", source.display()))?;
        digest.update(&buffer[..read]);
        copied += read as u64;
    }
    let sha256 = format!("{:x}", digest.finalize());
    if expected_sha256.is_some_and(|expected| !sha256.eq_ignore_ascii_case(expected)) {
        return Err(format!(
            "{} does not match the vendor manifest checksum",
            source.display()
        ));
    }
    *output_offset = output_offset
        .checked_add(copied)
        .ok_or_else(|| "Packed installer is too large".to_string())?;
    Ok(PackedEntry {
        role,
        name,
        offset,
        bytes: copied,
        sha256,
    })
}

fn read_payload_manifest(root: &Path, label: &str) -> Result<VendorManifest, String> {
    let path = root.join("manifest.json");
    let manifest = serde_json::from_slice(
        &std::fs::read(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?,
    )
    .map_err(|error| format!("Offline {label} manifest is invalid: {error}"))?;
    Ok(manifest)
}

fn payload_role_label(role: &PackedRole) -> Result<(&'static str, &'static str), String> {
    match role {
        PackedRole::Vendor => Ok(("vendor", "vendor")),
        PackedRole::Models => Ok(("models", "models")),
        PackedRole::Bootstrap => {
            Err("A bootstrap installer cannot be a sidecar payload".to_string())
        }
    }
}

pub fn verify_sidecar_payload(
    root: impl AsRef<Path>,
    expected_app_version: &str,
    role: PackedRole,
) -> Result<VerifiedSidecarPayload, String> {
    let root = root.as_ref();
    let (label, expected_kind) = payload_role_label(&role)?;
    let manifest = read_payload_manifest(root, label)?;
    if manifest.app_version != expected_app_version {
        return Err(format!(
            "Offline {label} payload is for Nightingale {}, but this installer is for {}",
            manifest.app_version, expected_app_version
        ));
    }
    if manifest
        .payload_kind
        .as_deref()
        .is_some_and(|kind| kind != expected_kind)
    {
        return Err(format!(
            "Offline {label} manifest has the wrong payload type"
        ));
    }
    if manifest
        .platform
        .as_deref()
        .is_some_and(|platform| platform != std::env::consts::OS)
    {
        return Err(format!(
            "Offline {label} payload is for a different operating system"
        ));
    }
    if manifest
        .architecture
        .as_deref()
        .is_some_and(|architecture| architecture != std::env::consts::ARCH)
    {
        return Err(format!(
            "Offline {label} payload is for a different architecture"
        ));
    }
    if manifest.parts.is_empty() && manifest.archive_bytes == 0 {
        return Err(format!("Offline {label} manifest has no payload"));
    }

    let manifest_path = root.join("manifest.json");
    let manifest_bytes = manifest_path
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", manifest_path.display()))?
        .len();
    let mut entries = vec![PackedEntry {
        role: role.clone(),
        name: "manifest.json".to_string(),
        offset: 0,
        bytes: manifest_bytes,
        sha256: sha256_range(&manifest_path, 0, manifest_bytes)?,
    }];

    let sources = if manifest.parts.is_empty() {
        vec![VendorPart {
            file: manifest.archive.clone(),
            sha256: manifest.archive_sha256.clone(),
            bytes: manifest.archive_bytes,
        }]
    } else {
        let part_bytes = manifest
            .parts
            .iter()
            .try_fold(0u64, |total, part| total.checked_add(part.bytes))
            .ok_or_else(|| format!("Offline {label} payload size is invalid"))?;
        if part_bytes != manifest.archive_bytes {
            return Err(format!(
                "Offline {label} parts do not match the archive size"
            ));
        }
        manifest.parts.clone()
    };
    for source in sources {
        if !safe_file_name(&source.file) {
            return Err(format!(
                "Offline {label} filename is unsafe: {}",
                source.file
            ));
        }
        let path = root.join(&source.file);
        let bytes = path
            .metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?
            .len();
        if bytes != source.bytes {
            return Err(format!(
                "Offline {label} component {} has the wrong size",
                source.file
            ));
        }
        let sha256 = sha256_range(&path, 0, bytes)?;
        if !sha256.eq_ignore_ascii_case(&source.sha256) {
            return Err(format!(
                "Offline {label} component {} failed checksum verification",
                source.file
            ));
        }
        entries.push(PackedEntry {
            role: role.clone(),
            name: source.file,
            offset: 0,
            bytes,
            sha256,
        });
    }
    Ok(VerifiedSidecarPayload {
        app_version: manifest.app_version,
        entries,
    })
}

fn copy_verified_sidecar_entry(
    root: &Path,
    entry: &PackedEntry,
    destination: &Path,
) -> Result<(), String> {
    let source_path = root.join(&entry.name);
    let mut source = BufReader::with_capacity(
        8 * 1024 * 1024,
        File::open(&source_path)
            .map_err(|error| format!("Could not open {}: {error}", source_path.display()))?,
    );
    let mut target = BufWriter::with_capacity(
        8 * 1024 * 1024,
        File::create(destination)
            .map_err(|error| format!("Could not create {}: {error}", destination.display()))?,
    );
    let mut digest = Sha256::new();
    let mut copied = 0u64;
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| format!("Could not read {}: {error}", source_path.display()))?;
        if read == 0 {
            break;
        }
        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not copy {}: {error}", entry.name))?;
        digest.update(&buffer[..read]);
        copied += read as u64;
    }
    target
        .flush()
        .map_err(|error| format!("Could not finish {}: {error}", destination.display()))?;
    if copied != entry.bytes
        || !format!("{:x}", digest.finalize()).eq_ignore_ascii_case(&entry.sha256)
    {
        let _ = std::fs::remove_file(destination);
        return Err(format!(
            "Offline sidecar component {} changed while it was copied",
            entry.name
        ));
    }
    Ok(())
}

pub fn install_sidecar_payload(
    root: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    expected_app_version: &str,
    role: PackedRole,
) -> Result<VerifiedSidecarPayload, String> {
    let root = root.as_ref();
    let destination = destination.as_ref();
    let swap = prepare_atomic_directory_swap(destination)?;
    let verified = verify_sidecar_payload(root, expected_app_version, role)?;
    std::fs::create_dir_all(&swap.partial)
        .map_err(|error| format!("Could not create {}: {error}", swap.partial.display()))?;
    for entry in &verified.entries {
        if let Err(error) =
            copy_verified_sidecar_entry(root, entry, &swap.partial.join(&entry.name))
        {
            let _ = std::fs::remove_dir_all(&swap.partial);
            return Err(error);
        }
    }
    activate_atomic_directory_swap(destination, &swap)?;
    Ok(verified)
}

fn append_payload_bundle(
    writer: &mut BufWriter<File>,
    offset: &mut u64,
    entries: &mut Vec<PackedEntry>,
    root: &Path,
    manifest: &VendorManifest,
    role: PackedRole,
) -> Result<(), String> {
    entries.push(append_source(
        writer,
        offset,
        &root.join("manifest.json"),
        role.clone(),
        "manifest.json".to_string(),
        None,
        None,
    )?);
    if manifest.parts.is_empty() {
        entries.push(append_source(
            writer,
            offset,
            &root.join(&manifest.archive),
            role,
            manifest.archive.clone(),
            Some(&manifest.archive_sha256),
            Some(manifest.archive_bytes),
        )?);
    } else {
        for part in &manifest.parts {
            entries.push(append_source(
                writer,
                offset,
                &root.join(&part.file),
                role.clone(),
                part.file.clone(),
                Some(&part.sha256),
                Some(part.bytes),
            )?);
        }
    }
    Ok(())
}

pub fn pack_offline_installer(
    stub: impl AsRef<Path>,
    bootstrap_setup: impl AsRef<Path>,
    vendor_root: impl AsRef<Path>,
    output: impl AsRef<Path>,
) -> Result<PackedIndex, String> {
    pack_offline_installer_with_models(stub, bootstrap_setup, vendor_root, None, output)
}

pub fn pack_offline_installer_with_models(
    stub: impl AsRef<Path>,
    bootstrap_setup: impl AsRef<Path>,
    vendor_root: impl AsRef<Path>,
    models_root: Option<&Path>,
    output: impl AsRef<Path>,
) -> Result<PackedIndex, String> {
    let stub = stub.as_ref();
    let bootstrap_setup = bootstrap_setup.as_ref();
    let vendor_root = vendor_root.as_ref();
    let output = output.as_ref();
    let manifest = read_payload_manifest(vendor_root, "vendor")?;
    if manifest.parts.is_empty() && manifest.archive_bytes == 0 {
        return Err("Offline vendor manifest has no payload".to_string());
    }
    let models_manifest = models_root
        .map(|root| read_payload_manifest(root, "models"))
        .transpose()?;
    if let Some(models_manifest) = models_manifest.as_ref() {
        if models_manifest.parts.is_empty() && models_manifest.archive_bytes == 0 {
            return Err("Offline models manifest has no payload".to_string());
        }
        if models_manifest.app_version != manifest.app_version {
            return Err(format!(
                "Offline models are for Nightingale {}, but the analyzer is for {}",
                models_manifest.app_version, manifest.app_version
            ));
        }
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let partial = partial_path(output)?;
    let _ = std::fs::remove_file(&partial);
    let file = File::create(&partial)
        .map_err(|error| format!("Could not create {}: {error}", partial.display()))?;
    let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
    let mut offset = 0u64;
    let mut entries = Vec::new();

    let result = (|| {
        entries.push(append_source(
            &mut writer,
            &mut offset,
            stub,
            PackedRole::Bootstrap,
            "installer-stub.exe".to_string(),
            None,
            None,
        )?);
        entries.push(append_source(
            &mut writer,
            &mut offset,
            bootstrap_setup,
            PackedRole::Bootstrap,
            bootstrap_setup
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Bootstrap installer filename is invalid".to_string())?
                .to_string(),
            None,
            None,
        )?);
        append_payload_bundle(
            &mut writer,
            &mut offset,
            &mut entries,
            vendor_root,
            &manifest,
            PackedRole::Vendor,
        )?;
        if let (Some(models_root), Some(models_manifest)) = (models_root, models_manifest.as_ref())
        {
            append_payload_bundle(
                &mut writer,
                &mut offset,
                &mut entries,
                models_root,
                models_manifest,
                PackedRole::Models,
            )?;
        }

        let index = PackedIndex {
            format_version: FORMAT_VERSION,
            app_version: manifest.app_version,
            entries,
        };
        let bytes = serde_json::to_vec(&index)
            .map_err(|error| format!("Could not serialize installer index: {error}"))?;
        writer
            .write_all(&bytes)
            .and_then(|_| writer.write_all(&(bytes.len() as u64).to_le_bytes()))
            .and_then(|_| writer.write_all(FOOTER_MAGIC))
            .and_then(|_| writer.flush())
            .map_err(|error| format!("Could not finish {}: {error}", partial.display()))?;
        Ok::<_, String>(index)
    })();

    let index = match result {
        Ok(index) => index,
        Err(error) => {
            drop(writer);
            let _ = std::fs::remove_file(&partial);
            return Err(error);
        }
    };
    drop(writer);
    let permissions = std::fs::metadata(stub)
        .map_err(|error| format!("Could not inspect {}: {error}", stub.display()))?
        .permissions();
    std::fs::set_permissions(&partial, permissions)
        .map_err(|error| format!("Could not set {} permissions: {error}", partial.display()))?;
    if output.exists() {
        std::fs::remove_file(output)
            .map_err(|error| format!("Could not replace {}: {error}", output.display()))?;
    }
    std::fs::rename(&partial, output)
        .map_err(|error| format!("Could not finalize {}: {error}", output.display()))?;
    Ok(index)
}

pub fn read_packed_index(installer: impl AsRef<Path>) -> Result<PackedIndex, String> {
    let installer = installer.as_ref();
    let mut file = BufReader::new(
        File::open(installer)
            .map_err(|error| format!("Could not open {}: {error}", installer.display()))?,
    );
    let total = file
        .get_ref()
        .metadata()
        .map_err(|error| format!("Could not inspect {}: {error}", installer.display()))?
        .len();
    if total < FOOTER_BYTES {
        return Err("This executable has no Nightingale offline payload".to_string());
    }
    file.seek(SeekFrom::End(-(FOOTER_BYTES as i64)))
        .map_err(|error| format!("Could not read installer footer: {error}"))?;
    let mut length_bytes = [0u8; 8];
    let mut magic = [0u8; 16];
    file.read_exact(&mut length_bytes)
        .and_then(|_| file.read_exact(&mut magic))
        .map_err(|error| format!("Could not read installer footer: {error}"))?;
    if &magic != FOOTER_MAGIC {
        return Err("This executable has no Nightingale offline payload".to_string());
    }
    let index_bytes = u64::from_le_bytes(length_bytes);
    if index_bytes == 0 || index_bytes > MAX_INDEX_BYTES {
        return Err("Offline installer index size is invalid".to_string());
    }
    let index_offset = total
        .checked_sub(FOOTER_BYTES + index_bytes)
        .ok_or_else(|| "Offline installer index is truncated".to_string())?;
    file.seek(SeekFrom::Start(index_offset))
        .map_err(|error| format!("Could not seek to installer index: {error}"))?;
    let mut bytes = vec![0u8; index_bytes as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("Could not read installer index: {error}"))?;
    let index: PackedIndex = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Offline installer index is invalid: {error}"))?;
    validate_index(&index, index_offset)?;
    Ok(index)
}

fn validate_index(index: &PackedIndex, data_end: u64) -> Result<(), String> {
    if index.format_version != FORMAT_VERSION {
        return Err(format!(
            "Offline installer format {} is unsupported",
            index.format_version
        ));
    }
    if index.entries.len() < 3
        || index
            .entries
            .iter()
            .filter(|entry| {
                entry.name != "installer-stub.exe" && entry.role == PackedRole::Bootstrap
            })
            .count()
            != 1
    {
        return Err("Offline installer index is incomplete".to_string());
    }
    if index
        .entries
        .iter()
        .filter(|entry| entry.role == PackedRole::Vendor && entry.name == "manifest.json")
        .count()
        != 1
    {
        return Err("Offline installer vendor payload is incomplete".to_string());
    }
    let model_entries = index
        .entries
        .iter()
        .filter(|entry| entry.role == PackedRole::Models)
        .count();
    let model_manifests = index
        .entries
        .iter()
        .filter(|entry| entry.role == PackedRole::Models && entry.name == "manifest.json")
        .count();
    if model_entries > 0 && model_manifests != 1 {
        return Err("Offline installer model payload is incomplete".to_string());
    }
    let mut previous_end = 0u64;
    for entry in &index.entries {
        if !safe_file_name(&entry.name) || entry.bytes == 0 {
            return Err(format!(
                "Offline installer entry is invalid: {}",
                entry.name
            ));
        }
        let end = entry
            .offset
            .checked_add(entry.bytes)
            .ok_or_else(|| format!("Offline installer entry is too large: {}", entry.name))?;
        if entry.offset < previous_end || end > data_end {
            return Err(format!(
                "Offline installer entry is out of range: {}",
                entry.name
            ));
        }
        previous_end = end;
    }
    Ok(())
}

pub fn verify_packed_installer(installer: impl AsRef<Path>) -> Result<PackedIndex, String> {
    let installer = installer.as_ref();
    let index = read_packed_index(installer)?;
    for entry in &index.entries {
        let digest = sha256_range(installer, entry.offset, entry.bytes)?;
        if !digest.eq_ignore_ascii_case(&entry.sha256) {
            return Err(format!(
                "Offline installer entry {} failed checksum verification",
                entry.name
            ));
        }
    }
    Ok(index)
}

pub fn extract_packed_entry(
    installer: impl AsRef<Path>,
    entry: &PackedEntry,
    destination: impl AsRef<Path>,
) -> Result<(), String> {
    let installer = installer.as_ref();
    let destination = destination.as_ref();
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let partial = partial_path(destination)?;
    let _ = std::fs::remove_file(&partial);
    let mut source = BufReader::with_capacity(
        8 * 1024 * 1024,
        File::open(installer)
            .map_err(|error| format!("Could not open {}: {error}", installer.display()))?,
    );
    source
        .seek(SeekFrom::Start(entry.offset))
        .map_err(|error| format!("Could not seek {}: {error}", installer.display()))?;
    let mut target = BufWriter::with_capacity(
        8 * 1024 * 1024,
        File::create(&partial)
            .map_err(|error| format!("Could not create {}: {error}", partial.display()))?,
    );
    let mut digest = Sha256::new();
    let mut remaining = entry.bytes;
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    while remaining > 0 {
        let read_len = buffer.len().min(remaining as usize);
        let read = source
            .read(&mut buffer[..read_len])
            .map_err(|error| format!("Could not read {}: {error}", entry.name))?;
        if read == 0 {
            let _ = std::fs::remove_file(&partial);
            return Err(format!("Packed entry {} is truncated", entry.name));
        }
        target
            .write_all(&buffer[..read])
            .map_err(|error| format!("Could not extract {}: {error}", entry.name))?;
        digest.update(&buffer[..read]);
        remaining -= read as u64;
    }
    target
        .flush()
        .map_err(|error| format!("Could not finish {}: {error}", entry.name))?;
    drop(target);
    let digest = format!("{:x}", digest.finalize());
    if !digest.eq_ignore_ascii_case(&entry.sha256) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!(
            "Packed entry {} failed checksum verification",
            entry.name
        ));
    }
    if destination.exists() {
        std::fs::remove_file(destination)
            .map_err(|error| format!("Could not replace {}: {error}", destination.display()))?;
    }
    std::fs::rename(&partial, destination)
        .map_err(|error| format!("Could not finalize {}: {error}", destination.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        PackedRole, extract_packed_entry, install_sidecar_payload, pack_offline_installer,
        pack_offline_installer_with_models, prepare_atomic_directory_swap, verify_packed_installer,
        verify_sidecar_payload,
    };
    use sha2::{Digest, Sha256};
    use std::{
        io::{Seek, Write},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("nightingale-{label}-{nonce}"))
    }

    fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
        let root = temp_root("offline-installer");
        let vendor = root.join("vendor");
        std::fs::create_dir_all(&vendor).unwrap();
        std::fs::write(root.join("stub.exe"), b"stub").unwrap();
        std::fs::write(root.join("setup.exe"), b"setup").unwrap();
        std::fs::write(vendor.join("vendor.tar.zst.part001"), b"payload").unwrap();
        std::fs::write(
            vendor.join("manifest.json"),
            br#"{
                "app_version":"1.0.0",
                "archive":"vendor.tar.zst",
                "archive_sha256":"unused",
                "archive_bytes":7,
                "parts":[{
                    "file":"vendor.tar.zst.part001",
                    "sha256":"239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5",
                    "bytes":7
                }]
            }"#,
        )
        .unwrap();
        let output = root.join("offline.exe");
        (root, output)
    }

    fn add_models_fixture(root: &std::path::Path) -> std::path::PathBuf {
        let models = root.join("models");
        std::fs::create_dir_all(&models).unwrap();
        std::fs::write(models.join("models.tar.zst.part001"), b"weights").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"weights"));
        std::fs::write(
            models.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "app_version": "1.0.0",
                "archive": "models.tar.zst",
                "archive_sha256": "unused",
                "archive_bytes": 7,
                "parts": [{
                    "file": "models.tar.zst.part001",
                    "sha256": hash,
                    "bytes": 7
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        models
    }

    #[test]
    fn packs_verifies_and_extracts_the_bootstrap_and_vendor() {
        let (root, output) = fixture();
        let index = pack_offline_installer(
            root.join("stub.exe"),
            root.join("setup.exe"),
            root.join("vendor"),
            &output,
        )
        .unwrap();
        assert_eq!(index.entries.len(), 4);
        let verified = verify_packed_installer(&output).unwrap();
        let part = verified
            .entries
            .iter()
            .find(|entry| entry.role == PackedRole::Vendor && entry.name.ends_with("part001"))
            .unwrap();
        let extracted = root.join("extracted").join(&part.name);
        extract_packed_entry(&output, part, &extracted).unwrap();
        assert_eq!(std::fs::read(extracted).unwrap(), b"payload");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_corrupted_overlay_data() {
        let (root, output) = fixture();
        let index = pack_offline_installer(
            root.join("stub.exe"),
            root.join("setup.exe"),
            root.join("vendor"),
            &output,
        )
        .unwrap();
        let part = index
            .entries
            .iter()
            .find(|entry| entry.name.ends_with("part001"))
            .unwrap();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .open(&output)
            .unwrap();
        file.seek(std::io::SeekFrom::Start(part.offset)).unwrap();
        file.write_all(b"X").unwrap();
        assert!(verify_packed_installer(&output).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn packs_and_verifies_an_optional_model_payload() {
        let (root, output) = fixture();
        let models = add_models_fixture(&root);
        let index = pack_offline_installer_with_models(
            root.join("stub.exe"),
            root.join("setup.exe"),
            root.join("vendor"),
            Some(&models),
            &output,
        )
        .unwrap();
        assert!(
            index
                .entries
                .iter()
                .any(|entry| entry.role == PackedRole::Models && entry.name == "manifest.json")
        );
        assert!(
            index
                .entries
                .iter()
                .any(|entry| entry.role == PackedRole::Models && entry.name.ends_with("part001"))
        );
        verify_packed_installer(&output).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verifies_and_atomically_installs_model_sidecars() {
        let (root, _) = fixture();
        let models = add_models_fixture(&root);
        let verified = verify_sidecar_payload(&models, "1.0.0", PackedRole::Models).unwrap();
        assert_eq!(verified.entries.len(), 2);

        let destination = root.join("installed-models-模");
        install_sidecar_payload(&models, &destination, "1.0.0", PackedRole::Models).unwrap();
        assert_eq!(
            std::fs::read(destination.join("models.tar.zst.part001")).unwrap(),
            b"weights"
        );

        std::fs::write(models.join("models.tar.zst.part001"), b"damaged").unwrap();
        assert!(
            install_sidecar_payload(&models, &destination, "1.0.0", PackedRole::Models).is_err()
        );
        assert_eq!(
            std::fs::read(destination.join("models.tar.zst.part001")).unwrap(),
            b"weights"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_a_stranded_sidecar_backup_before_verifying_new_media() {
        let (root, _) = fixture();
        let models = add_models_fixture(&root);
        let destination = root.join("installed-models-\u{6a21}");
        install_sidecar_payload(&models, &destination, "1.0.0", PackedRole::Models).unwrap();

        let swap = prepare_atomic_directory_swap(&destination).unwrap();
        std::fs::rename(&destination, &swap.backup).unwrap();
        std::fs::create_dir_all(&swap.partial).unwrap();
        std::fs::write(swap.partial.join("incomplete.txt"), b"partial").unwrap();
        std::fs::write(models.join("models.tar.zst.part001"), b"damaged").unwrap();

        assert!(
            install_sidecar_payload(&models, &destination, "1.0.0", PackedRole::Models).is_err()
        );
        assert_eq!(
            std::fs::read(destination.join("models.tar.zst.part001")).unwrap(),
            b"weights"
        );
        assert!(!swap.backup.exists());
        assert!(!swap.partial.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
