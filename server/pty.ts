/**
 * PTY WebSocket server — bridges browser terminals to sandbox containers.
 *
 * Each sandbox session has its own ActivityMonitor and terminal connections.
 * Uses Bun's native Terminal API (Bun 1.3.5+) for PTY management.
 *
 * WebSocket endpoints:
 *   /ws/terminal?sessionId=X&mode=Y  — PTY into a session's container
 *   /ws/monitor?sessionId=X          — subscribe to a session's health monitor
 */

import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { getContainerName, getSession } from "./container.js";
import { ActivityMonitor } from "./monitor.js";
import { runtime } from "./runtime.js";
import { ingestSetupTokenOutput, resetCapture } from "./auth.js";
import { onPrUpdate, type PrRequest } from "./pr.js";
import { onPortUpdate, getOpenPorts, type PortForward } from "./ports.js";
import { listSessionContainers, inspectContainer, streamContainerLogs, type DockerContainerInfo } from "./docker-namespace-proxy.js";
import { subscribeSession } from "./docker-events.js";
import { onSecretRequestUpdate } from "./secret-requests.js";
import type { ChildProcess } from "node:child_process";

// Per-session activity monitors
const monitors: Map<string, ActivityMonitor> = new Map();

/** Wrapper around Bun.spawn + Bun.Terminal that exposes a node-pty-like interface. */
interface BunPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly proc: ReturnType<typeof Bun.spawn>;
}

// Per-session Claude PTY processes (for sending intervention commands)
const claudePtySessions: Map<string, BunPty> = new Map();

/** Get (or create) the ActivityMonitor for a given session. */
export function getMonitor(sessionId: string): ActivityMonitor {
  let m = monitors.get(sessionId);
  if (!m) {
    m = new ActivityMonitor();
    // Wire up intervention: when the monitor detects stuck + auto-intervene is on,
    // send ESC followed by a redirect prompt to the Claude PTY
    m.onIntervene = (message: string) => {
      const ptyProc = claudePtySessions.get(sessionId);
      if (ptyProc) {
        // Send ESC (cancel current input/operation)
        ptyProc.write("\x1b");
        // Small delay then send the redirect message
        setTimeout(() => {
          ptyProc.write(`${message}\r`);
        }, 500);
      }
    };
    monitors.set(sessionId, m);
  }
  return m;
}

/** Remove a session's monitor (call on session stop). */
export function removeMonitor(sessionId: string): void {
  const m = monitors.get(sessionId);
  if (m) m.destroy();
  monitors.delete(sessionId);
  claudePtySessions.delete(sessionId);

  // Kill and remove the persistent Claude PTY for this session (if any).
  const persistent = persistentClaudeSessions.get(sessionId);
  if (persistent) {
    try { persistent.pty.kill(); } catch (err: any) {
      console.warn(`[pty] Failed to kill persistent PTY for session ${sessionId}: ${err.message}`);
    }
    persistentClaudeSessions.delete(sessionId);
  }
}

interface PtySession {
  pty: BunPty;
  ws: WebSocket;
}

const ptySessions: Map<string, PtySession> = new Map();
let sessionCounter = 0;

// Persistent Claude PTY sessions — survive WebSocket disconnects so the Claude
// process keeps running when a tab is backgrounded or a second tab is opened.
interface PersistentClaudeSession {
  pty: BunPty;
  buffer: string;        // rolling replay buffer sent to reconnecting clients
  subs: Set<WebSocket>; // currently connected WebSocket subscribers
}
const MAX_REPLAY_BUFFER = 512 * 1024; // 512 KB
const persistentClaudeSessions: Map<string, PersistentClaudeSession> = new Map();

/**
 * Spawn a process with a Bun.Terminal PTY.
 * Returns a BunPty wrapper and fires callbacks for data/exit.
 */
