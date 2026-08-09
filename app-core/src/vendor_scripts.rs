use std::io::{self, Write};
use std::path::{Path, PathBuf};

const ANALYZE_PY: &str = include_str!("../analyzer/analyze.py");
const SERVER_PY: &str = include_str!("../analyzer/server.py");
const PIPELINE_PY: &str = include_str!("../analyzer/pipeline.py");
const KEY_DETECT_PY: &str = include_str!("../analyzer/key_detect.py");
const STEMS_PY: &str = include_str!("../analyzer/stems.py");
const TRANSCRIBE_PY: &str = include_str!("../analyzer/transcribe.py");
const ALIGN_PY: &str = include_str!("../analyzer/align.py");
const CTC_ALIGN_PY: &str = include_str!("../analyzer/ctc_align.py");
const QWEN_ALIGN_PY: &str = include_str!("../analyzer/qwen_align.py");
const AUDIO_PY: &str = include_str!("../analyzer/audio.py");
const HALLUCINATION_PY: &str = include_str!("../analyzer/hallucination.py");
const LANGUAGE_PY: &str = include_str!("../analyzer/language.py");
const WHISPER_COMPAT_PY: &str = include_str!("../analyzer/whisper_compat.py");
const PARAKEET_PY: &str = include_str!("../analyzer/parakeet.py");
const GPU_PY: &str = include_str!("../analyzer/gpu.py");
const CJK_PY: &str = include_str!("../analyzer/cjk.py");
const MELODY_PY: &str = include_str!("../analyzer/melody.py");

const FILES: &[(&str, &str)] = &[
    ("analyze.py", ANALYZE_PY),
    ("server.py", SERVER_PY),
    ("pipeline.py", PIPELINE_PY),
    ("key_detect.py", KEY_DETECT_PY),
    ("stems.py", STEMS_PY),
    ("transcribe.py", TRANSCRIBE_PY),
    ("align.py", ALIGN_PY),
    ("ctc_align.py", CTC_ALIGN_PY),
    ("qwen_align.py", QWEN_ALIGN_PY),
    ("audio.py", AUDIO_PY),
    ("hallucination.py", HALLUCINATION_PY),
    ("language.py", LANGUAGE_PY),
    ("whisper_compat.py", WHISPER_COMPAT_PY),
    ("parakeet.py", PARAKEET_PY),
    ("gpu.py", GPU_PY),
    ("cjk.py", CJK_PY),
    ("melody.py", MELODY_PY),
];

pub fn write_scripts(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;

    for (name, content) in FILES {
        write_script(&dir.join(name), content)?;
    }

    Ok(())
}

fn write_script(path: &Path, content: &str) -> io::Result<()> {
    let temporary = sibling_path(path, "download");
    let backup = sibling_path(path, "previous");

    if !path.exists() && backup.is_file() {
        make_writable(&backup)?;
        std::fs::rename(&backup, path)?;
    }
    if std::fs::read(path).ok().as_deref() == Some(content.as_bytes()) {
        remove_generated_file(&temporary)?;
        remove_generated_file(&backup)?;
        return Ok(());
    }

    remove_generated_file(&temporary)?;
    let mut file = std::fs::File::create(&temporary)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    drop(file);

    remove_generated_file(&backup)?;
    if path.is_file() {
        make_writable(path)?;
        if let Err(error) = std::fs::rename(path, &backup) {
            let _ = remove_generated_file(&temporary);
            return Err(error);
        }
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::rename(&backup, path);
        let _ = remove_generated_file(&temporary);
        return Err(error);
    }
    remove_generated_file(&backup)?;
    Ok(())
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .expect("embedded analyzer scripts always have a file name")
        .to_string_lossy();
    path.with_file_name(format!(".{name}.{suffix}"))
}

fn remove_generated_file(path: &Path) -> io::Result<()> {
    if path.exists() {
        make_writable(path)?;
        std::fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(windows)]
fn make_writable(path: &Path) -> io::Result<()> {
    if path.exists() {
        let mut permissions = std::fs::metadata(path)?.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            std::fs::set_permissions(path, permissions)?;
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn make_writable(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MELODY_PY, SERVER_PY, WHISPER_COMPAT_PY, make_writable, write_scripts};

    #[test]
    fn refreshes_read_only_scripts_and_continues_with_the_remaining_files() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-analyzer-scripts-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let blocked = root.join("whisper_compat.py");
        std::fs::write(&blocked, "stale").unwrap();
        let mut permissions = std::fs::metadata(&blocked).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&blocked, permissions).unwrap();
        std::fs::write(root.join("melody.py"), "also stale").unwrap();

        write_scripts(&root).unwrap();

        assert_eq!(
            std::fs::read_to_string(&blocked).unwrap(),
            WHISPER_COMPAT_PY
        );
        assert_eq!(
            std::fs::read_to_string(root.join("melody.py")).unwrap(),
            MELODY_PY
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skips_an_identical_read_only_script() {
        let root = std::env::temp_dir().join(format!(
            "nightingale-analyzer-scripts-identical-{}",
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let identical = root.join("server.py");
        std::fs::write(&identical, SERVER_PY).unwrap();
        let mut permissions = std::fs::metadata(&identical).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&identical, permissions).unwrap();

        write_scripts(&root).unwrap();

        assert_eq!(std::fs::read_to_string(&identical).unwrap(), SERVER_PY);
        make_writable(&identical).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
