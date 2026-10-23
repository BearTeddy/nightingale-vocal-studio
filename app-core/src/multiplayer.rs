use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MultiplayerPlayer {
    pub id: String,
    pub profile: String,
    pub microphone: String,
    pub channel: Option<u16>,
    pub color: String,
}

pub fn validate_multiplayer_players(players: &[MultiplayerPlayer]) -> Result<(), String> {
    if !(2..=4).contains(&players.len()) {
        return Err("Choose between two and four singers".into());
    }
    for (index, player) in players.iter().enumerate() {
        if player.id.is_empty()
            || player.profile.trim().is_empty()
            || player.profile.len() > 120
            || player.profile.chars().any(char::is_control)
            || player.microphone.is_empty()
        {
            return Err("Every singer needs a profile and microphone".into());
        }
        for other in &players[..index] {
            if other.id == player.id || other.profile == player.profile {
                return Err("Choose a different profile for each singer".into());
            }
            if other.microphone == player.microphone
                && (other.channel.is_none()
                    || player.channel.is_none()
                    || other.channel == player.channel)
            {
                return Err(
                    "Each singer needs a separate microphone or non-overlapping input channel"
                        .into(),
                );
            }
        }
    }
    Ok(())
}

pub fn save_multiplayer_players(
    players: Vec<MultiplayerPlayer>,
) -> Result<crate::AppConfig, String> {
    validate_multiplayer_players(&players)?;
    let mut profiles = crate::ProfileStore::load();
    for player in &players {
        if !profiles.profiles.contains(&player.profile) {
            profiles.profiles.push(player.profile.clone());
        }
    }
    profiles.save();
    let mut config = crate::AppConfig::load();
    config.multiplayer_players = Some(players);
    config.save();
    Ok(config)
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MultiplayerScore {
    pub profile: String,
    pub score: u32,
}

pub fn add_multiplayer_scores(
    song_hash: &str,
    scores: &[MultiplayerScore],
    difficulty: &str,
    factor: f64,
) -> Result<(), String> {
    if !(1..=4).contains(&scores.len()) {
        return Err("Invalid player count".into());
    }
    let mut store = crate::ProfileStore::load();
    let mut seen = std::collections::HashSet::new();
    for score in scores {
        if score.score > 1000
            || !store.profiles.contains(&score.profile)
            || !seen.insert(&score.profile)
        {
            return Err("Invalid multiplayer score or profile".into());
        }
    }
    let played_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_secs())
        .unwrap_or(0);
    for score in scores {
        store.scores.push(crate::profile::ScoreRecord {
            profile: score.profile.clone(),
            song_hash: song_hash.into(),
            score: score.score,
            played_at,
            difficulty: if matches!(difficulty, "easy" | "pro") {
                difficulty.into()
            } else {
                "medium".into()
            },
            pitch_tolerance_factor: crate::profile::normalized_pitch_tolerance_factor(factor),
        });
    }
    store.save();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn player(id: &str, channel: Option<u16>) -> MultiplayerPlayer {
        MultiplayerPlayer {
            id: id.into(),
            profile: id.into(),
            microphone: "interface".into(),
            channel,
            color: "cyan".into(),
        }
    }
    #[test]
    fn input_channels_must_be_distinct_and_not_mixed_twice() {
        assert!(
            validate_multiplayer_players(&[player("a", Some(0)), player("b", Some(1))]).is_ok()
        );
        assert!(
            validate_multiplayer_players(&[player("a", Some(0)), player("b", Some(0))]).is_err()
        );
        assert!(validate_multiplayer_players(&[player("a", None), player("b", Some(1))]).is_err());
        assert!(
            validate_multiplayer_players(&[player("a", Some(0)), player("a", Some(1))]).is_err()
        );
        assert!(validate_multiplayer_players(&[player("a", Some(0))]).is_err());
    }
}
