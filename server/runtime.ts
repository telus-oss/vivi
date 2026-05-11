/**
 * Container runtime detection — supports Docker, Podman, and Kubernetes.
 *
 * Selection:
 *   1. VIVI_BACKEND=k8s        — Kubernetes mode (uses @kubernetes/client-node)
 *   2. CONTAINER_RUNTIME env   — "docker" or "podman" (local-daemon mode)
 *   3. Auto-detect             — try docker first, fall back to podman
 *
 * In k8s mode `bin` is still set (to "docker") so the few host-side shell-outs
 * that aren't sandbox-related (e.g. `git bundle create` on the host) still work
 * — but every sandbox-side `bin exec`/`bin run` call site MUST branch on
 * `runtime.backend === "k8s"` before invoking the CLI.
 */

import { execSync } from "node:child_process";

export type Backend = "docker" | "podman" | "k8s";

export interface ContainerRuntime {
  /** Which backend will host the sandboxes. */
  backend: Backend;
  /** CLI binary name: "docker" or "podman". Unused for sandbox ops when backend === "k8s". */
  bin: string;
  /** Compose command. Unused when backend === "k8s". */
  composeBin: string;
}

function detect(): ContainerRuntime {
  if (process.env.VIVI_BACKEND?.toLowerCase() === "k8s") {
    // Host still needs a container CLI for `git bundle create` (no — that's pure git);
    // pick docker if present, podman if not, neither is also fine for k8s mode.
    let bin = "docker";
    for (const candidate of ["docker", "podman"] as const) {
      try {
        execSync(`${candidate} --version`, { stdio: "pipe", timeout: 5_000 });
        bin = candidate;
        break;
      } catch {
        // try next
      }
    }
    return { backend: "k8s", bin, composeBin: `${bin} compose` };
  }

  const override = process.env.CONTAINER_RUNTIME?.toLowerCase();
  if (override === "docker" || override === "podman") {
    verify(override);
    return resolveLocal(override);
  }

  // Auto-detect: prefer docker, fall back to podman
  for (const bin of ["docker", "podman"] as const) {
    try {
      execSync(`${bin} --version`, { stdio: "pipe", timeout: 5_000 });
      return resolveLocal(bin);
    } catch {
      // not available, try next
    }
  }

  throw new Error(
    "Neither docker nor podman found in PATH. Install one of them, or set VIVI_BACKEND=k8s to use a Kubernetes cluster.",
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

function resolveLocal(bin: string): ContainerRuntime {
  return {
    backend: bin as Backend,
    bin,
    composeBin: `${bin} compose`,
  };
}

export const runtime = detect();

console.log(`[runtime] Backend: ${runtime.backend}${runtime.backend !== "k8s" ? ` (CLI: ${runtime.bin})` : ""}`);
