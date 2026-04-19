-- Persist running sandbox containers so sessions survive server restarts.

CREATE TABLE IF NOT EXISTS active_containers (
  session_id TEXT PRIMARY KEY,
  container_ref TEXT NOT NULL,
  container_id TEXT,
  repo_path TEXT,
  repo_name TEXT,
  branch TEXT,
  started_at TEXT NOT NULL
);
