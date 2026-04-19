/**
 * Vivi forward proxy with HTTPS MITM, API key injection,
 * git policy enforcement, and PR interception.
 *
 * Handles:
 *   - HTTP forward proxying (absolute URLs)
 *   - HTTPS CONNECT tunnels with TLS MITM for hosts with secrets OR git hosts
 *   - HTTPS CONNECT passthrough for other allowed hosts
 *   - Allowlist-based host filtering
 *   - API key injection (swap sk-sandbox-* for real keys)
 *   - Git push blocking (blocks git-receive-pack at network level)
 *   - Git/GitHub credential injection from host's git setup
 *   - PR creation interception (gh pr create → host server approval flow)
 *   - Request logging
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import { execSync } from "node:child_process";

// --- Config ---

const SECRETS_FILE = process.env.SECRETS_FILE || "/config/secrets.json";
const ALLOWLIST_FILE = process.env.ALLOWLIST_FILE || "/config/allowlist.json";
const GIT_POLICY_FILE = process.env.GIT_POLICY_FILE || "/config/git-policy.json";
const CA_CERT_FILE = process.env.CA_CERT_FILE || "/ca/ca-cert.pem";
const CA_KEY_FILE = process.env.CA_KEY_FILE || "/ca/ca-key.pem";
const PORT = parseInt(process.env.PROXY_PORT || "7443", 10);
const HOST_SERVER = process.env.HOST_SERVER || "host.docker.internal:7700";
const TIMING_LOGS = JSON.parse(process.env.PROXY_TIMING_LOGS || "true");

// --- Types ---

interface SecretEntry {
  key: string;
  baseUrl: string;
}

interface AllowlistFile {
  enabled: boolean;
  hosts: string[];
}

interface GitPolicy {
  enabled: boolean;
  gitHosts: string[];
  allowFetch: boolean;
  allowPush: boolean;
  allowPrCreation: boolean;
  protectedBranches: string[];
  allowReadFromUpstream: boolean;
}

// --- State ---

const hostSecrets = new Map<string, { key: string }>();
let allowlist: AllowlistFile = { enabled: true, hosts: [] };
let gitPolicy: GitPolicy = {
  enabled: true,
  gitHosts: ["github.com", "api.github.com"],
  allowFetch: true,
  allowPush: false,
  allowPrCreation: true,
  protectedBranches: ["main", "master"],
  allowReadFromUpstream: true,
};
let caCert: Buffer | null = null;
let caKey: Buffer | null = null;
const certCache = new Map<string, { key: Buffer; cert: Buffer }>();

// Credential cache: host → { username, password, expiresAt }
const credentialCache = new Map<string, { username: string; password: string; expiresAt: number }>();
const CRED_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// GitHub token cache
let ghTokenCache: { token: string; expiresAt: number } | null = null;

// --- Loaders ---

function loadSecrets() {
  try {
    const data: Record<string, SecretEntry> = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
    hostSecrets.clear();
    // NOTE: hostSecrets is keyed by hostname, so multiple secrets targeting the
    // same host will collide (last-write-wins). This is fine as long as the keys
    // are interchangeable. If a future use case requires different keys for the
    // same host (e.g. Claude Code vs an application), the proxy would need to
    // switch to placeholder-specific matching (sk-sandbox-{id} → key) instead
    // of the current generic sk-sandbox-* → per-host-key replacement.
    for (const s of Object.values(data)) {
      try {
        const host = new URL(s.baseUrl).hostname;
        hostSecrets.set(host, { key: s.key });
      } catch {}
    }
    log("CONFIG", `Loaded ${hostSecrets.size} secret(s)`);
  } catch (e: any) {
    if (e.code !== "ENOENT") log("ERROR", `Loading secrets: ${e.message}`);
  }
}

function loadAllowlist() {
  try {
    allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, "utf-8"));
    log("CONFIG", `Allowlist ${allowlist.enabled ? "enabled" : "disabled"}, ${allowlist.hosts.length} host(s)`);
  } catch (e: any) {
    if (e.code !== "ENOENT") log("ERROR", `Loading allowlist: ${e.message}`);
  }
}

function loadGitPolicy() {
  try {
    const data = JSON.parse(fs.readFileSync(GIT_POLICY_FILE, "utf-8"));
    gitPolicy = { ...gitPolicy, ...data };
    log("CONFIG", `Git policy loaded: ${gitPolicy.gitHosts.length} git host(s), push=${gitPolicy.allowPush}, fetch=${gitPolicy.allowFetch}`);
  } catch (e: any) {
    if (e.code !== "ENOENT") log("ERROR", `Loading git policy: ${e.message}`);
  }
}

function loadCA() {
  try {
    caCert = fs.readFileSync(CA_CERT_FILE);
    caKey = fs.readFileSync(CA_KEY_FILE);
    log("CONFIG", "CA certificate loaded");
  } catch {
    log("WARN", "No CA certificate — HTTPS MITM disabled");
  }
}

// Load + watch
loadSecrets();
loadAllowlist();
loadGitPolicy();
loadCA();
try { fs.watchFile(SECRETS_FILE, { interval: 1000 }, loadSecrets); } catch {}
try { fs.watchFile(ALLOWLIST_FILE, { interval: 1000 }, loadAllowlist); } catch {}
try { fs.watchFile(GIT_POLICY_FILE, { interval: 1000 }, loadGitPolicy); } catch {}

// --- Helpers ---

function isHostAllowed(hostname: string): boolean {
  if (!allowlist.enabled) return true;

  for (const pattern of allowlist.hosts) {
    if (pattern === hostname) return true;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // e.g. ".github.com"
      if (hostname.endsWith(suffix) || hostname === suffix.slice(1)) return true;
    }
  }
  return false;
}

function isGitHost(hostname: string): boolean {
  return gitPolicy.enabled && gitPolicy.gitHosts.includes(hostname);
}

function isGitApiHost(hostname: string): boolean {
  // api.github.com is the GitHub REST API host
  return hostname === "api.github.com";
}

// --- MITM cert generation ---

function getCertForHost(hostname: string): { key: Buffer; cert: Buffer } | null {
  const cached = certCache.get(hostname);
  if (cached) return cached;

  if (!caCert || !caKey) return null;

  const t0 = performance.now();
  try {
    const prefix = `/tmp/mitm-${hostname}-${Date.now()}`;
    const keyPath = `${prefix}.key`;
    const csrPath = `${prefix}.csr`;
    const certPath = `${prefix}.crt`;
    const extPath = `${prefix}.ext`;

    fs.writeFileSync(extPath, `subjectAltName=DNS:${hostname}\n`);
    execSync(`openssl genrsa -out ${keyPath} 2048 2>/dev/null`);
    execSync(`openssl req -new -key ${keyPath} -out ${csrPath} -subj "/CN=${hostname}" 2>/dev/null`);
    execSync(
      `openssl x509 -req -in ${csrPath} -CA ${CA_CERT_FILE} -CAkey ${CA_KEY_FILE} ` +
      `-CAcreateserial -out ${certPath} -days 30 -extfile ${extPath} 2>/dev/null`
    );

    const result = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    certCache.set(hostname, result);

    for (const f of [keyPath, csrPath, certPath, extPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
    TIMING_LOGS && log("TIMING", `cert-gen ${hostname} ${(performance.now() - t0).toFixed(1)}ms`);
    return result;
  } catch (err: any) {
    log("ERROR", `Cert gen for ${hostname}: ${err.message}`);
    return null;
  }
}

// --- Key injection (for API secrets like Anthropic) ---

function injectKey(headers: Record<string, string | string[] | undefined>, hostname: string): boolean {
  const secret = hostSecrets.get(hostname);
  if (!secret) return false;

  let injected = false;
  for (const h of Object.keys(headers)) {
    const v = headers[h];
    if (typeof v === "string" && v.includes("sk-sandbox-")) {
      headers[h] = v.replace(/sk-sandbox-[^\s"',]+/, secret.key);
      injected = true;
    }
  }
  return injected;
}

// --- Git credential injection (from host's git setup) ---

async function getHostCredentials(hostname: string): Promise<{ username: string; password: string } | null> {
  const cached = credentialCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const res = await fetch(`http://${HOST_SERVER}/api/git/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: hostname, protocol: "https" }),
    });
    if (!res.ok) {
      log("WARN", `Host credential request failed: ${res.status}`);
      return null;
    }
    const creds = await res.json() as { username: string; password: string };
    if (creds.username && creds.password) {
      credentialCache.set(hostname, { ...creds, expiresAt: Date.now() + CRED_CACHE_TTL });
      return creds;
    }
    return null;
  } catch (err: any) {
    log("ERROR", `Host credential fetch for ${hostname}: ${err.message}`);
    return null;
  }
}

async function getGhToken(): Promise<string | null> {
  if (ghTokenCache && ghTokenCache.expiresAt > Date.now()) return ghTokenCache.token;

  try {
    const res = await fetch(`http://${HOST_SERVER}/api/git/gh-token`);
    if (!res.ok) return null;
    const data = await res.json() as { token: string };
    if (data.token) {
      ghTokenCache = { token: data.token, expiresAt: Date.now() + CRED_CACHE_TTL };
      return data.token;
    }
    return null;
  } catch (err: any) {
    log("ERROR", `gh token fetch: ${err.message}`);
    return null;
  }
}

// --- Git policy enforcement ---

function isGitPushRequest(urlPath: string): boolean {
  // Match POST to /git-receive-pack (the actual push), but NOT /info/refs?service=git-receive-pack
  return urlPath.includes("/git-receive-pack") && !urlPath.includes("/info/refs");
}

function isGitPushInfoRefs(urlPath: string): boolean {
  return urlPath.includes("/info/refs") && urlPath.includes("service=git-receive-pack");
}

function isGitFetchRequest(urlPath: string): boolean {
  return urlPath.includes("/git-upload-pack");
}

function isPrCreationRequest(method: string, urlPath: string): boolean {
  // GitHub API: POST /repos/:owner/:repo/pulls
  return method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls\/?$/.test(urlPath);
}

// --- Git pkt-line helpers ---

function writeGitPktLine(data: string): Buffer {
  const len = Buffer.byteLength(data) + 4;
  const lenHex = len.toString(16).padStart(4, "0");
  return Buffer.from(lenHex + data);
}

const GIT_FLUSH = Buffer.from("0000");

// --- Git push interception ---

/**
 * Handle GET /info/refs?service=git-receive-pack by returning a fake
 * capability advertisement. This makes git think the remote is ready
 * to accept a push.
 */
