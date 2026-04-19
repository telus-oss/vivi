import { getApiBase } from "./backend";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

// Config
export const getConfig = () => request<{ host: string }>("/config");

// Sessions (multi-session)
export const getSessions = () => request<import("./types").SessionState[]>("/sessions");
export const startSession = (body: {
  repoPath?: string;
  attachTo?: string;
  taskDescription?: string;
  profileId?: string;
  imageId?: number;
  githubRepo?: import("./types").GitHubRepoSelection;
}) =>
  request<import("./types").SessionState>("/sessions", { method: "POST", body: JSON.stringify(body) });
export const stopSession = (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" });

// Secrets
export const listSecrets = () => request<import("./types").SecretPublic[]>("/secrets");
export const addSecret = (body: { name: string; envVar: string; key: string; baseUrl: string; headerName?: string }) =>
  request<import("./types").SecretPublic>("/secrets", { method: "POST", body: JSON.stringify(body) });
export const removeSecret = (id: string) => request<{ ok: boolean }>(`/secrets/${id}`, { method: "DELETE" });
export const updateSecret = (id: string, body: { name?: string; envVar?: string; key?: string; baseUrl?: string; headerName?: string }) =>
  request<import("./types").SecretPublic>(`/secrets/${id}`, { method: "PATCH", body: JSON.stringify(body) });

// Allowlist
export const getAllowlist = () => request<import("./types").AllowlistConfig>("/allowlist");
export const addNetworkRule = (pattern: string, description?: string) =>
  request<import("./types").NetworkRule>("/allowlist/network", { method: "POST", body: JSON.stringify({ pattern, description }) });
export const removeNetworkRule = (id: string) =>
  request<{ ok: boolean }>(`/allowlist/network/${id}`, { method: "DELETE" });
export const updateNetworkRule = (id: string, pattern: string, description?: string) =>
  request<import("./types").NetworkRule>(`/allowlist/network/${id}`, { method: "PUT", body: JSON.stringify({ pattern, description }) });
export const setAllowlistEnabled = (enabled: boolean) =>
  request<{ ok: boolean }>("/allowlist/enabled", { method: "PUT", body: JSON.stringify({ enabled }) });

// Secret Requests
export const listSecretRequests = () =>
  request<import("./types").SecretRequest[]>("/secret-requests");
export const dismissSecretRequest = (id: string) =>
  request<{ ok: boolean }>(`/secret-requests/${id}`, { method: "DELETE" });

// Auth (extract token after interactive setup-token)
export const extractToken = () =>
  request<{ ok: boolean; secret?: import("./types").SecretPublic; error?: string }>("/auth/extract-token", {
    method: "POST",
  });

// Filesystem completion
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  isGit: boolean;
}
export const completePath = (pathStr: string) =>
  request<{ dir: string; dirIsGit: boolean; results: FsEntry[] }>(`/fs/complete?path=${encodeURIComponent(pathStr)}`);

// Monitor
export const getHealth = (sessionId?: string) =>
  request<import("./types").HealthSnapshot>(`/monitor/health${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`);
export const clearAlerts = (sessionId?: string) =>
  request<{ ok: boolean }>(`/monitor/clear-alerts${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { method: "POST" });
export const setAutoIntervene = (sessionId: string, enabled: boolean) =>
  request<{ ok: boolean }>(`/monitor/${encodeURIComponent(sessionId)}/auto-intervene`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
export const setMonitorConfig = (sessionId: string, config: Partial<import("./types").MonitorConfig>) =>
  request<{ ok: boolean; config: import("./types").MonitorConfig }>(`/monitor/${encodeURIComponent(sessionId)}/config`, {
    method: "PUT",
    body: JSON.stringify(config),
  });

// PR Management (session-scoped)
export const getPrRequests = (sessionId: string) =>
  request<import("./types").PrRequest[]>(`/pr?sessionId=${encodeURIComponent(sessionId)}`);
export const getAllPrRequests = () =>
  request<import("./types").PrRequest[]>("/pr");
export const getPrRequest = (id: string) => request<import("./types").PrRequest>(`/pr/${id}`);
export const approvePr = (id: string, action: "pull_local" | "github_pr", description?: string) =>
  request<import("./types").PrRequest>(`/pr/${id}/approve`, { method: "POST", body: JSON.stringify({ action, description }) });
export const dismissPr = (id: string) =>
  request<import("./types").PrRequest>(`/pr/${id}`, { method: "DELETE" });
export const getPrDiff = (id: string) => request<{ diff: string }>(`/pr/${id}/diff`);
export const getPrFile = (id: string, path: string) =>
  request<{ content: string; path: string }>(`/pr/${id}/file?path=${encodeURIComponent(path)}`);

// Port Forwards (session-scoped)
export const getOpenPorts = (sessionId: string) =>
  request<import("./types").PortForward[]>(`/ports?sessionId=${encodeURIComponent(sessionId)}`);
export const closePort = (sessionId: string, port: number) =>
  request<{ ok: boolean }>(`/ports/${encodeURIComponent(sessionId)}/${port}`, { method: "DELETE" });

/** Get the URL for a port forward (uses server-provided proxyUrl). */
export function getPortForwardUrl(pf: import("./types").PortForward): string {
  const raw = pf.proxyUrl || `http://localhost:${pf.hostPort}`;
  // Validate protocol to prevent javascript: or data: URI injection
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return raw;
    }
  } catch {
    // Malformed URL — fall through to safe default
  }
  return `http://localhost:${pf.hostPort}`;
}

