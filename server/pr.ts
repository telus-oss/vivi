/**
 * PR request management — handles intercepted PR creation requests from the sandbox.
 *
 * When the sandbox agent runs `gh pr create`, the proxy intercepts the GitHub API call
 * and forwards it here. The user approves via the UI, choosing to merge locally or
 * create a real GitHub PR.
 *
 * PRs are scoped to sessions — each PR is associated with the session that created it.
 */

import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getContainerName, getSession } from "./container.js";
import { runtime } from "./runtime.js";

export interface PrRequest {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  branch: string;
  baseBranch: string;
  status: "pending" | "pulling" | "merging" | "creating_pr" | "completed" | "failed" | "dismissed";
  result?: { prUrl?: string; error?: string; action?: string };
  createdAt: number;
}

const prRequests: PrRequest[] = [];
const listeners: Set<(pr: PrRequest) => void> = new Set();

function notify(pr: PrRequest) {
  for (const fn of listeners) {
    try { fn(pr); } catch (err: any) {
      console.warn(`[pr] Listener error during notify for PR ${pr.id}: ${err.message}`);
    }
  }
}

export function createPrRequest(sessionId: string, data: {
  title: string;
  description: string;
  branch: string;
  baseBranch: string;
}): PrRequest {
  const pr: PrRequest = {
    id: randomUUID(),
    sessionId,
    title: data.title,
    description: data.description,
    branch: data.branch,
    baseBranch: data.baseBranch || "main",
    status: "pending",
    createdAt: Date.now(),
  };
  prRequests.push(pr);
  notify(pr);
  return pr;
}

export function getPrRequests(sessionId?: string): PrRequest[] {
  if (sessionId) {
    return prRequests.filter((p) => p.sessionId === sessionId);
  }
  return [...prRequests];
}

export function getPrRequest(id: string): PrRequest | undefined {
  return prRequests.find((p) => p.id === id);
}

export function dismissPr(id: string): PrRequest {
  const pr = prRequests.find((p) => p.id === id);
  if (!pr) throw new Error(`PR request ${id} not found`);
  pr.status = "dismissed";
  notify(pr);
  return pr;
}

