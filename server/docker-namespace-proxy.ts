/**
 * Per-session Docker socket proxy.
 *
 * Each sandbox session gets its own Unix socket at /tmp/docker-ns-{sessionId}.sock.
 * That socket is bind-mounted into the sandbox container as /var/run/docker.sock,
 * so the sandbox can run docker commands without direct access to the dind daemon.
 *
 * The proxy enforces session namespacing:
 *   - POST /containers/create  → injects vivi.session=<id> label, blocks --privileged
 *   - GET  /containers/json    → rewrites URL to add ?filters={"label":["vivi.session=<id>"]}
 *   - Everything else          → piped through unchanged
 *
 * Security model: the sandbox network is internal (no internet access), so sandbox
 * containers cannot reach dind directly — they can only speak Docker through this proxy.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { execSync, exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { runtime } from "./runtime.js";
import { paths } from "./paths.js";

const execAsync = promisify(exec);

const DIND_HOST = "127.0.0.1";
const DIND_PORT = 2375;
const SOCKET_DIR = paths().socketsDir;
export const SESSION_LABEL = "vivi.session";

// TCP port range for per-session proxies (used when Podman can't mount sockets)
const TCP_PROXY_PORT_START = 18000;
const TCP_PROXY_PORT_MAX = 18999;
const allocatedTcpPorts = new Set<number>();

const activeProxies = new Map<string, net.Server>();

export interface SessionProxyInfo {
  /** "socket" for Docker (bind-mount), "tcp" for Podman (DOCKER_HOST env var) */
  mode: "socket" | "tcp";
  /** Socket path (mode=socket) or TCP port (mode=tcp) */
  socketPath?: string;
  tcpPort?: number;
}

const sessionProxyInfo = new Map<string, SessionProxyInfo>();

function allocateTcpPort(): number {
  for (let port = TCP_PROXY_PORT_START; port <= TCP_PROXY_PORT_MAX; port++) {
    if (!allocatedTcpPorts.has(port)) {
      allocatedTcpPorts.add(port);
      return port;
    }
  }
  throw new Error("No available TCP ports for Docker namespace proxy");
}

export function getSessionSocketPath(sessionId: string): string {
  return path.join(SOCKET_DIR, `docker-ns-${sessionId}.sock`);
}

export function getSessionProxyInfo(sessionId: string): SessionProxyInfo | undefined {
  return sessionProxyInfo.get(sessionId);
}

export function startSessionProxy(sessionId: string): Promise<SessionProxyInfo> {
  const useTcp = runtime.bin === "podman";

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      handleConnection(client, sessionId);
    });

    server.on("error", (err) => {
      console.error(`[docker-proxy:${sessionId}] Error:`, err.message);
      reject(err);
    });

    if (useTcp) {
      const port = allocateTcpPort();
      server.listen(port, "127.0.0.1", () => {
        console.log(`[docker-proxy:${sessionId}] Listening on tcp://127.0.0.1:${port}`);
        activeProxies.set(sessionId, server);
        const info: SessionProxyInfo = { mode: "tcp", tcpPort: port };
        sessionProxyInfo.set(sessionId, info);
        resolve(info);
      });
    } else {
      const socketPath = getSessionSocketPath(sessionId);
      try { fs.unlinkSync(socketPath); } catch {
        // Socket file may not exist yet — expected on first start
      }
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o666); } catch (err: any) {
          console.warn(`[docker-proxy:${sessionId}] Failed to chmod socket: ${err.message}`);
        }
        console.log(`[docker-proxy:${sessionId}] Listening on ${socketPath}`);
        activeProxies.set(sessionId, server);
        const info: SessionProxyInfo = { mode: "socket", socketPath };
        sessionProxyInfo.set(sessionId, info);
        resolve(info);
      });
    }
  });
}

export function stopSessionProxy(sessionId: string): void {
  const server = activeProxies.get(sessionId);
  if (server) {
    server.close();
    activeProxies.delete(sessionId);
  }
  const info = sessionProxyInfo.get(sessionId);
  if (info?.mode === "socket" && info.socketPath) {
    try { fs.unlinkSync(info.socketPath); } catch {
      // Socket file may already be removed
    }
  }
  if (info?.mode === "tcp" && info.tcpPort) {
    allocatedTcpPorts.delete(info.tcpPort);
  }
  sessionProxyInfo.delete(sessionId);
}

export function cleanupSessionContainers(sessionId: string): void {
  try {
    const ids = execSync(
      `${runtime.bin} -H tcp://127.0.0.1:${DIND_PORT} ps -aq --filter label=${SESSION_LABEL}=${sessionId}`,
      { encoding: "utf-8", timeout: 10_000, stdio: "pipe" },
    ).trim();
    if (ids) {
      execSync(
        `${runtime.bin} -H tcp://127.0.0.1:${DIND_PORT} rm -f ${ids}`,
        { stdio: "pipe", timeout: 15_000 },
      );
      console.log(`[docker-proxy:${sessionId}] Removed dind containers for session`);
    }
  } catch (err: any) {
    // dind may not be running, or session had no containers
    console.warn(`[docker-proxy:${sessionId}] Failed to clean up dind containers: ${err.message}`);
  }
}

