/**
 * Kubernetes backend — opt-in alternative to the local Docker/Podman daemon.
 *
 * Enabled when VIVI_BACKEND=k8s. The Vivi server runs on the host (not in the
 * cluster) and treats the cluster as a remote container engine: one Pod per
 * sandbox session, exec/log/watch via the Kubernetes API.
 *
 * Single-tenant for now — all sandboxes land in one namespace (default: "vivi").
 * Multi-user requires running one Vivi server per user-namespace (see
 * docs/k8s-backend-exploration.md).
 */

import * as k8s from "@kubernetes/client-node";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import stream, { PassThrough, Readable } from "node:stream";

export const NAMESPACE = process.env.VIVI_K8S_NAMESPACE || "vivi";
const SANDBOX_IMAGE = process.env.VIVI_SANDBOX_IMAGE || "vivi-sandbox:latest";
const PROXY_IMAGE = process.env.VIVI_PROXY_IMAGE || "vivi-proxy:latest";
const SANDBOX_CONTAINER_NAME = "sandbox";
const BUNDLE_INIT_CONTAINER = "bundle-init";

/**
 * Bun's `fetch` (and undici-style fetch in general) does not honor Node's
 * `https.Agent` client-certificate options that @kubernetes/client-node sets.
 * Result: even when `loadFromDefault` reads the kubeconfig correctly, the API
 * server rejects the request as `system:anonymous`.
 *
 * Workaround: run `kubectl proxy` as a sidecar so we can talk to the cluster
 * over plain HTTP on localhost. `kubectl` handles all the auth/TLS for us.
 *
 * Set VIVI_K8S_DIRECT=1 to opt out (e.g. when running in-cluster with a
 * service-account token, where Bun's fetch handles bearer auth fine).
 */
let kubectlProxyProc: ChildProcess | null = null;
let kubectlProxyPort: number = 8001;

function startKubectlProxy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`[k8s] Starting kubectl proxy on 127.0.0.1:${port}...`);
    // `--reject-paths=^$` empties kubectl proxy's default deny list which
    // otherwise blocks pod exec / port-forward requests (matched by
    // /api/v1/.../exec). Safe here because we bind to loopback only.
    kubectlProxyProc = spawn("kubectl", [
      "proxy",
      `--port=${port}`,
      "--address=127.0.0.1",
      "--reject-paths=^$",
      "--accept-paths=^.*",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let ready = false;
    const onReady = () => { if (!ready) { ready = true; resolve(); } };

    kubectlProxyProc.stdout?.on("data", (chunk: Buffer) => {
      const out = chunk.toString();
      if (out.includes("Starting to serve")) onReady();
    });
    kubectlProxyProc.stderr?.on("data", (chunk: Buffer) => {
      console.warn(`[k8s] kubectl proxy stderr: ${chunk.toString().trim()}`);
    });
    kubectlProxyProc.on("error", (err) => reject(err));
    kubectlProxyProc.on("exit", (code) => {
      if (!ready) reject(new Error(`kubectl proxy exited with code ${code} before ready`));
      else console.warn(`[k8s] kubectl proxy exited with code ${code}`);
    });
    // Fallback: poll the port directly in case stdout signal didn't fire
    const start = Date.now();
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/namespaces`);
        if (res.ok || res.status === 200 || res.status === 401) {
          clearInterval(poll);
          onReady();
        }
      } catch {
        // not ready
      }
      if (Date.now() - start > 10_000) {
        clearInterval(poll);
        if (!ready) reject(new Error("kubectl proxy did not become reachable within 10s"));
      }
    }, 300);
  });
}

function buildKubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (process.env.VIVI_K8S_DIRECT === "1") {
    kc.loadFromDefault();
    return kc;
  }
  // Point at kubectl proxy — single in-cluster-like cluster, no auth.
  kc.loadFromOptions({
    clusters: [{ name: "kubectl-proxy", server: `http://127.0.0.1:${kubectlProxyPort}`, skipTLSVerify: true }],
    users: [{ name: "kubectl-proxy" }],
    contexts: [{ name: "kubectl-proxy", cluster: "kubectl-proxy", user: "kubectl-proxy" }],
    currentContext: "kubectl-proxy",
  });
  return kc;
}

