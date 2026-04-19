/**
 * Port forwarding — allows sandbox containers to expose ports to the host.
 *
 * Uses `docker exec socat` to bridge: host TCP listener -> container port.
 * Same pattern as the terminal PTY bridge.
 */

import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { getContainerName } from "./container.js";
import { runtime } from "./runtime.js";
import { makeProxyUrl, setServerPort } from "./proxyUrl.js";

export { makeProxyUrl, setServerPort };

export interface PortForward {
  sessionId: string;
  containerPort: number;
  hostPort: number;
  status: "active" | "closing";
  createdAt: number;
  /** Subdomain slug for reverse-proxy access (e.g. "p-3000-abc123"). */
  proxySubdomain: string;
  /** Full URL for accessing this port forward via the reverse proxy. */
  proxyUrl: string;
  /** If set, socat connects to this host instead of localhost (for DinD container ports). */
  targetHost?: string;
  /** Display name of the DinD container (if forwarding a container port). */
  containerName?: string;
  /** Human-readable label for this port forward. */
  label?: string;
  /** Semantic type of this port forward (e.g. "git"). */
  type?: string;
}

interface PortForwardInternal extends PortForward {
  server: net.Server;
  socatProcesses: Set<ChildProcess>;
}

const portForwards: Map<string, PortForwardInternal> = new Map();
const allocatedHostPorts: Set<number> = new Set();
const listeners: Set<(ports: PortForward[]) => void> = new Set();

const HOST_PORT_START = 19000;
const HOST_PORT_MAX = 19999;

// Bind port forwards to all interfaces when HOST is a public hostname,
// so they're reachable from the network. Default to loopback only.
function getPortBindAddress(): string {
  const host = process.env.HOST || "localhost";
  if (host === "localhost" || host === "127.0.0.1") return "127.0.0.1";
  return "0.0.0.0";
}

function makeKey(sessionId: string, containerPort: number): string {
  return `${sessionId}:${containerPort}`;
}

/** Build a subdomain slug like "p-3000-abc123" from session + port. */
function makeSubdomain(sessionId: string, containerPort: number): string {
  const shortId = sessionId.slice(0, 8);
  return `p-${containerPort}-${shortId}`;
}

/** Regex to parse a proxy subdomain: p-{port}-{sessionPrefix} */
const SUBDOMAIN_RE = /^p-(\d+)-([a-z0-9]+)$/;

/**
 * Look up a port forward by its subdomain slug.
 * Returns the internal record (with hostPort for proxying) or undefined.
 */
export function getPortForwardBySubdomain(subdomain: string): PortForward | undefined {
  const match = SUBDOMAIN_RE.exec(subdomain);
  if (!match) return undefined;

  for (const pf of portForwards.values()) {
    if (pf.proxySubdomain === subdomain && pf.status === "active") {
      return toPublic(pf);
    }
  }
  return undefined;
}

function allocateHostPort(): number {
  for (let port = HOST_PORT_START; port <= HOST_PORT_MAX; port++) {
    if (!allocatedHostPorts.has(port)) {
      allocatedHostPorts.add(port);
      return port;
    }
  }
  throw new Error(`No available host ports in range ${HOST_PORT_START}-${HOST_PORT_MAX}`);
}

function toPublic(pf: PortForwardInternal): PortForward {
  const { server, socatProcesses, ...pub } = pf;
  return pub;
}

function notify() {
  const ports = getOpenPorts();
  for (const fn of listeners) {
    try { fn(ports); } catch (err: any) {
      console.warn(`[ports] Listener error during port update notification: ${err.message}`);
    }
  }
}

/**
 * Open a port forward: listen on a host port and bridge TCP connections
 * into the sandbox container via `docker exec -i <container> socat`.
 *
 * If `targetHost` is provided (for DinD container ports), socat connects to
 * that IP instead of localhost — this allows forwarding ports from Docker
 * containers launched inside the sandbox.
 */