export async function listSessionContainers(sessionId: string): Promise<DockerContainerInfo[]> {
  try {
    const { stdout } = await execAsync(
      `${runtime.bin} -H tcp://127.0.0.1:${DIND_PORT} ps -a --filter label=${SESSION_LABEL}=${sessionId} --format "{{json .}}"`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    const out = stdout.trim();
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const r = JSON.parse(line);
        return {
          id: r.ID,
          name: (r.Names || "").replace(/^\//, ""),
          image: r.Image,
          status: r.Status,
          state: r.State,
          ports: r.Ports || "",
          createdAt: r.CreatedAt,
        };
      });
  } catch (err: any) {
    // DinD may not be running or session has no containers
    console.warn(`[docker-proxy] Failed to list containers for session ${sessionId}: ${err.message}`);
    return [];
  }
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
}

/**
 * Inspect a container, returning the full Docker inspect JSON.
 * Validates that the container belongs to the given session (label check).
 */
export async function inspectContainer(
  sessionId: string,
  containerId: string,
): Promise<Record<string, any>> {
  // Sanitize containerId to prevent injection
  const safeId = containerId.replace(/[^a-zA-Z0-9_.-]/g, "");
  const { stdout } = await execAsync(
    `${runtime.bin} -H tcp://127.0.0.1:${DIND_PORT} inspect ${safeId}`,
    { encoding: "utf-8", timeout: 10_000 },
  );
  const arr = JSON.parse(stdout);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("Container not found");
  }
  const info = arr[0];
  // Security: verify session ownership
  const label = info.Config?.Labels?.[SESSION_LABEL];
  if (label !== sessionId) {
    throw new Error("Container does not belong to this session");
  }
  return info;
}

/**
 * Stream logs from a container. Returns the spawned child process.
 * Caller should listen on stdout/stderr and kill when done.
 * Validates session ownership before streaming.
 */
