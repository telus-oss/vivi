#!/usr/bin/env bun
/**
 * Vivi CLI — manages the vivi docker stack (app + proxy + dind).
 *
 * Usage:
 *   vivi start            Bring up the stack in the background
 *   vivi stop             Stop the stack, preserving volumes
 *   vivi restart          Stop then start
 *   vivi status           Show service status
 *   vivi logs [service]   Tail logs (optionally for one service)
 *   vivi update           Pull the latest release's compose + images
 *   vivi path             Print resolved config / data dirs
 *   vivi version          Print CLI version
 *
 * Build-time constants (see cli/build.ts):
 *   VIVI_VERSION  — release tag this binary was built for (e.g. "v0.3.1")
 *   VIVI_REPO     — GitHub org/repo hosting releases (e.g. "telus-oss/vivi")
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { paths } from "../server/paths.js";

// Injected at build time via `bun build --define`. Fall back to dev defaults
// so `bun run cli/vivi.ts` works during local iteration.
declare const VIVI_VERSION: string;
declare const VIVI_REPO: string;
const VERSION = typeof VIVI_VERSION !== "undefined" ? VIVI_VERSION : "dev";
const REPO = typeof VIVI_REPO !== "undefined" ? VIVI_REPO : "telus-oss/vivi";

const COMPOSE_ASSET = "docker-compose.yml";

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

function composeEnv(): Record<string, string> {
  const p = paths();
  return {
    VIVI_VERSION: VERSION === "dev" ? "latest" : VERSION,
    VIVI_CONFIG_DIR: p.configDir,
    VIVI_DATA_DIR: p.dataDir,
    // Host-side path for bind-mounts the app container will hand back to the
    // host Docker daemon when launching sandbox containers.
    HOST_DATA_DIR: p.dataDir,
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

async function cmdRestart(): Promise<number> {
  const stopRc = await cmdStop();
  if (stopRc !== 0) return stopRc;
  return cmdStart();
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
  start           Bring up app + proxy + dind
  stop            Stop the stack
  restart         Stop then start
  status          Show service status
  logs [svc]      Tail logs
  update          Pull latest compose + images
  path            Print resolved config / data dirs
  version         Print CLI version

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

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  let rc: number;
  switch (cmd) {
    case "start":
      rc = await cmdStart();
      break;
    case "stop":
      rc = await cmdStop();
      break;
    case "restart":
      rc = await cmdRestart();
      break;
    case "status":
      rc = await cmdStatus();
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
