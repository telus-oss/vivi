/**
 * Docker event stream manager — replaces polling with `docker events`.
 *
 * Spawns a single long-running `docker events` process against the DinD daemon
 * and routes container lifecycle events to per-session subscribers. Subscribers
 * receive a fresh container list snapshot whenever a relevant event fires.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { listSessionContainers, SESSION_LABEL, type DockerContainerInfo } from "./docker-namespace-proxy.js";
import { runtime } from "./runtime.js";

const DIND_HOST = "127.0.0.1";
const DIND_PORT = 2375;

type SessionCallback = (containers: DockerContainerInfo[]) => void;

const sessionSubs = new Map<string, Set<SessionCallback>>();
let eventsProcess: ChildProcess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stopGraceTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let consecutiveFailures = 0;

const DEBOUNCE_MS = 250;
const RESTART_DELAY_MS = 3000;
const MAX_RESTART_DELAY_MS = 30000;
/** Grace period before actually killing the process when all subscribers leave.
 *  Prevents rapid stop/start churn from WebSocket reconnection cycles. */
const STOP_GRACE_MS = 5000;

// Events that meaningfully change container state
const RELEVANT_STATUSES = new Set([
  "create", "start", "stop", "die", "destroy", "kill",
  "pause", "unpause", "rename", "restart", "oom",
]);

function startProcess(): void {
  if (eventsProcess) return;

  // Podman CLI cannot talk to the Docker DinD daemon — it uses the libpod API
  // instead of the Docker Engine API. Skip the event stream for Podman; the
  // Docker-in-Docker container monitoring feature is unavailable in this mode.
  if (runtime.bin === "podman") {
    console.log("[docker-events] Skipping DinD event stream (Podman cannot connect to Docker daemon)");
    return;
  }

  const args = [
    "-H", `tcp://${DIND_HOST}:${DIND_PORT}`,
    "events",
    "--filter", "type=container",
    "--format", "{{json .}}",
  ];

  const cmd = `${runtime.bin} ${args.join(" ")}`;
  const proc = spawn(runtime.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  eventsProcess = proc;
  console.log(`[docker-events] Started event stream (pid: ${proc.pid}, cmd: ${cmd})`);

  let lineBuf = "";
  let receivedData = false;
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (!receivedData) { receivedData = true; consecutiveFailures = 0; }
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        handleEvent(evt);
      } catch {
        // Ignore unparseable lines
      }
    }
  });

  // Handle pipe read errors (e.g. ENXIO when DinD daemon is unavailable or
  // connection drops during reconnection). Without these handlers the errors
  // surface as uncaught exceptions.
  proc.stdout?.on("error", (err) => {
    console.warn(`[docker-events] stdout error (pid ${proc.pid}): ${err.message}`);
  });

  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });
  proc.stderr?.on("error", (err) => {
    console.warn(`[docker-events] stderr error (pid ${proc.pid}): ${err.message}`);
  });

  proc.on("exit", (code) => {
    const stderr = stderrBuf.trim();
    if (code !== 0) {
      consecutiveFailures++;
      console.error(`[docker-events] Process exited with code ${code}${stderr ? ` — stderr: ${stderr}` : ""} (failure #${consecutiveFailures})`);
    } else {
      consecutiveFailures = 0;
      console.log("[docker-events] Process exited with code 0");
    }
    // Only clear the reference if this is still the current process.
    // stopProcess() may have already started a replacement.
    if (eventsProcess === proc) {
      eventsProcess = null;
    }
    // Auto-restart with exponential backoff if there are still subscribers
    if (!eventsProcess && sessionSubs.size > 0) {
      const delay = Math.min(RESTART_DELAY_MS * Math.pow(2, consecutiveFailures - 1), MAX_RESTART_DELAY_MS);
      console.log(`[docker-events] Scheduling restart in ${(delay / 1000).toFixed(1)}s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!eventsProcess && sessionSubs.size > 0) startProcess();
      }, delay);
    }
  });

  proc.on("error", (err) => {
    console.error("[docker-events] Spawn error:", err.message);
    eventsProcess = null;
  });
}

function stopProcess(): void {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (stopGraceTimer) { clearTimeout(stopGraceTimer); stopGraceTimer = null; }
  if (eventsProcess) {
    eventsProcess.kill();
    eventsProcess = null;
  }
  consecutiveFailures = 0;
}

/** Schedule a deferred stop — cancelled if a new subscriber arrives before the grace period. */
function scheduleStop(): void {
  if (stopGraceTimer) return; // already scheduled
  stopGraceTimer = setTimeout(() => {
    stopGraceTimer = null;
    if (sessionSubs.size === 0) {
      console.log("[docker-events] No subscribers after grace period, stopping");
      stopProcess();
    }
  }, STOP_GRACE_MS);
}

function cancelScheduledStop(): void {
  if (stopGraceTimer) { clearTimeout(stopGraceTimer); stopGraceTimer = null; }
}

function handleEvent(evt: any): void {
  const status = evt.status || evt.Action;
  if (!RELEVANT_STATUSES.has(status)) return;

  const sessionId = evt.Actor?.Attributes?.[SESSION_LABEL];
  if (!sessionId) return;

  const subs = sessionSubs.get(sessionId);
  if (!subs || subs.size === 0) return;

  // Debounce: batch rapid events for the same session
  const existing = debounceTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  debounceTimers.set(sessionId, setTimeout(() => {
    debounceTimers.delete(sessionId);
    notifySession(sessionId);
  }, DEBOUNCE_MS));
}

async function notifySession(sessionId: string): Promise<void> {
  const subs = sessionSubs.get(sessionId);
  if (!subs || subs.size === 0) return;

  const containers = await listSessionContainers(sessionId);
  for (const cb of subs) {
    try { cb(containers); } catch (err: any) {
      console.warn(`[docker-events] Subscriber error for session ${sessionId}: ${err.message}`);
    }
  }
}

/**
 * Subscribe to container state changes for a session.
 * The callback fires with a fresh container list whenever relevant events occur.
 * Also fires immediately with the current state.
 * Returns an unsubscribe function.
 */
export function subscribeSession(
  sessionId: string,
  cb: SessionCallback,
): () => void {
  let subs = sessionSubs.get(sessionId);
  if (!subs) {
    subs = new Set();
    sessionSubs.set(sessionId, subs);
  }
  subs.add(cb);

  // Cancel any pending stop — a new subscriber arrived
  cancelScheduledStop();

  // Start the events process lazily
  if (!eventsProcess) startProcess();

  // Fire immediately with current state
  listSessionContainers(sessionId).then((containers) => {
    try { cb(containers); } catch (err: any) {
      console.warn(`[docker-events] Initial subscriber callback error for session ${sessionId}: ${err.message}`);
    }
  }).catch((err) => {
    console.warn(`[docker-events] Failed to list containers for session ${sessionId}:`, err.message);
  });

  return () => {
    subs!.delete(cb);
    if (subs!.size === 0) sessionSubs.delete(sessionId);
    // Defer stop so transient WebSocket reconnections don't cause churn
    if (sessionSubs.size === 0) scheduleStop();
  };
}

/**
 * Force-refresh all subscribers for a session (e.g. after a known container change).
 */
export function refreshSession(sessionId: string): void {
  notifySession(sessionId);
}