function spawnPty(
  cmd: string,
  args: string[],
  opts: { cols: number; rows: number },
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): BunPty {
  // Use a single streaming TextDecoder so multi-byte UTF-8 characters split
  // across chunks are reassembled correctly instead of producing garbage.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  // On Windows, Bun.spawn won't auto-resolve PATHEXT (e.g. "claude" → "claude.exe"),
  // so resolve the absolute path up front. No-op on Unix if cmd is already a path.
  const resolvedCmd = Bun.which(cmd) ?? cmd;
  const proc = Bun.spawn([resolvedCmd, ...args], {
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
    // Bun.spawn returned without a PTY — usually because the command is not on PATH
    // (e.g. `claude` CLI missing on the host). Kill the stub proc and surface a
    // clean error instead of crashing the whole server on a later write/close.
    try { proc.kill(); } catch { /* stub proc, may already be dead */ }
    const isWin = process.platform === "win32";
    throw new Error(
      isWin
        ? `Failed to spawn PTY for "${cmd}". Bun's PTY support is POSIX-only — ` +
          `Vivi's terminal flows (login, in-session shell) don't work on Windows native. ` +
          `Run Vivi inside WSL or on a Linux/macOS host.`
        : `Failed to spawn PTY for "${cmd}". Command not found or exited immediately. ` +
          `Is "${cmd}" installed and on PATH?`
    );
  }

  // Monitor process exit
  proc.exited.then((code: number) => {
    onExit(code ?? 0);
  }).catch((err: Error) => {
    console.error("[pty] Process exit error:", err.message);
    onExit(1);
  });

  const pty: BunPty = {
    write(data: string) {
      try { terminal.write(data); } catch (err: any) {
        console.warn("[pty] Error writing to terminal:", err.message);
      }
    },
    resize(cols: number, rows: number) {
      try { terminal.resize(cols, rows); } catch (err: any) {
        console.warn("[pty] Error resizing terminal:", err.message);
      }
    },
    kill() {
      try { terminal.close(); } catch (err: any) {
        console.warn("[pty] Error closing terminal:", err.message);
      }
      try { proc.kill(); } catch (err: any) {
        console.warn("[pty] Error killing process:", err.message);
      }
    },
    proc,
  };

  return pty;
}

export function attachWebSocketServer(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/ws/terminal") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, url);
      });
    } else if (url.pathname === "/ws/monitor") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleMonitorConnection(ws, url);
      });
    } else if (url.pathname === "/ws/docker") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleDockerConnection(ws, url);
      });
    }
    // Anything else: leave the socket alone. Other upgrade listeners
    // (e.g. the subdomain port-forward proxy in server/index.ts) may still
    // be mid-handshake on this socket.
  });
}

