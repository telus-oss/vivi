#!/usr/bin/env bun
/**
 * Vivi CLI — manages the vivi docker stack (app + proxy + dind).
 *
 * Usage:
 *   vivi start [--host]   Bring up the stack in the background
 *   vivi stop [--host]    Stop the stack, preserving volumes
 *   vivi restart [--host] Stop then start
 *   vivi status [--host]  Show service status
 *   vivi logs [service]   Tail logs (optionally for one service)
 *   vivi update           Pull the latest release's compose + images
 *   vivi path             Print resolved config / data dirs
 *   vivi version          Print CLI version
 *
 * `--host` runs the app server natively on the host (proxy + dind still
 * run in containers). Useful when host credentials must be available to
 * the server — e.g. the host `gh` CLI at companies that block PATs.
 *
 * Build-time constants (see cli/build.ts):
 *   VIVI_VERSION  — release tag this binary was built for (e.g. "v0.3.1")
 *   VIVI_REPO     — GitHub org/repo hosting releases (e.g. "telus-oss/vivi")
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { paths } from "../server/paths.js";

// Injected at build time via `bun build --define`. Fall back to dev defaults
// so `bun run cli/vivi.ts` works during local iteration.
declare const VIVI_VERSION: string;
declare const VIVI_REPO: string;
const VERSION = typeof VIVI_VERSION !== "undefined" ? VIVI_VERSION : "dev";
const REPO = typeof VIVI_REPO !== "undefined" ? VIVI_REPO : "telus-oss/vivi";

const COMPOSE_ASSET = "docker-compose.yml";
const HOST_APP_PORT = process.env.PORT || "7700";
const HOST_APP_BIND = "vivi.localhost";

interface RunOpts {
  env?: Record<string, string>;
  stdio?: "inherit" | "pipe";
}

function run(cmd: string, args: string[], opts: RunOpts = {}): number {
  const result = spawnSync(cmd, args, {
    stdio: opts.stdio ?? "inherit",
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (result.error) {
    console.error(`Error running ${cmd}:`, result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function detectComposeBin(): { bin: string; args: string[] } {
  for (const candidate of [
    { bin: "docker", args: ["compose"] },
    { bin: "podman", args: ["compose"] },
  ]) {
    const probe = spawnSync(candidate.bin, [...candidate.args, "version"], {
      stdio: "pipe",
    });
    if (probe.status === 0) return candidate;
  }
  console.error(
    "Could not find `docker compose` or `podman compose`. Install Docker Desktop (https://www.docker.com/products/docker-desktop) or Podman (https://podman.io) first.",
  );
  process.exit(1);
}

async function fetchCompose(version: string): Promise<string> {
  const url =
    version === "dev"
      ? `https://raw.githubusercontent.com/${REPO}/main/${COMPOSE_ASSET}`
      : `https://github.com/${REPO}/releases/download/${version}/${COMPOSE_ASSET}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${COMPOSE_ASSET} from ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return await res.text();
}

async function ensureComposeFile(opts: { force?: boolean } = {}): Promise<string> {
  const { composeFile } = paths();
  if (!opts.force && fs.existsSync(composeFile)) return composeFile;

  console.log(`Fetching ${COMPOSE_ASSET} for ${VERSION}...`);
  const body = await fetchCompose(VERSION);
  fs.writeFileSync(composeFile, body);
  console.log(`Wrote ${composeFile}`);
  return composeFile;
}

function composeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const p = paths();
  return {
    VIVI_VERSION: VERSION === "dev" ? "latest" : VERSION,
    VIVI_CONFIG_DIR: p.configDir,
    VIVI_DATA_DIR: p.dataDir,
    // Host-side path for bind-mounts the app container will hand back to the
    // host Docker daemon when launching sandbox containers.
    HOST_DATA_DIR: p.dataDir,
    ...extra,
  };
}

function printPaths() {
  const p = paths();
  console.log(`config dir:  ${p.configDir}`);
  console.log(`data dir:    ${p.dataDir}`);
  console.log(`compose:     ${p.composeFile}`);
  console.log(`database:    ${p.dbFile}`);
  console.log(`staging:     ${p.stagingDir}`);
  console.log(`sockets:     ${p.socketsDir}`);
  console.log(`profiles:    ${p.profilesDir}`);
}

// ---------------------------------------------------------------------------
// Host-mode app process management
// ---------------------------------------------------------------------------

function appBinaryPath(): string {
  return path.join(path.dirname(process.execPath), "vivi-app");
}

function appPidFile(): string {
  return path.join(paths().dataDir, "vivi-app.pid");
}

function appLogFile(): string {
  return path.join(paths().dataDir, "vivi-app.log");
}

function readAppPid(): number | null {
  const pidFile = appPidFile();
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0); // liveness probe — throws if process is gone
    return pid;
  } catch {
    fs.rmSync(pidFile, { force: true });
    return null;
  }
}

async function waitForHealth(port: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {/* still starting */}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function hostComposeEnv(): Record<string, string> {
  // Proxy reaches the native host server via docker's host.docker.internal
  // gateway. The upstream compose file honours `${HOST_SERVER:-app:PORT}`.
  return composeEnv({ HOST_SERVER: `host.docker.internal:${HOST_APP_PORT}` });
}

