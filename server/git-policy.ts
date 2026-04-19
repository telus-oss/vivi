/**
 * Git policy management — controls what git operations the sandbox can perform.
 *
 * Writes config/git-policy.json for the proxy container (watched for changes).
 * Designed to be frontend-controllable via REST API.
 */

import fs from "node:fs";
import path from "node:path";

export interface GitPolicy {
  enabled: boolean;
  gitHosts: string[];
  allowFetch: boolean;
  allowPush: boolean;
  allowPrCreation: boolean;
  protectedBranches: string[];
  allowReadFromUpstream: boolean;
}

const CONFIG_DIR = path.resolve("config");
const POLICY_FILE = path.join(CONFIG_DIR, "git-policy.json");

const DEFAULT_POLICY: GitPolicy = {
  enabled: true,
  gitHosts: ["github.com", "api.github.com"],
  allowFetch: true,
  allowPush: false,
  allowPrCreation: true,
  protectedBranches: ["main", "master"],
  allowReadFromUpstream: true,
};

let policy: GitPolicy = DEFAULT_POLICY;

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(POLICY_FILE, "utf-8"));
    policy = { ...DEFAULT_POLICY, ...data };
  } catch (e: any) {
    if (e.code !== "ENOENT") {
      console.error(`[git-policy] Error loading: ${e.message}`);
    }
    // Write defaults if file doesn't exist
    sync();
  }
}

function sync() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2) + "\n");
}

// Load on startup
load();

export function getPolicy(): GitPolicy {
  return { ...policy };
}

export function updatePolicy(updates: Partial<GitPolicy>): GitPolicy {
  policy = { ...policy, ...updates };
  sync();
  return { ...policy };
}
