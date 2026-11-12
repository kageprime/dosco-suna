//! SQLite store for Kortix Capture.
//!
//! Tables: application, domain, video, segment, frame, ocr, window_bound,
//! ocr_fts (FTS5 over frame text), ax_blob/ax_snapshot, timezone, app_version,
//! metadata, once_tasks, audio + audio_transcript + audio_fts (audio memory).

use super::paths::MemoryPaths;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::time::Duration;

/// The schema this build writes. [`migrate`] does no work on a library at this
/// version. Increase it for every change to `SCHEMA`, `INDEXES` or the added
/// columns in [`migrate`]: a library at the old version then migrates once.
/// 2: indexes for the sync queue, retention and remote retention queries.
pub const SCHEMA_VERSION: i64 = 2;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS application (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    icon_path TEXT,
    display_name TEXT,
    is_user_app INTEGER,
    dominant_color INTEGER,
    UNIQUE(bundle_id, version)
);
CREATE INDEX IF NOT EXISTS idx_application_bundle_id ON application(bundle_id);

CREATE TABLE IF NOT EXISTS domain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    normalized_domain TEXT NOT NULL UNIQUE,
    common_name TEXT,
    icon_path TEXT,
    dominant_color INTEGER
);

CREATE TABLE IF NOT EXISTS video (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    height INTEGER NOT NULL,
    width INTEGER NOT NULL,
    path TEXT NOT NULL,
    num_frames INTEGER NOT NULL,
    status INTEGER NOT NULL DEFAULT 0,          -- 0 full, 1 downscaled, 2 deleted
    size_bytes INTEGER,
    start_timestamp INTEGER,                    
    end_timestamp INTEGER                       
);
CREATE INDEX IF NOT EXISTS idx_video_start ON video(start_timestamp);

CREATE TABLE IF NOT EXISTS segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_frame_id INTEGER NOT NULL,
    application INTEGER REFERENCES application(id),
    domain INTEGER REFERENCES domain(id),
    url TEXT
);
CREATE INDEX IF NOT EXISTS idx_segment_application ON segment(application);
CREATE INDEX IF NOT EXISTS idx_segment_domain ON segment(domain);

CREATE TABLE IF NOT EXISTS frame (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,                 -- epoch ms
    video INTEGER REFERENCES video(id),
    video_index INTEGER,
    image_path TEXT,                            -- staged still until encoded
    width INTEGER,
    height INTEGER,
    foreground TEXT,                            -- OCR text inside the focused window
    background TEXT,                            -- OCR text elsewhere
    title TEXT,
    tree BLOB,
    segment INTEGER REFERENCES segment(id),
    is_inactive INTEGER NOT NULL DEFAULT 0,
    ax_root_hash BLOB,
    capture_display_x REAL,
    capture_display_y REAL,
    capture_display_width REAL,
    capture_display_height REAL,
    capture_reason TEXT,
    dhash TEXT,                                 -- perceptual hash
    image_hash TEXT,                            -- sha256 of the staged still
    ocr_status INTEGER NOT NULL DEFAULT 0       -- 0 pending, 1 done, 2 copied, 3 failed, 4 off (no text read)
);
CREATE INDEX IF NOT EXISTS idx_frame_timestamp ON frame(timestamp);
CREATE INDEX IF NOT EXISTS idx_frame_segment ON frame(segment);
CREATE INDEX IF NOT EXISTS idx_frame_video ON frame(video);
CREATE INDEX IF NOT EXISTS idx_frame_ocr_pending ON frame(id) WHERE ocr_status = 0;
CREATE INDEX IF NOT EXISTS idx_frame_unfinalized ON frame(id, image_path) WHERE video IS NULL AND image_path IS NOT NULL;

-- Boxes index into (foreground || background): text_offset >= length(foreground)
-- means the box belongs to the background text.
CREATE TABLE IF NOT EXISTS ocr (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame INTEGER NOT NULL REFERENCES frame(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    text_offset INTEGER NOT NULL,
    text_length INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ocr_frame ON ocr(frame);

CREATE TABLE IF NOT EXISTS window_bound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame INTEGER NOT NULL REFERENCES frame(id),
    application INTEGER NOT NULL REFERENCES application(id),
    window_title TEXT,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    window_layer INTEGER NOT NULL DEFAULT 0,
    z_order INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    is_focussed_window INTEGER
);
CREATE INDEX IF NOT EXISTS idx_window_bound_frame ON window_bound(frame);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
);