export function openPort(
  sessionId: string,
  containerPort: number,
  targetHost?: string,
  containerName_?: string,
  label?: string,
  type?: string,
): PortForward {
  const key = makeKey(sessionId, containerPort) + (targetHost ? `:${targetHost}` : "");

  // Already forwarded?
  const existing = portForwards.get(key);
  if (existing && existing.status === "active") {
    return toPublic(existing);
  }

  const hostPort = allocateHostPort();
  const sandboxContainerName = getContainerName(sessionId);
  const socatProcesses = new Set<ChildProcess>();

  // socat target: either a DinD container IP or localhost
  const socatTarget = targetHost ? `TCP:${targetHost}:${containerPort}` : `TCP:localhost:${containerPort}`;

  const tcpServer = net.createServer((socket) => {
    const socat = spawn(runtime.bin, [
      "exec", "-i", sandboxContainerName,
      "socat", "STDIO", socatTarget,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    socatProcesses.add(socat);

    // Handle EPIPE/write errors on stdin — expected when socat exits before we stop writing
    socat.stdin?.on("error", (err) => {
      console.warn(`[ports] socat stdin error (${sandboxContainerName}→${socatTarget}): ${err.message}`);
      socket.destroy();
    });

    // Log stderr for debugging
    socat.stderr?.on("data", (data: Buffer) => {
      console.error(`[ports] socat stderr (${sandboxContainerName}→${socatTarget}): ${data.toString().trim()}`);
    });

    // Bidirectional piping: socket <-> socat stdin/stdout
    socket.on("data", (chunk) => {
      if (socat.stdin?.writable) {
        socat.stdin.write(chunk);
      }
    });

    socat.stdout?.on("data", (chunk: Buffer) => {
      if (!socket.destroyed) {
        socket.write(chunk);
      }
    });

    socket.on("end", () => {
      socat.stdin?.end();
    });

    socket.on("close", () => {
      socat.kill();
      socatProcesses.delete(socat);
    });

    socat.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[ports] socat exited with code ${code} for ${sandboxContainerName}→${socatTarget}`);
        // Send an HTTP error response so the browser shows something useful
        if (!socket.destroyed && !socket.writableEnded) {
          socket.end(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n` +
            `Port ${containerPort} is not reachable in the sandbox container.\n` +
            `Make sure a server is running on port ${containerPort}.\n`
          );
        }
      } else if (!socket.destroyed) {
        socket.end();
      }
      socatProcesses.delete(socat);
    });

    socket.on("error", (err) => {
      console.error(`[ports] socket error: ${err.message}`);
      socat.kill();
      socatProcesses.delete(socat);
    });

    socat.on("error", (err) => {
      console.error(`[ports] socat spawn error: ${err.message}`);
      socket.destroy();
      socatProcesses.delete(socat);
    });
  });

  tcpServer.on("error", (err) => {
    console.error(`[ports] TCP server error on host port ${hostPort}:`, err.message);
    // Clean up if listen fails
    allocatedHostPorts.delete(hostPort);
    portForwards.delete(key);
    notify();
  });

  const logTarget = targetHost ? `${targetHost}:${containerPort}` : `container:${containerPort}`;
  const bindAddr = getPortBindAddress();
  const displayHost = process.env.HOST || "localhost";
  tcpServer.listen(hostPort, bindAddr, () => {
    console.log(`[ports] Forwarding ${displayHost}:${hostPort} → ${logTarget} (session ${sessionId})`);
  });

  const subdomain = makeSubdomain(sessionId, containerPort);
  const pf: PortForwardInternal = {
    sessionId,
    containerPort,
    hostPort,
    proxySubdomain: subdomain,
    proxyUrl: makeProxyUrl(subdomain),
    status: "active",
    createdAt: Date.now(),
    server: tcpServer,
    socatProcesses,
    targetHost,
    containerName: containerName_,
    label,
    type,
  };

  portForwards.set(key, pf);
  notify();

  return toPublic(pf);
}

/**
 * Close a single port forward.
 */
export function closePort(sessionId: string, containerPort: number): boolean {
  const key = makeKey(sessionId, containerPort);
  const pf = portForwards.get(key);
  if (!pf) return false;

  pf.status = "closing";

  // Kill all active socat processes
  for (const proc of pf.socatProcesses) {
    try { proc.kill(); } catch (err: any) {
      console.warn(`[ports] Failed to kill socat process: ${err.message}`);
    }
  }
  pf.socatProcesses.clear();

  // Close the TCP server
  pf.server.close(() => {
    console.log(`[ports] Closed forwarding on host port ${pf.hostPort}`);
  });

  allocatedHostPorts.delete(pf.hostPort);
  portForwards.delete(key);
  notify();

  return true;
}

/**
 * Get all open port forwards, optionally filtered by session.
 */
export function getOpenPorts(sessionId?: string): PortForward[] {
  const results: PortForward[] = [];
  for (const pf of portForwards.values()) {
    if (!sessionId || pf.sessionId === sessionId) {
      results.push(toPublic(pf));
    }
  }
  return results;
}

/**
 * Close all port forwards for a session (called when session stops).
 */
export function closeAllPorts(sessionId: string): void {
  const toClose: [string, number][] = [];
  for (const pf of portForwards.values()) {
    if (pf.sessionId === sessionId) {
      toClose.push([pf.sessionId, pf.containerPort]);
    }
  }
  for (const [sid, port] of toClose) {
    closePort(sid, port);
  }
  if (toClose.length > 0) {
    console.log(`[ports] Closed ${toClose.length} port forward(s) for session ${sessionId}`);
  }
}

/**
 * Subscribe to port forward changes. Returns an unsubscribe function.
 */
export function onPortUpdate(fn: (ports: PortForward[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
