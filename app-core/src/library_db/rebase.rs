//! One-shot rewrite of `album_art_path` columns when the data root moves.
//!
//! Used by `cache::change_app_data_path` after the user picks a new data dir
//! and we have copied the on-disk files. Opens the *destination* DB directly
//! (the global `LIBRARY_DB` connection still points at the source root at
//! this moment) so we can rewrite paths before the app reconnects.

use std::path::Path;

use rusqlite::{Connection, params};

fn maybe_rebase_string_path(path: &str, old_root: &Path, new_root: &Path) -> Option<String> {
    let rel = Path::new(path).strip_prefix(old_root).ok()?;
    Some(new_root.join(rel).to_string_lossy().into_owned())
}

fn rebase_song_album_art_paths_in_db(
    db_path: &Path,
    old_root: &Path,
    new_root: &Path,
) -> Result<(), String> {
    if !db_path.is_file() || crate::cache::same_path(old_root, new_root) {
        return Ok(());
    }

    let conn = Connection::open(db_path)
        .map_err(|e| format!("failed opening songs db {:?}: {e}", db_path))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("failed opening songs db transaction: {e}"))?;
    let mut stmt = tx
        .prepare("SELECT id, album_art_path, payload FROM songs")
        .map_err(|e| format!("failed preparing songs query: {e}"))?;

    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("failed querying songs: {e}"))?;

    let mut updates: Vec<(i64, Option<String>, String)> = Vec::new();
    for row in rows {
        let (id, album_art_path, payload) =
            row.map_err(|e| format!("failed reading songs row: {e}"))?;

        let mut changed = false;
        let mut new_album_art = album_art_path.clone();
        if let Some(current) = album_art_path.as_deref() {
            if let Some(rebased) = maybe_rebase_string_path(current, old_root, new_root) {
                new_album_art = Some(rebased);
                changed = true;
            }
        }

        let mut new_payload = payload.clone();
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&payload) {
            if let Some(album_art_value) = value.get_mut("album_art_path") {
                if let Some(current) = album_art_value.as_str() {
                    if let Some(rebased) = maybe_rebase_string_path(current, old_root, new_root) {
                        *album_art_value = serde_json::Value::String(rebased);
                        if let Ok(serialized) = serde_json::to_string(&value) {
                            new_payload = serialized;
                            changed = true;
                        }
                    }
                }
            }
        }

        if changed {
            updates.push((id, new_album_art, new_payload));
        }
    }
    drop(stmt);

    for (id, album_art_path, payload) in updates {
        tx.execute(
            "UPDATE songs SET album_art_path = ?2, payload = ?3 WHERE id = ?1",
            params![id, album_art_path, payload],
        )
        .map_err(|e| format!("failed updating songs row {id}: {e}"))?;
    }

    let has_recording_takes: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'recording_takes')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("failed checking recording take schema: {e}"))?;
    if has_recording_takes {
        let mut stmt = tx
            .prepare("SELECT id, payload FROM recording_takes")
            .map_err(|e| format!("failed preparing recording take query: {e}"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("failed querying recording takes: {e}"))?;
        let mut take_updates = Vec::new();
        for row in rows {
            let (id, payload) =
                row.map_err(|e| format!("failed reading recording take row: {e}"))?;
            let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&payload) else {
                continue;
            };
            let mut changed = false;
            for key in ["vocal_path", "partial_path", "mix_path", "video_path"] {
                let Some(path_value) = value.get_mut(key) else {
                    continue;
                };
                let Some(current) = path_value.as_str() else {
                    continue;
                };
                if let Some(rebased) = maybe_rebase_string_path(current, old_root, new_root) {
                    *path_value = serde_json::Value::String(rebased);
                    changed = true;
                }
            }
            if changed {
                let serialized = serde_json::to_string(&value)
                    .map_err(|e| format!("failed serializing recording take {id}: {e}"))?;
                take_updates.push((id, serialized));
            }
        }
        drop(stmt);
        for (id, payload) in take_updates {
            tx.execute(
                "UPDATE recording_takes SET payload = ?2 WHERE id = ?1",
                params![id, payload],
            )
            .map_err(|e| format!("failed updating recording take {id}: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("failed committing songs path rewrite: {e}"))?;
    Ok(())
}

pub fn rebase_song_album_art_paths(old_root: &Path, new_root: &Path) -> Result<(), String> {
    rebase_song_album_art_paths_in_db(&new_root.join("songs.db"), old_root, new_root)
}

pub fn rebase_song_album_art_cache_paths(old_cache: &Path, new_cache: &Path) -> Result<(), String> {
    rebase_song_album_art_paths_in_db(&super::library_db_path(), old_cache, new_cache)
}

#[cfg(test)]
mod tests {
    use super::rebase_song_album_art_paths_in_db;
    use rusqlite::{Connection, params};

    #[test]
    fn rebases_saved_recording_take_paths_with_the_data_root() {
        let root =
            std::env::temp_dir().join(format!("nightingale-rebase-{}", rand::random::<u64>()));
        let old_root = root.join("old");
        let new_root = root.join("new");
        std::fs::create_dir_all(&new_root).unwrap();
        let db_path = new_root.join("songs.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE songs (id INTEGER PRIMARY KEY, album_art_path TEXT, payload TEXT NOT NULL);
             CREATE TABLE recording_takes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);",
        )
        .unwrap();
        let old_vocal = old_root.join("recordings").join("take.wav");
        let take = serde_json::json!({
            "vocal_path": old_vocal,
            "partial_path": old_root.join("recordings").join("take.partial.wav"),
            "mix_path": old_root.join("recordings").join("take.m4a"),
            "video_path": null,
        });
        conn.execute(
            "INSERT INTO recording_takes (id, payload) VALUES (?1, ?2)",
            params!["take-1", take.to_string()],
        )
        .unwrap();
        drop(conn);

        rebase_song_album_art_paths_in_db(&db_path, &old_root, &new_root).unwrap();
        let conn = Connection::open(&db_path).unwrap();
        let payload: String = conn
            .query_row(
                "SELECT payload FROM recording_takes WHERE id = 'take-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            value["vocal_path"].as_str(),
            Some(
                new_root
                    .join("recordings")
                    .join("take.wav")
                    .to_string_lossy()
                    .as_ref()
            )
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(root);
    }
}