// Updates
export interface UpdateStatus {
  available: boolean;
  currentCommit: string;
  remoteCommit: string;
  behindCount: number;
  commitMessages: string[];
}
export const checkForUpdate = () => request<UpdateStatus>("/update/check");
export const applyUpdate = () =>
  request<{ ok: boolean; message: string }>("/update/apply", { method: "POST" });

// Live diff (working tree diff for a running session)
export const getSessionDiff = (sessionId: string) =>
  request<{ diff: string }>(`/sessions/${encodeURIComponent(sessionId)}/diff`);
export const getSessionFile = (sessionId: string, path: string) =>
  request<{ content: string; path: string }>(`/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`);

// Docker containers (per session, via dind namespace proxy)
export const getSessionContainers = (sessionId: string) =>
  request<import("./types").DockerContainer[]>(`/sessions/${encodeURIComponent(sessionId)}/containers`);

// GitHub Issues
export const getGitHubIssues = (repoPath: string) =>
  request<import("./types").GitHubIssuesResult>(`/github/issues?repoPath=${encodeURIComponent(repoPath)}`);

// GitHub Auth + Repo Picker
export const getGitHubStatus = () =>
  request<import("./types").GitHubAuthStatus>("/github/status");
export const saveGitHubToken = (token: string) =>
  request<import("./types").GitHubAuthStatus>("/github/token", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
export const clearGitHubToken = () =>
  request<{ ok: boolean }>("/github/token", { method: "DELETE" });
export const listGitHubRepos = (search?: string, refresh?: boolean) => {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (refresh) params.set("refresh", "1");
  const qs = params.toString();
  return request<import("./types").GitHubRepo[]>(`/github/repos${qs ? `?${qs}` : ""}`);
};
export const listGitHubBranches = (owner: string, repo: string) =>
  request<import("./types").GitHubBranch[]>(
    `/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
  );

// Git Policy
export const getGitPolicy = () => request<import("./types").GitPolicy>("/git/policy");
export const updateGitPolicy = (policy: Partial<import("./types").GitPolicy>) =>
  request<import("./types").GitPolicy>("/git/policy", { method: "PUT", body: JSON.stringify(policy) });

// Profiles
export const listProfiles = () => request<import("./types").Profile[]>("/profiles");
export const createProfile = (body: { name: string; description?: string }) =>
  request<import("./types").Profile>("/profiles", { method: "POST", body: JSON.stringify(body) });
export const updateProfile = (id: string, patch: { name?: string; description?: string; autoSave?: boolean }) =>
  request<import("./types").Profile>(`/profiles/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteProfile = (id: string) =>
  request<{ ok: boolean }>(`/profiles/${id}`, { method: "DELETE" });
export const saveProfileFromSession = (profileId: string, sessionId: string) =>
  request<{ ok: boolean }>(`/profiles/${profileId}/save-from-session/${sessionId}`, { method: "POST" });

// Sandbox container logs
export type LogSource = "sandbox" | "proxy" | "dind";
export const getSessionLogs = (sessionId: string, tail = 200, source: LogSource = "sandbox") =>
  request<{ logs: string }>(`/sessions/${encodeURIComponent(sessionId)}/logs?tail=${tail}&source=${source}`);

// Sandbox Images
export const listSandboxImages = () => request<import("./types").SandboxImage[]>("/sandbox-images");
export const addSandboxImage = (name: string, image: string) =>
  request<import("./types").SandboxImage>("/sandbox-images", { method: "POST", body: JSON.stringify({ name, image }) });
export const removeSandboxImage = (id: number) =>
  request<{ ok: boolean }>(`/sandbox-images/${id}`, { method: "DELETE" });
export const setSandboxImageDefault = (id: number) =>
  request<import("./types").SandboxImage>(`/sandbox-images/${id}/default`, { method: "PUT" });