/** Probe a port to see if it's already running a kubectl proxy. */
async function probeKubectlProxy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/namespaces?limit=1`);
    if (!res.ok) return false;
    const body = await res.text();
    return body.includes("NamespaceList") || body.includes('"kind"');
  } catch {
    return false;
  }
}

/** Ensure kubectl proxy is running before any API call. Idempotent. */
let proxyReadyPromise: Promise<void> | null = null;
async function ensureKubectlProxy(): Promise<void> {
  if (process.env.VIVI_K8S_DIRECT === "1") return;
  if (proxyReadyPromise) return proxyReadyPromise;
  proxyReadyPromise = (async () => {
    // Already-running proxy from a prior Vivi run? Reuse it.
    if (await probeKubectlProxy(kubectlProxyPort)) {
      console.log(`[k8s] Reusing existing kubectl proxy on 127.0.0.1:${kubectlProxyPort}`);
      return;
    }
    await startKubectlProxy(kubectlProxyPort);
  })();
  return proxyReadyPromise;
}

// Build the kc lazily — first API call awaits ensureKubectlProxy() first.
let _kc: k8s.KubeConfig | null = null;
let _core: k8s.CoreV1Api | null = null;
let _apps: k8s.AppsV1Api | null = null;
let _networking: k8s.NetworkingV1Api | null = null;
let _exec: k8s.Exec | null = null;

async function clients() {
  await ensureKubectlProxy();
  if (!_kc) {
    _kc = buildKubeConfig();
    _core = _kc.makeApiClient(k8s.CoreV1Api);
    _apps = _kc.makeApiClient(k8s.AppsV1Api);
    _networking = _kc.makeApiClient(k8s.NetworkingV1Api);
    _exec = new k8s.Exec(_kc);
    console.log(`[k8s] Connected to cluster, namespace: ${NAMESPACE}${process.env.VIVI_K8S_DIRECT === "1" ? "" : ` (via kubectl proxy on 127.0.0.1:${kubectlProxyPort})`}`);
  }
  return { kc: _kc!, core: _core!, apps: _apps!, networking: _networking!, exec: _exec! };
}

console.log(`[k8s] Module loaded, namespace: ${NAMESPACE}`);

// ---------------------------------------------------------------------------
// Namespace + proxy + NetworkPolicy bootstrap
// ---------------------------------------------------------------------------

/**
 * Idempotently ensure the namespace, proxy Deployment, proxy Service, and
 * NetworkPolicy exist. Safe to call on every session start.
 */
export async function ensureInfra(): Promise<void> {
  await ensureNamespace();
  await ensureProxyDeployment();
  await ensureProxyService();
  // NetworkPolicy intentionally not applied by default — minikube's default CNI
  // (kindnet/bridge) does not enforce NetworkPolicy, so applying it would give
  // a false sense of isolation. Opt-in via VIVI_K8S_NETWORK_POLICY=1.
  if (process.env.VIVI_K8S_NETWORK_POLICY === "1") {
    await ensureNetworkPolicy();
  }
  await waitForProxyReady();
}

async function ensureNamespace(): Promise<void> {
  const { core } = await clients();
  try {
    await core.readNamespace({ name: NAMESPACE });
    return;
  } catch (err: any) {
    if (err?.code !== 404 && err?.response?.statusCode !== 404) throw err;
  }
  await core.createNamespace({
    body: { metadata: { name: NAMESPACE, labels: { "app.kubernetes.io/managed-by": "vivi" } } },
  });
  console.log(`[k8s] Created namespace ${NAMESPACE}`);
}

async function ensureProxyDeployment(): Promise<void> {
  const { apps } = await clients();
  try {
    await apps.readNamespacedDeployment({ name: "proxy", namespace: NAMESPACE });
    return;
  } catch (err: any) {
    if (err?.code !== 404 && err?.response?.statusCode !== 404) throw err;
  }

  const hostServer = process.env.VIVI_K8S_HOST_SERVER || "host.minikube.internal:7700";
  await apps.createNamespacedDeployment({
    namespace: NAMESPACE,
    body: {
      metadata: { name: "proxy", labels: { app: "proxy" } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "proxy" } },
        template: {
          metadata: { labels: { app: "proxy" } },
          spec: {
            // Disable k8s auto-injected service env vars (e.g. PROXY_PORT=tcp://...)
            // which collide with the proxy's own PROXY_PORT config var.
            enableServiceLinks: false,
            containers: [{
              name: "proxy",
              image: PROXY_IMAGE,
              imagePullPolicy: "IfNotPresent",
              env: [{ name: "HOST_SERVER", value: hostServer }],
              ports: [{ containerPort: 7443 }],
              readinessProbe: {
                httpGet: { path: "/health", port: 7443 },
                periodSeconds: 5,
              },
            }],
          },
        },
      },
    },
  });
  console.log(`[k8s] Created proxy Deployment (HOST_SERVER=${hostServer})`);
}

async function ensureProxyService(): Promise<void> {
  const { core } = await clients();
  try {
    await core.readNamespacedService({ name: "proxy", namespace: NAMESPACE });
    return;
  } catch (err: any) {
    if (err?.code !== 404 && err?.response?.statusCode !== 404) throw err;
  }
  await core.createNamespacedService({
    namespace: NAMESPACE,
    body: {
      metadata: { name: "proxy" },
      spec: {
        selector: { app: "proxy" },
        ports: [{ port: 7443, targetPort: 7443 }],
      },
    },
  });
  console.log(`[k8s] Created proxy Service`);
}

async function ensureNetworkPolicy(): Promise<void> {
  const { networking } = await clients();
  try {
    await networking.readNamespacedNetworkPolicy({ name: "sandbox-egress", namespace: NAMESPACE });
    return;
  } catch (err: any) {
    if (err?.code !== 404 && err?.response?.statusCode !== 404) throw err;
  }
  await networking.createNamespacedNetworkPolicy({
    namespace: NAMESPACE,
    body: {
      metadata: { name: "sandbox-egress" },
      spec: {
        podSelector: { matchLabels: { "vivi.role": "sandbox" } },
        policyTypes: ["Egress"],
        egress: [
          // Sandbox can reach the proxy only
          { to: [{ podSelector: { matchLabels: { app: "proxy" } } }] },
          // DNS
          {
            to: [{ namespaceSelector: {} }],
            ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
          },
        ],
      },
    },
  });
  console.log(`[k8s] Applied NetworkPolicy sandbox-egress`);
}

async function waitForProxyReady(timeoutMs: number = 60_000): Promise<void> {
  const { apps } = await clients();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const dep = await apps.readNamespacedDeployment({ name: "proxy", namespace: NAMESPACE });
      const ready = dep.status?.readyReplicas ?? 0;
      if (ready >= 1) {
        console.log(`[k8s] Proxy is ready`);
        return;
      }
    } catch {
      // not found yet
    }
    await sleep(1000);
  }
  throw new Error(`Proxy deployment did not become ready within ${timeoutMs / 1000}s`);
}

/**
 * Run kubectl as a subprocess. Used for exec/cp-style operations because the
 * @kubernetes/client-node WebSocket exec path proxies poorly through kubectl
 * proxy on Bun. The HTTP API client (CRUD on pods/services/etc) is unaffected.
 */
function kubectlSubprocess(
  args: string[],
  opts: { stdin?: Buffer | string | null; timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("kubectl", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    proc.stdout!.on("data", (c) => stdoutBufs.push(c));
    proc.stderr!.on("data", (c) => stderrBufs.push(c));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try { proc.kill(); } catch {
            // already dead
          }
          reject(new Error(`kubectl ${args[0]} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : null;

    proc.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdoutBufs), stderr: Buffer.concat(stderrBufs), exitCode: code ?? 1 });
    });

    if (opts.stdin != null) {
      proc.stdin!.end(opts.stdin);
    } else {
      proc.stdin!.end();
    }
  });
}

