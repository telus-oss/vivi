-- Configurable sandbox images: each row is an available Docker image
-- that users can select when launching a new sandbox session.

CREATE TABLE IF NOT EXISTS sandbox_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,           -- display name (e.g. 'Default Sandbox')
  image TEXT NOT NULL UNIQUE,   -- Docker image reference (e.g. 'vivi-sandbox')
  is_default INTEGER NOT NULL DEFAULT 0,  -- 1 = pre-selected in dropdown
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed with the built-in image
INSERT INTO sandbox_images (name, image, is_default) VALUES ('Default (built-in)', 'vivi-sandbox', 1);
