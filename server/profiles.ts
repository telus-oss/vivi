/**
 * Named Claude profiles — each profile is a ~/.claude snapshot stored on the host.
 * Files live in data/profiles/{id}/claude/; SQLite holds metadata.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import db from "./db.js";
import { runtime } from "./runtime.js";

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  autoSave: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const PROFILES_DIR = path.resolve("data", "profiles");

export function getProfileDir(id: string): string {
  return path.join(PROFILES_DIR, id, "claude");
}

function rowToProfile(row: any): Profile {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    autoSave: row.auto_save === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

export function listProfiles(): Profile[] {
  const rows = db.prepare("SELECT * FROM profiles ORDER BY name").all();
  return rows.map(rowToProfile);
}

export function getProfile(id: string): Profile | undefined {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id);
  return row ? rowToProfile(row) : undefined;
}

export function createProfile(name: string, description?: string): Profile {
  const id = crypto.randomUUID().slice(0, 6);
  const dir = getProfileDir(id);
  fs.mkdirSync(dir, { recursive: true });
  db.prepare(
    "INSERT INTO profiles (id, name, description) VALUES (?, ?, ?)"
  ).run(id, name, description ?? null);
  return rowToProfile(db.prepare("SELECT * FROM profiles WHERE id = ?").get(id));
}

export function updateProfile(id: string, patch: { name?: string; description?: string; autoSave?: boolean }): Profile {
  if (patch.name !== undefined) {
    db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(patch.name, id);
  }
  if (patch.description !== undefined) {
    db.prepare("UPDATE profiles SET description = ? WHERE id = ?").run(patch.description, id);
  }
  if (patch.autoSave !== undefined) {
    db.prepare("UPDATE profiles SET auto_save = ? WHERE id = ?").run(patch.autoSave ? 1 : 0, id);
  }
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id);
  if (!row) throw new Error(`Profile ${id} not found`);
  return rowToProfile(row);
}

export function deleteProfile(id: string): void {
  db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  const dir = path.join(PROFILES_DIR, id);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function markProfileUsed(id: string): void {
  db.prepare("UPDATE profiles SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

export function saveProfileFromContainer(profileId: string, containerName: string): void {
  const dir = getProfileDir(profileId);
  fs.mkdirSync(dir, { recursive: true });
  // Use `docker exec tar` instead of `docker cp` because `docker cp` fails when
  // the container has a Unix socket bind-mounted (/var/run/docker.sock) — Docker
  // walks the overlay merged layer and errors with "not a directory".
  execSync(`${runtime.bin} exec ${containerName} tar cf - -C /home/agent/.claude . | tar xf - -C ${JSON.stringify(dir)}`, {
    stdio: "pipe",
    timeout: 30_000,
  });
  markProfileUsed(profileId);
}
