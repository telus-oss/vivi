/**
 * Allowlist management — backed by SQLite.
 *
 * Writes config/allowlist.json for the proxy container (watched for changes).
 */

import fs from "node:fs";
import path from "node:path";
import db, { getConfig, setConfig } from "./db.js";

export interface NetworkRule {
  id: string;
  pattern: string;
  description?: string;
}

export interface AllowlistConfig {
  network: NetworkRule[];
  enabled: boolean;
}

const CONFIG_DIR = path.resolve("config");
const ALLOWLIST_FILE = path.join(CONFIG_DIR, "allowlist.json");

/** Write config/allowlist.json for the proxy container. */
function syncAllowlistJson() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const enabled = getConfig("allowlist_enabled", "true") === "true";
  const rules = db.prepare("SELECT pattern FROM network_rules").all() as { pattern: string }[];

  const data = {
    enabled,
    hosts: rules.map((r) => r.pattern),
  };

  fs.writeFileSync(ALLOWLIST_FILE, JSON.stringify(data, null, 2));
}

// Sync on startup
syncAllowlistJson();

// --- Prepared statements ---
const stmts = {
  listNet: db.prepare("SELECT id, pattern, description FROM network_rules ORDER BY id"),
  addNet: db.prepare("INSERT INTO network_rules (pattern, description) VALUES (?, ?)"),
  removeNet: db.prepare("DELETE FROM network_rules WHERE id = ?"),
  updateNet: db.prepare("UPDATE network_rules SET pattern = ?, description = ? WHERE id = ?"),
};

export function getAllowlistConfig(): AllowlistConfig {
  return {
    network: (stmts.listNet.all() as any[]).map((r) => ({ id: String(r.id), pattern: r.pattern, description: r.description })),
    enabled: getConfig("allowlist_enabled", "true") === "true",
  };
}

export function setAllowlistEnabled(enabled: boolean) {
  setConfig("allowlist_enabled", String(enabled));
  syncAllowlistJson();
}

export function addNetworkRule(pattern: string, description?: string): NetworkRule {
  const result = stmts.addNet.run(pattern, description || null);
  syncAllowlistJson();
  return { id: String(result.lastInsertRowid), pattern, description };
}

export function removeNetworkRule(id: string): boolean {
  const result = stmts.removeNet.run(id);
  if (result.changes > 0) syncAllowlistJson();
  return result.changes > 0;
}

export function updateNetworkRule(id: string, pattern: string, description?: string): NetworkRule | null {
  const result = stmts.updateNet.run(pattern, description || null, id);
  if (result.changes > 0) {
    syncAllowlistJson();
    return { id, pattern, description };
  }
  return null;
}

