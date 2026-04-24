/**
 * SQL migration runner.
 *
 * Migrations are plain .sql files in the /migrations directory, named with a
 * numeric prefix (e.g. 001_initial_schema.sql). They are applied in filename
 * order, each inside a single transaction. Applied migrations are recorded in
 * the `schema_migrations` table and never re-run.
 *
 * Baseline detection: if the database already has tables from before the
 * migration system was introduced, the runner marks all migrations up to and
 * including the current baseline as applied without executing them, so existing
 * deployments don't get errors from CREATE TABLE IF NOT EXISTS being a no-op
 * while other SQL in the same file (e.g. new constraints) would differ.
 *
 * Usage:
 *   import { runMigrations } from "./migrate.js";
 *   runMigrations(db);                         // use default migrations dir
 *   runMigrations(db, "/custom/migrations");   // override dir
 *
 *   # CLI (run pending migrations and exit)
 *   npx tsx server/migrate.ts
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";

// Filename of the last migration that was present before the migration system
// was introduced. Any deployment that already has the `secrets` table but no
// `schema_migrations` table is assumed to have this baseline applied.
const BASELINE_MIGRATION = "001_initial_schema.sql";

// Resolve `migrations/` relative to the binary first (for `bun build --compile`
// output like dist/bin/vivi-app → ../../migrations), then fall back to cwd
// for `bun run` / `bun dev`.
const DEFAULT_MIGRATIONS_DIR = (() => {
  const nextToBinary = path.resolve(path.dirname(process.execPath), "../../migrations");
  if (fs.existsSync(nextToBinary)) return nextToBinary;
  return path.resolve("migrations");
})();

export function runMigrations(
  db: Database,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): void {
  // Ensure the tracking table exists.
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Detect pre-migration deployments: if secrets table exists but no
  // migrations have been recorded, stamp the baseline as already applied.
  const anyApplied = db
    .prepare("SELECT COUNT(*) as c FROM schema_migrations")
    .get() as { c: number };

  if (anyApplied.c === 0) {
    const hasExistingSchema = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secrets'")
      .get();

    if (hasExistingSchema) {
      // Mark everything up to the baseline as applied without running SQL.
      const files = getMigrationFiles(migrationsDir);
      const stamp = db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)",
      );
      const stampAll = db.transaction(() => {
        for (const file of files) {
          stamp.run(file);
          if (file === BASELINE_MIGRATION) break;
        }
      });
      stampAll();
      console.log("[migrate] Existing database detected — stamped baseline migrations as applied");
    }
  }

  // Collect applied migration names.
  const applied = new Set<string>(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );

  const files = getMigrationFiles(migrationsDir);
  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
    console.log(`[migrate] Applying ${file}...`);

    db.transaction(() => {
      db.run(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    })();

    console.log(`[migrate] Applied  ${file}`);
    ran++;
  }

  if (ran === 0) {
    console.log("[migrate] No pending migrations");
  } else {
    console.log(`[migrate] ${ran} migration(s) applied`);
  }
}

function getMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexicographic order — relies on numeric prefix
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isMain) {
  const { paths } = await import("./paths.js");
  const db = new Database(paths().dbFile);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  runMigrations(db);
  db.close();
}