async function cmdStartHost(): Promise<number> {
  const appBin = appBinaryPath();
  if (!fs.existsSync(appBin)) {
    console.error(
      `vivi-app binary not found at ${appBin}.\n` +
        `Build it with \`bun run build:server\` and place it next to the vivi CLI.`,
    );
    return 1;
  }
  if (readAppPid()) {
    console.log("vivi-app is already running (use `vivi stop --host` first).");
    return 0;
  }

  const compose = detectComposeBin();
  const composeFile = await ensureComposeFile();

  console.log("Bringing up proxy + dind...");
  const composeRc = run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "up", "-d", "proxy", "dind"],
    { env: hostComposeEnv() },
  );
  if (composeRc !== 0) return composeRc;

  console.log(`Starting vivi-app natively on :${HOST_APP_PORT}...`);
  const p = paths();
  const logFd = fs.openSync(appLogFile(), "a");
  const child = spawn(appBin, [], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PORT: HOST_APP_PORT,
      HOST: HOST_APP_BIND,
      MANAGED_COMPOSE: "1",
      VIVI_CONFIG_DIR: p.configDir,
      VIVI_DATA_DIR: p.dataDir,
    },
  });
  child.unref();
  fs.closeSync(logFd);

  if (!child.pid) {
    console.error("Failed to spawn vivi-app.");
    return 1;
  }
  fs.writeFileSync(appPidFile(), String(child.pid));

  console.log(`vivi-app pid ${child.pid}; waiting for :${HOST_APP_PORT}...`);
  const healthy = await waitForHealth(HOST_APP_PORT, 30_000);
  if (!healthy) {
    console.error(
      `vivi-app did not become healthy in 30s. See ${appLogFile()} for details.`,
    );
    return 1;
  }
  console.log(`Ready: http://localhost:${HOST_APP_PORT}`);
  return 0;
}

async function cmdStopHost(): Promise<number> {
  const pid = readAppPid();
  if (pid) {
    console.log(`Stopping vivi-app (pid ${pid})...`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: any) {
      console.warn(`kill SIGTERM failed: ${err.message}`);
    }
    // Give it a moment to exit cleanly, then force.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
    }
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {/* already gone */}
    fs.rmSync(appPidFile(), { force: true });
  } else {
    console.log("vivi-app is not running.");
  }

  const compose = detectComposeBin();
  const composeFile = paths().composeFile;
  if (!fs.existsSync(composeFile)) return 0;
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "stop", "proxy", "dind"],
    { env: hostComposeEnv() },
  );
}

async function cmdStatusHost(): Promise<number> {
  const compose = detectComposeBin();
  const composeFile = paths().composeFile;
  const pid = readAppPid();
  console.log(
    `app (native): ${pid ? `running (pid ${pid})` : "stopped"}  log: ${appLogFile()}`,
  );
  if (!fs.existsSync(composeFile)) {
    console.log("Compose file not initialised yet.");
    return 0;
  }
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "ps", "proxy", "dind"],
    { env: hostComposeEnv() },
  );
}

