use rusqlite::{OptionalExtension, params};

use crate::recording::{PracticeSession, RecordingTake, SavePracticeSession, TransportSegment};

use super::connection::with_conn;

pub fn upsert_recording_take(take: &RecordingTake) -> rusqlite::Result<()> {
    let payload = serde_json::to_string(take)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    with_conn(|connection| {
        connection.execute(
            "INSERT INTO recording_takes (id, session_id, song_hash, profile, status, created_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
            params![take.id, take.session_id, take.song_hash, take.profile, take.status, take.created_at as i64, payload],
        )?;
        Ok(())
    })
}

pub fn load_recording_take(take_id: &str) -> rusqlite::Result<Option<RecordingTake>> {
    with_conn(|connection| {
        connection
            .query_row(
                "SELECT payload FROM recording_takes WHERE id = ?1",
                params![take_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|payload| {
                serde_json::from_str(&payload).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })
            })
            .transpose()
    })
}

pub fn list_recording_takes_by_status(status: &str) -> rusqlite::Result<Vec<RecordingTake>> {
    with_conn(|connection| {
        let mut statement = connection.prepare(
            "SELECT payload FROM recording_takes WHERE status = ?1 ORDER BY created_at ASC",
        )?;
        statement
            .query_map(params![status], |row| row.get::<_, String>(0))?
            .map(|payload| {
                payload.and_then(|payload| {
                    serde_json::from_str(&payload).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
            })
            .collect()
    })
}

pub fn practice_session_exists(session_id: &str) -> rusqlite::Result<bool> {
    with_conn(|connection| {
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM practice_sessions WHERE id = ?1)",
            params![session_id],
            |row| row.get(0),
        )
    })
}

pub fn repair_recovered_session_end_time(session_id: &str, ended_at: u64) -> rusqlite::Result<()> {
    with_conn(|connection| {
        connection.execute(
            "UPDATE practice_sessions SET ended_at = ?2
             WHERE id = ?1 AND kind = 'recovered-recording'",
            params![session_id, ended_at as i64],
        )?;
        Ok(())
    })
}

pub fn upsert_practice_session(session: &SavePracticeSession) -> rusqlite::Result<()> {
    let transport_json = serde_json::to_string(&session.transport_segments)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    with_conn(|connection| {
        connection.execute(
            "INSERT INTO practice_sessions
             (id, profile, song_hash, kind, started_at, ended_at, performance_json, recording_take_id, transport_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at,
             performance_json = excluded.performance_json, recording_take_id = excluded.recording_take_id,
             transport_json = excluded.transport_json",
            params![
                session.id,
                session.profile,
                session.song_hash,
                session.kind,
                session.started_at as i64,
                session.ended_at as i64,
                session.performance_json,
                session.recording_take_id,
                transport_json,
            ],
        )?;
        Ok(())
    })
}

pub fn list_practice_sessions(profile: Option<&str>) -> rusqlite::Result<Vec<PracticeSession>> {
    with_conn(|connection| {
        let sql = if profile.is_some() {
            "SELECT id, profile, song_hash, kind, started_at, ended_at, performance_json, recording_take_id, transport_json
             FROM practice_sessions WHERE profile = ?1 ORDER BY started_at DESC LIMIT 200"
        } else {
            "SELECT id, profile, song_hash, kind, started_at, ended_at, performance_json, recording_take_id, transport_json
             FROM practice_sessions ORDER BY started_at DESC LIMIT 200"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = if let Some(profile) = profile {
            statement.query_map(params![profile], map_session)?
        } else {
            statement.query_map([], map_session)?
        };
        rows.collect()
    })
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<PracticeSession> {
    let started_at: i64 = row.get(4)?;
    let ended_at: Option<i64> = row.get(5)?;
    let transport_json: String = row.get(8)?;
    let transport_segments =
        serde_json::from_str::<Vec<TransportSegment>>(&transport_json).unwrap_or_default();
    Ok(PracticeSession {
        id: row.get(0)?,
        profile: row.get(1)?,
        song_hash: row.get(2)?,
        kind: row.get(3)?,
        started_at: started_at.max(0) as u64,
        ended_at: ended_at.map(|value| value.max(0) as u64),
        performance_json: row.get(6)?,
        recording_take_id: row.get(7)?,
        transport_segments,
    })
}