/**
 * Copy the proxy's CA cert into a ConfigMap so sandbox pods can mount it as
 * /proxy-ca/ca-cert.pem. The proxy generates its own CA on first start (see
 * docker/proxy.ts) so we have to pull it from the running proxy pod.
 *
 * Re-runs on every session start (cheap); the ConfigMap is upserted.
 */
export async function syncProxyCa(): Promise<void> {
  const { core } = await clients();
  // Read the CA cert via kubectl subprocess (more reliable than WS exec on Bun)
  const res = await kubectlSubprocess([
    "exec", "-n", NAMESPACE, "deploy/proxy", "--", "cat", "/ca/ca-cert.pem",
  ], { timeoutMs: 10_000 });
  if (res.exitCode !== 0) {
    throw new Error(`CA read failed: exit ${res.exitCode} stderr=${res.stderr.toString()}`);
  }
  const caData = res.stdout.toString("utf-8");
  if (!caData.includes("BEGIN CERTIFICATE")) {
    throw new Error(`Proxy CA cert looks malformed: ${caData.slice(0, 200)}`);
  }

  // Upsert the ConfigMap
  const body = {
    metadata: { name: "proxy-ca" },
    data: { "ca-cert.pem": caData },
  };
  try {
    await core.readNamespacedConfigMap({ name: "proxy-ca", namespace: NAMESPACE });
    await core.replaceNamespacedConfigMap({ name: "proxy-ca", namespace: NAMESPACE, body });
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) {
      await core.createNamespacedConfigMap({ namespace: NAMESPACE, body });
    } else {
      throw err;
    }
  }
  console.log(`[k8s] Synced proxy CA into ConfigMap (${caData.length} bytes)`);
}