function handleTerminalConnection(ws: WebSocket, url: URL) {
  const cols = parseInt(url.searchParams.get("cols") || "120", 10);
  const rows = parseInt(url.searchParams.get("rows") || "40", 10);
  const mode = url.searchParams.get("mode") || "claude"; // "claude", "shell", or "setup-token"
  const sessionId = url.searchParams.get("sessionId") || "";

  const ptySessionId = `term-${++sessionCounter}`;

  // ── Claude mode: persistent PTY that survives WebSocket disconnects ──────────
  // When a tab is backgrounded the browser may close the WebSocket, but the
  // Claude process must keep running. We keep one PTY per sessionId and let
  // multiple WebSocket connections subscribe to it.
  if (mode === "claude") {
    if (!sessionId) {
      ws.send(JSON.stringify({ type: "error", message: "Missing sessionId query parameter." }));
      ws.close();
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.status !== "running") {
      const errorMsg = session?.status === "error" && session.error
        ? session.error
        : `Session ${sessionId} is not running. Start a session first.`;
      ws.send(JSON.stringify({ type: "error", message: errorMsg, fatal: true }));
      ws.close();
      return;
    }

    let persistent = persistentClaudeSessions.get(sessionId);

    if (!persistent) {
      // Spawn the Claude process for the first connection to this session.
      const containerName = getContainerName(sessionId);
      let ptyHandle: BunPty;
      try {
        ptyHandle = spawnPty(
          runtime.bin,
          ["exec", "-it", "-u", "agent", "-e", "TERM=xterm-256color", containerName, "claude", "--dangerously-skip-permissions"],
          { cols, rows },
          // onData — PTY → all subscribers + rolling buffer + monitor
          (data: string) => {
            const p = persistentClaudeSessions.get(sessionId);
            if (!p) return;
            p.buffer += data;
            if (p.buffer.length > MAX_REPLAY_BUFFER) {
              p.buffer = p.buffer.slice(p.buffer.length - MAX_REPLAY_BUFFER);
            }
            getMonitor(sessionId).ingest(data);
            for (const sub of p.subs) {
              if (sub.readyState === WebSocket.OPEN) sub.send(data);
            }
          },
          // onExit
          (exitCode: number) => {
            const p = persistentClaudeSessions.get(sessionId);
            if (p) {
              const msg = `\r\n[Process exited with code ${exitCode}]\r\n`;
              for (const sub of p.subs) {
                if (sub.readyState === WebSocket.OPEN) {
                  sub.send(msg);
                  sub.close();
                }
              }
              persistentClaudeSessions.delete(sessionId);
            }
            if (claudePtySessions.get(sessionId) === ptyHandle) {
              claudePtySessions.delete(sessionId);
            }
            ptySessions.delete(ptySessionId);
          },
        );
      } catch (err: any) {
        ws.send(JSON.stringify({ type: "error", message: `Failed to spawn PTY: ${err.message}` }));
        ws.close();
        return;
      }

      persistent = { pty: ptyHandle, buffer: "", subs: new Set() };
      persistentClaudeSessions.set(sessionId, persistent);
      claudePtySessions.set(sessionId, ptyHandle);
      ptySessions.set(ptySessionId, { pty: ptyHandle, ws });
    }

    // Attach this WebSocket as a subscriber.
    const p = persistent;
    p.subs.add(ws);

    // Log WebSocket errors but don't crash — EPIPE is expected when browser disconnects.
    ws.on("error", (err: Error) => {
      console.warn(`[pty] WebSocket error for session ${sessionId}: ${err.message}`);
    });

    // Send session ID then replay buffered output so reconnecting tabs catch up.
    // NOTE: we do NOT resize here — the replay buffer was formatted for the old
    // dimensions. The client will send a resize message after it processes the
    // replay, which avoids corrupting the replayed text.
    ws.send(JSON.stringify({ type: "session", id: ptySessionId }));
    if (p.buffer) ws.send(p.buffer);

    // WebSocket → PTY input
    ws.on("message", (data) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize" && parsed.cols && parsed.rows) {
          p.pty.resize(parsed.cols, parsed.rows);
          return;
        }
        if (parsed.type === "ping") return;
      } catch {
        // Not JSON — treat as terminal input (expected for raw keystrokes)
      }
      p.pty.write(msg);
    });

    // When the WebSocket closes, just remove it from subscribers.
    // The PTY keeps running so other tabs (and future reconnects) are unaffected.
    ws.on("close", () => {
      p.subs.delete(ws);
    });

    return;
  }

  // ── setup-token / shell modes: transient PTY per connection ─────────────────
  let cmd: string;
  let args: string[];

  if (mode === "setup-token") {
    resetCapture();
    cmd = "claude";
    args = ["setup-token"];
  } else {
    // shell
    if (!sessionId) {
      ws.send(JSON.stringify({ type: "error", message: "Missing sessionId query parameter." }));
      ws.close();
      return;
    }

    const session = getSession(sessionId);
    if (!session || session.status !== "running") {
      const errorMsg = session?.status === "error" && session.error
        ? session.error
        : `Session ${sessionId} is not running. Start a session first.`;
      ws.send(JSON.stringify({ type: "error", message: errorMsg, fatal: true }));
      ws.close();
      return;
    }

    const containerName = getContainerName(sessionId);
    cmd = runtime.bin;
    args = ["exec", "-it", "-u", "agent", containerName, "/bin/bash"];
  }

  let ptyHandle: BunPty;
  try {
    ptyHandle = spawnPty(cmd, args, { cols, rows },
      // onData
      (data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
        if (mode === "setup-token") ingestSetupTokenOutput(data);
      },
      // onExit
      (exitCode: number) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
          ws.close();
        }
        ptySessions.delete(ptySessionId);
      },
    );
  } catch (err: any) {
    // fatal: true prevents the client from auto-reconnecting and wiping the
    // error message — a spawn failure (missing CLI, unsupported platform) will
    // fail identically on retry, so the user needs time to read the reason.
    ws.send(JSON.stringify({ type: "error", message: `Failed to spawn PTY: ${err.message}`, fatal: true }));
    ws.close();
    return;
  }

  ptySessions.set(ptySessionId, { pty: ptyHandle, ws });

  // Log WebSocket errors but don't crash — EPIPE is expected when browser disconnects.
  ws.on("error", (err: Error) => {
    console.warn(`[pty] WebSocket error for ${mode} session ${ptySessionId}: ${err.message}`);
  });

  ws.send(JSON.stringify({ type: "session", id: ptySessionId }));

  ws.on("message", (data) => {
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        ptyHandle.resize(parsed.cols, parsed.rows);
        return;
      }
      if (parsed.type === "ping") return;
    } catch {
      // Not JSON — treat as terminal input (expected for raw keystrokes)
    }
    ptyHandle.write(msg);
  });

  ws.on("close", () => {
    ptyHandle.kill();
    ptySessions.delete(ptySessionId);
  });
}

