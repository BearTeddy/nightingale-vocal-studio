use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::library_db;

fn default_curriculum_version() -> u32 {
    1
}

fn default_lesson_version() -> u32 {
    1
}

fn default_attempt_limit() -> u32 {
    50
}

fn empty_json_object() -> String {
    "{}".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearnerProfile {
    pub profile: String,
    #[serde(default = "default_curriculum_version")]
    pub curriculum_version: u32,
    pub current_stage: String,
    #[serde(default)]
    pub comfortable_low_midi: Option<f64>,
    #[serde(default)]
    pub comfortable_high_midi: Option<f64>,
    #[serde(default)]
    pub reliable_low_midi: Option<f64>,
    #[serde(default)]
    pub reliable_high_midi: Option<f64>,
    #[serde(default)]
    pub explored_low_midi: Option<f64>,
    #[serde(default)]
    pub explored_high_midi: Option<f64>,
    #[serde(default)]
    pub assistance_override: Option<String>,
    #[serde(default)]
    pub device_calibration_json: Option<String>,
    #[serde(default = "empty_json_object")]
    pub state_json: String,
    /// Unix timestamp in milliseconds.
    #[ts(type = "number")]
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearningAttempt {
    pub id: String,
    pub profile: String,
    pub skill_id: String,
    pub lesson_id: String,
    #[serde(default = "default_lesson_version")]
    pub lesson_version: u32,
    pub stage: String,
    pub kind: String,
    pub intent: String,
    pub assist_preset: String,
    #[serde(default)]
    pub scoring_policy_id: Option<String>,
    #[serde(default)]
    pub song_hash: Option<String>,
    #[serde(default)]
    pub practice_session_id: Option<String>,
    #[serde(default)]
    pub recording_take_id: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub unfamiliar_target: bool,
    /// Unix timestamp in milliseconds.
    #[ts(type = "number")]
    pub started_at_ms: u64,
    /// Unix timestamp in milliseconds.
    #[ts(type = "number")]
    pub ended_at_ms: u64,
    #[serde(default)]
    pub ranked: bool,
    pub valid_evidence: bool,
    pub completion_reason: String,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub signal_confidence: Option<f64>,
    #[serde(default = "empty_json_object")]
    pub evidence_json: String,
    #[serde(default = "empty_json_object")]
    pub context_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearnerProgress {
    pub profile: String,
    pub skill_id: String,
    pub stage: String,
    pub mastery_state: String,
    #[serde(default)]
    pub attempt_count: u32,
    #[serde(default)]
    pub valid_attempt_count: u32,
    #[serde(default)]
    pub rolling_score: Option<f64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub next_review_at_ms: Option<u64>,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub last_attempt_at_ms: Option<u64>,
    #[serde(default)]
    pub review_recommended: bool,
    #[serde(default = "empty_json_object")]
    pub state_json: String,
    /// Unix timestamp in milliseconds.
    #[ts(type = "number")]
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TechniquePreference {
    pub profile: String,
    pub cue_id: String,
    pub status: String,
    #[serde(default)]
    pub helpful_count: u32,
    #[serde(default)]
    pub unhelpful_count: u32,
    #[serde(default)]
    pub last_effort_delta: Option<f64>,
    #[serde(default = "empty_json_object")]
    pub details_json: String,
    /// Unix timestamp in milliseconds.
    #[ts(type = "number")]
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearningState {
    pub learner_profile: Option<LearnerProfile>,
    pub progress: Vec<LearnerProgress>,
    pub technique_preferences: Vec<TechniquePreference>,
    pub recent_attempts: Vec<LearningAttempt>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SaveLearningAttemptRequest {
    pub attempt: LearningAttempt,
    #[serde(default)]
    pub learner_profile: Option<LearnerProfile>,
    #[serde(default)]
    pub progress_updates: Vec<LearnerProgress>,
    #[serde(default)]
    pub technique_preferences: Vec<TechniquePreference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SaveLearnerProfileRequest {
    pub learner_profile: LearnerProfile,
    #[serde(default)]
    pub technique_preferences: Vec<TechniquePreference>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ListLearningAttemptsQuery {
    pub profile: String,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub lesson_id: Option<String>,
    #[serde(default = "default_attempt_limit")]
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LearningAttemptPage {
    pub items: Vec<LearningAttempt>,
    #[ts(type = "number")]
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
    pub has_more: bool,
}

fn require_non_empty(label: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 256 {
        return Err(format!("{label} is too long"));
    }
    Ok(())
}

fn validate_optional_midi(label: &str, value: Option<f64>) -> Result<(), String> {
    if value.is_some_and(|midi| !midi.is_finite() || !(0.0..=127.0).contains(&midi)) {
        return Err(format!("{label} must be a finite MIDI pitch from 0 to 127"));
    }
    Ok(())
}

fn validate_json(label: &str, value: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(value)
        .map(|_| ())
        .map_err(|error| format!("{label} must be valid JSON: {error}"))
}

impl LearnerProfile {
    fn validate(&self) -> Result<(), String> {
        require_non_empty("profile", &self.profile)?;
        require_non_empty("current_stage", &self.current_stage)?;
        if self.curriculum_version == 0 {
            return Err("curriculum_version must be at least 1".into());
        }
        validate_optional_midi("comfortable_low_midi", self.comfortable_low_midi)?;
        validate_optional_midi("comfortable_high_midi", self.comfortable_high_midi)?;
        validate_optional_midi("reliable_low_midi", self.reliable_low_midi)?;
        validate_optional_midi("reliable_high_midi", self.reliable_high_midi)?;
        validate_optional_midi("explored_low_midi", self.explored_low_midi)?;
        validate_optional_midi("explored_high_midi", self.explored_high_midi)?;
        if self
            .comfortable_low_midi
            .zip(self.comfortable_high_midi)
            .is_some_and(|(low, high)| low > high)
        {
            return Err("comfortable_low_midi cannot exceed comfortable_high_midi".into());
        }
        if let Some(calibration) = self.device_calibration_json.as_deref() {
            validate_json("device_calibration_json", calibration)?;
        }
        validate_json("state_json", &self.state_json)
    }
}

impl LearningAttempt {
    fn validate(&self) -> Result<(), String> {
        for (label, value) in [
            ("attempt.id", self.id.as_str()),
            ("attempt.profile", self.profile.as_str()),
            ("attempt.skill_id", self.skill_id.as_str()),
            ("attempt.lesson_id", self.lesson_id.as_str()),
            ("attempt.stage", self.stage.as_str()),
            ("attempt.kind", self.kind.as_str()),
            ("attempt.intent", self.intent.as_str()),
            ("attempt.assist_preset", self.assist_preset.as_str()),
            ("attempt.completion_reason", self.completion_reason.as_str()),
        ] {
            require_non_empty(label, value)?;
        }
        if self.lesson_version == 0 {
            return Err("attempt.lesson_version must be at least 1".into());
        }
        if self.ended_at_ms < self.started_at_ms {
            return Err("attempt.ended_at_ms cannot be earlier than started_at_ms".into());
        }
        if self
            .score
            .is_some_and(|score| !score.is_finite() || !(0.0..=100.0).contains(&score))
        {
            return Err("attempt.score must be a finite value from 0 to 100".into());
        }
        if self
            .signal_confidence
            .is_some_and(|confidence| !confidence.is_finite() || !(0.0..=1.0).contains(&confidence))
        {
            return Err("attempt.signal_confidence must be from 0 to 1".into());
        }
        validate_json("attempt.evidence_json", &self.evidence_json)?;
        validate_json("attempt.context_json", &self.context_json)
    }
}

impl LearnerProgress {
    fn validate(&self, profile: &str) -> Result<(), String> {
        if self.profile != profile {
            return Err("progress update profile does not match attempt profile".into());
        }
        require_non_empty("progress.skill_id", &self.skill_id)?;
        require_non_empty("progress.stage", &self.stage)?;
        require_non_empty("progress.mastery_state", &self.mastery_state)?;
        if self
            .rolling_score
            .is_some_and(|score| !score.is_finite() || !(0.0..=100.0).contains(&score))
        {
            return Err("progress.rolling_score must be a finite value from 0 to 100".into());
        }
        validate_json("progress.state_json", &self.state_json)
    }
}

impl TechniquePreference {
    fn validate(&self, profile: &str) -> Result<(), String> {
        if self.profile != profile {
            return Err("technique preference profile does not match request profile".into());
        }
        require_non_empty("technique_preference.cue_id", &self.cue_id)?;
        require_non_empty("technique_preference.status", &self.status)?;
        if self
            .last_effort_delta
            .is_some_and(|value| !value.is_finite() || !(-10.0..=10.0).contains(&value))
        {
            return Err("technique_preference.last_effort_delta must be from -10 to 10".into());
        }
        validate_json("technique_preference.details_json", &self.details_json)
    }
}

impl SaveLearningAttemptRequest {
    fn validate(&self) -> Result<(), String> {
        self.attempt.validate()?;
        if let Some(profile) = &self.learner_profile {
            profile.validate()?;
            if profile.profile != self.attempt.profile {
                return Err("learner profile does not match attempt profile".into());
            }
        }
        for progress in &self.progress_updates {
            progress.validate(&self.attempt.profile)?;
        }
        for preference in &self.technique_preferences {
            preference.validate(&self.attempt.profile)?;
        }
        Ok(())
    }
}

impl SaveLearnerProfileRequest {
    fn validate(&self) -> Result<(), String> {
        self.learner_profile.validate()?;
        for preference in &self.technique_preferences {
            preference.validate(&self.learner_profile.profile)?;
        }
        Ok(())
    }
}

impl ListLearningAttemptsQuery {
    fn validate(&self) -> Result<(), String> {
        require_non_empty("profile", &self.profile)?;
        if self
            .skill_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("skill_id cannot be blank".into());
        }
        if self
            .lesson_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("lesson_id cannot be blank".into());
        }
        Ok(())
    }
}

pub fn load_learning_state(profile: &str) -> Result<LearningState, String> {
    require_non_empty("profile", profile)?;
    library_db::load_learning_state(profile).map_err(|error| error.to_string())
}

pub fn save_learning_attempt(request: SaveLearningAttemptRequest) -> Result<(), String> {
    request.validate()?;
    library_db::save_learning_attempt(&request).map_err(|error| error.to_string())
}

pub fn save_learner_profile(request: SaveLearnerProfileRequest) -> Result<(), String> {
    request.validate()?;
    library_db::save_learner_profile(&request).map_err(|error| error.to_string())
}

pub fn list_learning_attempts(
    mut query: ListLearningAttemptsQuery,
) -> Result<LearningAttemptPage, String> {
    query.validate()?;
    query.limit = query.limit.clamp(1, 200);
    library_db::list_learning_attempts(&query).map_err(|error| error.to_string())
}

pub fn delete_learning_state(profile: &str) -> Result<(), String> {
    require_non_empty("profile", profile)?;
    library_db::delete_learning_state(profile).map_err(|error| error.to_string())
}
