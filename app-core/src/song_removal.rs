use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cache::{CacheDir, remove_file_and_size};
use crate::library_db;
use crate::song::{Song, SongOrigin};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RemoveSongResult {
    pub freed_bytes: u64,
    pub source_deleted: bool,
}

/// Remove one exact catalogue row. The path is used only to disambiguate songs
/// with identical content hashes and must match the stored row before any file
/// operation is attempted.
pub fn remove_song(
    file_hash: &str,
    path: &str,
    delete_source: bool,
) -> Result<RemoveSongResult, String> {
    let song = library_db::load_song_by_hash_and_path(file_hash, path)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Song is no longer in the library".to_string())?;

    if delete_source && !matches!(song.origin, SongOrigin::LocalFile) {
        return Err("Remote source files cannot be deleted from Nightingale".to_string());
    }

    let mut freed_bytes = 0;
    let mut source_deleted = false;
    if delete_source {
        let paths = local_source_paths(&song);
        for source_path in paths {
            let existed = source_path.exists() || source_path.is_symlink();
            let bytes = remove_file_and_size(&source_path);
            if existed && !source_path.exists() {
                source_deleted = true;
                freed_bytes += bytes;
            } else if existed {
                return Err(format!("Could not delete {}", source_path.display()));
            }
        }
    }

    let hash_still_used = library_db::hide_and_delete_song(&song)
        .map_err(|error| format!("Could not remove song from library: {error}"))?;

    // Generated assets are content-addressed and may be shared by duplicate
    // files, so keep them until the final row using this hash is removed.
    if !hash_still_used {
        freed_bytes += CacheDir::new().delete_song_cache(&song.file_hash);
    }

    // Remote media is a disposable downloaded copy. Local media is only
    // touched when the user explicitly chose permanent deletion above.
    if !matches!(song.origin, SongOrigin::LocalFile) {
        freed_bytes += remove_file_and_size(&song.path);
    }

    Ok(RemoveSongResult {
        freed_bytes,
        source_deleted,
    })
}

fn local_source_paths(song: &Song) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    let candidates = std::iter::once(song.path.clone()).chain(
        song.usdx
            .iter()
            .flat_map(|bundle| {
                [
                    Some(bundle.txt_path.clone()),
                    Some(bundle.audio.clone()),
                    bundle.vocals.clone(),
                    bundle.instrumental.clone(),
                    bundle.video.clone(),
                ]
            })
            .flatten(),
    );
    for path in candidates {
        if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::local_source_paths;
    use crate::song::{Song, SongOrigin};
    use crate::usdx::UsdxBundle;
    use std::path::PathBuf;

    #[test]
    fn usdx_source_paths_are_deduplicated() {
        let descriptor = PathBuf::from("/songs/example.txt");
        let song = Song {
            path: descriptor.clone(),
            file_hash: "hash".into(),
            title: "Title".into(),
            artist: "Artist".into(),
            album: "Album".into(),
            duration_secs: 1.0,
            album_art_path: None,
            is_analyzed: true,
            language: None,
            transcript_source: None,
            key: None,
            override_key: None,
            tempo: 1.0,
            key_offset: 0,
            is_video: false,
            usdx: Some(UsdxBundle {
                txt_path: descriptor,
                audio: PathBuf::from("/songs/example.mp3"),
                vocals: None,
                instrumental: None,
                video: None,
            }),
            origin: SongOrigin::LocalFile,
            no_stems: false,
        };

        assert_eq!(local_source_paths(&song).len(), 2);
    }
}