// ---------------------------------------------------------------------------
// Pod lifecycle
// ---------------------------------------------------------------------------

export interface SandboxPodOptions {
  /** Logical session id (12-char) — pod name becomes vivi-sandbox-<id> */
  sessionId: string;
  /** Branch name for the sandbox to create */
  branch: string;
  /** TASK_DESCRIPTION env */
  taskDescription?: string;
  /** GIT_REMOTE_URL env */
  remoteUrl?: string;
  /** HOST_GIT_NAME env */
  hostGitName?: string;
  /** HOST_GIT_EMAIL env */
  hostGitEmail?: string;
  /** Extra env (sandbox secrets, etc.) */
  extraEnv?: Record<string, string>;
}

export function getPodName(sessionId: string): string {
  return `vivi-sandbox-${sessionId}`;
}

/**
 * Create a sandbox pod with:
 *   - emptyDir at /staging where the bundle gets dropped
 *   - emptyDir at /workspace for the agent's working tree
 *   - bundle-init initContainer that waits for /staging/.ready before main starts
 *   - sandbox container running the standard vivi entrypoint
 *
 * Returns when the Pod has been created (NOT when it's ready). Caller must
 * push the bundle via uploadBundle() and then waitUntilReady().
 */
export async function createSandboxPod(opts: SandboxPodOptions): Promise<string> {
  const { core } = await clients();
  const podName = getPodName(opts.sessionId);

  const baseEnv: Record<string, string> = {
    HTTP_PROXY: "http://proxy:7443",
    HTTPS_PROXY: "http://proxy:7443",
    http_proxy: "http://proxy:7443",
    https_proxy: "http://proxy:7443",
    NO_PROXY: "proxy,localhost",
    no_proxy: "proxy,localhost",
    SSL_CERT_FILE: "/proxy-ca/ca-cert.pem",
    NODE_EXTRA_CA_CERTS: "/proxy-ca/ca-cert.pem",
    GH_TOKEN: "gh-sandbox-placeholder",
    TASK_DESCRIPTION: opts.taskDescription || "",
    GIT_REMOTE_URL: opts.remoteUrl || "",
    SESSION_ID: opts.sessionId,
    SANDBOX_BRANCH: opts.branch,
    CONTAINER_RUNTIME: "k8s",
    HOST: process.env.VIVI_K8S_SANDBOX_HOST || "host.minikube.internal",
    ...(opts.hostGitName ? { HOST_GIT_NAME: opts.hostGitName } : {}),
    ...(opts.hostGitEmail ? { HOST_GIT_EMAIL: opts.hostGitEmail } : {}),
    ...(opts.extraEnv || {}),
  };
  const env = Object.entries(baseEnv).map(([name, value]) => ({ name, value }));

  await core.createNamespacedPod({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: podName,
        labels: {
          "vivi.role": "sandbox",
          "vivi.session": opts.sessionId,
        },
      },
      spec: {
        restartPolicy: "Never",
        // No k8s service env auto-injection — sandbox shouldn't know about cluster services.
        enableServiceLinks: false,
        initContainers: [{
          name: BUNDLE_INIT_CONTAINER,
          // Use the sandbox image (it has bash and basic tools) to avoid a
          // second image to pull/load.
          image: SANDBOX_IMAGE,
          imagePullPolicy: "IfNotPresent",
          command: ["sh", "-c", "while [ ! -f /staging/.ready ]; do sleep 0.3; done"],
          volumeMounts: [{ name: "staging", mountPath: "/staging" }],
        }],
        containers: [{
          name: SANDBOX_CONTAINER_NAME,
          image: SANDBOX_IMAGE,
          imagePullPolicy: "IfNotPresent",
          env,
          tty: true,
          stdin: true,
          volumeMounts: [
            { name: "staging", mountPath: "/staging", readOnly: true },
            { name: "workspace", mountPath: "/workspace" },
            // CA cert injected by ensureProxyCa() via a ConfigMap mount
            { name: "proxy-ca", mountPath: "/proxy-ca", readOnly: true },
          ],
        }],
        volumes: [
          { name: "staging", emptyDir: {} },
          { name: "workspace", emptyDir: {} },
          { name: "proxy-ca", configMap: { name: "proxy-ca", optional: true } },
        ],
      },
    },
  });

  console.log(`[k8s] Created Pod ${podName}`);
  return podName;
}