function handleGitPushInfoRefs(
  _mitmReq: http.IncomingMessage,
  mitmRes: http.ServerResponse,
): void {
  mitmRes.writeHead(200, {
    "Content-Type": "application/x-git-receive-pack-advertisement",
    "Cache-Control": "no-cache",
  });

  // Service announcement line
  const serviceLine = writeGitPktLine("# service=git-receive-pack\n");

  // Capability advertisement with no existing refs (zero-sha)
  const caps =
    "0000000000000000000000000000000000000000 capabilities^{}\0 " +
    "delete-refs ofs-delta report-status quiet agent=vivi/1.0\n";
  const pktCaps = writeGitPktLine(caps);

  mitmRes.end(Buffer.concat([serviceLine, GIT_FLUSH, pktCaps, GIT_FLUSH]));
}

/**
 * Intercept POST /git-receive-pack: parse the pushed refs from the
 * pkt-line header, notify the host server, and return a fake success
 * response so `git push` appears to succeed.
 */
async function interceptGitPush(
  mitmReq: http.IncomingMessage,
  mitmRes: http.ServerResponse,
): Promise<void> {
  // Read request body (pkt-lines + pack data)
  const chunks: Buffer[] = [];
  for await (const chunk of mitmReq) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  // Parse pkt-lines to extract pushed refs
  const pushedRefs: { oldSha: string; newSha: string; refname: string }[] = [];
  let offset = 0;
  try {
    while (offset + 4 <= body.length) {
      const lenStr = body.slice(offset, offset + 4).toString("ascii");
      if (lenStr === "0000") break; // flush
      const len = parseInt(lenStr, 16);
      if (isNaN(len) || len < 4) break;
      const line = body.slice(offset + 4, offset + len).toString("utf-8");
      offset += len;

      // Format: <old-sha> <new-sha> <refname>\0<capabilities>\n
      const nullIdx = line.indexOf("\0");
      const refLine = (nullIdx >= 0 ? line.slice(0, nullIdx) : line).replace(/\n$/, "");
      const parts = refLine.split(" ");
      if (parts.length >= 3 && parts[0].length === 40) {
        pushedRefs.push({ oldSha: parts[0], newSha: parts[1], refname: parts[2] });
      }
    }
  } catch {}

  // Extract branch names
  const branches = pushedRefs
    .map((r) => r.refname.replace(/^refs\/heads\//, ""))
    .filter((b) => !b.startsWith("refs/"));
  const branch = branches[0] || "unknown";

  // Extract session ID from custom header
  const sessionId = (mitmReq.headers["x-vivi-session"] as string) || "";

  // Notify host server
  try {
    await fetch(`http://${HOST_SERVER}/api/sandbox/git-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, sessionId, pushedRefs }),
    });
    log("GIT-PUSH", `Intercepted push to ${branch} (session ${sessionId || "unknown"})`);
  } catch (err: any) {
    log("ERROR", `Git push notification failed: ${err.message}`);
  }

  // Return fake success response
  mitmRes.writeHead(200, {
    "Content-Type": "application/x-git-receive-pack-result",
    "Cache-Control": "no-cache",
  });
  let response = writeGitPktLine("unpack ok\n");
  for (const ref of pushedRefs) {
    response = Buffer.concat([response, writeGitPktLine(`ok ${ref.refname}\n`)]);
  }
  response = Buffer.concat([response, GIT_FLUSH]);
  mitmRes.end(response);
}

// --- PR interception ---

async function interceptPrCreation(
  mitmReq: http.IncomingMessage,
  mitmRes: http.ServerResponse,
): Promise<void> {
  // Read the request body
  const chunks: Buffer[] = [];
  for await (const chunk of mitmReq) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString("utf-8");

  try {
    const prData = JSON.parse(body);

    // Forward to host server
    const res = await fetch(`http://${HOST_SERVER}/api/sandbox/pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: prData.title || "Untitled PR",
        description: prData.body || "",
        branch: prData.head || "unknown",
        baseBranch: prData.base || "main",
      }),
    });

    const result = await res.json();
    log("GIT-PR", `PR creation intercepted: "${prData.title}" → pending approval`);

    // Return a fake GitHub PR response so gh CLI is happy
    const fakeResponse = {
      id: 0,
      number: 0,
      state: "open",
      title: prData.title || "Untitled PR",
      body: prData.body || "",
      html_url: `[Vivi] PR submitted for approval — check the Vivi UI`,
      head: { ref: prData.head },
      base: { ref: prData.base },
      created_at: new Date().toISOString(),
      _vivi: { status: "pending_approval", prRequestId: (result as any).id },
    };

    mitmRes.writeHead(201, { "Content-Type": "application/json" });
    mitmRes.end(JSON.stringify(fakeResponse));
  } catch (err: any) {
    log("ERROR", `PR interception failed: ${err.message}`);
    mitmRes.writeHead(500, { "Content-Type": "application/json" });
    mitmRes.end(JSON.stringify({ message: `PR interception error: ${err.message}` }));
  }
}

