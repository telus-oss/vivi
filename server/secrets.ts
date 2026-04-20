/**
 * Secret store — backed by SQLite.
 *
 * Also writes config/secrets.json for the Docker reverse proxy container.
 */

import fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import db from "./db.js";
import { runtime } from "./runtime.js";
import { paths } from "./paths.js";

export interface Secret {
  id: string;
  name: string;
  envVar: string;
  key: string;
  baseUrl: string;
  headerName: string;
  createdAt: string;
}

export interface SecretPublic {
  id: string;
  name: string;
  envVar: string;
  baseUrl: string;
  headerName: string;
  createdAt: string;
  sandboxKey: string;
  sandboxBaseUrl: string;
}

const SECRETS_FILE = paths().secretsFile;

/** Write config/secrets.json for the reverse proxy container. */
function syncProxyFile() {
  const rows = db.prepare("SELECT id, key, base_url, header_name FROM secrets").all() as {
    id: string; key: string; base_url: string; header_name: string;
  }[];
  const proxySecrets: Record<string, { key: string; baseUrl: string; headerName: string }> = {};
  for (const r of rows) {
    proxySecrets[r.id] = { key: r.key, baseUrl: r.base_url, headerName: r.header_name };
  }
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(proxySecrets, null, 2));
}

// Sync on startup
syncProxyFile();

// --- Prepared statements ---
const stmts = {
  insert: db.prepare(
    "INSERT OR REPLACE INTO secrets (id, name, env_var, key, base_url, header_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ),
  remove: db.prepare("DELETE FROM secrets WHERE id = ?"),
  get: db.prepare("SELECT * FROM secrets WHERE id = ?"),
  list: db.prepare("SELECT * FROM secrets ORDER BY created_at"),
  update: db.prepare(
    "UPDATE secrets SET name = ?, env_var = ?, key = ?, base_url = ?, header_name = ? WHERE id = ?",
  ),
};

export function addSecret(opts: {
  name: string;
  envVar: string;
  key: string;
  baseUrl: string;
  headerName?: string;
}): SecretPublic {
  const id = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "secret";
  const now = new Date().toISOString();
  stmts.insert.run(id, opts.name, opts.envVar, opts.key, opts.baseUrl.replace(/\/$/, ""), opts.headerName || "x-api-key", now);
  syncProxyFile();
  return toPublic({ id, name: opts.name, envVar: opts.envVar, key: opts.key, baseUrl: opts.baseUrl.replace(/\/$/, ""), headerName: opts.headerName || "x-api-key", createdAt: now });
}

export function removeSecret(id: string): boolean {
  const result = stmts.remove.run(id);
  if (result.changes > 0) syncProxyFile();
  return result.changes > 0;
}

export function updateSecret(id: string, opts: {
  name?: string;
  envVar?: string;
  key?: string;
  baseUrl?: string;
  headerName?: string;
}): SecretPublic | undefined {
  const existing = getSecret(id);
  if (!existing) return undefined;
  const updated: Secret = {
    id: existing.id,
    name: opts.name ?? existing.name,
    envVar: opts.envVar ?? existing.envVar,
    key: (opts.key && opts.key.length > 0) ? opts.key : existing.key,
    baseUrl: (opts.baseUrl ?? existing.baseUrl).replace(/\/$/, ""),
    headerName: opts.headerName ?? existing.headerName,
    createdAt: existing.createdAt,
  };
  stmts.update.run(updated.name, updated.envVar, updated.key, updated.baseUrl, updated.headerName, id);
  syncProxyFile();
  return toPublic(updated);
}

export function getSecret(id: string): Secret | undefined {
  const row = stmts.get.get(id) as any;
  return row ? rowToSecret(row) : undefined;
}

export function listSecrets(): SecretPublic[] {
  return (stmts.list.all() as any[]).map(rowToSecret).map(toPublic);
}

export function getSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of stmts.list.all() as any[]) {
    const s = rowToSecret(row);
    env[s.envVar] = `sk-sandbox-${s.id}`;
    if (s.baseUrl && s.envVar === "ANTHROPIC_AUTH_TOKEN") {
      env["ANTHROPIC_BASE_URL"] = s.baseUrl;
    }
  }
  return env;
}

function rowToSecret(row: any): Secret {
  return {
    id: row.id,
    name: row.name,
    envVar: row.env_var,
    key: row.key,
    baseUrl: row.base_url,
    headerName: row.header_name,
    createdAt: row.created_at,
  };
}

function toPublic(s: Secret): SecretPublic {
  return {
    id: s.id,
    name: s.name,
    envVar: s.envVar,
    baseUrl: s.baseUrl,
    headerName: s.headerName,
    createdAt: s.createdAt,
    sandboxKey: `sk-sandbox-${s.id}`,
    sandboxBaseUrl: s.baseUrl,
  };
}

/**
 * Push current secrets as env vars into all running sandbox containers.
 * Writes /etc/sandbox-secrets which is sourced by .bashrc in the sandbox.
 */
export function syncContainerSecrets(): void {
  const env = getSandboxEnv();
  // Build a shell script that exports all secret env vars
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
  const script = lines.join("\n") + "\n";

  // Find all running sandbox containers
  let containerNames: string[];
  try {
    const output = execSync(
      `${runtime.bin} ps --filter "name=vivi-sandbox-" --format "{{.Names}}"`,
      { encoding: "utf-8", timeout: 5_000 },
    ).trim();
    containerNames = output ? output.split("\n") : [];
  } catch {
    return;
  }

  for (const name of containerNames) {
    try {
      // Write the env file inside the container via stdin (avoids heredoc
      // escaping issues where JSON.stringify turns newlines into literal \n)
      execFileSync(runtime.bin, ["exec", "-i", name, "bash", "-c", "cat > /etc/sandbox-secrets"], {
        input: script,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5_000,
      });
      console.log(`[secrets] Synced env vars to ${name}`);
    } catch (err: any) {
      console.warn(`[secrets] Failed to sync to ${name}: ${err.message}`);
    }
  }
}