/**
 * Wait for the pod to reach the `Init:0/1` state (init container running) so
 * we can exec into it to push the bundle.
 */
export async function waitForInitContainerRunning(podName: string, timeoutMs: number = 60_000): Promise<void> {
  const { core } = await clients();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pod = await core.readNamespacedPod({ name: podName, namespace: NAMESPACE });
    const initStatus = pod.status?.initContainerStatuses?.[0];
    if (initStatus?.state?.running) return;
    if (initStatus?.state?.terminated) {
      throw new Error(`bundle-init terminated early: ${JSON.stringify(initStatus.state.terminated)}`);
    }
    await sleep(500);
  }
  throw new Error(`bundle-init did not start within ${timeoutMs / 1000}s`);
}

/**
 * Upload a file from the host into the pod's /staging volume, then signal
 * the init container to exit by touching /staging/.ready.
 */
export async function uploadBundle(podName: string, hostBundlePath: string): Promise<void> {
  const data = fs.readFileSync(hostBundlePath);
  // Pipe the bundle bytes into `kubectl exec -i ... -- sh -c 'cat > /staging/repo.bundle && touch /staging/.ready'`
  const res = await kubectlSubprocess([
    "exec", "-i", "-n", NAMESPACE, podName, "-c", BUNDLE_INIT_CONTAINER, "--",
    "sh", "-c", "cat > /staging/repo.bundle && touch /staging/.ready",
  ], { stdin: data, timeoutMs: 60_000 });
  if (res.exitCode !== 0) {
    throw new Error(`bundle upload failed: exit ${res.exitCode} stderr=${res.stderr.toString()}`);
  }
  console.log(`[k8s] Uploaded bundle to ${podName} (${data.length} bytes)`);
}

