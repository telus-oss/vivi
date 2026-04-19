/**
 * SQLite database for all persistent state.
 *
 * Schema is managed via numbered SQL files in /migrations — see
 * server/migrate.ts. Do not add CREATE TABLE statements here; write a new
 * migration file instead.
 *
 * Tables:
 *   secrets           - API keys + proxy config
 *   network_rules     - httpjail allowlist (hosts)
 *   command_rules     - command watchlist
 *   config            - key/value settings
 *   sessions          - session history
 *   events            - activity monitor events
 *   alerts            - activity monitor alerts
 *   active_containers - running sandbox containers (for session restore)
 *   schema_migrations - migration tracking (managed by migrate.ts)
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { runMigrations } from "./migrate.js";

const DB_DIR = path.resolve("data");
const DB_PATH = path.join(DB_DIR, "vivi.db");

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

runMigrations(db);

export default db;

// --- Helpers ---

export function getConfig(key: string, defaultValue?: string): string | undefined {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setConfig(key: string, value: string) {
  db.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}
