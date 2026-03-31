PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    root_path     TEXT NOT NULL UNIQUE,
    language      TEXT NOT NULL,
    framework     TEXT,
    test_command  TEXT,
    lint_command  TEXT,
    build_command TEXT,
    ignore_paths  TEXT NOT NULL DEFAULT '[]',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(id),
    project_path          TEXT NOT NULL,
    goal                  TEXT NOT NULL,
    start_time            DATETIME DEFAULT CURRENT_TIMESTAMP,
    end_time              DATETIME,
    status                TEXT NOT NULL DEFAULT 'running',
    phase                 TEXT NOT NULL DEFAULT 'planning',
    trigger_source        TEXT NOT NULL DEFAULT 'dashboard',
    metadata              TEXT,
    active_change_set_id  TEXT
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_type     TEXT NOT NULL,
    started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at    DATETIME,
    status         TEXT NOT NULL DEFAULT 'pending',
    trigger        TEXT NOT NULL,
    input_summary  TEXT,
    output_summary TEXT,
    step_current   INTEGER NOT NULL DEFAULT 0,
    step_total     INTEGER
);

CREATE TABLE IF NOT EXISTS agent_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_run_id  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    event_type    TEXT NOT NULL,
    event_data    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS control_signals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_run_id  TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    action        TEXT NOT NULL,
    reason        TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    consumed_at   DATETIME,
    expires_at    DATETIME,
    created_by    TEXT NOT NULL DEFAULT 'dashboard'
);

CREATE TABLE IF NOT EXISTS write_slot_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'waiting',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    acquired_at   DATETIME,
    released_at   DATETIME,
    release_reason TEXT
);

CREATE TABLE IF NOT EXISTS write_slot_locks (
    project_id    TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    acquired_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phase_execution_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    phase         TEXT NOT NULL,
    attempt       INTEGER NOT NULL,
    execution_id  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, phase, attempt)
);

CREATE TABLE IF NOT EXISTS session_dispatch_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    reason        TEXT NOT NULL DEFAULT 'manual',
    status        TEXT NOT NULL DEFAULT 'queued',
    error_message TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS change_sets (
    id                    TEXT PRIMARY KEY,
    session_id            TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    status                TEXT NOT NULL DEFAULT 'draft',
    summary               TEXT NOT NULL,
    review_notes          TEXT NOT NULL,
    files_json            TEXT NOT NULL,
    diff_text             TEXT NOT NULL,
    test_command_snapshot TEXT,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor         TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    details       TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_phase ON sessions(phase);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_control_signals_run ON control_signals(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_control_signals_session ON control_signals(session_id);
CREATE INDEX IF NOT EXISTS idx_control_signals_pending ON control_signals(agent_run_id, consumed_at);
CREATE INDEX IF NOT EXISTS idx_write_slot_queue_project ON write_slot_queue(project_id, status, id);
CREATE INDEX IF NOT EXISTS idx_write_slot_queue_session ON write_slot_queue(session_id, status);
CREATE INDEX IF NOT EXISTS idx_phase_execution_attempts_lookup ON phase_execution_attempts(session_id, phase, attempt);
CREATE INDEX IF NOT EXISTS idx_phase_execution_attempts_status ON phase_execution_attempts(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_status ON session_dispatch_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_session ON session_dispatch_jobs(session_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_jobs_active_session ON session_dispatch_jobs(session_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_change_sets_session ON change_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_time ON audit_log(timestamp);