/**
 * Wait for the sandbox container's entrypoint to finish (it touches
 * /tmp/.sandbox-ready when init scripts complete).
 */
export async function waitForSandboxReady(podName: string, timeoutMs: number = 60_000): Promise<void> {
  const { core } = await clients();
  const start = Date.now();

  // First, wait for the pod to be in `Running` phase
  while (Date.now() - start < timeoutMs) {
    const pod = await core.readNamespacedPod({ name: podName, namespace: NAMESPACE });
    if (pod.status?.phase === "Running") break;
    if (pod.status?.phase === "Failed") {
      throw new Error(`Pod ${podName} failed: ${pod.status?.message || "no message"}`);
    }
    await sleep(500);
  }

  // Then poll for /tmp/.sandbox-ready via exec
  while (Date.now() - start < timeoutMs) {
    try {
      const code = await execStatus(podName, ["test", "-f", "/tmp/.sandbox-ready"]);
      if (code === 0) return;
    } catch {
      // exec may fail transiently while pod is starting; ignore
    }
    await sleep(500);
  }

  throw new Error(`Sandbox in pod ${podName} did not become ready within ${timeoutMs / 1000}s`);
}

export async function getPodPhase(podName: string): Promise<"Pending" | "Running" | "Succeeded" | "Failed" | "Unknown" | "Missing"> {
  const { core } = await clients();
  try {
    const pod = await core.readNamespacedPod({ name: podName, namespace: NAMESPACE });
    return (pod.status?.phase as any) ?? "Unknown";
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) return "Missing";
    throw err;
  }
}