// --- Logging ---

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`${ts} [${tag}] ${msg}`);
}

// --- HTTP forward proxy ---

const server = http.createServer((req, res) => {
  // Handle client-side socket errors to prevent crashes during proxying
  res.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "ECONNRESET" && e.code !== "EPIPE") {
      log("ERROR", `Response socket: ${e.message}`);
    }
  });
  req.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "ECONNRESET" && e.code !== "EPIPE") {
      log("ERROR", `Request socket: ${e.message}`);
    }
  });
  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      secrets: hostSecrets.size,
      allowlist: allowlist.enabled,
      gitPolicy: { enabled: gitPolicy.enabled, hosts: gitPolicy.gitHosts.length },
    }));
    return;
  }

  // Forward proxy expects absolute URL
  let target: URL;
  try {
    target = new URL(req.url!);
  } catch {
    res.writeHead(400);
    res.end("Bad request\n");
    return;
  }

  // Route vivi.internal to host server
  if (target.hostname === "vivi.internal") {
    const hostUrl = `http://${HOST_SERVER}${target.pathname}${target.search}`;
    log("INTERNAL", `${req.method} ${target.href} → ${hostUrl}`);

    const proxyReq = http.request(hostUrl, {
      method: req.method,
      headers: { ...req.headers, host: HOST_SERVER },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });
    proxyReq.on("error", (err) => {
      log("ERROR", `Internal route: ${err.message}`);
      if (!res.headersSent) { res.writeHead(502); res.end(`Internal route error: ${err.message}\n`); }
    });
    req.pipe(proxyReq, { end: true });
    return;
  }

  // Allowlist check
  if (!isHostAllowed(target.hostname)) {
    log("DENY", `${req.method} ${target.href}`);
    res.writeHead(403);
    res.end(`Blocked by allowlist: ${target.hostname}\n`);
    return;
  }

  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;

  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers.host;
  headers.host = target.host;

  const injected = injectKey(headers, target.hostname);
  log(injected ? "INJECT" : "ALLOW", `${req.method} ${target.href}`);

  const proxyReq = transport.request(
    {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: headers as http.OutgoingHttpHeaders,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    },
  );

  proxyReq.on("error", (err) => {
    log("ERROR", `${target.href}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}\n`);
    }
  });

  req.pipe(proxyReq, { end: true });
});