// ---------------------------------------------------------------------------
// All-in-containers mode (original behaviour)
// ---------------------------------------------------------------------------

async function cmdStart(): Promise<number> {
  const compose = detectComposeBin();
  const composeFile = await ensureComposeFile();
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "up", "-d"],
    { env: composeEnv() },
  );
}

async function cmdStop(): Promise<number> {
  const compose = detectComposeBin();
  const composeFile = paths().composeFile;
  if (!fs.existsSync(composeFile)) {
    console.log("Vivi is not running (no compose file found).");
    return 0;
  }
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "down"],
    { env: composeEnv() },
  );
}

async function cmdRestart(host: boolean): Promise<number> {
  const stopRc = host ? await cmdStopHost() : await cmdStop();
  if (stopRc !== 0) return stopRc;
  return host ? await cmdStartHost() : await cmdStart();
}

async function cmdStatus(): Promise<number> {
  const compose = detectComposeBin();
  const composeFile = paths().composeFile;
  if (!fs.existsSync(composeFile)) {
    console.log("Vivi is not configured yet. Run `vivi start` to initialise.");
    return 0;
  }
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "ps"],
    { env: composeEnv() },
  );
}

async function cmdLogs(argv: string[]): Promise<number> {
  const compose = detectComposeBin();
  const composeFile = paths().composeFile;
  if (!fs.existsSync(composeFile)) {
    console.log("Vivi is not running.");
    return 1;
  }
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "logs", "-f", ...argv],
    { env: composeEnv() },
  );
}

async function cmdUpdate(): Promise<number> {
  const compose = detectComposeBin();
  await ensureComposeFile({ force: true });
  const composeFile = paths().composeFile;
  const rc = run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "pull"],
    { env: composeEnv() },
  );
  if (rc !== 0) return rc;
  return run(
    compose.bin,
    [...compose.args, "-f", composeFile, "-p", "vivi", "up", "-d"],
    { env: composeEnv() },
  );
}

function usage(): void {
  console.log(`vivi ${VERSION}

Commands:
  start [--host]   Bring up app + proxy + dind
                   --host: run app natively on host (proxy + dind in containers)
  stop [--host]    Stop the stack
  restart [--host] Stop then start
  status [--host]  Show service status
  logs [svc]       Tail logs
  update           Pull latest compose + images
  path             Print resolved config / data dirs
  version          Print CLI version

Env vars:
  VIVI_CONFIG_DIR   Override config directory
  VIVI_DATA_DIR     Override data directory
  VIVI_HOME         Parent dir for both (config/, data/)

Defaults:
  Linux   ~/.config/vivi + ~/.local/share/vivi (respects XDG_*)
  macOS   ~/Library/Application Support/vivi
  Windows %APPDATA%\\vivi + %LOCALAPPDATA%\\vivi
`);
}

function takeHostFlag(argv: string[]): { host: boolean; rest: string[] } {
  const rest: string[] = [];
  let host = false;
  for (const arg of argv) {
    if (arg === "--host") host = true;
    else rest.push(arg);
  }
  return { host, rest };
}

async function main(): Promise<void> {
  const [, , cmd, ...rawRest] = process.argv;
  const { host, rest } = takeHostFlag(rawRest);
  let rc: number;
  switch (cmd) {
    case "start":
      rc = host ? await cmdStartHost() : await cmdStart();
      break;
    case "stop":
      rc = host ? await cmdStopHost() : await cmdStop();
      break;
    case "restart":
      rc = await cmdRestart(host);
      break;
    case "status":
      rc = host ? await cmdStatusHost() : await cmdStatus();
      break;
    case "logs":
      rc = await cmdLogs(rest);
      break;
    case "update":
      rc = await cmdUpdate();
      break;
    case "path":
      printPaths();
      rc = 0;
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      rc = 0;
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      rc = 0;
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      rc = 1;
  }
  process.exit(rc);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