export async function streamContainerLogs(
  sessionId: string,
  containerId: string,
  tail: number = 200,
): Promise<ChildProcess> {
  // Validate ownership first
  const safeId = containerId.replace(/[^a-zA-Z0-9_.-]/g, "");
  const { stdout } = await execAsync(
    `${runtime.bin} -H tcp://127.0.0.1:${DIND_PORT} inspect --format '{{index .Config.Labels "${SESSION_LABEL}"}}' ${safeId}`,
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (stdout.trim() !== sessionId) {
    throw new Error("Container does not belong to this session");
  }

  const proc = spawn(runtime.bin, [
    "-H", `tcp://127.0.0.1:${DIND_PORT}`,
    "logs", "--follow", "--timestamps", "--tail", String(tail),
    safeId,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  return proc;
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function handleConnection(client: net.Socket, sessionId: string): void {
  const upstream = net.connect(DIND_PORT, DIND_HOST);

  upstream.on("data", (chunk) => client.write(chunk));
  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());

  // Re-enter header-listening mode to handle HTTP keep-alive connections.
  // The Docker CLI reuses a single TCP connection for multiple requests
  // (e.g. HEAD /_ping then POST /containers/create), so we must intercept
  // each request individually rather than switching to pass-through after
  // the first one.
  const listenForNextRequest = (initial?: Buffer) => {
    let buf = initial ?? Buffer.alloc(0);

    const headerListener = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return; // still collecting headers

      client.removeListener("data", headerListener);

      const headerSection = buf.slice(0, sep).toString("utf-8");
      const rest = buf.slice(sep + 4);
      const lines = headerSection.split("\r\n");
      const firstLine = lines[0] ?? "";
      const spaceIdx = firstLine.indexOf(" ");
      const method = firstLine.slice(0, spaceIdx).toUpperCase();
      const urlPath = firstLine.slice(spaceIdx + 1, firstLine.lastIndexOf(" "));

      if (method === "POST" && /^\/v[\d.]+\/containers\/create/.test(urlPath)) {
        interceptContainerCreate(client, upstream, listenForNextRequest, lines, rest, sessionId);
      } else if (method === "GET" && /^\/v[\d.]+\/containers\/json/.test(urlPath)) {
        const newPath = injectLabelFilter(urlPath, `${SESSION_LABEL}=${sessionId}`);
        const newHeader = `GET ${newPath} ${firstLine.slice(firstLine.lastIndexOf(" ") + 1)}\r\n`
          + lines.slice(1).join("\r\n") + "\r\n\r\n";
        upstream.write(newHeader);
        // GET has no request body — continue listening with leftover data
        listenForNextRequest(rest.length ? rest : undefined);
      } else {
        // Non-intercepted request — forward headers and consume body (if any)
        // before re-entering listen mode for the next request.
        upstream.write(buf.slice(0, sep + 4));
        const clLine = lines.find((l) => /^content-length:/i.test(l));
        const contentLength = clLine ? parseInt(clLine.split(":")[1].trim(), 10) : 0;
        if (contentLength === 0) {
          listenForNextRequest(rest.length ? rest : undefined);
        } else {
          forwardBodyThenListen(client, upstream, rest, contentLength, listenForNextRequest);
        }
      }
    };

    // Process any buffered data immediately
    if (buf.length > 0) {
      headerListener(Buffer.alloc(0));
    }

    client.on("data", headerListener);
  };

  listenForNextRequest();
}

/**
 * Forward exactly `contentLength` bytes of request body to upstream,
 * then re-enter header-listening mode with any leftover data.
 */
function forwardBodyThenListen(
  client: net.Socket,
  upstream: net.Socket,
  initial: Buffer,
  contentLength: number,
  onDone: (leftover?: Buffer) => void,
): void {
  let received = initial;

  const flush = () => {
    if (received.length < contentLength) return;
    client.removeListener("data", bodyListener);

    upstream.write(received.slice(0, contentLength));
    const extra = received.slice(contentLength);
    onDone(extra.length ? extra : undefined);
  };

  const bodyListener = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    flush();
  };

  client.on("data", bodyListener);
  flush();
}

function interceptContainerCreate(
  client: net.Socket,
  upstream: net.Socket,
  onDone: (leftover?: Buffer) => void,
  headerLines: string[],
  rest: Buffer,
  sessionId: string,
): void {
  const clLine = headerLines.find((l) => /^content-length:/i.test(l));
  const contentLength = clLine ? parseInt(clLine.split(":")[1].trim(), 10) : 0;

  let body = rest;

  const tryIntercept = () => {
    if (body.length < contentLength) return; // need more data

    client.removeListener("data", bodyListener);

    let bodyObj: any;
    try {
      bodyObj = JSON.parse(body.slice(0, contentLength).toString("utf-8"));
    } catch {
      // Unparseable — forward as-is
      upstream.write(Buffer.from(headerLines.join("\r\n") + "\r\n\r\n"));
      upstream.write(body.slice(0, contentLength));
      const extra = body.slice(contentLength);
      onDone(extra.length ? extra : undefined);
      return;
    }

    // Block --privileged containers inside the sandbox
    if (bodyObj.HostConfig?.Privileged) {
      const msg = JSON.stringify({ message: "privileged containers are not allowed in the Vivi sandbox" });
      client.write(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`,
      );
      client.end();
      upstream.destroy();
      return;
    }

    // Inject session label
    bodyObj.Labels = { ...(bodyObj.Labels ?? {}), [SESSION_LABEL]: sessionId };

    const newBodyBuf = Buffer.from(JSON.stringify(bodyObj));
    const newHeaderSection = headerLines
      .map((l) => (/^content-length:/i.test(l) ? `Content-Length: ${newBodyBuf.length}` : l))
      .join("\r\n") + "\r\n\r\n";

    upstream.write(newHeaderSection);
    upstream.write(newBodyBuf);

    const extra = body.slice(contentLength);
    onDone(extra.length ? extra : undefined);
  };

  const bodyListener = (chunk: Buffer) => {
    body = Buffer.concat([body, chunk]);
    tryIntercept();
  };

  client.on("data", bodyListener);
  tryIntercept();
}

function injectLabelFilter(urlPath: string, label: string): string {
  const qIdx = urlPath.indexOf("?");
  const base = qIdx === -1 ? urlPath : urlPath.slice(0, qIdx);
  const qs = qIdx === -1 ? "" : urlPath.slice(qIdx + 1);

  const params = new URLSearchParams(qs);
  let filters: Record<string, string[]> = {};
  const existing = params.get("filters");
  if (existing) {
    try { filters = JSON.parse(decodeURIComponent(existing)); } catch (err: any) {
      console.warn(`[docker-proxy] Failed to parse existing filters: ${err.message}`);
    }
  }
  // Docker clients serialize filter values inconsistently:
  // CLI/SDK uses arrays ["val"], compose uses objects {"val": true}.
  // Normalize all values to arrays before mutating.
  for (const key of Object.keys(filters)) {
    const v = filters[key];
    if (Array.isArray(v)) continue;
    if (v && typeof v === "object") filters[key] = Object.keys(v);
    else if (v != null) filters[key] = [String(v)];
  }
  filters.label = [...(filters.label ?? []), label];
  params.set("filters", JSON.stringify(filters));

  return `${base}?${params.toString()}`;
}
