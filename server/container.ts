/**
 * Container lifecycle management — multi-session sandbox orchestration.
 *
 * Each session gets its own Docker container (vivi-sandbox-{id}),
 * launched via `docker run`. A shared proxy container is managed via
 * docker-compose and stays alive as long as at least one session exists.
 *
 * Multiple sessions can share the same container via attachTo.
 */

import { execSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { getSandboxEnv } from "./secrets.js";
import { closeAllPorts } from "./ports.js";
import db from "./db.js";
import {
  startSessionProxy,
  stopSessionProxy,
  cleanupSessionContainers,
} from "./docker-namespace-proxy.js";
import * as profiles from "./profiles.js";
import { runtime } from "./runtime.js";
import * as sandboxImages from "./sandbox-images.js";

export interface SessionConfig {
  repoPath?: string;
  branch?: string;
  taskDescription?: string;
  attachTo?: string;
  profileId?: string;
  imageId?: number;
}

export interface SessionState {
  id: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  repoPath: string | null;
  repoName: string | null;
  branch: string | null;
  containerId: string | null;
  containerRef: string;
  error: string | null;
  startedAt: string | null;
}

const COMPOSE_FILE = path.resolve("docker-compose.yml");
const PROJECT_NAME = "vivi";
const STAGING_DIR = path.resolve("data", "staging");
// When running inside a container, bind-mount paths in `docker run -v` must reference
// the HOST filesystem, not the container filesystem. HOST_DATA_DIR provides the host-side
// path to the data directory so staging mounts resolve correctly on the host daemon.
const HOST_DATA_DIR = process.env.HOST_DATA_DIR || "";
const BUILTIN_IMAGE = "vivi-sandbox";
const SANDBOX_READY_TIMEOUT = Number(process.env.SANDBOX_READY_TIMEOUT) || 30_000;
const SANDBOX_NETWORK = "vivi_sandbox";
const PROXY_CA_VOLUME = "vivi_proxy-ca";

const sessions: Map<string, SessionState> = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getSessions(): SessionState[] {
  return [...sessions.values()].map((s) => ({ ...s }));
}

export function getSession(id: string): SessionState | undefined {
  const s = sessions.get(id);
  return s ? { ...s } : undefined;
}

export function getContainerName(sessionId: string): string {
  const session = sessions.get(sessionId);
  const ref = session?.containerRef || sessionId;
  return `vivi-sandbox-${ref}`;
}

export async function startSession(config: SessionConfig): Promise<SessionState> {
  if (config.attachTo) {
    return attachSession(config.attachTo);
  }

  if (!config.repoPath) {
    throw new Error("repoPath is required when creating a new container");
  }

  const repoPath = path.resolve(config.repoPath);
  if (!fs.existsSync(repoPath)) {
    throw new Error(
      `Path not found\n\n` +
      `The directory does not exist:\n${repoPath}\n\n` +
      `Check the path and try again.`
    );
  }
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error(
      `Not a git repository\n\n` +
      `No .git directory found in:\n${repoPath}\n\n` +
      `Make sure you're pointing to the root of a git repository, not a subdirectory.`
    );
  }

  const id = crypto.randomUUID().slice(0, 12);
  const branch = `claude/sandbox-${Date.now()}`;
  const repoName = path.basename(repoPath);

  const session: SessionState = {
    id,
    status: "starting",
    repoPath,
    repoName,
    branch,
    containerId: null,
    containerRef: id,
    error: null,
    startedAt: new Date().toISOString(),
  };
  sessions.set(id, session);

  try {
    const sessionStagingDir = path.join(STAGING_DIR, id);
    fs.mkdirSync(sessionStagingDir, { recursive: true });

    const bundlePath = path.join(sessionStagingDir, "repo.bundle");
    execSync("git bundle create " + JSON.stringify(bundlePath) + " --all", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 60_000,
    });
    console.log(`[container:${id}] Created git bundle at`, bundlePath);

    let remoteUrl = "";
    try {
      remoteUrl = execSync("git remote get-url origin", {
        cwd: repoPath, encoding: "utf-8", timeout: 5_000,
      }).trim();
      console.log(`[container:${id}] Remote URL:`, remoteUrl);
    } catch {
      console.log(`[container:${id}] No git remote found (fetch won't work in sandbox)`);
    }

    // Read host git identity so sandbox commits are attributed to the real user
    let hostGitName = "";
    let hostGitEmail = "";
    try {
      hostGitName = execSync("git config --global user.name", { encoding: "utf-8", timeout: 5_000 }).trim();
      hostGitEmail = execSync("git config --global user.email", { encoding: "utf-8", timeout: 5_000 }).trim();
    } catch {
      // Fall back to repo-level config
      try {
        hostGitName = execSync("git config user.name", { cwd: repoPath, encoding: "utf-8", timeout: 5_000 }).trim();
        hostGitEmail = execSync("git config user.email", { cwd: repoPath, encoding: "utf-8", timeout: 5_000 }).trim();
      } catch {
        // No git identity configured — sandbox commits will use container defaults
        console.log(`[container:${id}] No git user identity found (global or repo-level)`);
      }
    }

    await ensureProxy();

    // Start per-session Docker socket proxy (namespaces dind access for this session)
    const proxyInfo = await startSessionProxy(id);

    // Resolve which sandbox image to use
    let sandboxImage: string;
    if (config.imageId) {
      const img = sandboxImages.getById(config.imageId);
      if (!img) {
        throw new Error(`Sandbox image with id ${config.imageId} not found.`);
      }
      sandboxImage = img.image;
    } else {
      sandboxImage = sandboxImages.getDefault().image;
    }

    // Build or validate the sandbox image
    if (sandboxImage === BUILTIN_IMAGE) {
      execSync(`${runtime.bin} build -t ${BUILTIN_IMAGE} -f docker/Dockerfile.sandbox .`, {
        stdio: "pipe",
        timeout: 300_000,
      });
    } else {
      try {
        execFileSync(runtime.bin, ["image", "inspect", sandboxImage], { stdio: "pipe", timeout: 5_000 });
        console.log(`[container:${id}] Using custom image ${sandboxImage}`);
      } catch {
        throw new Error(
          `Image not found\n\n` +
          `Custom image '${sandboxImage}' is not available locally.\n\n` +
          `Pull it first:\n  ${runtime.bin} pull ${sandboxImage}`
        );
      }
    }

    const sandboxEnv = getSandboxEnv();
    const envFlags: string[] = [];
    for (const [key, value] of Object.entries(sandboxEnv)) {
      envFlags.push("-e", `${key}=${value}`);
    }

    const containerName = getContainerName(id);
    const stagingAbsPath = path.resolve(sessionStagingDir);
    // When running inside a container, remap staging path to the host-side equivalent
    const stagingMountPath = HOST_DATA_DIR
      ? stagingAbsPath.replace(path.resolve("data"), HOST_DATA_DIR)
      : stagingAbsPath;

    // Pre-flight: verify the container runtime can read bind-mounted paths.
    // On macOS, ~/Documents, ~/Desktop, ~/Downloads are TCC-protected —
    // Docker/OrbStack/Colima may be blocked from reading them.
    checkBindMountAccess(stagingMountPath, sandboxImage);

    // Validate profile if provided
    let profileDir: string | null = null;
    if (config.profileId) {
      profileDir = profiles.getProfileDir(config.profileId);
      if (!fs.existsSync(profileDir)) {
        fs.mkdirSync(profileDir, { recursive: true });
      }
      profiles.markProfileUsed(config.profileId);
    }

    // Docker: bind-mount the Unix socket into the container
    // Podman: use TCP proxy and set DOCKER_HOST (Podman VMs can't mount host sockets)
    const dockerSocketFlags: string[] = [];
    if (proxyInfo.mode === "socket" && proxyInfo.socketPath) {
      const socketMountPath = HOST_DATA_DIR
        ? proxyInfo.socketPath.replace(path.resolve("data"), HOST_DATA_DIR)
        : proxyInfo.socketPath;
      dockerSocketFlags.push("-v", `${socketMountPath}:/var/run/docker.sock`);
    } else if (proxyInfo.mode === "tcp" && proxyInfo.tcpPort) {
      dockerSocketFlags.push("-e", `DOCKER_HOST=tcp://host.containers.internal:${proxyInfo.tcpPort}`);
    }

    const args = [
      runtime.bin, "run", "-d",
      "--name", containerName,
      "--network", SANDBOX_NETWORK,
      "-v", `${stagingMountPath}:/staging:ro`,
      "-v", `${PROXY_CA_VOLUME}:/proxy-ca:ro`,
      "-v", `vivi-workspace-${id}:/workspace`,
      ...dockerSocketFlags,
      ...(profileDir ? ["-v", `${HOST_DATA_DIR ? profileDir.replace(path.resolve("data"), HOST_DATA_DIR) : profileDir}:/claude-profile:ro`] : []),
      "-e", "HTTP_PROXY=http://proxy:7443",
      "-e", "HTTPS_PROXY=http://proxy:7443",
      "-e", "http_proxy=http://proxy:7443",
      "-e", "https_proxy=http://proxy:7443",
      "-e", "NO_PROXY=proxy,localhost",
      "-e", "no_proxy=proxy,localhost",
      "-e", "SSL_CERT_FILE=/proxy-ca/ca-cert.pem",
      "-e", "NODE_EXTRA_CA_CERTS=/proxy-ca/ca-cert.pem",
      "-e", "GH_TOKEN=gh-sandbox-placeholder",
      "-e", `TASK_DESCRIPTION=${config.taskDescription || ""}`,
      "-e", `GIT_REMOTE_URL=${remoteUrl}`,
      "-e", `SESSION_ID=${id}`,
      "-e", `SANDBOX_BRANCH=${branch}`,
      "-e", `CONTAINER_RUNTIME=${runtime.bin}`,
      "-e", `HOST=${process.env.HOST || "localhost"}`,
      ...(hostGitName ? ["-e", `HOST_GIT_NAME=${hostGitName}`] : []),
      ...(hostGitEmail ? ["-e", `HOST_GIT_EMAIL=${hostGitEmail}`] : []),
      ...envFlags,
      "--tty",
      "--interactive",
      sandboxImage,
    ];

    const containerId = execFileSync(runtime.bin, args.slice(1), {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim();

    session.containerId = containerId.slice(0, 12);
    console.log(`[container:${id}] Started container ${containerName} (${session.containerId})`);

    await waitForContainer(containerName, SANDBOX_READY_TIMEOUT);

    session.status = "running";

    db.prepare(`
      INSERT OR REPLACE INTO active_containers (session_id, container_ref, container_id, repo_path, repo_name, branch, started_at, profile_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, id, session.containerId, repoPath, repoName, branch, session.startedAt, config.profileId ?? null);

    return { ...session };
  } catch (err: any) {
    session.status = "error";
    session.error = err.message;
    await stopSession(id).catch((stopErr: any) => {
      console.warn(`[container:${id}] Cleanup after start failure also failed: ${stopErr.message}`);
    });
    throw err;
  }
}

function attachSession(sourceSessionId: string): SessionState {
  const source = sessions.get(sourceSessionId);
  if (!source) throw new Error(`Session ${sourceSessionId} not found`);
  if (source.status !== "running") throw new Error(`Session ${sourceSessionId} is not running`);

  const id = crypto.randomUUID().slice(0, 12);
  const session: SessionState = {
    id,
    status: "running",
    repoPath: source.repoPath,
    repoName: source.repoName,
    branch: source.branch,
    containerId: source.containerId,
    containerRef: source.containerRef,
    error: null,
    startedAt: new Date().toISOString(),
  };
  sessions.set(id, session);
  console.log(`[container:${id}] Attached to container from session ${sourceSessionId}`);
  return { ...session };
}

export async function stopSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = "stopping";
  }

  closeAllPorts(sessionId);

  const containerRef = session?.containerRef || sessionId;
  sessions.delete(sessionId);

  const othersUsingContainer = [...sessions.values()].some(
    (s) => s.containerRef === containerRef
  );

  if (!othersUsingContainer) {
    // Auto-save profile before removing container
    const activeRow = db.prepare("SELECT profile_id FROM active_containers WHERE container_ref = ?").get(containerRef) as { profile_id: string | null } | undefined;
    const profileId = activeRow?.profile_id ?? null;

    db.prepare("DELETE FROM active_containers WHERE container_ref = ?").run(containerRef);

    const containerName = `vivi-sandbox-${containerRef}`;

    if (profileId) {
      const profile = profiles.getProfile(profileId);
      if (profile?.autoSave) {
        try {
          profiles.saveProfileFromContainer(profileId, containerName);
          console.log(`[container:${sessionId}] Saved ~/.claude to profile ${profileId}`);
        } catch (err: any) {
          console.warn(`[container:${sessionId}] Profile save failed: ${err.message}`);
        }
      }
    }

    try {
      execSync(`${runtime.bin} rm -f ${containerName}`, { stdio: "pipe", timeout: 30_000 });
      console.log(`[container:${sessionId}] Removed container ${containerName}`);
    } catch (err: any) {
      console.warn(`[container:${sessionId}] Failed to remove container ${containerName}: ${err.message}`);
    }

    // Remove the workspace volume (explicit stop = intentional cleanup)
    try {
      execSync(`${runtime.bin} volume rm vivi-workspace-${containerRef}`, { stdio: "pipe", timeout: 10_000 });
      console.log(`[container:${sessionId}] Removed workspace volume vivi-workspace-${containerRef}`);
    } catch (err: any) {
      console.warn(`[container:${sessionId}] Failed to remove workspace volume: ${err.message}`);
    }

    // Clean up dind containers for this session and stop the socket proxy
    cleanupSessionContainers(containerRef);
    stopSessionProxy(containerRef);

    try {
      const sessionStagingDir = path.join(STAGING_DIR, containerRef);
      if (fs.existsSync(sessionStagingDir)) {
        fs.rmSync(sessionStagingDir, { recursive: true, force: true });
      }
    } catch (err: any) {
      console.warn(`[container:${sessionId}] Failed to clean up staging dir: ${err.message}`);
    }
  } else {
    // Other sessions still use this container — only remove this session's DB row
    db.prepare("DELETE FROM active_containers WHERE session_id = ?").run(sessionId);
  }

  if (sessions.size === 0) {
    await stopProxy();
  }
}

// ---------------------------------------------------------------------------
// Proxy lifecycle
// ---------------------------------------------------------------------------

async function ensureProxy(): Promise<void> {
  // When running inside docker-compose.full.yml, proxy and dind are managed externally
  if (process.env.MANAGED_COMPOSE === "1") {
    console.log("[proxy] Managed by external compose — skipping ensureProxy");
    return;
  }
  try {
    const result = execSync(
      `${runtime.composeBin} -f "${COMPOSE_FILE}" -p ${PROJECT_NAME} ps --format json proxy`,
      { encoding: "utf-8", timeout: 5000 },
    );
    if (result.includes('"running"')) {
      console.log("[proxy] Already running");
      return;
    }
  } catch {
    // Proxy not running yet — will start below
  }

  console.log("[proxy] Starting proxy and dind via docker-compose...");
  execSync(`${runtime.composeBin} -f "${COMPOSE_FILE}" -p ${PROJECT_NAME} build proxy`, {
    stdio: "pipe", timeout: 300_000,
  });
  execSync(`${runtime.composeBin} -f "${COMPOSE_FILE}" -p ${PROJECT_NAME} up -d proxy dind`, {
    stdio: "inherit", timeout: 300_000,
  });

  const start = Date.now();
  while (Date.now() - start < 30_000) {
    try {
      const result = execSync(
        `${runtime.composeBin} -f "${COMPOSE_FILE}" -p ${PROJECT_NAME} ps --format json proxy`,
        { encoding: "utf-8", timeout: 5000 },
      );
      if (result.includes('"running"')) {
        console.log("[proxy] Proxy is running");
        return;
      }
    } catch {
      // Proxy not ready yet — will retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `Proxy failed to start\n\n` +
    `The docker-compose proxy container did not become healthy within the timeout.\n\n` +
    `Try:\n` +
    `  • Make sure ${runtime.bin} is running\n` +
    `  • Run: ${runtime.composeBin} -f docker-compose.yml down\n` +
    `  • Then retry launching the sandbox`
  );
}

async function stopProxy(): Promise<void> {
  if (process.env.MANAGED_COMPOSE === "1") {
    console.log("[proxy] Managed by external compose — skipping stopProxy");
    return;
  }
  console.log("[proxy] Stopping proxy (no active sessions)...");
  try {
    execSync(
      `${runtime.composeBin} -f "${COMPOSE_FILE}" -p ${PROJECT_NAME} down --timeout 10`,
      { stdio: "pipe", timeout: 30_000 },
    );
  } catch (err: any) {
    console.warn("[proxy] Failed to stop proxy:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Wait helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session restore (called on server startup)
// ---------------------------------------------------------------------------

export async function restoreSessions(): Promise<void> {
  const rows = db.prepare("SELECT * FROM active_containers").all() as {
    session_id: string;
    container_ref: string;
    container_id: string | null;
    repo_path: string | null;
    repo_name: string | null;
    branch: string | null;
    started_at: string;
  }[];

  for (const row of rows) {
    const containerName = `vivi-sandbox-${row.container_ref}`;
    try {
      const status = execSync(
        `${runtime.bin} inspect --format '{{.State.Status}}' ${containerName}`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();

      if (status === "running") {
        // Verify the container is actually reachable (not just metadata-running)
        let reachable = false;
        try {
          execSync(`${runtime.bin} exec ${containerName} true`, { stdio: "pipe", timeout: 5000 });
          reachable = true;
        } catch (execErr: any) {
          console.warn(`[container:${row.session_id}] Container ${containerName} reports running but is unreachable: ${execErr.message}`);
        }

        if (reachable) {
          await startSessionProxy(row.container_ref);
        }

        const session: SessionState = {
          id: row.session_id,
          status: reachable ? "running" : "error",
          repoPath: row.repo_path,
          repoName: row.repo_name,
          branch: row.branch,
          containerId: row.container_id,
          containerRef: row.container_ref,
          error: reachable ? null : "Container is no longer reachable. It may have been removed or is in a broken state.",
          startedAt: row.started_at,
        };
        sessions.set(row.session_id, session);
        if (reachable) {
          console.log(`[container:${row.session_id}] Restored running container ${containerName}`);
        } else {
          console.log(`[container:${row.session_id}] Restored container ${containerName} in error state (unreachable)`);
        }
      } else if (status === "exited") {
        // Container stopped (e.g. host reboot) but workspace volume persists — try to restart.
        console.log(`[container:${row.session_id}] Container ${containerName} exited, attempting restart...`);
        try {
          await ensureProxy();
          await startSessionProxy(row.container_ref);
          execSync(`${runtime.bin} start ${containerName}`, { stdio: "pipe", timeout: 10_000 });
          await waitForContainer(containerName, SANDBOX_READY_TIMEOUT);
          const session: SessionState = {
            id: row.session_id,
            status: "running",
            repoPath: row.repo_path,
            repoName: row.repo_name,
            branch: row.branch,
            containerId: row.container_id,
            containerRef: row.container_ref,
            error: null,
            startedAt: row.started_at,
          };
          sessions.set(row.session_id, session);
          console.log(`[container:${row.session_id}] Restarted container ${containerName}`);
        } catch (restartErr: any) {
          console.log(`[container:${row.session_id}] Failed to restart ${containerName}: ${restartErr.message}, cleaning up`);
          db.prepare("DELETE FROM active_containers WHERE session_id = ?").run(row.session_id);
        }
      } else {
        console.log(`[container:${row.session_id}] Container ${containerName} is ${status}, cleaning up`);
        db.prepare("DELETE FROM active_containers WHERE session_id = ?").run(row.session_id);
      }
    } catch (err: any) {
      console.log(`[container:${row.session_id}] Container ${containerName} not found (${err.message}), cleaning up`);
      db.prepare("DELETE FROM active_containers WHERE session_id = ?").run(row.session_id);
    }
  }
}

async function waitForContainer(containerName: string, timeoutMs: number) {
  const start = Date.now();
  console.log(`[container] Waiting for ${containerName} (timeout: ${timeoutMs}ms)...`);

  let containerExited = false;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = execSync(
        `${runtime.bin} inspect --format '{{.State.Status}}' ${containerName}`,
        { encoding: "utf-8", timeout: 5000 },
      );
      const status = result.trim();
      if (status === "running") break;
      if (status === "exited" || status === "dead") {
        containerExited = true;
        break;
      }
    } catch {
      // Container may not exist yet — will retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (containerExited) {
    throw new Error(diagnoseContainerFailure(containerName));
  }

  console.log(`[container] Container running, waiting for readiness signal...`);

  while (Date.now() - start < timeoutMs) {
    try {
      execSync(`${runtime.bin} exec ${containerName} test -f /tmp/.sandbox-ready`, { timeout: 3000 });
      console.log(`[container] Ready after ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return;
    } catch {
      // Readiness file not present yet — will retry
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Dump container logs and include tail in the error for diagnosis
  let logTail = "";
  try {
    const logs = execSync(`${runtime.bin} logs --tail 50 ${containerName}`, { encoding: "utf-8", timeout: 5000 });
    console.log(`[container] ---- ${containerName} logs (last 50 lines) ----`);
    console.log(logs);
    console.log(`[container] ---- end logs ----`);
    logTail = logs.trim().split("\n").slice(-5).join("\n");
  } catch (err: any) {
    console.warn(`[container] Failed to retrieve logs for timeout diagnosis: ${err.message}`);
  }

  throw new Error(
    `Container startup timed out\n\n` +
    `The sandbox container did not become ready within ${Math.round(timeoutMs / 1000)}s.` +
    (logTail ? `\n\nLast log output:\n${logTail}` : "")
  );
}

/**
 * Inspect a failed container's logs and return a user-friendly error message.
 * Detects known failure patterns (e.g. macOS TCC filesystem restrictions) and
 * provides actionable fix instructions.
 */
function diagnoseContainerFailure(containerName: string): string {
  let logs = "";
  try {
    logs = execSync(`${runtime.bin} logs --tail 50 ${containerName}`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    console.log(`[container] ---- ${containerName} logs (last 50 lines) ----`);
    console.log(logs);
    console.log(`[container] ---- end logs ----`);
  } catch (err) {
    console.warn(`[container] Failed to retrieve logs for ${containerName}:`, err);
  }

  // Detect macOS TCC / filesystem permission denial on bind mounts
  if (logs.includes("Operation not permitted") && (logs.includes("/staging") || logs.includes("repo.bundle"))) {
    return buildFilesystemPermissionError();
  }

  // Generic fallback — include the last few log lines for context
  const lastLines = logs.trim().split("\n").slice(-5).join("\n");
  return `Container exited unexpectedly.${lastLines ? `\n\nLast log output:\n${lastLines}` : ""}`;
}

/**
 * Pre-flight check: verify the container runtime can read a bind-mounted path.
 *
 * Runs a lightweight throwaway container that attempts to read the staging
 * directory. Catches macOS TCC permission blocks *before* the full sandbox
 * starts, so the user gets an instant actionable error instead of a 30-second
 * timeout followed by a cryptic "container is not running" loop.
 */
function checkBindMountAccess(stagingAbsPath: string, image: string): void {
  if (os.platform() !== "darwin") return; // TCC is macOS-only

  console.log(`[container] Pre-flight: checking bind-mount access for ${stagingAbsPath}...`);
  try {
    execFileSync(runtime.bin, [
      "run", "--rm",
      "-v", `${stagingAbsPath}:/staging:ro`,
      image,
      "test", "-r", "/staging/repo.bundle",
    ], { stdio: "pipe", timeout: 15_000 });
    console.log(`[container] Pre-flight: bind-mount access OK`);
  } catch (err: any) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    const combined = stderr + stdout;
    console.warn(`[container] Pre-flight: bind-mount check failed:`, combined);

    // Distinguish between "file simply not readable" and "Operation not permitted" (TCC block)
    if (combined.includes("Operation not permitted") || combined.includes("permission denied")) {
      throw new Error(buildFilesystemPermissionError());
    }
    // Non-TCC failure (e.g. file missing) — let the normal flow handle it
  }
}

/** Build the user-facing error message for macOS filesystem permission issues. */
function buildFilesystemPermissionError(): string {
  const runtimeName =
    runtime.bin === "podman" ? "Podman" : "Docker Desktop / OrbStack / Colima";

  return [
    `Filesystem permission denied`,
    ``,
    `macOS is blocking ${runtimeName} from reading files in a protected folder (Documents, Desktop, or Downloads).`,
    ``,
    `To fix, choose one:`,
    `  • System Settings → Privacy & Security → Full Disk Access → enable ${runtimeName}, then restart it`,
    `  • Move the project to ~/Projects/ or another non-protected directory`,
  ].join("\n");
}
