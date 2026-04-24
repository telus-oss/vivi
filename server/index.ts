/**
 * Vivi backend server.
 *
 * REST API + WebSocket server for managing multiple sandboxed Claude agent sessions.
 */

import express from "express";
import cors from "cors";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { runtime } from "./runtime.js";
import { attachWebSocketServer, getMonitor, removeMonitor } from "./pty.js";
import * as secrets from "./secrets.js";
import * as allowlist from "./allowlist.js";
import * as sandboxImages from "./sandbox-images.js";
import * as container from "./container.js";
import { restoreSessions } from "./container.js";
import * as auth from "./auth.js";
import * as gitPolicy from "./git-policy.js";
import * as pr from "./pr.js";
import * as ports from "./ports.js";
import * as updater from "./updater.js";
import { listSessionContainers, inspectContainer } from "./docker-namespace-proxy.js";
import * as githubIssues from "./github-issues.js";
import * as github from "./github.js";
import * as profiles from "./profiles.js";
import * as secretRequests from "./secret-requests.js";
import rateLimit from "express-rate-limit";

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  console.error("[server] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason);
});

const PORT = parseInt(process.env.PORT || "5151", 10);
const HOST = process.env.HOST || "localhost";

// Determine bind address: if HOST is a specific IP, bind to it; otherwise bind to all interfaces
// so the server is reachable via the hostname. "localhost" binds to loopback only.
function getBindAddress(host: string): string {
  if (host === "localhost" || host === "127.0.0.1") return "127.0.0.1";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host; // raw IPv4
  return "0.0.0.0"; // hostname → bind all interfaces
}

const BIND_ADDRESS = getBindAddress(HOST);

// --- Per-endpoint rate limit configuration ---
// windowMs: time window in ms, max: max requests per window
const RATE_LIMITS = {
  health:          { windowMs: 1 * 60 * 1000, max: 120 },
  sessionRead:     { windowMs: 1 * 60 * 1000, max: 120 },
  sessionWrite:    { windowMs: 1 * 60 * 1000, max: 30 },
  sessionExpensive:{ windowMs: 1 * 60 * 1000, max: 30 },  // logs, diff, file — 1-min window with ~5x headroom over single-user polling
  containers:      { windowMs: 1 * 60 * 1000, max: 60 },
  secrets:         { windowMs: 1 * 60 * 1000, max: 60 },
  secretRequests:  { windowMs: 1 * 60 * 1000, max: 60 },
  allowlist:       { windowMs: 1 * 60 * 1000, max: 60 },
  auth:            { windowMs: 1 * 60 * 1000, max: 20 },
  fsComplete:      { windowMs: 1 * 60 * 1000, max: 120 },
  gitPolicy:       { windowMs: 1 * 60 * 1000, max: 60 },
  gitCredentials:  { windowMs: 1 * 60 * 1000, max: 30 },
  pr:              { windowMs: 1 * 60 * 1000, max: 60 },
  sandbox:         { windowMs: 1 * 60 * 1000, max: 30 },
  ports:           { windowMs: 1 * 60 * 1000, max: 60 },
  monitor:         { windowMs: 1 * 60 * 1000, max: 120 },
  upload:          { windowMs: 1 * 60 * 1000, max: 20 },
  githubIssues:    { windowMs: 1 * 60 * 1000, max: 30 },
  github:          { windowMs: 1 * 60 * 1000, max: 60 },
  profiles:        { windowMs: 1 * 60 * 1000, max: 60 },
  update:          { windowMs: 1 * 60 * 1000, max: 10 },
  sandboxImages:   { windowMs: 1 * 60 * 1000, max: 60 },
} as const;

const limiter = (key: keyof typeof RATE_LIMITS) => rateLimit(RATE_LIMITS[key]);

const app = express();
// Behind cloudflared (boyhouse) the real client IP arrives via X-Forwarded-For.
// Trust one proxy hop so express-rate-limit uses that IP for keying and doesn't
// throw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// --- Health ---
app.get("/api/config", limiter("health"), (_req, res) => {
  res.json({ host: HOST });
});

app.get("/api/health", limiter("health"), (_req, res) => {
  res.json({ ok: true });
});

// --- Sessions (multi-session) ---
app.get("/api/sessions", limiter("sessionRead"), (_req, res) => {
  res.json(container.getSessions());
});

