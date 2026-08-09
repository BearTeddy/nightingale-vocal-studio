use std::{
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
    app_version: String,
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

fn safe_file_name(name: &str) -> bool {
    let path = Path::new(name);
    path.components().count() == 1 && matches!(path.components().next(), Some(Component::Normal(_)))
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

pub fn pack_offline_installer(
    stub: impl AsRef<Path>,
    bootstrap_setup: impl AsRef<Path>,
    vendor_root: impl AsRef<Path>,
    output: impl AsRef<Path>,
) -> Result<PackedIndex, String> {
    let stub = stub.as_ref();
    let bootstrap_setup = bootstrap_setup.as_ref();
    let vendor_root = vendor_root.as_ref();
    let output = output.as_ref();
    let manifest_path = vendor_root.join("manifest.json");
    let manifest: VendorManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("Could not read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Offline vendor manifest is invalid: {error}"))?;
    if manifest.parts.is_empty() && manifest.archive_bytes == 0 {
        return Err("Offline vendor manifest has no payload".to_string());
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
        entries.push(append_source(
            &mut writer,
            &mut offset,
            &manifest_path,
            PackedRole::Vendor,
            "manifest.json".to_string(),
            None,
            None,
        )?);

        if manifest.parts.is_empty() {
            entries.push(append_source(
                &mut writer,
                &mut offset,
                &vendor_root.join(&manifest.archive),
                PackedRole::Vendor,
                manifest.archive,
                Some(&manifest.archive_sha256),
                Some(manifest.archive_bytes),
            )?);
        } else {
            for part in &manifest.parts {
                entries.push(append_source(
                    &mut writer,
                    &mut offset,
                    &vendor_root.join(&part.file),
                    PackedRole::Vendor,
                    part.file.clone(),
                    Some(&part.sha256),
                    Some(part.bytes),
                )?);
            }
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
        PackedRole, extract_packed_entry, pack_offline_installer, verify_packed_installer,
    };
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
}