// --- HTTPS CONNECT handler ---

server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
  const [hostname, portStr] = (req.url || "").split(":");
  const port = parseInt(portStr) || 443;

  // Attach error handler early so no path can crash from an unhandled socket error
  clientSocket.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "ECONNRESET" && e.code !== "EPIPE") {
      log("ERROR", `Client socket ${hostname}:${port}: ${e.message}`);
    }
  });

  // Allowlist check
  if (!isHostAllowed(hostname)) {
    log("DENY", `CONNECT ${hostname}:${port}`);
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    clientSocket.end();
    return;
  }

  const hasSecret = hostSecrets.has(hostname);
  const gitHost = isGitHost(hostname);
  const canMitm = !!(caCert && caKey);
  const shouldMitm = (hasSecret || gitHost) && canMitm;

  if (!shouldMitm) {
    // Passthrough tunnel — no interception needed
    log("TUNNEL", `CONNECT ${hostname}:${port}`);
    const tunnelStart = performance.now();
    const serverSocket = net.connect(port, hostname, () => {
      TIMING_LOGS && log("TIMING", `tunnel-ready ${hostname}:${port} ${(performance.now() - tunnelStart).toFixed(1)}ms`);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ECONNRESET" && e.code !== "EPIPE") {
        log("ERROR", `CONNECT ${hostname}: ${e.message}`);
      }
      clientSocket.end();
    });
    return;
  }

  // MITM: we need to inspect/modify traffic
  const mitmTunnelStart = performance.now();
  const hostCert = getCertForHost(hostname);
  if (!hostCert) {
    log("WARN", `MITM cert failed for ${hostname}, falling back to tunnel`);
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on("error", () => clientSocket.end());
    return;
  }

  // Tell client the tunnel is up
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  TIMING_LOGS && log("TIMING", `tunnel-ready ${hostname}:${port} ${(performance.now() - mitmTunnelStart).toFixed(1)}ms`);

  // Terminate TLS from the client using our generated cert
  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    key: hostCert.key,
    cert: Buffer.concat([hostCert.cert, caCert!]),
  });

  // Create a temporary HTTP server to handle the decrypted requests
  const mitmHandler = async (mitmReq: http.IncomingMessage, mitmRes: http.ServerResponse) => {
    const urlPath = mitmReq.url || "/";
    const headers: Record<string, string | string[] | undefined> = { ...mitmReq.headers };
    delete headers.host;
    headers.host = hostname;

    // --- Git policy enforcement ---
    if (gitHost) {
      // Intercept git push — fake success and notify host server
      if (isGitPushInfoRefs(urlPath) && !gitPolicy.allowPush) {
        log("GIT-PUSH", `Intercepting git push info/refs: ${mitmReq.method} https://${hostname}${urlPath}`);
        handleGitPushInfoRefs(mitmReq, mitmRes);
        return;
      }

      if (isGitPushRequest(urlPath) && !gitPolicy.allowPush) {
        log("GIT-PUSH", `Intercepting git push: ${mitmReq.method} https://${hostname}${urlPath}`);
        await interceptGitPush(mitmReq, mitmRes);
        return;
      }

      // Block git fetch if policy disallows
      if (isGitFetchRequest(urlPath) && !gitPolicy.allowFetch) {
        log("GIT-BLOCK", `Blocked git fetch: ${mitmReq.method} https://${hostname}${urlPath}`);
        mitmRes.writeHead(403, { "Content-Type": "text/plain" });
        mitmRes.end("Git fetch is blocked by policy.\n");
        return;
      }

      // Intercept PR creation on GitHub API
      if (isGitApiHost(hostname) && isPrCreationRequest(mitmReq.method || "", urlPath)) {
        if (gitPolicy.allowPrCreation) {
          log("GIT-PR", `Intercepting PR creation: ${mitmReq.method} https://${hostname}${urlPath}`);
          await interceptPrCreation(mitmReq, mitmRes);
          return;
        } else {
          mitmRes.writeHead(403, { "Content-Type": "application/json" });
          mitmRes.end(JSON.stringify({ message: "PR creation is blocked by policy." }));
          return;
        }
      }

      // Inject credentials for git hosts (always replace — sandbox uses dummy placeholders)
      if (isGitApiHost(hostname)) {
        // GitHub API uses Bearer tokens
        const token = await getGhToken();
        if (token) {
          headers.authorization = `token ${token}`;
          log("GIT-AUTH", `Injected gh token for ${hostname}`);
        }
      } else if (!headers.authorization) {
        // Git HTTP uses Basic auth — only inject if missing
        const creds = await getHostCredentials(hostname);
        if (creds) {
          headers.authorization = "Basic " + Buffer.from(`${creds.username}:${creds.password}`).toString("base64");
          log("GIT-AUTH", `Injected git credentials for ${hostname}`);
        }
      }
    }

    // --- API key injection (for non-git hosts with secrets) ---
    if (hasSecret) {
      injectKey(headers, hostname);
    }

    const tag = gitHost ? "GIT-MITM" : (hasSecret ? "MITM+INJECT" : "MITM");
    log(tag, `${mitmReq.method} https://${hostname}${urlPath}`);

    const reqStart = performance.now();
    let ttfbMs = 0;
    let totalBytes = 0;

    const upstream = https.request(
      {
        hostname,
        port,
        path: urlPath,
        method: mitmReq.method,
        headers: headers as http.OutgoingHttpHeaders,
      },
      (upstreamRes) => {
        ttfbMs = performance.now() - reqStart;
        TIMING_LOGS && log("TIMING", `ttfb ${hostname} ${urlPath} ${ttfbMs.toFixed(1)}ms`);

        upstreamRes.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code !== "ECONNRESET" && e.code !== "EPIPE") {
            log("ERROR", `MITM upstream response ${hostname}: ${e.message}`);
          }
        });
        upstreamRes.on("data", (chunk: Buffer) => { totalBytes += chunk.length; });
        upstreamRes.on("end", () => {
          const totalMs = performance.now() - reqStart;
          TIMING_LOGS && log("TIMING", `done ${hostname} ${urlPath} ${upstreamRes.statusCode} ttfb=${ttfbMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms bytes=${totalBytes}`);
        });
        mitmRes.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
        upstreamRes.pipe(mitmRes, { end: true });
      },
    );

    upstream.on("error", (err) => {
      log("ERROR", `MITM upstream ${hostname}: ${err.message}`);
      if (!mitmRes.headersSent) {
        mitmRes.writeHead(502);
        mitmRes.end("Upstream error\n");
      }
    });

    mitmReq.pipe(upstream, { end: true });
  };

  const mitmServer = http.createServer(mitmHandler as any);
  mitmServer.emit("connection", tlsSocket);

  tlsSocket.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code !== "ECONNRESET") log("ERROR", `TLS ${hostname}: ${e.message}`);
  });
});

// --- Error resilience ---

// Handle HTTP parse errors and client socket errors at the server level
server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
  if (err.code !== "ECONNRESET" && err.code !== "EPIPE") {
    log("ERROR", `Client error: ${err.message}`);
  }
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } else {
    socket.destroy();
  }
});

// Safety nets — prevent unhandled errors from crashing the process
process.on("uncaughtException", (err) => {
  log("FATAL", `Uncaught exception: ${err.message}`);
  console.error(err.stack);
});

process.on("unhandledRejection", (reason) => {
  log("FATAL", `Unhandled rejection: ${reason}`);
});

// --- Start ---

server.listen(PORT, "0.0.0.0", () => {
  log("READY", `Proxy listening on :${PORT}`);
  log("READY", `Git hosts: ${gitPolicy.gitHosts.join(", ")}`);
  log("READY", `Host server: ${HOST_SERVER}`);
});