function handleMonitorConnection(ws: WebSocket, url: URL) {
  const sessionId = url.searchParams.get("sessionId") || "";

  if (!sessionId) {
    ws.send(JSON.stringify({ type: "error", message: "Missing sessionId query parameter." }));
    ws.close();
    return;
  }

  const monitor = getMonitor(sessionId);

  // Send current health immediately
  ws.send(JSON.stringify({ type: "health", data: monitor.getHealth() }));

  // Subscribe to health updates
  const unsubHealth = monitor.onUpdate((snapshot) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "health", data: snapshot }));
    }
  });

  // Subscribe to PR updates (filtered by session)
  const unsubPr = onPrUpdate((pr) => {
    if (pr.sessionId === sessionId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pr_request", data: pr }));
    }
  });

  // Send current ports immediately
  ws.send(JSON.stringify({ type: "ports", data: getOpenPorts(sessionId) }));

  // Subscribe to port updates (filtered by session)
  const unsubPorts = onPortUpdate((allPorts) => {
    if (ws.readyState === WebSocket.OPEN) {
      const sessionPorts = allPorts.filter((p) => p.sessionId === sessionId);
      ws.send(JSON.stringify({ type: "ports", data: sessionPorts }));
    }
  });

  // Subscribe to secret request updates (broadcast to all connected clients)
  const unsubSecretReq = onSecretRequestUpdate((req) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "secret_request", data: req }));
    }
  });

  // Log WebSocket errors — EPIPE is expected when browser disconnects.
  ws.on("error", (err: Error) => {
    console.warn(`[monitor] WebSocket error for session ${sessionId}: ${err.message}`);
  });

  // Subscribe to docker container events (replaces polling)
  const session = getSession(sessionId);
  let lastContainerJson = "";
  const unsubContainers = session ? subscribeSession(session.containerRef, (containers) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(containers);
    if (json !== lastContainerJson) {
      lastContainerJson = json;
      ws.send(JSON.stringify({ type: "containers", data: containers }));
    }
  }) : () => {};

  ws.on("close", () => {
    unsubHealth();
    unsubPr();
    unsubPorts();
    unsubContainers();
    unsubSecretReq();
  });
}

// ---------------------------------------------------------------------------
// /ws/docker — per-container log streaming, inspect, and container list
// ---------------------------------------------------------------------------

function handleDockerConnection(ws: WebSocket, url: URL) {
  const sessionId = url.searchParams.get("sessionId") || "";
  if (!sessionId) {
    ws.send(JSON.stringify({ type: "error", message: "Missing sessionId" }));
    ws.close();
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
    ws.close();
    return;
  }

  const containerRef = session.containerRef;
  ws.on("error", (err: Error) => {
    console.warn(`[docker-ws] WebSocket error for session ${sessionId}: ${err.message}`);
  });

  // Active log streams for this connection
  const logStreams = new Map<string, ChildProcess>();

  // Subscribe to container events
  let lastJson = "";
  const unsubContainers = subscribeSession(containerRef, (containers) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const json = JSON.stringify(containers);
    if (json !== lastJson) {
      lastJson = json;
      ws.send(JSON.stringify({ type: "containers", data: containers }));
    }
  });

  ws.on("message", async (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "subscribe_logs") {
      const { containerId, tail } = msg;
      if (!containerId || logStreams.has(containerId)) return;

      try {
        const proc = await streamContainerLogs(containerRef, containerId, tail ?? 200);
        logStreams.set(containerId, proc);

        const sendLine = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const text = chunk.toString("utf-8");
          ws.send(JSON.stringify({ type: "log", containerId, stream, data: text }));
        };

        proc.stdout?.on("data", sendLine("stdout"));
        proc.stderr?.on("data", sendLine("stderr"));

        proc.on("exit", (code) => {
          logStreams.delete(containerId);
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "log_end", containerId, exitCode: code ?? 0 }));
          }
        });
        proc.on("error", () => {
          logStreams.delete(containerId);
        });
      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      }
    } else if (msg.type === "unsubscribe_logs") {
      const proc = logStreams.get(msg.containerId);
      if (proc) {
        proc.kill();
        logStreams.delete(msg.containerId);
      }
    } else if (msg.type === "inspect") {
      try {
        const data = await inspectContainer(containerRef, msg.containerId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "inspect", containerId: msg.containerId, data }));
        }
      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        }
      }
    }
  });

  ws.on("close", () => {
    unsubContainers();
    for (const proc of logStreams.values()) {
      try { proc.kill(); } catch (err: any) {
        console.warn(`[docker-ws] Failed to kill log stream process: ${err.message}`);
      }
    }
    logStreams.clear();
  });
}
