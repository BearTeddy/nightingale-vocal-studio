use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::learning::{
    LearnerProfile, LearnerProgress, LearningAttempt, LearningAttemptPage, LearningState,
    ListLearningAttemptsQuery, SaveLearnerProfileRequest, SaveLearningAttemptRequest,
    TechniquePreference,
};

use super::connection::{with_conn, with_conn_mut};

const RECENT_ATTEMPT_LIMIT: i64 = 20;

const PROFILE_COLUMNS: &str = "profile, curriculum_version, current_stage, comfortable_low_midi,
     comfortable_high_midi, reliable_low_midi, reliable_high_midi,
     explored_low_midi, explored_high_midi, assistance_override,
     device_calibration_json, state_json, updated_at_ms";

const ATTEMPT_COLUMNS: &str = "id, profile, skill_id, lesson_id, lesson_version, stage, kind,
     intent, assist_preset, scoring_policy_id, song_hash, practice_session_id,
     recording_take_id, target_id, unfamiliar_target, started_at_ms, ended_at_ms,
     ranked, valid_evidence, completion_reason, score, signal_confidence,
     evidence_json, context_json";

const PROGRESS_COLUMNS: &str = "profile, skill_id, stage, mastery_state, attempt_count,
     valid_attempt_count, rolling_score, next_review_at_ms, last_attempt_at_ms,
     review_recommended, state_json, updated_at_ms";

const TECHNIQUE_COLUMNS: &str = "profile, cue_id, status, helpful_count, unhelpful_count,
     last_effort_delta, details_json, updated_at_ms";

pub fn load_learning_state(profile: &str) -> rusqlite::Result<LearningState> {
    with_conn(|connection| load_learning_state_from(connection, profile))
}

pub fn save_learning_attempt(request: &SaveLearningAttemptRequest) -> rusqlite::Result<()> {
    with_conn_mut(|connection| save_learning_attempt_to(connection, request))
}

pub fn save_learner_profile(request: &SaveLearnerProfileRequest) -> rusqlite::Result<()> {
    with_conn_mut(|connection| save_learner_profile_to(connection, request))
}

pub fn list_learning_attempts(
    query: &ListLearningAttemptsQuery,
) -> rusqlite::Result<LearningAttemptPage> {
    with_conn(|connection| list_learning_attempts_from(connection, query))
}

pub fn delete_learning_state(profile: &str) -> rusqlite::Result<()> {
    with_conn(|connection| {
        connection.execute(
            "DELETE FROM learner_profiles WHERE profile = ?1",
            params![profile],
        )?;
        Ok(())
    })
}