-- One-shot data migrations that already ran (see `run_once`).
CREATE TABLE IF NOT EXISTS once_tasks (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS timezone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    observed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    observed_at INTEGER NOT NULL
);

-- accessibility trees, deduplicated by content hash.
CREATE TABLE IF NOT EXISTS ax_blob (
    hash BLOB PRIMARY KEY,
    payload BLOB NOT NULL                       -- zstd(JSON tree)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ax_snapshot (
    frame_id INTEGER PRIMARY KEY REFERENCES frame(id) ON DELETE CASCADE,
    hash BLOB NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    application_name TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    process_identifier INTEGER NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    is_partial_tree INTEGER NOT NULL DEFAULT 0
);

-- Cloud sync (sync/mod.rs).
-- In-flight multipart uploads; a crash resumes from the parts recorded here.
CREATE TABLE IF NOT EXISTS sync_multipart (
    key TEXT PRIMARY KEY,
    upload_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,                       -- hex SHA-256 of the whole file
    size INTEGER NOT NULL,
    part_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_part (
    key TEXT NOT NULL,
    part_number INTEGER NOT NULL,
    etag TEXT NOT NULL,
    sha256 TEXT NOT NULL,                       -- base64, as sent in x-amz-checksum-sha256
    PRIMARY KEY (key, part_number)
) WITHOUT ROWID;
-- Remote objects to delete (local deletion, remote retention) or uploads to abort.
CREATE TABLE IF NOT EXISTS sync_tombstone (
    key TEXT NOT NULL,
    upload_id TEXT NOT NULL DEFAULT '',         -- non-empty: abort this multipart upload
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    PRIMARY KEY (key, upload_id)
) WITHOUT ROWID;
-- Daily index lines not yet merged into <device>/index/<day>.jsonl.
CREATE TABLE IF NOT EXISTS sync_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    day TEXT NOT NULL,
    line TEXT NOT NULL
);
-- Restore: a source device's segment id -> the segment restored for it, so a
-- segment that spans chunks (or restore runs) stays one segment.
CREATE TABLE IF NOT EXISTS sync_segment (
    device TEXT NOT NULL,
    remote INTEGER NOT NULL,
    segment INTEGER NOT NULL,
    PRIMARY KEY (device, remote)
) WITHOUT ROWID;
-- Assets already in the bucket (content-addressed icons and action screenshots).
CREATE TABLE IF NOT EXISTS sync_asset (
    name TEXT PRIMARY KEY,                      -- sha256-<hex>.<ext> (schema 1: <hex>.<ext>)
    uploaded_at INTEGER NOT NULL
) WITHOUT ROWID;

-- Audio memory (audio.rs): one compressed mono segment per wall-clock minute
-- (shorter at a start, a stop or a gap). Times are epoch ms; `path` is
-- relative to audio/. status and the sync columns mean what they mean on `video`.
CREATE TABLE IF NOT EXISTS audio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    sources TEXT NOT NULL DEFAULT '',           -- comma list: microphone, system, file
    status INTEGER NOT NULL DEFAULT 0,          -- 0 local, 2 deleted, 3 remote only
    transcript_status INTEGER NOT NULL DEFAULT 0, -- 0 not asked, 1 pending, 2 done, 3 failed
    transcript_error TEXT,
    pii_redacted INTEGER NOT NULL DEFAULT 0,
    uploaded_at INTEGER,
    remote_key TEXT,
    remote_sha256 TEXT,
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    next_upload_at INTEGER,
    upload_error TEXT,
    upload_error_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_audio_start ON audio(start_ms);

-- Action segments (actions.rs): the action recorder's processed segments as
-- format items. `path` is relative to actions/; `screenshots` is a JSON array of
-- asset names in actions/assets/. `source` is the recorder segment it came from.
-- status and the sync columns mean what they mean on `video`.
CREATE TABLE IF NOT EXISTS action_segment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    screenshots TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    pii_redacted INTEGER NOT NULL DEFAULT 0,
    status INTEGER NOT NULL DEFAULT 0,          -- 0 local, 3 remote only
    uploaded_at INTEGER,
    remote_key TEXT,
    remote_sha256 TEXT,
    upload_attempts INTEGER NOT NULL DEFAULT 0,
    next_upload_at INTEGER,
    upload_error TEXT,
    upload_error_class TEXT
);
CREATE INDEX IF NOT EXISTS idx_action_segment_start ON action_segment(start_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_segment_source ON action_segment(source);
CREATE TABLE IF NOT EXISTS audio_transcript (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audio INTEGER NOT NULL REFERENCES audio(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_transcript_audio ON audio_transcript(audio);
CREATE INDEX IF NOT EXISTS idx_audio_transcript_start ON audio_transcript(start_ms);
CREATE VIRTUAL TABLE IF NOT EXISTS audio_fts USING fts5(
    text,
    content='audio_transcript',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS audio_transcript_ai AFTER INSERT ON audio_transcript BEGIN
    INSERT INTO audio_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS audio_transcript_ad AFTER DELETE ON audio_transcript BEGIN
    INSERT INTO audio_fts(audio_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS ocr_fts USING fts5(
    foreground,
    background,
    title,
    content='frame',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS frame_ai AFTER INSERT ON frame BEGIN
    INSERT INTO ocr_fts(rowid, foreground, background, title)
    VALUES (new.id, new.foreground, new.background, new.title);
END;
CREATE TRIGGER IF NOT EXISTS frame_ad AFTER DELETE ON frame BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, foreground, background, title)
    VALUES('delete', old.id, old.foreground, old.background, old.title);
END;
CREATE TRIGGER IF NOT EXISTS frame_au AFTER UPDATE ON frame
WHEN OLD.foreground IS NOT NEW.foreground
  OR OLD.background IS NOT NEW.background
  OR OLD.title IS NOT NEW.title
BEGIN
    INSERT INTO ocr_fts(ocr_fts, rowid, foreground, background, title)
    VALUES('delete', old.id, old.foreground, old.background, old.title);
    INSERT INTO ocr_fts(rowid, foreground, background, title)
    VALUES (new.id, new.foreground, new.background, new.title);
END;
"#;

/// Indexes on columns that [`migrate`] adds to old libraries, so they run after
/// the added columns. They keep the sync and retention queries off full scans:
/// the rows of these tables are never deleted, so a scan grows every day.
/// - `*_unsent`: the upload queue (`uploaded_at IS NULL`), counted and summed from the index.
/// - `*_status`: local rows (`status < 2`) for release and retention; the remote-only count.
/// - `*_uploaded`: the uploaded count and the last upload time.
/// - `*_remote_*`: rows with a bucket copy, for device.json and remote retention.
const INDEXES: &str = r#"
CREATE INDEX IF NOT EXISTS idx_video_unsent ON video(local_only, status, size_bytes) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_video_status ON video(status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_video_uploaded ON video(uploaded_at) WHERE uploaded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_remote_start ON video(start_timestamp) WHERE remote_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_remote_end ON video(end_timestamp) WHERE remote_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_video_remote_age ON video(COALESCE(end_timestamp, start_timestamp, 0)) WHERE remote_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audio_unsent ON audio(local_only, status, size_bytes) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audio_status ON audio(status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_audio_uploaded ON audio(uploaded_at) WHERE uploaded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audio_remote_end ON audio(end_ms) WHERE remote_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_segment_unsent ON action_segment(local_only, status, size_bytes) WHERE uploaded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_action_segment_status ON action_segment(status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_action_segment_uploaded ON action_segment(uploaded_at) WHERE uploaded_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_segment_remote_end ON action_segment(end_ms) WHERE remote_key IS NOT NULL;
"#;

/// The WAL file shrinks to this size after a checkpoint. Without a limit it keeps
/// its largest size (a long OCR backlog, a big retention pass) for good.
const JOURNAL_SIZE_LIMIT: i64 = 64 * 1024 * 1024;

fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(10))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

/// Read-write connection; creates and migrates the schema.
pub fn open(paths: &MemoryPaths) -> Result<Connection> {
    paths.ensure()?;
    let conn =
        Connection::open(paths.db()).with_context(|| format!("open {}", paths.db().display()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Periodic upkeep of a library that records for weeks. Call it from one
/// long-lived connection (the recorder's finalize loop), not on every open.
/// - `PRAGMA optimize` updates the planner statistics of tables that changed.
///   `analysis_limit` keeps it to a sample, so it takes milliseconds on a big library.
/// - `wal_checkpoint(TRUNCATE)` copies the WAL into the database and cuts the WAL
///   file to zero bytes. While a reader holds an old snapshot it does less and
///   reports busy; the next call finishes the work.
pub fn maintain(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "analysis_limit", 1000)?;
    conn.execute_batch("PRAGMA optimize;")?;
    let (busy, wal_pages, checkpointed): (i64, i64, i64) =
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    tracing::debug!(busy, wal_pages, checkpointed, "library maintenance");
    Ok(())
}

/// The `schema_version` the library records; 0 for a new library.
fn schema_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'schema_version'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Read-only connection for queries (CLI, UI). Works while the recorder writes.
pub fn open_readonly(paths: &MemoryPaths) -> Result<Connection> {
    let db = paths.db();
    if !db.exists() {
        anyhow::bail!(
            "no capture library at {} (start recording with `kortix-capture record`)",
            db.display()
        );
    }
    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open {}", db.display()))?;
    configure(&conn)?;
    Ok(conn)
}

/// Create or update the schema. A library at [`SCHEMA_VERSION`] (or newer) needs
/// no work: this is one read. Otherwise one write transaction runs every
/// idempotent step. Two processes that open an old library at the same time
/// migrate it once: the second waits for the first (busy timeout), then skips.
pub fn migrate(conn: &Connection) -> Result<()> {
    if schema_version(conn) >= SCHEMA_VERSION {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    if schema_version(&tx) >= SCHEMA_VERSION {
        return Ok(());
    }
    migrate_steps(&tx)?;
    tx.commit()?;
    Ok(())
}

fn migrate_steps(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    // Columns added after a table first shipped.
    for (table, column, decl) in [
        ("frame", "dhash", "TEXT"),
        ("frame", "image_hash", "TEXT"),
        ("frame", "ocr_status", "INTEGER NOT NULL DEFAULT 1"),
        ("frame", "pii_redacted", "INTEGER NOT NULL DEFAULT 0"),
        ("video", "start_timestamp", "INTEGER"),
        ("video", "end_timestamp", "INTEGER"),
        // Cloud sync (sync.rs).
        ("video", "uploaded_at", "INTEGER"), // epoch ms of the verified upload
        ("video", "remote_key", "TEXT"),     // object key without extension
        ("video", "upload_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("video", "next_upload_at", "INTEGER"), // epoch ms; backoff after a failure
        ("video", "upload_error", "TEXT"),
        ("video", "upload_error_class", "TEXT"), // ErrorClass of upload_error
        ("video", "remote_sha256", "TEXT"),      // hex SHA-256 of the stored .mp4 object
        // Multi-display: every frame and every video belongs to one display.
        ("frame", "display_id", "INTEGER"), // CGDirectDisplayID / monitor id; NULL before multi-display
        ("frame", "display_name", "TEXT"),
        ("frame", "display_main", "INTEGER"),
        ("frame", "display_focused", "INTEGER"), // 1 when this display held the focused window
        ("frame", "display_scale", "REAL"),
        ("frame", "ocr_changed", "REAL"), // fraction of the display the last read found changed
        ("video", "display_id", "INTEGER"),
        ("video", "display", "TEXT"), // JSON {id,name,x,y,w,h,scale,main} of the chunk's display
        // 1 = made before the person chose the current sync destination: stays on this computer.
        ("video", "local_only", "INTEGER NOT NULL DEFAULT 0"),
        ("audio", "local_only", "INTEGER NOT NULL DEFAULT 0"),
        ("action_segment", "local_only", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !has_column(conn, table, column)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
        }
    }
    conn.execute_batch(INDEXES)?;
    set_meta(conn, "schema_version", &SCHEMA_VERSION.to_string())?;
    Ok(())
}

/// The destination switch rule: everything not yet uploaded stays on this computer.
/// Only recordings made after the switch go to the new destination. Returns how
/// many chunks, audio segments and action segments were marked.
pub fn keep_unsent_local(conn: &Connection) -> Result<usize> {
    let mut n = 0;
    for table in ["video", "audio", "action_segment"] {
        n += conn.execute(
            &format!("UPDATE {table} SET local_only = 1 WHERE uploaded_at IS NULL AND local_only = 0"),
            [],
        )?;
    }
    Ok(n)
}

/// Run a one-shot data migration at most once per library. The task and its
/// `once_tasks` row commit together, so a failed task is retried on the next
/// start. Returns true when the task ran now. Name tasks `<area>-<change>`
/// and never rename or reuse a name.
pub fn run_once(
    conn: &Connection,
    name: &str,
    task: impl FnOnce(&Connection) -> Result<()>,
) -> Result<bool> {
    let tx = conn.unchecked_transaction()?;
    let done: Option<i64> = tx
        .query_row(
            "SELECT applied_at FROM once_tasks WHERE name = ?1",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    if done.is_some() {
        return Ok(false);
    }
    task(&tx)?;
    tx.execute(
        "INSERT INTO once_tasks(name, applied_at) VALUES (?1, ?2)",
        params![name, now_ms()],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO metadata(key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )?;
    Ok(())
}

/// `https://www.Example.com/a` -> `example.com`. None for non-web URLs.
pub fn normalize_domain(url: &str) -> Option<String> {
    let rest = url
        .split_once("://")
        .map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))?;
    if rest.0 != "http" && rest.0 != "https" {
        return None;
    }
    let host_port = rest.1.split(['/', '?', '#']).next()?;
    let host = host_port
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(host_port);
    let host = host
        .split(':')
        .next()?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    // An internationalized host compares in its ASCII (punycode) form, as the API stores it.
    let host = if host.is_ascii() {
        host
    } else {
        match url::Host::parse(&host).ok()? {
            url::Host::Domain(d) => d,
            _ => return None,
        }
    };
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// Web origin only: credentials, paths, queries and fragments are dropped.
pub fn url_origin(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let host_port = rest.split(['/', '?', '#']).next()?;
    let host = host_port
        .rsplit_once('@')
        .map(|(_, h)| h)
        .unwrap_or(host_port);
    if host.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{}",
        scheme.to_ascii_lowercase(),
        host.to_ascii_lowercase()
    ))
}

pub struct AppRow {
    pub id: i64,
    pub icon_path: Option<String>,
}

pub fn upsert_application(
    conn: &Connection,
    bundle_id: &str,
    version: &str,
    display_name: &str,
) -> Result<AppRow> {
    if let Some(row) = conn
        .query_row(
            "SELECT id, icon_path FROM application WHERE bundle_id = ?1 AND version = ?2",
            params![bundle_id, version],
            |r| {
                Ok(AppRow {
                    id: r.get(0)?,
                    icon_path: r.get(1)?,
                })
            },
        )
        .optional()?
    {
        return Ok(row);
    }
    // Reuse the icon of another version of the same app.
    let icon: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT icon_path, dominant_color FROM application WHERE bundle_id = ?1 AND icon_path IS NOT NULL LIMIT 1",
            [bundle_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (icon_path, color) = icon.unwrap_or((None, None));
    conn.execute(
        "INSERT INTO application(bundle_id, version, display_name, is_user_app, icon_path, dominant_color)
         VALUES (?1, ?2, ?3, 1, ?4, ?5)",
        params![bundle_id, version, display_name, icon_path, color],
    )?;
    Ok(AppRow {
        id: conn.last_insert_rowid(),
        icon_path,
    })
}

pub fn upsert_domain(conn: &Connection, domain: &str) -> Result<i64> {
    conn.execute(
        "INSERT OR IGNORE INTO domain(normalized_domain) VALUES (?1)",
        [domain],
    )?;
    Ok(conn.query_row(
        "SELECT id FROM domain WHERE normalized_domain = ?1",
        [domain],
        |r| r.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    /// A directory under the system temp dir, removed on drop.
    struct TmpDir(std::path::PathBuf);

    impl TmpDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("kcap-store-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn fts_tracks_frame_text() {
        let conn = mem();
        conn.execute(
            "INSERT INTO frame(timestamp, foreground, title) VALUES (1, 'webhook signatures verified', 'Docs')",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'signature'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "porter stemming matches singular");
        conn.execute(
            "UPDATE frame SET foreground = 'nothing here' WHERE id = 1",
            [],
        )
        .unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM ocr_fts WHERE ocr_fts MATCH 'signature'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 0, "update trigger reindexes");
    }

    /// A library from before schema 2: the sync columns that `migrate` adds later
    /// are missing, none of `INDEXES` exists, and `schema_version` is 1.
    fn old_library(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE video (id INTEGER PRIMARY KEY AUTOINCREMENT, height INTEGER NOT NULL,
                 width INTEGER NOT NULL, path TEXT NOT NULL, num_frames INTEGER NOT NULL,
                 status INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER,
                 start_timestamp INTEGER, end_timestamp INTEGER);
             CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
             INSERT INTO metadata VALUES ('schema_version', '1', 0);",
        )
        .unwrap();
        for i in 0..500 {
            conn.execute(
                "INSERT INTO video(height, width, path, num_frames, status, size_bytes) VALUES (1, 1, ?1, 1, ?2, 10)",
                params![format!("v{i}"), i % 4],
            )
            .unwrap();
        }
        conn
    }

    fn index_names(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn migration_upgrades_an_old_library_once() {
        let dir = TmpDir::new();
        let db = dir.path().join("memory.db");
        drop(old_library(&db));

        let conn = Connection::open(&db).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn), SCHEMA_VERSION);
        let names = index_names(&conn);
        for want in [
            "idx_video_unsent",
            "idx_video_status",
            "idx_audio_unsent",
            "idx_action_segment_remote_end",
        ] {
            assert!(
                names.iter().any(|n| n == want),
                "{want} missing in {names:?}"
            );
        }
        assert!(has_column(&conn, "video", "local_only").unwrap());
        let (rows, unsent): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(uploaded_at IS NULL AND local_only = 0 AND status < 2) FROM video",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (rows, unsent),
            (500, 250),
            "the rows stay, the new columns take their defaults"
        );

        // At the current version a second open writes nothing: not even the metadata row.
        let before: i64 = conn
            .query_row(
                "SELECT updated_at FROM metadata WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let conn2 = Connection::open(&db).unwrap();
        migrate(&conn2).unwrap();
        let changes: i64 = conn2
            .query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
        assert_eq!(changes, 0);
        let after: i64 = conn2
            .query_row(
                "SELECT updated_at FROM metadata WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(before, after);

        // A library that a newer build migrated is not touched either.
        set_meta(&conn2, "schema_version", &(SCHEMA_VERSION + 1).to_string()).unwrap();
        migrate(&conn2).unwrap();
        assert_eq!(schema_version(&conn2), SCHEMA_VERSION + 1);
    }

    #[test]
    fn migration_is_idempotent_when_interrupted() {
        // A migration that stopped before its commit leaves version 1; the next open
        // runs every step again. `IF NOT EXISTS` and `has_column` make that safe.
        let conn = mem();
        set_meta(&conn, "schema_version", "1").unwrap();
        migrate(&conn).unwrap();
        assert_eq!(schema_version(&conn), SCHEMA_VERSION);
        let n = index_names(&conn).len();
        set_meta(&conn, "schema_version", "1").unwrap();
        migrate(&conn).unwrap();
        assert_eq!(index_names(&conn).len(), n);
    }

    #[test]
    fn open_sets_wal_limit_and_maintain_truncates_the_wal() {
        let dir = TmpDir::new();
        let paths = MemoryPaths::at(dir.path());
        let conn = open(&paths).unwrap();
        let limit: i64 = conn
            .query_row("PRAGMA journal_size_limit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(limit, JOURNAL_SIZE_LIMIT);
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..2000 {
            tx.execute(
                "INSERT INTO frame(timestamp, foreground) VALUES (?1, 'some text to fill pages')",
                [i],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        let wal = dir.path().join("memory.db-wal");
        assert!(std::fs::metadata(&wal).unwrap().len() > 0);
        maintain(&conn).unwrap();
        assert_eq!(
            std::fs::metadata(&wal).unwrap().len(),
            0,
            "TRUNCATE cuts the WAL to zero bytes"
        );
    }

    /// Each query that runs every few seconds (the sync tick, the recorder tick) or on
    /// a big table reads the index named here, and no table in full: a scan of these
    /// tables, or of an index of every row, grows with the library.
    /// The plans are checked without statistics (a new library) and after `ANALYZE`
    /// (what `PRAGMA optimize` in [`maintain`] writes).
    #[test]
    fn hot_queries_use_an_index() {
        use super::super::sync::{CHUNK_ERROR_SQL, QUEUE_KEY_SQL, QUEUE_SQL};
        let queue_index: [&[&str]; 15] = [
            &["idx_video_unsent"],
            &[
                "idx_video_unsent",
                "idx_audio_unsent",
                "idx_action_segment_unsent",
            ],
            &["idx_video_unsent"],
            &["idx_video_unsent"],
            &["idx_video_uploaded"],
            &["idx_video_status"],
            &[], // sync_tombstone: one row per pending remote delete
            &[], // sync_multipart: one row per open upload
            &["idx_audio_unsent"],
            &["idx_audio_uploaded"],
            &["idx_audio_status"],
            &["idx_action_segment_unsent"],
            &["idx_action_segment_uploaded"],
            &["idx_action_segment_status"],
            &[
                "idx_video_uploaded",
                "idx_audio_uploaded",
                "idx_action_segment_uploaded",
            ],
        ];
        let mut hot: Vec<(&str, &[&str])> = QUEUE_SQL.into_iter().zip(queue_index).collect();
        hot.extend([
            (CHUNK_ERROR_SQL, &["idx_video_unsent"][..]),
            (
                QUEUE_KEY_SQL,
                &["idx_video_uploaded", "idx_audio_uploaded", "idx_action_segment_uploaded"],
            ),
            // recorder.rs: the OCR backlog, every tick.
            ("SELECT count(*) FROM frame WHERE ocr_status = 0", &["idx_frame_ocr_pending"]),
            // sync/mod.rs device_json, every pass.
            ("SELECT min(start_timestamp) FROM video WHERE remote_key IS NOT NULL", &["idx_video_remote_start"]),
            ("SELECT max(end_timestamp) FROM video WHERE remote_key IS NOT NULL", &["idx_video_remote_end"]),
            // sync/mod.rs upload_pending, every pass.
            (
                "SELECT id FROM video WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND COALESCE(next_upload_at, 0) <= ?1
                   AND (?3 = 0 OR COALESCE(end_timestamp, start_timestamp, 0) >= ?3) ORDER BY id LIMIT ?2",
                &["idx_video_unsent"],
            ),
            (
                "SELECT id FROM audio WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0 AND transcript_status != ?4
                   AND COALESCE(next_upload_at, 0) <= ?1 AND (?3 = 0 OR end_ms >= ?3) ORDER BY id LIMIT ?2",
                &["idx_audio_unsent"],
            ),
            (
                "SELECT id FROM action_segment WHERE status < 2 AND uploaded_at IS NULL AND local_only = 0
                   AND COALESCE(next_upload_at, 0) <= ?1 AND (?3 = 0 OR end_ms >= ?3) ORDER BY id LIMIT ?2",
                &["idx_action_segment_unsent"],
            ),
            // sync/mod.rs release_local, every pass.
            (
                "SELECT id, path FROM video WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND +uploaded_at <= ?1",
                &["idx_video_status"],
            ),
            (
                "SELECT id, path FROM audio WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND +uploaded_at <= ?1",
                &["idx_audio_status"],
            ),
            (
                "SELECT id, path FROM action_segment WHERE status < 2 AND remote_key IS NOT NULL AND uploaded_at IS NOT NULL AND +uploaded_at <= ?1",
                &["idx_action_segment_status"],
            ),
            // sync/mod.rs remote_retention, every pass when it is on.
            (
                "SELECT id, remote_key, COALESCE(start_timestamp, 0) FROM video
                 WHERE remote_key IS NOT NULL AND COALESCE(end_timestamp, start_timestamp, 0) < ?1 ORDER BY +id LIMIT 1000",
                &["idx_video_remote_age"],
            ),
            (
                "SELECT id, remote_key, start_ms FROM audio WHERE remote_key IS NOT NULL AND end_ms < ?1 ORDER BY +id LIMIT 1000",
                &["idx_audio_remote_end"],
            ),
            (
                "SELECT id, remote_key, start_ms FROM action_segment WHERE remote_key IS NOT NULL AND end_ms < ?1 ORDER BY +id LIMIT 1000",
                &["idx_action_segment_remote_end"],
            ),
            // retention.rs oldest_videos / oldest_audio, every 10 minutes.
            (
                "SELECT id, path FROM video WHERE status <= ?1 AND (?2 IS NULL OR COALESCE(end_timestamp, 0) < ?2)
                   AND (?4 IS NULL OR uploaded_at IS NOT NULL OR local_only = 1 OR COALESCE(end_timestamp, 0) < ?4)
                 ORDER BY +id LIMIT ?3",
                &["idx_video_status"],
            ),
            (
                "SELECT id, path FROM audio WHERE status = 0 AND (?1 IS NULL OR end_ms < ?1)
                   AND (?3 IS NULL OR uploaded_at IS NOT NULL OR local_only = 1 OR end_ms < ?3) ORDER BY start_ms LIMIT ?2",
                &["idx_audio_status"],
            ),
        ]);
        let check = |conn: &Connection, when: &str| {
            for (sql, want) in &hot {
                let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
                let nulls = vec![rusqlite::types::Null; stmt.parameter_count()];
                let plan: Vec<String> = stmt
                    .query_map(rusqlite::params_from_iter(nulls), |r| r.get::<_, String>(3))
                    .unwrap()
                    .collect::<rusqlite::Result<_>>()
                    .unwrap();
                for step in &plan {
                    let scans_big = ["video", "audio", "action_segment", "frame"]
                        .iter()
                        .any(|t| step == &format!("SCAN {t}"));
                    assert!(!scans_big, "{when}: full scan in {plan:?} for {sql}");
                }
                for index in *want {
                    assert!(
                        plan.iter()
                            .any(|step| step.contains(&format!("INDEX {index}"))),
                        "{when}: {index} not in {plan:?} for {sql}"
                    );
                }
            }
        };
        let conn = mem();
        check(&conn, "no statistics");
        // A library after weeks: most rows released (status 3), a few local, a few unsent.
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..3000i64 {
            let (status, up, key) = match i {
                0..=2899 => (3, Some(i), Some("k")),
                2900..=2989 => (0, Some(i), Some("k")),
                _ => (0, None, None),
            };
            tx.execute(
                "INSERT INTO video(height, width, path, num_frames, status, size_bytes, start_timestamp, end_timestamp, uploaded_at, remote_key)
                 VALUES (1, 1, 'v', 1, ?1, 10, ?2, ?2, ?3, ?4)",
                params![status, i, up, key],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO audio(start_ms, end_ms, path, status, uploaded_at, remote_key) VALUES (?1, ?1, 'a', ?2, ?3, ?4)",
                params![i, status, up, key],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO action_segment(start_ms, end_ms, path, status, uploaded_at, remote_key) VALUES (?1, ?1, 'a', ?2, ?3, ?4)",
                params![i, status, up, key],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO frame(timestamp, ocr_status) VALUES (?1, 1)",
                [i],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        conn.execute_batch("ANALYZE").unwrap();
        check(&conn, "after ANALYZE");
    }

    #[test]
    fn domains_and_origins_normalize() {
        assert_eq!(
            normalize_domain("https://www.GitHub.com/a/b?x=1"),
            Some("github.com".into())
        );
        assert_eq!(
            normalize_domain("http://user:pw@localhost:3000/x"),
            Some("localhost".into())
        );
        assert_eq!(normalize_domain("file:///Users/x"), None);
        assert_eq!(
            url_origin("https://u:p@Example.com:8443/reset?token=abc#f"),
            Some("https://example.com:8443".into())
        );
    }

    #[test]
    fn application_upsert_reuses_icons_across_versions() {
        let conn = mem();
        let a = upsert_application(&conn, "com.x", "1.0", "X").unwrap();
        conn.execute(
            "UPDATE application SET icon_path = 'icons/x.png' WHERE id = ?1",
            [a.id],
        )
        .unwrap();
        let again = upsert_application(&conn, "com.x", "1.0", "X").unwrap();
        assert_eq!(a.id, again.id);
        let b = upsert_application(&conn, "com.x", "2.0", "X").unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(b.icon_path.as_deref(), Some("icons/x.png"));
    }

    #[test]
    fn once_tasks_run_once_and_retry_after_failure() {
        let conn = mem();
        let mut runs = 0;
        assert!(run_once(&conn, "t-one", |c| {
            runs += 1;
            c.execute("INSERT INTO metadata(key, value) VALUES ('x', '1')", [])?;
            Ok(())
        })
        .unwrap());
        assert!(!run_once(&conn, "t-one", |_| panic!("must not run twice")).unwrap());
        assert_eq!(runs, 1);
        let applied: i64 = conn
            .query_row(
                "SELECT applied_at FROM once_tasks WHERE name = 't-one'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(applied > 0);
        // A failing task rolls back its writes and leaves no row, so it runs again.
        assert!(run_once(&conn, "t-fail", |c| {
            c.execute("INSERT INTO metadata(key, value) VALUES ('y', '1')", [])?;
            anyhow::bail!("boom")
        })
        .is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM metadata WHERE key = 'y'", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        assert!(run_once(&conn, "t-fail", |_| Ok(())).unwrap());
    }
}
