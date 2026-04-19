/**
 * Container runtime detection — supports Docker and Podman.
 *
 * Detection order:
 *   1. CONTAINER_RUNTIME env var ("docker" or "podman")
 *   2. Auto-detect: try docker first, fall back to podman
 *
 * Exports a resolved config object used by all server modules
 * that invoke container CLI commands.
 */

import { execSync } from "node:child_process";

export interface ContainerRuntime {
  /** CLI binary name: "docker" or "podman" */
  bin: string;
  /** Compose command for execSync string interpolation: "docker compose" or "podman compose" */
  composeBin: string;
}

function detect(): ContainerRuntime {
  const override = process.env.CONTAINER_RUNTIME?.toLowerCase();
  if (override === "docker" || override === "podman") {
    verify(override);
    return resolve(override);
  }

  // Auto-detect: prefer docker, fall back to podman
  for (const bin of ["docker", "podman"] as const) {
    try {
      execSync(`${bin} --version`, { stdio: "pipe", timeout: 5_000 });
      return resolve(bin);
    } catch {
      // not available, try next
    }
  }

  throw new Error(
    "Neither docker nor podman found in PATH. Install one of them to use Vivi."
  );
}

function verify(bin: string): void {
  try {
    execSync(`${bin} --version`, { stdio: "pipe", timeout: 5_000 });
  } catch {
    throw new Error(
      `CONTAINER_RUNTIME is set to "${bin}" but it was not found in PATH.`
    );
  }
}

function resolve(bin: string): ContainerRuntime {
  return {
    bin,
    composeBin: `${bin} compose`,
  };
}

export const runtime = detect();

console.log(`[runtime] Container runtime: ${runtime.bin}`);