fn load_learning_state_from(
    connection: &Connection,
    profile: &str,
) -> rusqlite::Result<LearningState> {
    let learner_profile = connection
        .query_row(
            &format!("SELECT {PROFILE_COLUMNS} FROM learner_profiles WHERE profile = ?1"),
            params![profile],
            map_learner_profile,
        )
        .optional()?;

    let progress = {
        let mut statement = connection.prepare(&format!(
            "SELECT {PROGRESS_COLUMNS} FROM learner_progress
             WHERE profile = ?1 ORDER BY skill_id COLLATE NOCASE ASC"
        ))?;
        statement
            .query_map(params![profile], map_learner_progress)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let technique_preferences = {
        let mut statement = connection.prepare(&format!(
            "SELECT {TECHNIQUE_COLUMNS} FROM technique_preferences
             WHERE profile = ?1 ORDER BY cue_id COLLATE NOCASE ASC"
        ))?;
        statement
            .query_map(params![profile], map_technique_preference)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    let recent_attempts = {
        let mut statement = connection.prepare(&format!(
            "SELECT {ATTEMPT_COLUMNS} FROM learning_attempts
             WHERE profile = ?1 ORDER BY started_at_ms DESC, id DESC LIMIT ?2"
        ))?;
        statement
            .query_map(params![profile, RECENT_ATTEMPT_LIMIT], map_learning_attempt)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };

    Ok(LearningState {
        learner_profile,
        progress,
        technique_preferences,
        recent_attempts,
    })
}

fn save_learning_attempt_to(
    connection: &mut Connection,
    request: &SaveLearningAttemptRequest,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;

    if let Some(profile) = &request.learner_profile {
        upsert_learner_profile(&transaction, profile)?;
    } else {
        ensure_learner_profile(&transaction, &request.attempt)?;
    }

    insert_learning_attempt(&transaction, &request.attempt)?;
    for progress in &request.progress_updates {
        upsert_learner_progress(&transaction, progress)?;
    }
    for preference in &request.technique_preferences {
        upsert_technique_preference(&transaction, preference)?;
    }

    transaction.commit()
}

fn save_learner_profile_to(
    connection: &mut Connection,
    request: &SaveLearnerProfileRequest,
) -> rusqlite::Result<()> {
    let transaction = connection.transaction()?;
    upsert_learner_profile(&transaction, &request.learner_profile)?;
    for preference in &request.technique_preferences {
        upsert_technique_preference(&transaction, preference)?;
    }
    transaction.commit()
}

fn ensure_learner_profile(
    transaction: &Transaction<'_>,
    attempt: &LearningAttempt,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO learner_profiles
         (profile, curriculum_version, current_stage, state_json, updated_at_ms)
         VALUES (?1, 1, ?2, '{}', ?3)
         ON CONFLICT(profile) DO NOTHING",
        params![attempt.profile, attempt.stage, attempt.ended_at_ms as i64],
    )?;
    Ok(())
}

fn upsert_learner_profile(
    transaction: &Transaction<'_>,
    profile: &LearnerProfile,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO learner_profiles
         (profile, curriculum_version, current_stage, comfortable_low_midi,
          comfortable_high_midi, reliable_low_midi, reliable_high_midi,
          explored_low_midi, explored_high_midi, assistance_override,
          device_calibration_json, state_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(profile) DO UPDATE SET
          curriculum_version = excluded.curriculum_version,
          current_stage = excluded.current_stage,
          comfortable_low_midi = excluded.comfortable_low_midi,
          comfortable_high_midi = excluded.comfortable_high_midi,
          reliable_low_midi = excluded.reliable_low_midi,
          reliable_high_midi = excluded.reliable_high_midi,
          explored_low_midi = excluded.explored_low_midi,
          explored_high_midi = excluded.explored_high_midi,
          assistance_override = excluded.assistance_override,
          device_calibration_json = excluded.device_calibration_json,
          state_json = excluded.state_json,
          updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= learner_profiles.updated_at_ms",
        params![
            profile.profile,
            profile.curriculum_version as i64,
            profile.current_stage,
            profile.comfortable_low_midi,
            profile.comfortable_high_midi,
            profile.reliable_low_midi,
            profile.reliable_high_midi,
            profile.explored_low_midi,
            profile.explored_high_midi,
            profile.assistance_override,
            profile.device_calibration_json,
            profile.state_json,
            profile.updated_at_ms as i64,
        ],
    )?;
    Ok(())
}

fn insert_learning_attempt(
    transaction: &Transaction<'_>,
    attempt: &LearningAttempt,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO learning_attempts
         (id, profile, skill_id, lesson_id, lesson_version, stage, kind, intent,
          assist_preset, scoring_policy_id, song_hash, practice_session_id,
          recording_take_id, target_id, unfamiliar_target, started_at_ms, ended_at_ms,
          ranked, valid_evidence, completion_reason, score, signal_confidence,
          evidence_json, context_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
         ON CONFLICT(id) DO NOTHING",
        params![
            attempt.id,
            attempt.profile,
            attempt.skill_id,
            attempt.lesson_id,
            attempt.lesson_version as i64,
            attempt.stage,
            attempt.kind,
            attempt.intent,
            attempt.assist_preset,
            attempt.scoring_policy_id,
            attempt.song_hash,
            attempt.practice_session_id,
            attempt.recording_take_id,
            attempt.target_id,
            attempt.unfamiliar_target,
            attempt.started_at_ms as i64,
            attempt.ended_at_ms as i64,
            attempt.ranked,
            attempt.valid_evidence,
            attempt.completion_reason,
            attempt.score,
            attempt.signal_confidence,
            attempt.evidence_json,
            attempt.context_json,
        ],
    )?;
    Ok(())
}

fn upsert_learner_progress(
    transaction: &Transaction<'_>,
    progress: &LearnerProgress,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO learner_progress
         (profile, skill_id, stage, mastery_state, attempt_count, valid_attempt_count,
          rolling_score, next_review_at_ms, last_attempt_at_ms, review_recommended,
          state_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(profile, skill_id) DO UPDATE SET
          stage = excluded.stage,
          mastery_state = excluded.mastery_state,
          attempt_count = excluded.attempt_count,
          valid_attempt_count = excluded.valid_attempt_count,
          rolling_score = excluded.rolling_score,
          next_review_at_ms = excluded.next_review_at_ms,
          last_attempt_at_ms = excluded.last_attempt_at_ms,
          review_recommended = excluded.review_recommended,
          state_json = excluded.state_json,
          updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= learner_progress.updated_at_ms",
        params![
            progress.profile,
            progress.skill_id,
            progress.stage,
            progress.mastery_state,
            progress.attempt_count as i64,
            progress.valid_attempt_count as i64,
            progress.rolling_score,
            progress.next_review_at_ms.map(|value| value as i64),
            progress.last_attempt_at_ms.map(|value| value as i64),
            progress.review_recommended,
            progress.state_json,
            progress.updated_at_ms as i64,
        ],
    )?;
    Ok(())
}

fn upsert_technique_preference(
    transaction: &Transaction<'_>,
    preference: &TechniquePreference,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO technique_preferences
         (profile, cue_id, status, helpful_count, unhelpful_count,
          last_effort_delta, details_json, updated_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(profile, cue_id) DO UPDATE SET
          status = excluded.status,
          helpful_count = excluded.helpful_count,
          unhelpful_count = excluded.unhelpful_count,
          last_effort_delta = excluded.last_effort_delta,
          details_json = excluded.details_json,
          updated_at_ms = excluded.updated_at_ms
         WHERE excluded.updated_at_ms >= technique_preferences.updated_at_ms",
        params![
            preference.profile,
            preference.cue_id,
            preference.status,
            preference.helpful_count as i64,
            preference.unhelpful_count as i64,
            preference.last_effort_delta,
            preference.details_json,
            preference.updated_at_ms as i64,
        ],
    )?;
    Ok(())
}

fn list_learning_attempts_from(
    connection: &Connection,
    query: &ListLearningAttemptsQuery,
) -> rusqlite::Result<LearningAttemptPage> {
    let total: i64 = connection.query_row(
        "SELECT COUNT(*) FROM learning_attempts
         WHERE profile = ?1
           AND (?2 IS NULL OR skill_id = ?2)
           AND (?3 IS NULL OR lesson_id = ?3)",
        params![query.profile, query.skill_id, query.lesson_id],
        |row| row.get(0),
    )?;

    let mut statement = connection.prepare(&format!(
        "SELECT {ATTEMPT_COLUMNS} FROM learning_attempts
         WHERE profile = ?1
           AND (?2 IS NULL OR skill_id = ?2)
           AND (?3 IS NULL OR lesson_id = ?3)
         ORDER BY started_at_ms DESC, id DESC LIMIT ?4 OFFSET ?5"
    ))?;
    let items = statement
        .query_map(
            params![
                query.profile,
                query.skill_id,
                query.lesson_id,
                query.limit as i64,
                query.offset as i64,
            ],
            map_learning_attempt,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total = total.max(0) as u64;
    let has_more = (query.offset as u64).saturating_add(items.len() as u64) < total;

    Ok(LearningAttemptPage {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        has_more,
    })
}

fn map_learner_profile(row: &rusqlite::Row<'_>) -> rusqlite::Result<LearnerProfile> {
    let curriculum_version: i64 = row.get(1)?;
    let updated_at_ms: i64 = row.get(12)?;
    Ok(LearnerProfile {
        profile: row.get(0)?,
        curriculum_version: curriculum_version.max(1) as u32,
        current_stage: row.get(2)?,
        comfortable_low_midi: row.get(3)?,
        comfortable_high_midi: row.get(4)?,
        reliable_low_midi: row.get(5)?,
        reliable_high_midi: row.get(6)?,
        explored_low_midi: row.get(7)?,
        explored_high_midi: row.get(8)?,
        assistance_override: row.get(9)?,
        device_calibration_json: row.get(10)?,
        state_json: row.get(11)?,
        updated_at_ms: updated_at_ms.max(0) as u64,
    })
}

fn map_learning_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<LearningAttempt> {
    let lesson_version: i64 = row.get(4)?;
    let started_at_ms: i64 = row.get(15)?;
    let ended_at_ms: i64 = row.get(16)?;
    Ok(LearningAttempt {
        id: row.get(0)?,
        profile: row.get(1)?,
        skill_id: row.get(2)?,
        lesson_id: row.get(3)?,
        lesson_version: lesson_version.max(1) as u32,
        stage: row.get(5)?,
        kind: row.get(6)?,
        intent: row.get(7)?,
        assist_preset: row.get(8)?,
        scoring_policy_id: row.get(9)?,
        song_hash: row.get(10)?,
        practice_session_id: row.get(11)?,
        recording_take_id: row.get(12)?,
        target_id: row.get(13)?,
        unfamiliar_target: row.get(14)?,
        started_at_ms: started_at_ms.max(0) as u64,
        ended_at_ms: ended_at_ms.max(0) as u64,
        ranked: row.get(17)?,
        valid_evidence: row.get(18)?,
        completion_reason: row.get(19)?,
        score: row.get(20)?,
        signal_confidence: row.get(21)?,
        evidence_json: row.get(22)?,
        context_json: row.get(23)?,
    })
}

fn map_learner_progress(row: &rusqlite::Row<'_>) -> rusqlite::Result<LearnerProgress> {
    let attempt_count: i64 = row.get(4)?;
    let valid_attempt_count: i64 = row.get(5)?;
    let next_review_at_ms: Option<i64> = row.get(7)?;
    let last_attempt_at_ms: Option<i64> = row.get(8)?;
    let updated_at_ms: i64 = row.get(11)?;
    Ok(LearnerProgress {
        profile: row.get(0)?,
        skill_id: row.get(1)?,
        stage: row.get(2)?,
        mastery_state: row.get(3)?,
        attempt_count: attempt_count.max(0) as u32,
        valid_attempt_count: valid_attempt_count.max(0) as u32,
        rolling_score: row.get(6)?,
        next_review_at_ms: next_review_at_ms.map(|value| value.max(0) as u64),
        last_attempt_at_ms: last_attempt_at_ms.map(|value| value.max(0) as u64),
        review_recommended: row.get(9)?,
        state_json: row.get(10)?,
        updated_at_ms: updated_at_ms.max(0) as u64,
    })
}

fn map_technique_preference(row: &rusqlite::Row<'_>) -> rusqlite::Result<TechniquePreference> {
    let helpful_count: i64 = row.get(3)?;
    let unhelpful_count: i64 = row.get(4)?;
    let updated_at_ms: i64 = row.get(7)?;
    Ok(TechniquePreference {
        profile: row.get(0)?,
        cue_id: row.get(1)?,
        status: row.get(2)?,
        helpful_count: helpful_count.max(0) as u32,
        unhelpful_count: unhelpful_count.max(0) as u32,
        last_effort_delta: row.get(5)?,
        details_json: row.get(6)?,
        updated_at_ms: updated_at_ms.max(0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_db::migrations::{configure, run_migrations};

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        configure(&connection).unwrap();
        run_migrations(&connection).unwrap();
        connection
    }

    fn attempt_request() -> SaveLearningAttemptRequest {
        SaveLearningAttemptRequest {
            attempt: LearningAttempt {
                id: "attempt-1".into(),
                profile: "Singer".into(),
                skill_id: "pitch-center".into(),
                lesson_id: "center-one-note".into(),
                lesson_version: 1,
                stage: "center-and-hold".into(),
                kind: "lesson".into(),
                intent: "learn".into(),
                assist_preset: "guided".into(),
                scoring_policy_id: Some("balanced-v1".into()),
                song_hash: None,
                practice_session_id: Some("practice-1".into()),
                recording_take_id: None,
                target_id: Some("middle-c".into()),
                unfamiliar_target: false,
                started_at_ms: 1_000,
                ended_at_ms: 1_030,
                ranked: false,
                valid_evidence: true,
                completion_reason: "completed".into(),
                score: Some(84.5),
                signal_confidence: Some(0.93),
                evidence_json: r#"{"center_error_cents":18.0}"#.into(),
                context_json: r#"{"tempo":0.9}"#.into(),
            },
            learner_profile: Some(LearnerProfile {
                profile: "Singer".into(),
                curriculum_version: 1,
                current_stage: "center-and-hold".into(),
                comfortable_low_midi: Some(48.0),
                comfortable_high_midi: Some(72.0),
                reliable_low_midi: Some(50.0),
                reliable_high_midi: Some(70.0),
                explored_low_midi: Some(46.0),
                explored_high_midi: Some(74.0),
                assistance_override: None,
                device_calibration_json: Some(r#"{"noise_floor_db":-55}"#.into()),
                state_json: "{}".into(),
                updated_at_ms: 1_030,
            }),
            progress_updates: vec![LearnerProgress {
                profile: "Singer".into(),
                skill_id: "pitch-center".into(),
                stage: "center-and-hold".into(),
                mastery_state: "assisted".into(),
                attempt_count: 3,
                valid_attempt_count: 3,
                rolling_score: Some(82.0),
                next_review_at_ms: Some(86_400_000),
                last_attempt_at_ms: Some(1_030),
                review_recommended: false,
                state_json: "{}".into(),
                updated_at_ms: 1_030,
            }],
            technique_preferences: vec![TechniquePreference {
                profile: "Singer".into(),
                cue_id: "released-jaw".into(),
                status: "preferred".into(),
                helpful_count: 2,
                unhelpful_count: 0,
                last_effort_delta: Some(-1.0),
                details_json: "{}".into(),
                updated_at_ms: 1_030,
            }],
        }
    }

    #[test]
    fn learning_state_round_trips_and_attempts_page() {
        let mut connection = test_connection();
        let request = attempt_request();
        save_learning_attempt_to(&mut connection, &request).unwrap();
        save_learning_attempt_to(&mut connection, &request).unwrap();

        let state = load_learning_state_from(&connection, "Singer").unwrap();
        assert_eq!(state.learner_profile, request.learner_profile);
        assert_eq!(state.progress, request.progress_updates);
        assert_eq!(state.technique_preferences, request.technique_preferences);
        assert_eq!(state.recent_attempts, vec![request.attempt.clone()]);

        let page = list_learning_attempts_from(
            &connection,
            &ListLearningAttemptsQuery {
                profile: "Singer".into(),
                skill_id: Some("pitch-center".into()),
                lesson_id: None,
                limit: 1,
                offset: 0,
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
        assert_eq!(page.items, vec![request.attempt]);
        assert!(!page.has_more);
    }

    #[test]
    fn failed_related_write_rolls_back_the_attempt() {
        let mut connection = test_connection();
        let mut request = attempt_request();
        request.learner_profile = None;
        request.progress_updates[0].profile = "Missing profile".into();

        assert!(save_learning_attempt_to(&mut connection, &request).is_err());
        let attempt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM learning_attempts", [], |row| {
                row.get(0)
            })
            .unwrap();
        let profile_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM learner_profiles", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(attempt_count, 0);
        assert_eq!(profile_count, 0);
    }
}
