use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cache::profiles_path;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScoreRecord {
    pub profile: String,
    pub song_hash: String,
    pub score: u32,
    pub played_at: u64,
    #[serde(default = "default_scoring_difficulty")]
    pub difficulty: String,
}

fn default_scoring_difficulty() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProfileStore {
    pub active: Option<String>,
    pub profiles: Vec<String>,
    #[serde(default)]
    pub scores: Vec<ScoreRecord>,
}

impl Default for ProfileStore {
    fn default() -> Self {
        Self {
            active: Some("Guest".to_string()),
            profiles: vec!["Guest".to_string()],
            scores: Vec::new(),
        }
    }
}

impl ProfileStore {
    pub fn load() -> Self {
        let path = profiles_path();

        let mut store = if path.is_file() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Self::default()
        };

        if store.ensure_active_profile() {
            store.save();
        }

        store
    }

    fn ensure_active_profile(&mut self) -> bool {
        if self.profiles.is_empty() {
            self.profiles.push("Guest".to_string());
            self.active = Some("Guest".to_string());
            return true;
        }

        if self
            .active
            .as_ref()
            .is_some_and(|active| self.profiles.contains(active))
        {
            return false;
        }

        self.active = self.profiles.first().cloned();
        true
    }

    pub fn save(&self) {
        let path = profiles_path();

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, json);
        }
    }

    pub fn create_profile(&mut self, name: String) {
        if !self.profiles.contains(&name) {
            self.profiles.push(name.clone());
        }

        self.active = Some(name);

        self.save();
    }

    pub fn switch_profile(&mut self, name: &str) {
        if self.profiles.contains(&name.to_string()) {
            self.active = Some(name.to_string());

            self.save();
        }
    }

    pub fn delete_profile(&mut self, name: &str) {
        self.profiles.retain(|n| n != name);

        self.scores.retain(|r| r.profile != name);

        if self.active.as_deref() == Some(name) {
            self.active = self.profiles.first().cloned();
        }

        self.save();
    }

    pub fn add_score(&mut self, song_hash: &str, score: u32, difficulty: &str) {
        let profile = match &self.active {
            Some(p) => p.clone(),
            None => return,
        };
        let played_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.scores.push(ScoreRecord {
            profile,
            song_hash: song_hash.to_string(),
            score,
            played_at,
            difficulty: match difficulty {
                "easy" | "pro" => difficulty.to_string(),
                _ => default_scoring_difficulty(),
            },
        });
        self.save();
    }

    pub fn best_score(&self, song_hash: &str, profile: &str) -> Option<u32> {
        self.scores
            .iter()
            .filter(|r| r.song_hash == song_hash && r.profile == profile)
            .map(|r| r.score)
            .max()
    }

    pub fn top_scores_for_song(&self, song_hash: &str, limit: usize) -> Vec<(String, u32)> {
        let mut best: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
        for record in &self.scores {
            if record.song_hash == song_hash {
                let entry = best.entry(&record.profile).or_insert(0);
                if record.score > *entry {
                    *entry = record.score;
                }
            }
        }
        let mut sorted: Vec<(String, u32)> = best
            .into_iter()
            .map(|(name, score)| (name.to_string(), score))
            .collect();
        sorted.sort_by(|a, b| b.1.cmp(&a.1));
        sorted.truncate(limit);
        sorted
    }
}

#[cfg(test)]
mod tests {
    use super::{ProfileStore, ScoreRecord};

    #[test]
    fn legacy_scores_default_to_medium_difficulty() {
        let record: ScoreRecord = serde_json::from_str(
            r#"{"profile":"Guest","song_hash":"song","score":800,"played_at":1}"#,
        )
        .expect("legacy score should deserialize");

        assert_eq!(record.difficulty, "medium");
    }

    #[test]
    fn default_profile_is_ready_for_scores_and_recordings() {
        let store = ProfileStore::default();
        assert_eq!(store.active.as_deref(), Some("Guest"));
        assert_eq!(store.profiles, vec!["Guest"]);
    }

    #[test]
    fn empty_or_stale_profile_state_is_normalized() {
        let mut empty = ProfileStore {
            active: None,
            profiles: Vec::new(),
            scores: Vec::new(),
        };
        assert!(empty.ensure_active_profile());
        assert_eq!(empty.active.as_deref(), Some("Guest"));

        let mut stale = ProfileStore {
            active: Some("Missing".to_string()),
            profiles: vec!["Singer".to_string()],
            scores: Vec::new(),
        };
        assert!(stale.ensure_active_profile());
        assert_eq!(stale.active.as_deref(), Some("Singer"));
    }
}
