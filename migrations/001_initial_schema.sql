-- Initial schema: all tables present at launch.

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  env_var TEXT NOT NULL,
  key TEXT NOT NULL,
  base_url TEXT NOT NULL,
  header_name TEXT NOT NULL DEFAULT 'x-api-key',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- UNIQUE on pattern so seed INSERT OR IGNORE is idempotent.
CREATE TABLE IF NOT EXISTS network_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS command_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  task_description TEXT,
  status TEXT NOT NULL DEFAULT 'started',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  type TEXT NOT NULL,
  content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER REFERENCES sessions(id),
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed default network allowlist (idempotent via UNIQUE constraint).
INSERT OR IGNORE INTO network_rules (pattern, description) VALUES
  ('registry.npmjs.org',       'npm registry'),
  ('*.github.com',             'GitHub'),
  ('*.githubusercontent.com',  'GitHub raw content'),
  ('api.anthropic.com',        'Anthropic API'),
  ('downloads.anthropic.com',  'Claude Code updates'),
  ('platform.claude.com',      'Claude platform');

-- Seed default config (idempotent via PRIMARY KEY conflict).
INSERT OR IGNORE INTO config (key, value) VALUES
  ('allowlist_enabled', 'true');