app.get("/api/sessions/:id", limiter("sessionRead"), (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.post("/api/sessions", limiter("sessionWrite"), async (req, res) => {
  try {
    const state = await container.startSession(req.body);
    res.json(state);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/sessions/:id", limiter("sessionWrite"), async (req, res) => {
  try {
    ports.closeAllPorts(req.params.id);
    removeMonitor(req.params.id);
    await container.stopSession(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:id/containers", limiter("containers"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  // Use containerRef for the label (shared across attached sessions)
  res.json(await listSessionContainers(session.containerRef));
});

app.get("/api/sessions/:id/containers/:containerId/inspect", limiter("containers"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  try {
    const data = await inspectContainer(session.containerRef, req.params.containerId);
    res.json(data);
  } catch (err: any) {
    res.status(err.message.includes("not belong") ? 403 : 500).json({ error: err.message });
  }
});

// --- Sandbox container logs ---
app.get("/api/sessions/:id/logs", limiter("sessionExpensive"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "running") return res.status(400).json({ error: "Session not running" });
  try {
    const source = (req.query.source as string) || "sandbox";
    let containerName: string;
    switch (source) {
      case "proxy":
        containerName = "vivi-proxy-1";
        break;
      case "dind":
        containerName = "vivi-dind-1";
        break;
      case "sandbox":
      default:
        containerName = container.getContainerName(req.params.id);
        break;
    }
    const tail = parseInt(req.query.tail as string) || 200;
    // Cap tail at 2000 to prevent abuse
    const safeTail = Math.min(tail, 2000);
    const result = await execFileAsync(
      runtime.bin, ["logs", "--tail", String(safeTail), containerName],
      { encoding: "utf-8", timeout: 10_000, maxBuffer: 5 * 1024 * 1024 },
    );
    // docker logs sends stdout/stderr on separate streams; merge them like the original 2>&1
    const logs = (result.stdout || "") + (result.stderr || "");
    res.json({ logs });
  } catch (err: any) {
    console.error("[logs] Failed to fetch container logs for session %s:", req.params.id, err.message);
    res.status(500).json({ error: "Failed to retrieve container logs" });
  }
});

// --- Live diff (working tree diff for a running session) ---
app.get("/api/sessions/:id/diff", limiter("sessionExpensive"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "running") return res.status(400).json({ error: "Session not running" });
  try {
    const containerName = container.getContainerName(req.params.id);
    // Show all changes (committed + uncommitted + untracked) compared to the
    // base branch, so the diff reflects everything the sandbox has done.
    const { stdout: diff } = await execFileAsync(
      runtime.bin, ["exec", containerName, "bash", "-c", 'cd /workspace && git add -N . 2>/dev/null; BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/remotes/origin/main); git diff "$BASE"'],
      { encoding: "utf-8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    res.json({ diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:id/file", limiter("sessionExpensive"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "running") return res.status(400).json({ error: "Session not running" });
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path query param required" });
  // Normalize and validate: resolve against /workspace, then verify it stays within bounds
  const resolved = path.resolve("/workspace", filePath);
  if (!resolved.startsWith("/workspace/")) return res.status(400).json({ error: "Invalid file path" });
  try {
    const containerName = container.getContainerName(req.params.id);
    const { stdout: content } = await execFileAsync(
      runtime.bin,
      ["exec", containerName, "cat", `/workspace/${filePath}`],
      { encoding: "utf-8", timeout: 30_000 },
    );
    res.json({ content, path: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Backwards-compatible session endpoints ---
app.get("/api/session", limiter("sessionRead"), (_req, res) => {
  const sessions = container.getSessions();
  if (sessions.length === 0) {
    res.json({
      id: null,
      status: "stopped",
      repoPath: null,
      repoName: null,
      branch: null,
      containerId: null,
      error: null,
      startedAt: null,
    });
  } else {
    // Return the first session for backwards compat
    res.json(sessions[0]);
  }
});

app.post("/api/session/start", limiter("sessionWrite"), async (req, res) => {
  try {
    const state = await container.startSession(req.body);
    res.json(state);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/session/stop", limiter("sessionWrite"), async (req, res) => {
  try {
    const sessions = container.getSessions();
    // Stop the first running session for backwards compat
    const running = sessions.find((s) => s.status === "running" || s.status === "starting");
    if (running) {
      ports.closeAllPorts(running.id);
      removeMonitor(running.id);
      await container.stopSession(running.id);
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Secrets ---
app.get("/api/secrets", limiter("secrets"), (_req, res) => {
  res.json(secrets.listSecrets());
});

app.post("/api/secrets", limiter("secrets"), (req, res) => {
  try {
    const s = secrets.addSecret(req.body);
    secrets.syncContainerSecrets();
    // Auto-fulfill any pending secret request matching this envVar
    secretRequests.fulfillByEnvVar(req.body.envVar);
    res.json(s);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/secrets/:id", limiter("secrets"), (req, res) => {
  const ok = secrets.removeSecret(req.params.id);
  if (ok) secrets.syncContainerSecrets();
  res.json({ ok });
});

app.patch("/api/secrets/:id", limiter("secrets"), (req, res) => {
  const { name, envVar, key, baseUrl, headerName } = req.body;

  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }
  if (envVar !== undefined) {
    if (typeof envVar !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(envVar)) {
      return res.status(400).json({ error: "envVar must match ENV_VAR pattern (e.g. MY_API_KEY)" });
    }
  }
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string" || !/^https?:\/\/.+/.test(baseUrl)) {
      return res.status(400).json({ error: "baseUrl must be a valid http or https URL" });
    }
  }
  if (headerName !== undefined) {
    if (typeof headerName !== "string" || !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(headerName)) {
      return res.status(400).json({ error: "headerName must be a valid HTTP header name" });
    }
  }

  const result = secrets.updateSecret(req.params.id, { name, envVar, key, baseUrl, headerName });
  if (!result) return res.status(404).json({ error: "Secret not found" });
  secrets.syncContainerSecrets();
  res.json(result);
});

// --- Secret Requests ---
app.get("/api/secret-requests", limiter("secretRequests"), (_req, res) => {
  res.json(secretRequests.listPendingRequests());
});

app.delete("/api/secret-requests/:id", limiter("secretRequests"), (req, res) => {
  const ok = secretRequests.dismissRequest(req.params.id);
  res.json({ ok });
});

// --- Allowlist ---
app.get("/api/allowlist", limiter("allowlist"), (_req, res) => {
  res.json(allowlist.getAllowlistConfig());
});

app.post("/api/allowlist/network", limiter("allowlist"), (req, res) => {
  const rule = allowlist.addNetworkRule(req.body.pattern, req.body.description);
  res.json(rule);
});

app.delete("/api/allowlist/network/:id", limiter("allowlist"), (req, res) => {
  const ok = allowlist.removeNetworkRule(req.params.id);
  res.json({ ok });
});

app.put("/api/allowlist/network/:id", limiter("allowlist"), (req, res) => {
  const rule = allowlist.updateNetworkRule(req.params.id, req.body.pattern, req.body.description);
  if (!rule) return res.status(404).json({ error: "Rule not found" });
  res.json(rule);
});

app.put("/api/allowlist/enabled", limiter("allowlist"), (req, res) => {
  allowlist.setAllowlistEnabled(req.body.enabled);
  res.json({ ok: true });
});

// --- Sandbox Images ---
app.get("/api/sandbox-images", limiter("sandboxImages"), (_req, res) => {
  res.json(sandboxImages.listImages());
});

app.post("/api/sandbox-images", limiter("sandboxImages"), (req, res) => {
  const { name, image } = req.body;
  if (!name || !image) {
    return res.status(400).json({ error: "name and image are required" });
  }
  try {
    const entry = sandboxImages.addImage(name, image);
    res.json(entry);
  } catch (e) {
    console.error("sandbox-images: addImage failed:", e);
    res.status(400).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});

app.delete("/api/sandbox-images/:id", limiter("sandboxImages"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid image ID" });
      return;
    }
    sandboxImages.removeImage(id);
    res.json({ ok: true });
  } catch (e) {
    console.error("sandbox-images: removeImage failed:", e);
    res.status(400).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});

app.put("/api/sandbox-images/:id/default", limiter("sandboxImages"), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid image ID" });
      return;
    }
    sandboxImages.setDefault(id);
    res.json({ ok: true });
  } catch (e) {
    console.error("sandbox-images: setDefault failed:", e);
    res.status(400).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});

// --- Auth (grab token captured from setup-token stdout) ---
app.post("/api/auth/extract-token", limiter("auth"), (_req, res) => {
  const token = auth.consumeCapturedToken();
  if (token) {
    const s = secrets.addSecret({
      name: "Anthropic",
      envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      key: token,
      baseUrl: "https://api.anthropic.com",
      headerName: "x-api-key",
    });
    secrets.syncContainerSecrets();
    res.json({ ok: true, secret: s });
  } else {
    res.json({ ok: false, error: "No token captured. Did setup-token complete successfully?" });
  }
});

// --- Filesystem completion ---
app.get("/api/fs/complete", limiter("fsComplete"), (req, res) => {
  const input = String(req.query.path || "");

  // Resolve ~ to home directory
  const resolved = input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : input;

  // Determine directory to list and prefix to filter by
  let dir: string;
  let prefix: string;
  if (resolved.endsWith("/")) {
    dir = resolved;
    prefix = "";
  } else {
    dir = path.dirname(resolved);
    prefix = path.basename(resolved).toLowerCase();
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results: { name: string; path: string; isDir: boolean; isGit: boolean }[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && !prefix.startsWith(".")) continue;
      if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue;
      if (!entry.isDirectory()) continue;

      const fullPath = path.join(dir, entry.name);
      const isGit = fs.existsSync(path.join(fullPath, ".git"));
      results.push({ name: entry.name, path: fullPath, isDir: true, isGit });
    }

    results.sort((a, b) => {
      // Git repos first, then alphabetical
      if (a.isGit !== b.isGit) return a.isGit ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Check if the listed directory itself is a git repo
    const dirIsGit = fs.existsSync(path.join(dir, ".git"));

    res.json({ dir, dirIsGit, results: results.slice(0, 50) });
  } catch {
    // Directory doesn't exist or not readable — return empty results
    res.json({ dir, dirIsGit: false, results: [] });
  }
});

// --- Git Policy ---
app.get("/api/git/policy", limiter("gitPolicy"), (_req, res) => {
  res.json(gitPolicy.getPolicy());
});

app.put("/api/git/policy", limiter("gitPolicy"), (req, res) => {
  const updated = gitPolicy.updatePolicy(req.body);
  res.json(updated);
});

// --- Git Credentials (for proxy to call) ---
app.post("/api/git/credentials", limiter("gitCredentials"), express.text({ type: "*/*" }), (req, res) => {
  try {
    const input = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    // If JSON format from proxy: { host, protocol }
    let credInput: string;
    try {
      const parsed = JSON.parse(input);
      credInput = `protocol=${parsed.protocol || "https"}\nhost=${parsed.host}\n\n`;
    } catch {
      // Not JSON — already in git credential format
      credInput = input;
    }

    const result = execSync("git credential fill", {
      input: credInput,
      encoding: "utf-8",
      timeout: 10_000,
    });

    // Parse git credential output
    const creds: Record<string, string> = {};
    for (const line of result.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) creds[key] = rest.join("=");
    }

    res.json({ username: creds.username, password: creds.password });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to get credentials: ${err.message}` });
  }
});

app.get("/api/git/gh-token", limiter("gitCredentials"), (_req, res) => {
  try {
    const token = execSync("gh auth token", { encoding: "utf-8", timeout: 10_000 }).trim();
    res.json({ token });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to get gh token: ${err.message}` });
  }
});

// --- PR Management (session-scoped) ---
app.get("/api/pr", limiter("pr"), (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  res.json(pr.getPrRequests(sessionId));
});

app.get("/api/pr/:id", limiter("pr"), (req, res) => {
  const p = pr.getPrRequest(req.params.id);
  if (!p) return res.status(404).json({ error: "PR not found" });
  res.json(p);
});

app.post("/api/sandbox/request-secret", limiter("sandbox"), (req, res) => {
  try {
    const { sessionId, name, envVar, baseUrl, headerName } = req.body;
    if (!name || !envVar || !baseUrl) {
      return res.status(400).json({ error: "name, envVar, and baseUrl are required" });
    }
    const r = secretRequests.addSecretRequest({ sessionId: sessionId || "unknown", name, envVar, baseUrl, headerName });
    res.json(r);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sandbox/pr", limiter("sandbox"), async (req, res) => {
  try {
    const { sessionId, ...data } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    const p = pr.createPrRequest(sessionId, data);
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Git Push interception (from MITM proxy) ---
app.post("/api/sandbox/git-push", limiter("sandbox"), async (req, res) => {
  try {
    const { branch, sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    if (!branch) {
      return res.status(400).json({ error: "branch is required" });
    }

    // Detect base branch from the container
    let baseBranch = "main";
    try {
      const containerName = container.getContainerName(sessionId);
      baseBranch = execFileSync(
        runtime.bin, ["exec", containerName, "git", "-C", "/workspace", "symbolic-ref", "refs/remotes/origin/HEAD"],
        { encoding: "utf-8", timeout: 5_000, stdio: "pipe" },
      ).trim().replace("refs/remotes/origin/", "");
    } catch {
      // fall back to main
    }

    // Derive title from the branch's most recent commit
    let title = `Push: ${branch}`;
    try {
      const containerName = container.getContainerName(sessionId);
      title = execFileSync(
        runtime.bin, ["exec", containerName, "git", "-C", "/workspace", "log", "-1", "--format=%s", branch],
        { encoding: "utf-8", timeout: 5_000, stdio: "pipe" },
      ).trim() || title;
    } catch {
      // Fall back to default title
    }

    // Derive description from commit messages since base
    let description = "";
    try {
      const containerName = container.getContainerName(sessionId);
      description = execFileSync(
        runtime.bin, ["exec", containerName, "git", "-C", "/workspace", "log", `${baseBranch}..${branch}`, "--format=- %s"],
        { encoding: "utf-8", timeout: 5_000, stdio: "pipe" },
      ).trim();
    } catch {
      // Description is optional — leave empty if git log fails
    }

    const p = pr.createPrRequest(sessionId, {
      title,
      description,
      branch,
      baseBranch,
    });
    console.log(`[git-push] Branch ${branch} surfaced for session ${sessionId}`);
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/pr/:id/diff", limiter("pr"), (req, res) => {
  try {
    const diff = pr.getPrDiff(req.params.id);
    res.json({ diff });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/pr/:id/file", limiter("pr"), (req, res) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ error: "path query param required" });
    const content = pr.getPrFile(req.params.id, filePath);
    res.json({ content, path: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/pr/:id", limiter("pr"), (req, res) => {
  try {
    const p = pr.dismissPr(req.params.id);
    res.json(p);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.post("/api/pr/:id/approve", limiter("pr"), async (req, res) => {
  try {
    const p = await pr.approvePr(req.params.id, req.body.action, req.body.description);
    res.json(p);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Ports (sandbox port forwarding) ---
app.get("/api/ports", limiter("ports"), (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  res.json(ports.getOpenPorts(sessionId));
});

app.post("/api/sandbox/ports", limiter("ports"), (req, res) => {
  try {
    const { port, sessionId, targetHost, containerName, label, type } = req.body;
    if (!port || typeof port !== "number") {
      return res.status(400).json({ error: "Missing or invalid 'port' (number required)" });
    }
    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }
    const pf = ports.openPort(sessionId, port, targetHost, containerName, label, type);
    res.json(pf);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/ports/:sessionId/:containerPort", limiter("ports"), (req, res) => {
  const ok = ports.closePort(req.params.sessionId, parseInt(req.params.containerPort, 10));
  res.json({ ok });
});

// --- Monitor (session-scoped) ---
app.get("/api/monitor/:sessionId/health", limiter("monitor"), (req, res) => {
  const monitor = getMonitor(req.params.sessionId);
  res.json(monitor.getHealth());
});

app.post("/api/monitor/:sessionId/clear-alerts", limiter("monitor"), (req, res) => {
  const monitor = getMonitor(req.params.sessionId);
  monitor.clearAlerts();
  res.json({ ok: true });
});

app.put("/api/monitor/:sessionId/auto-intervene", limiter("monitor"), (req, res) => {
  const monitor = getMonitor(req.params.sessionId);
  const { enabled } = req.body;
  monitor.autoIntervene = !!enabled;
  res.json({ ok: true });
});

app.put("/api/monitor/:sessionId/config", limiter("monitor"), (req, res) => {
  const monitor = getMonitor(req.params.sessionId);
  const { errorThreshold, editFailThreshold, fileRevisitThreshold, bashStreakThreshold } = req.body;
  if (typeof errorThreshold === "number" && errorThreshold >= 1) monitor.config.errorThreshold = errorThreshold;
  if (typeof editFailThreshold === "number" && editFailThreshold >= 1) monitor.config.editFailThreshold = editFailThreshold;
  if (typeof fileRevisitThreshold === "number" && fileRevisitThreshold >= 1) monitor.config.fileRevisitThreshold = fileRevisitThreshold;
  if (typeof bashStreakThreshold === "number" && bashStreakThreshold >= 1) monitor.config.bashStreakThreshold = bashStreakThreshold;
  res.json({ ok: true, config: { ...monitor.config } });
});

// --- Backwards-compatible monitor endpoints ---
app.get("/api/monitor/health", limiter("monitor"), (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    const monitor = getMonitor(sessionId);
    res.json(monitor.getHealth());
  } else {
    // Return health for first running session for backwards compat
    const sessions = container.getSessions();
    const running = sessions.find((s) => s.status === "running");
    if (running) {
      const monitor = getMonitor(running.id);
      res.json(monitor.getHealth());
    } else {
      res.json({ fileVsBashRatio: 0, totalEvents: 0, alerts: [], breakdown: {}, repetitionScore: 0 });
    }
  }
});

app.post("/api/monitor/clear-alerts", limiter("monitor"), (req, res) => {
  const sessionId = req.query.sessionId as string | undefined;
  if (sessionId) {
    const monitor = getMonitor(sessionId);
    monitor.clearAlerts();
  }
  res.json({ ok: true });
});

// --- Image upload (writes image into a container for Claude to reference) ---
app.post("/api/sessions/:id/upload-image", limiter("upload"), async (req, res) => {
  const session = container.getSession(req.params.id);
  if (!session || session.status !== "running") {
    return res.status(400).json({ error: "Session not running" });
  }
  const { data, ext } = req.body;
  if (!data || !ext) {
    return res.status(400).json({ error: "data (base64) and ext required" });
  }
  const safeName = `pasted-${Date.now()}.${ext.replace(/[^a-z0-9]/gi, "")}`;
  const containerPath = `/tmp/${safeName}`;
  const containerName = container.getContainerName(req.params.id);
  try {
    const buf = Buffer.from(data, "base64");
    execFileSync(runtime.bin, ["exec", "-i", containerName, "bash", "-c", `cat > ${containerPath}`], {
      input: buf,
      timeout: 10_000,
    });
    res.json({ ok: true, path: containerPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- GitHub Issues ---
app.get("/api/github/issues", limiter("githubIssues"), (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) return res.status(400).json({ error: "repoPath is required" });
  const result = githubIssues.fetchGitHubIssues(repoPath);
  res.json(result);
});

// --- GitHub Auth + Repo Picker ---
app.get("/api/github/status", limiter("github"), (_req, res) => {
  res.json(github.status());
});

app.post("/api/github/token", limiter("github"), async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) return res.status(400).json({ error: "token is required" });
  try {
    const result = await github.saveToken(token);
    github.invalidateRepoCache();
    res.json({ configured: true, ...result });
  } catch (err: any) {
    const status = err instanceof github.GitHubAuthError ? err.status : 400;
    res.status(status).json({ error: err.message });
  }
});

app.delete("/api/github/token", limiter("github"), (_req, res) => {
  github.clearToken();
  github.invalidateRepoCache();
  res.json({ ok: true });
});

app.get("/api/github/repos", limiter("github"), async (req, res) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const force = req.query.refresh === "1";
    const repos = await github.listRepos({ search, force });
    res.json(repos);
  } catch (err: any) {
    const status = err instanceof github.GitHubAuthError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get("/api/github/branches", limiter("github"), async (req, res) => {
  const owner = typeof req.query.owner === "string" ? req.query.owner : "";
  const repo = typeof req.query.repo === "string" ? req.query.repo : "";
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  try {
    const branches = await github.listBranches(owner, repo);
    res.json(branches);
  } catch (err: any) {
    const status = err instanceof github.GitHubAuthError ? err.status : 500;
    res.status(status).json({ error: err.message });
  }
});

// --- Profiles ---
app.get("/api/profiles", limiter("profiles"), (_req, res) => {
  res.json(profiles.listProfiles());
});

app.post("/api/profiles", limiter("profiles"), (req, res) => {
  try {
    const p = profiles.createProfile(req.body.name, req.body.description);
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/profiles/:id", limiter("profiles"), (req, res) => {
  try {
    const p = profiles.updateProfile(req.params.id, req.body);
    res.json(p);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/profiles/:id", limiter("profiles"), (req, res) => {
  try {
    profiles.deleteProfile(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/profiles/:profileId/save-from-session/:sessionId", limiter("profiles"), (req, res) => {
  try {
    const session = container.getSession(req.params.sessionId);
    if (!session || session.status !== "running") {
      return res.status(400).json({ error: "Session not running" });
    }
    const containerName = container.getContainerName(req.params.sessionId);
    profiles.saveProfileFromContainer(req.params.profileId, containerName);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Updates ---
app.get("/api/update/check", limiter("update"), (_req, res) => {
  try {
    const status = updater.checkForUpdate();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/update/apply", limiter("update"), async (_req, res) => {
  try {
    if (updater.isUpdateInProgress()) {
      return res.status(409).json({ error: "Update already in progress" });
    }
    // Send response before restarting
    res.json({ ok: true, message: "Update started. Server will restart shortly." });
    // Apply update (will restart the process)
    await updater.applyUpdate();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Serve frontend (production builds) ---
// In production the Vite-built frontend lives in dist/. Serve it as static
// files with a fallback to index.html for client-side routing.
const distPath = path.resolve("dist");
if (fs.existsSync(path.join(distPath, "index.html"))) {
  // Build ID changes per deploy so /sw.js bytes differ, which is what the
  // browser uses to decide whether to install a new service worker. Without
  // this, the SW is byte-identical across deploys and users are stuck on
  // stale cached content until a hard refresh.
  const buildId = (() => {
    if (process.env.BUILD_ID) return process.env.BUILD_ID;
    try {
      return execSync("git rev-parse HEAD", { cwd: process.cwd() })
        .toString()
        .trim()
        .slice(0, 12);
    } catch {
      return String(Date.now());
    }
  })();

  app.get("/sw.js", (_req, res) => {
    try {
      const swSource = fs.readFileSync(path.join(distPath, "sw.js"), "utf8");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Service-Worker-Allowed", "/");
      res.end(swSource.replace(/__BUILD_ID__/g, buildId));
    } catch (err: any) {
      res.status(500).type("text/plain").send(`sw.js error: ${err.message}`);
    }
  });

  app.use(express.static(distPath));
  app.use((_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

// --- Subdomain-based reverse proxy for port forwards ---
import httpProxy from "http-proxy";
import { getPortForwardBySubdomain } from "./ports.js";

const portProxy = httpProxy.createProxyServer({});

portProxy.on("error", (err, _req, res) => {
  console.error(`[port-proxy] Proxy error: ${err.message}`);
  if (res && "writeHead" in res && !res.headersSent) {
    (res as http.ServerResponse).writeHead(502, { "Content-Type": "text/plain" });
    (res as http.ServerResponse).end(`Port forward proxy error: ${err.message}\n`);
  }
});

/**
 * WebSocket upgrade forwarder for port-forward subdomains.
 *
 * Bun 1.3.12 forces a two-layer design because of three bugs:
 *   - http.ClientRequest never fires 'upgrade' → http-proxy.ws() stalls.
 *   - socket.write on the raw socket from Node http 'upgrade' events is a
 *     no-op (bytesWritten stays 0). The only reliable 101 writer is
 *     `ws.WebSocketServer.handleUpgrade`, which Bun intercepts natively.
 *   - net.connect to a same-process net.Server hangs in 'opening' forever,
 *     so the normal `ws.WebSocket` client can't reach our host-port TCP
 *     bridge. `Bun.connect` does not have this bug.
 *
 * Workaround: ws.handleUpgrade on the browser side (native intercept), and
 * a hand-rolled minimal WS client on the upstream side over Bun.connect to
 * the host-port TCP bridge in server/ports.ts (which docker-execs socat
 * into the sandbox and pipes bytes to code-server). Frames are decoded
 * from raw TCP bytes, re-emitted via ws; outgoing messages are re-framed
 * with a fresh mask and written to the Bun.connect socket.
 */
const portForwardWss = new WebSocketServer({ noServer: true });

function encodeWsFrame(payload: Buffer, opcode: number, mask: boolean): Buffer {
  const header: number[] = [0x80 | (opcode & 0x0f)];
  let extLen: Buffer | null = null;
  if (payload.length <= 125) {
    header.push((mask ? 0x80 : 0) | payload.length);
  } else if (payload.length <= 0xffff) {
    header.push((mask ? 0x80 : 0) | 126);
    extLen = Buffer.alloc(2);
    extLen.writeUInt16BE(payload.length, 0);
  } else {
    header.push((mask ? 0x80 : 0) | 127);
    extLen = Buffer.alloc(8);
    extLen.writeUInt32BE(0, 0);
    extLen.writeUInt32BE(payload.length, 4);
  }
  const parts: Buffer[] = [Buffer.from(header)];
  if (extLen) parts.push(extLen);
  if (mask) {
    const key = crypto.randomBytes(4);
    parts.push(key);
    const masked = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ key[i % 4];
    parts.push(masked);
  } else {
    parts.push(payload);
  }
  return Buffer.concat(parts);
}

interface ParsedFrame { fin: boolean; opcode: number; payload: Buffer }

function parseWsFrame(buf: Buffer, offset: number): { frame: ParsedFrame; next: number } | null {
  if (buf.length - offset < 2) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let cur = offset + 2;
  if (len === 126) {
    if (buf.length - cur < 2) return null;
    len = buf.readUInt16BE(cur);
    cur += 2;
  } else if (len === 127) {
    if (buf.length - cur < 8) return null;
    const hi = buf.readUInt32BE(cur);
    const lo = buf.readUInt32BE(cur + 4);
    len = hi * 0x100000000 + lo;
    cur += 8;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buf.length - cur < 4) return null;
    maskKey = buf.subarray(cur, cur + 4);
    cur += 4;
  }
  if (buf.length - cur < len) return null;
  let payload = buf.subarray(cur, cur + len);
  if (maskKey) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
    payload = out;
  }
  return { frame: { fin, opcode, payload: Buffer.from(payload) }, next: cur + len };
}

function forwardWebSocketUpgrade(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  pf: { sessionId: string; containerPort: number; hostPort: number; targetHost?: string },
): void {
  portForwardWss.handleUpgrade(req, socket, head, (clientWs) => {
    let handshakeDone = false;
    let upstreamBuf = Buffer.alloc(0);
    let upstream: import("bun").Socket | null = null;

    const clientReadyState = () => (clientWs as unknown as { readyState: number }).readyState;

    const closeBoth = () => {
      try { clientWs.close(); } catch {}
      try { upstream?.end(); } catch {}
    };

    Bun.connect({
      hostname: "127.0.0.1",
      port: pf.hostPort,
      socket: {
        open(sock) {
          upstream = sock;
          const path = req.url || "/";
          const key = crypto.randomBytes(16).toString("base64");
          const handshake = [
            `GET ${path} HTTP/1.1`,
            `Host: 127.0.0.1:${pf.hostPort}`,
            `Upgrade: websocket`,
            `Connection: Upgrade`,
            `Sec-WebSocket-Key: ${key}`,
            `Sec-WebSocket-Version: 13`,
            ``, ``,
          ].join("\r\n");
          sock.write(handshake);
        },
        data(_sock, chunk) {
          upstreamBuf = Buffer.concat([upstreamBuf, chunk]);
          if (!handshakeDone) {
            const end = upstreamBuf.indexOf("\r\n\r\n");
            if (end === -1) return;
            const headerBlock = upstreamBuf.subarray(0, end).toString();
            if (!/^HTTP\/1\.1 101/i.test(headerBlock)) {
              console.error(`[port-proxy] upstream did not return 101:\n${headerBlock}`);
              closeBoth();
              return;
            }
            handshakeDone = true;
            upstreamBuf = upstreamBuf.subarray(end + 4);
          }
          while (true) {
            const r = parseWsFrame(upstreamBuf, 0);
            if (!r) break;
            upstreamBuf = upstreamBuf.subarray(r.next);
            const { opcode, payload } = r.frame;
            if (opcode === 0x8) { closeBoth(); return; }
            if (opcode === 0x9) {
              // Ping → pong back upstream
              if (upstream) upstream.write(encodeWsFrame(payload, 0xA, true));
              continue;
            }
            if (opcode === 0xA) continue; // pong — ignore
            if (opcode === 0x1 || opcode === 0x2) {
              if (clientReadyState() === 1 /* OPEN */) {
                clientWs.send(payload, { binary: opcode === 0x2 });
              }
            }
            // continuation frames (0x0) aren't handled here; code-server is
            // expected to send whole messages.
          }
        },
        close() { closeBoth(); },
        error(_sock, err) {
          console.error(`[port-proxy] upstream error on :${pf.hostPort}: ${err.message}`);
          closeBoth();
        },
      },
    }).catch((err) => {
      console.error(`[port-proxy] Bun.connect failed on :${pf.hostPort}: ${err.message}`);
      closeBoth();
    });

    clientWs.on("message", (data, isBinary) => {
      if (!upstream || !handshakeDone) return;
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      upstream.write(encodeWsFrame(payload, isBinary ? 0x2 : 0x1, true));
    });
    clientWs.on("close", () => {
      try { upstream?.end(); } catch {}
    });
    clientWs.on("error", (err) => {
      console.error(`[port-proxy] client ws error: ${err.message}`);
      closeBoth();
    });
  });
}

/** Pattern for port-forward subdomains: p-{port}-{sessionPrefix} */
const PORT_SUBDOMAIN_RE = /^p-\d+-[a-z0-9]+$/;

/**
 * Extract the port-forward subdomain from a Host header.
 * e.g. "p-3000-abc123.localhost:5151" -> "p-3000-abc123"
 *      "p-3000-abc123.example.com:5151" -> "p-3000-abc123"
 *      "localhost:5151"               -> null
 *      "host.docker.internal:5151"    -> null
 */
function extractPortSubdomain(host: string | undefined): string | null {
  if (!host) return null;
  // Strip port number
  const hostname = host.split(":")[0];
  const parts = hostname.split(".");
  if (parts.length < 2) return null;
  // The first label is the candidate subdomain
  const candidate = parts[0];
  // Only match our port-forward pattern (p-{port}-{sessionPrefix})
  if (PORT_SUBDOMAIN_RE.test(candidate)) {
    return candidate;
  }
  return null;
}

// --- Start server ---
const server = http.createServer((req, res) => {
  const subdomain = extractPortSubdomain(req.headers.host);
  if (subdomain) {
    const pf = getPortForwardBySubdomain(subdomain);
    if (pf) {
      portProxy.web(req, res, { target: `http://127.0.0.1:${pf.hostPort}` });
      return;
    }
    // Unknown subdomain — return 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(`No active port forward for subdomain: ${subdomain}\n`);
    return;
  }
  // No subdomain — pass to Express
  app(req, res);
});

// Handle WebSocket upgrades for port-forward subdomains
server.on("upgrade", (req, socket, head) => {
  const subdomain = extractPortSubdomain(req.headers.host);
  if (subdomain) {
    const pf = getPortForwardBySubdomain(subdomain);
    if (pf) {
      forwardWebSocketUpgrade(req, socket as net.Socket, head, pf);
      return;
    }
    socket.destroy();
    return;
  }
  // Non-port-forward WebSocket upgrades are handled by attachWebSocketServer below
});

attachWebSocketServer(server);

// Listen immediately so the frontend can connect, then restore sessions in the background.
server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`[vivi] Server running on http://${HOST}:${PORT} (bind: ${BIND_ADDRESS})`);
  console.log(`[vivi] WebSocket: ws://${HOST}:${PORT}/ws/terminal?sessionId=X`);
  console.log(`[vivi] Monitor:   ws://${HOST}:${PORT}/ws/monitor?sessionId=X`);
  restoreSessions();
});

// --- Graceful shutdown ---
async function gracefulShutdown(signal: string) {
  console.log(`[vivi] ${signal} received, shutting down gracefully...`);
  server.close(() => {
    console.log("[vivi] HTTP server closed");
  });
  // Stop all active sessions
  const activeSessions = container.getSessions();
  for (const session of activeSessions) {
    try {
      ports.closeAllPorts(session.id);
      removeMonitor(session.id);
      await container.stopSession(session.id);
      console.log(`[vivi] Stopped session ${session.id}`);
    } catch (err: any) {
      console.warn(`[vivi] Failed to stop session ${session.id}: ${err.message}`);
    }
  }
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
