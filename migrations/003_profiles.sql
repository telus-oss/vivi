-- Named Claude profiles: each profile stores a ~/.claude snapshot on disk.
-- The actual files live in data/profiles/{id}/claude/ on the host.

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  auto_save INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

-- Track which profile (if any) was used when a container was started.
ALTER TABLE active_containers ADD COLUMN profile_id TEXT REFERENCES profiles(id);