export async function deletePod(podName: string): Promise<void> {
  const { core } = await clients();
  try {
    await core.deleteNamespacedPod({ name: podName, namespace: NAMESPACE, gracePeriodSeconds: 0 });
    console.log(`[k8s] Deleted Pod ${podName}`);
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.statusCode === 404) return;
    console.warn(`[k8s] Failed to delete pod ${podName}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// One-shot exec helpers (replace `docker exec` for diff/logs/etc)
// ---------------------------------------------------------------------------

export interface ExecOptions {
  stdin?: string | Buffer;
  /** Per-exec timeout. Default 30s. */
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a command in the sandbox container and capture stdout/stderr/exit code.
 * Drop-in replacement for the `execFileSync(runtime.bin, ["exec", name, ...])` pattern.
 */
export async function execCapture(podName: string, argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const stdin = opts.stdin != null
    ? (typeof opts.stdin === "string" ? Buffer.from(opts.stdin) : opts.stdin)
    : null;

  const res = await kubectlSubprocess(
    [
      "exec",
      ...(stdin != null ? ["-i"] : []),
      "-n", NAMESPACE, podName, "-c", SANDBOX_CONTAINER_NAME, "--",
      ...argv,
    ],
    { stdin, timeoutMs: opts.timeoutMs ?? 30_000 },
  );
  return {
    stdout: res.stdout.toString("utf-8"),
    stderr: res.stderr.toString("utf-8"),
    exitCode: res.exitCode,
  };
}

/** Just the exit code. */
async function execStatus(podName: string, argv: string[]): Promise<number> {
  const res = await execCapture(podName, argv, { timeoutMs: 5_000 });
  return res.exitCode;
}

// ---------------------------------------------------------------------------
// PTY exec — bridge a Kubernetes exec WebSocket to the existing PTY interface
// ---------------------------------------------------------------------------

export interface K8sPtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Start an interactive exec into the sandbox container by spawning
 * `kubectl exec`. Bridges data through `onData`/`onExit` callbacks.
 *
 * Two implementations:
 *   - POSIX (Bun PTY): real TTY via Bun.spawn's `terminal:` option —
 *     full resize, ANSI cursor, colors. Used for `docker exec -it`-equivalent.
 *   - Windows (Node pipes): plain stdin/stdout pipes, no PTY. Resize is a no-op.
 *     Loses cursor/colors in some apps but works for shells and the Claude TUI
 *     well enough to prove the backend.
 */
export async function createPty(
  podName: string,
  argv: string[],
  opts: { cols: number; rows: number },
  onData: (chunk: string) => void,
  onExit: (code: number) => void,
): Promise<K8sPtyHandle> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const kubectlPath = Bun.which?.("kubectl") ?? "kubectl";

  // `-t` only works when stdin is a TTY. We don't have one on Windows-Bun,
  // so request `-i` only and let the server treat stdin as a stream.
  const isPosix = process.platform !== "win32";
  const args = [
    "exec", "-i",
    ...(isPosix ? ["-t"] : []),
    "-n", NAMESPACE, podName, "-c", SANDBOX_CONTAINER_NAME, "--",
    ...argv,
  ];

  if (isPosix) {
    const proc = Bun.spawn([kubectlPath, ...args], {
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        data(_terminal: Bun.Terminal, data: Uint8Array) {
          onData(decoder.decode(data, { stream: true }));
        },
      },
      env: process.env as Record<string, string>,
      cwd: process.cwd(),
    });
    const terminal = proc.terminal;
    if (!terminal) {
      try { proc.kill(); } catch {
        // already dead
      }
      throw new Error(`kubectl PTY spawn failed — Bun returned no terminal.`);
    }
    proc.exited.then((code: number) => onExit(code ?? 0))
      .catch((err: Error) => { console.error("[k8s] kubectl PTY exit error:", err.message); onExit(1); });
    return {
      write(data: string) { try { terminal.write(data); } catch { /* closed */ } },
      resize(cols: number, rows: number) { try { terminal.resize(cols, rows); } catch { /* closed */ } },
      kill() { try { terminal.close(); } catch {
        // already closed
      } try { proc.kill(); } catch {
        // already dead
      } },
    };
  }

  // Windows: no real PTY. Use node:child_process.spawn with pipes.
  const proc = spawn(kubectlPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout!.on("data", (c: Buffer) => onData(decoder.decode(c, { stream: true })));
  proc.stderr!.on("data", (c: Buffer) => onData(decoder.decode(c, { stream: true })));
  proc.on("exit", (code) => onExit(code ?? 0));
  proc.on("error", (err) => { console.error("[k8s] kubectl spawn error:", err.message); onExit(1); });
  return {
    write(data: string) {
      try { proc.stdin!.write(data); } catch {
        // pipe closed
      }
    },
    resize(_cols: number, _rows: number) { /* no-op on pipe mode */ },
    kill() { try { proc.kill(); } catch {
      // already dead
    } },
  };
}

// ---------------------------------------------------------------------------
// Logs (replaces `docker logs`)
// ---------------------------------------------------------------------------

export async function readPodLogs(podName: string, tail: number = 200): Promise<string> {
  const res = await kubectlSubprocess(
    ["logs", "-n", NAMESPACE, podName, "-c", SANDBOX_CONTAINER_NAME, `--tail=${tail}`],
    { timeoutMs: 15_000 },
  );
  // kubectl mirrors docker's behaviour — exit 0 + stderr if container has no logs yet.
  return res.stdout.toString("utf-8") + res.stderr.toString("utf-8");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
