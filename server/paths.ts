/**
 * Cross-platform resolution of Vivi's config and data directories.
 *
 * Precedence:
 *   1. VIVI_CONFIG_DIR / VIVI_DATA_DIR env vars (absolute paths, override everything)
 *   2. XDG_CONFIG_HOME / XDG_DATA_HOME on Linux (or BSD/other unix)
 *   3. Platform-native defaults:
 *        Linux   → ~/.config/vivi, ~/.local/share/vivi
 *        macOS   → ~/Library/Application Support/vivi  (both config and data)
 *        Windows → %APPDATA%\vivi,  %LOCALAPPDATA%\vivi
 *
 * A single override env var VIVI_HOME=/path can set both at once (config=<home>/config,
 * data=<home>/data). This is useful for docker-compose, CI, and tests.
 *
 * Directories are created lazily — callers should use paths() which ensures the
 * relevant subdirs exist before returning them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ViviPaths {
  configDir: string;
  dataDir: string;
  secretsFile: string;
  allowlistFile: string;
  gitPolicyFile: string;
  composeFile: string;
  dbFile: string;
  stagingDir: string;
  socketsDir: string;
  profilesDir: string;
}

function platformDefaults(): { config: string; data: string } {
  const home = os.homedir();
  const plat = process.platform;

  if (plat === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return {
      config: path.join(appData, "vivi"),
      data: path.join(localAppData, "vivi"),
    };
  }

  if (plat === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support", "vivi");
    return { config: appSupport, data: appSupport };
  }

  // Linux / BSD / others — follow XDG Base Directory spec
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return {
    config: path.join(xdgConfig, "vivi"),
    data: path.join(xdgData, "vivi"),
  };
}

function isRepoCheckout(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8"));
    return pkg.name === "vivi";
  } catch {
    return false;
  }
}

function resolveDirs(): { configDir: string; dataDir: string } {
  const home = process.env.VIVI_HOME;
  const configOverride = process.env.VIVI_CONFIG_DIR;
  const dataOverride = process.env.VIVI_DATA_DIR;

  // In a vivi repo checkout (bun dev), default to repo-local ./config and ./data
  // so devs keep the historical in-tree state. Explicit env vars still win.
  const devFallback = !home && !configOverride && !dataOverride && isRepoCheckout();
  const defaults = devFallback
    ? { config: path.resolve("config"), data: path.resolve("data") }
    : platformDefaults();

  const configDir = configOverride
    ? path.resolve(configOverride)
    : home
      ? path.resolve(home, "config")
      : defaults.config;

  const dataDir = dataOverride
    ? path.resolve(dataOverride)
    : home
      ? path.resolve(home, "data")
      : defaults.data;

  return { configDir, dataDir };
}

let cached: ViviPaths | null = null;

export function paths(): ViviPaths {
  if (cached) return cached;

  const { configDir, dataDir } = resolveDirs();

  const stagingDir = path.join(dataDir, "staging");
  const socketsDir = path.join(dataDir, "sockets");
  const profilesDir = path.join(dataDir, "profiles");

  for (const dir of [configDir, dataDir, stagingDir, socketsDir, profilesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  cached = {
    configDir,
    dataDir,
    secretsFile: path.join(configDir, "secrets.json"),
    allowlistFile: path.join(configDir, "allowlist.json"),
    gitPolicyFile: path.join(configDir, "git-policy.json"),
    composeFile: path.join(configDir, "docker-compose.yml"),
    dbFile: path.join(dataDir, "vivi.db"),
    stagingDir,
    socketsDir,
    profilesDir,
  };
  return cached;
}

/**
 * Host-side path to the data directory, for bind-mounts into sandbox containers.
 *
 * When the server runs inside a container, `-v /path/on/host:/path/in/container`
 * flags must reference the host filesystem, not the container's. HOST_DATA_DIR
 * is set by the compose file to the host-side data path; when unset (server
 * running on the host directly), we use the real data dir.
 */
export function hostDataDir(): string {
  return process.env.HOST_DATA_DIR || paths().dataDir;
}

/**
 * Translate a path under the server's data dir to its host-side equivalent.
 * No-op when the server isn't containerised.
 */
export function toHostPath(p: string): string {
  const host = process.env.HOST_DATA_DIR;
  if (!host) return p;
  return p.replace(paths().dataDir, host);
}