export function onPrUpdate(fn: (pr: PrRequest) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Get the diff for a PR from its container.
 */
export function getPrDiff(id: string): string {
  const prReq = prRequests.find((p) => p.id === id);
  if (!prReq) throw new Error(`PR request ${id} not found`);

  const containerName = getContainerName(prReq.sessionId);
  const diff = execFileSync(
    runtime.bin,
    ["exec", containerName, "git", "-C", "/workspace", "diff", `${prReq.baseBranch}...${prReq.branch}`],
    { encoding: "utf-8", timeout: 30_000 },
  );
  return diff;
}

/**
 * Get the full contents of a file from the PR branch in its container.
 */
export function getPrFile(id: string, filePath: string): string {
  const prReq = prRequests.find((p) => p.id === id);
  if (!prReq) throw new Error(`PR request ${id} not found`);

  // Normalize and validate: resolve against /workspace, then verify it stays within bounds
  const resolved = path.resolve("/workspace", filePath);
  if (!resolved.startsWith("/workspace/")) {
    throw new Error("Invalid file path");
  }

  const containerName = getContainerName(prReq.sessionId);
  const content = execFileSync(
    runtime.bin,
    ["exec", containerName, "git", "-C", "/workspace", "show", `${prReq.branch}:${filePath}`],
    { encoding: "utf-8", timeout: 30_000 },
  );
  return content;
}

/**
 * Approve a PR request — extract changes from container and execute the chosen action.
 */
export async function approvePr(
  id: string,
  action: "pull_local" | "github_pr",
  customDescription?: string,
): Promise<PrRequest> {
  const pr = prRequests.find((p) => p.id === id);
  if (!pr) throw new Error(`PR request ${id} not found`);
  if (pr.status !== "pending") throw new Error(`PR ${id} is not pending (status: ${pr.status})`);

  const session = getSession(pr.sessionId);
  if (!session || !session.repoPath) {
    throw new Error(`No active session ${pr.sessionId} with a repo path`);
  }

  const containerName = getContainerName(pr.sessionId);

  pr.status = action === "pull_local" ? "merging" : "creating_pr";
  pr.result = { action };
  notify(pr);

  try {
    // Step 1: Extract changes from container via git bundle.
    // Resolve baseBranch to a ref that actually exists in the sandbox — the host
    // repo may not have a "main" branch if it uses a different default branch name.
    const bundlePath = "/tmp/pr.bundle";

    let bundleBase = pr.baseBranch;
    try {
      execFileSync(
        runtime.bin,
        ["exec", containerName, "git", "-C", "/workspace", "rev-parse", "--verify", `${bundleBase}^{commit}`],
        { stdio: "pipe", timeout: 5_000 },
      );
    } catch {
      // baseBranch doesn't exist in the sandbox; try origin/HEAD
      try {
        bundleBase = execFileSync(
          runtime.bin,
          ["exec", containerName, "git", "-C", "/workspace", "symbolic-ref", "refs/remotes/origin/HEAD"],
          { encoding: "utf-8", stdio: "pipe", timeout: 5_000 },
        ).trim().replace("refs/remotes/origin/", "");
      } catch {
        bundleBase = ""; // fall through to full-branch bundle
      }
    }

    const bundleArgs = (bundleBase !== pr.branch)
      ? ["exec", containerName, "git", "-C", "/workspace", "bundle", "create", bundlePath, pr.branch, "--not", bundleBase]
      : ["exec", containerName, "git", "-C", "/workspace", "bundle", "create", bundlePath, pr.branch];

    execFileSync(runtime.bin, bundleArgs, { stdio: "pipe", timeout: 30_000 });

    // Step 2: Copy bundle to host.
    // We use `docker exec ... cat` instead of `docker cp` because `docker cp`
    // fails on macOS when the container has a Unix socket bind-mounted
    // (/var/run/docker.sock) — Docker tries to walk the overlay merged layer and
    // errors with "not a directory" when it hits the socket file.
    const hostBundlePath = `/tmp/vivi-pr-${pr.id}.bundle`;
    const bundleData = execFileSync(
      runtime.bin,
      ["exec", containerName, "cat", bundlePath],
      { maxBuffer: 100 * 1024 * 1024, timeout: 30_000 },
    );
    fs.writeFileSync(hostBundlePath, bundleData);

    // Verify the bundle is valid before attempting fetch
    execSync(`git bundle verify ${JSON.stringify(hostBundlePath)}`, {
      cwd: session.repoPath,
      stdio: "pipe",
      timeout: 10_000,
    });

    // Step 3: Fetch the branch into the host repo
    if (bundleBase !== pr.branch) {
      execFileSync("git", ["fetch", hostBundlePath, `${pr.branch}:${pr.branch}`], {
        cwd: session.repoPath, stdio: "pipe", timeout: 30_000,
      });
    } else {
      execFileSync("git", ["fetch", hostBundlePath, pr.branch], {
        cwd: session.repoPath, stdio: "pipe", timeout: 30_000,
      });
      execFileSync("git", ["merge", "FETCH_HEAD"], {
        cwd: session.repoPath, stdio: "pipe", timeout: 30_000,
      });
    }

    // Step 4: Execute the chosen action
    if (action === "pull_local") {
      // Just pull the branch to local — don't merge
      pr.status = "completed";
      pr.result = { action: "pull_local" };
    } else {
      // Push branch and create GitHub PR
      execFileSync("git", ["push", "origin", pr.branch], {
        cwd: session.repoPath, stdio: "pipe", timeout: 30_000,
      });

      // Build full PR body — use custom description if provided, otherwise agent's
      const prBody = customDescription ?? pr.description ?? "";
      let fullBody = prBody;
      fullBody += "\n\nCo-Authored-By: Claude (Vivi) <noreply@anthropic.com>";

      // Write body to a temp file to preserve newlines and special characters
      const bodyFile = `/tmp/vivi-pr-body-${pr.id}.md`;
      fs.writeFileSync(bodyFile, fullBody, "utf-8");

      let prUrl: string;
      try {
        prUrl = execFileSync(
          "gh",
          ["pr", "create", "--base", pr.baseBranch, "--head", pr.branch, "--title", pr.title, "--body-file", bodyFile],
          { cwd: session.repoPath, encoding: "utf-8", timeout: 30_000 },
        ).trim();
      } finally {
        try { fs.unlinkSync(bodyFile); } catch (err: any) {
          console.warn(`[pr] Failed to clean up temp body file ${bodyFile}: ${err.message}`);
        }
      }

      pr.status = "completed";
      pr.result = { action: "github_pr", prUrl };
    }

    // Cleanup
    try { fs.unlinkSync(hostBundlePath); } catch (err: any) {
      console.warn(`[pr] Failed to clean up bundle file ${hostBundlePath}: ${err.message}`);
    }

    notify(pr);
    return pr;
  } catch (err: any) {
    pr.status = "failed";
    pr.result = { ...pr.result, error: err.message };
    notify(pr);
    throw err;
  }
}
