/**
 * Named Claude profiles — each profile is a ~/.claude snapshot stored on the host.
 * Files live in data/profiles/{id}/claude/; SQLite holds metadata.
 *
 * When VIVI_S3_ENDPOINT is set (e.g. pointing at the chart's MinIO Deployment
 * or external S3), every save is also pushed to the bucket and missing
 * local copies are pulled back lazily. The host-local copy stays the source
 * of truth for the active read path; S3 is durability.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import db from "./db.js";
import { runtime } from "./runtime.js";
import { paths } from "./paths.js";
import * as storage from "./profile-storage.js";

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  autoSave: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

const PROFILES_DIR = paths().profilesDir;

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
  // Best-effort remote cleanup.
  storage.deleteProfile(id).catch(() => {
    // already logged inside
  });
}

export function markProfileUsed(id: string): void {
  db.prepare("UPDATE profiles SET last_used_at = datetime('now') WHERE id = ?").run(id);
}

export async function saveProfileFromContainer(profileId: string, containerName: string): Promise<void> {
  const dir = getProfileDir(profileId);
  fs.mkdirSync(dir, { recursive: true });

  if (runtime.backend === "k8s") {
    // k8s path: stream `tar` out of the pod via `kubectl exec`, then pipe
    // into a local `tar xf -`. Avoids a shell pipe so this works on Windows.
    await k8sTarExtract(containerName, dir);
  } else {
    // Use `docker exec tar` instead of `docker cp` because `docker cp` fails when
    // the container has a Unix socket bind-mounted (/var/run/docker.sock) — Docker
    // walks the overlay merged layer and errors with "not a directory".
    execSync(`${runtime.bin} exec ${containerName} tar cf - -C /home/agent/.claude . | tar xf - -C ${JSON.stringify(dir)}`, {
      stdio: "pipe",
      timeout: 30_000,
    });
  }

  markProfileUsed(profileId);
  // Mirror to remote storage if configured (fire-and-forget).
  pushToRemote(profileId).catch(() => {
    // logged inside
  });
}

/**
 * Stream the contents of /home/agent/.claude out of a sandbox pod via
 * `kubectl exec tar`, pipe through a local `tar xf -`, and land them in
 * destDir. Replaces the docker-mode `exec tar | tar` pipeline.
 */
function k8sTarExtract(podName: string, destDir: string): Promise<void> {
  const namespace = process.env.VIVI_K8S_NAMESPACE || "vivi";
  return new Promise((resolve, reject) => {
    const kubectl = spawn("kubectl", [
      "exec", "-n", namespace, podName, "-c", "sandbox",
      "--", "tar", "cf", "-", "-C", "/home/agent/.claude", ".",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const untar = spawn("tar", ["xf", "-", "-C", destDir], { stdio: ["pipe", "ignore", "pipe"] });

    const kubectlErr: Buffer[] = [];
    const untarErr: Buffer[] = [];
    kubectl.stderr!.on("data", (c: Buffer) => kubectlErr.push(c));
    untar.stderr!.on("data", (c: Buffer) => untarErr.push(c));

    kubectl.stdout!.pipe(untar.stdin!);

    const timer = setTimeout(() => {
      kubectl.kill(); untar.kill();
      reject(new Error("k8s profile save timed out after 60s"));
    }, 60_000);

    let done = 0;
    const finish = (err?: Error) => {
      done++;
      if (err) {
        clearTimeout(timer);
        kubectl.kill(); untar.kill();
        reject(err);
        return;
      }
      if (done >= 2) {
        clearTimeout(timer);
        resolve();
      }
    };

    kubectl.on("exit", (code) => {
      if (code !== 0) finish(new Error(`kubectl exec tar exited ${code}: ${Buffer.concat(kubectlErr).toString()}`));
      else finish();
    });
    untar.on("exit", (code) => {
      if (code !== 0) finish(new Error(`tar xf exited ${code}: ${Buffer.concat(untarErr).toString()}`));
      else finish();
    });
    kubectl.on("error", (err) => finish(err));
    untar.on("error", (err) => finish(err));
  });
}

/**
 * Tar-gzip the local profile directory and upload it to the configured
 * S3/MinIO bucket. No-op when remote storage is disabled.
 *
 * Resolves true on success or when storage is disabled (caller's flow is
 * unaffected); resolves false when the upload itself failed.
 */
async function pushToRemote(profileId: string): Promise<boolean> {
  if (!storage.isEnabled()) return true;
  const dir = getProfileDir(profileId);
  if (!fs.existsSync(dir)) return false;
  const tmp = path.join(os.tmpdir(), `vivi-profile-${profileId}-${Date.now()}.tar.gz`);
  try {
    execSync(`tar czf ${JSON.stringify(tmp)} -C ${JSON.stringify(dir)} .`, {
      stdio: "pipe",
      timeout: 30_000,
    });
    return await storage.uploadProfile(profileId, tmp);
  } catch (err: any) {
    console.warn(`[profiles] pushToRemote failed for ${profileId}: ${err.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch {
      // best-effort
    }
  }
}

/**
 * Restore a profile from remote storage if the local directory is missing.
 * Returns true if the profile is now available locally (either was already
 * present or was successfully pulled), false otherwise. Safe to call before
 * mounting a profile into a sandbox.
 */
export async function ensureLocalProfile(profileId: string): Promise<boolean> {
  const dir = getProfileDir(profileId);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) return true;
  if (!storage.isEnabled()) return fs.existsSync(dir);

  const tmp = path.join(os.tmpdir(), `vivi-profile-${profileId}-${Date.now()}.tar.gz`);
  try {
    const ok = await storage.downloadProfile(profileId, tmp);
    if (!ok) return fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    execSync(`tar xzf ${JSON.stringify(tmp)} -C ${JSON.stringify(dir)}`, {
      stdio: "pipe",
      timeout: 30_000,
    });
    console.log(`[profiles] Restored profile ${profileId} from remote storage`);
    return true;
  } catch (err: any) {
    console.warn(`[profiles] ensureLocalProfile failed for ${profileId}: ${err.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch {
      // best-effort
    }
  }
}
