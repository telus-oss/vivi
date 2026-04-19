export interface SessionState {
  id: string;
  status: "stopped" | "starting" | "running" | "stopping" | "error";
  repoPath: string | null;
  repoName: string | null;
  branch: string | null;
  containerId: string | null;
  containerRef: string;
  error: string | null;
  startedAt: string | null;
}

export interface PortForward {
  sessionId: string;
  containerPort: number;
  hostPort: number;
  status: "active" | "closing";
  createdAt: number;
  /** Subdomain slug for reverse-proxy access (e.g. "p-3000-abc123"). */
  proxySubdomain?: string;
  /** Full URL for accessing this port forward via the reverse proxy. */
  proxyUrl?: string;
  /** If set, the port is forwarded from a DinD container at this IP. */
  targetHost?: string;
  /** Display name of the DinD container. */
  containerName?: string;
  /** Human-readable label for this port forward (e.g. "Frontend Dev Server"). */
  label?: string;
  /** Semantic type of this port forward (e.g. "git"). Used for UI feature detection. */
  type?: string;
}

export interface SecretPublic {
  id: string;
  name: string;
  envVar: string;
  baseUrl: string;
  headerName: string;
  createdAt: string;
  sandboxKey: string;
  sandboxBaseUrl: string;
}

export interface NetworkRule {
  id: string;
  pattern: string;
  description?: string;
}

export interface AllowlistConfig {
  network: NetworkRule[];
  enabled: boolean;
}

export interface Alert {
  id: string;
  timestamp: number;
  severity: "warning" | "critical";
  type: "bash_rate" | "repetitive" | "stuck_loop" | "similar_loop" | "long_running_bash";
  message: string;
}

export interface ActiveBashInfo {
  command: string;
  startedAt: number;
  durationSec: number;
  expectedLong: boolean;
}

export interface StruggleSignals {
  recentErrorCount: number;
  fileRevisitCount: number;
  hotFiles: string[];
  editFailCycles: number;
  claudeMessageRepetition: number;
  recentErrors: string[];
  bashWithoutEditStreak: number;
}

export interface MonitorConfig {
  /** Error count threshold for "critical" severity */
  errorThreshold: number;
  /** Edit-fail cycle threshold for "critical" severity */
  editFailThreshold: number;
  /** File revisit count threshold for "warning" severity */
  fileRevisitThreshold: number;
  /** Bash-without-edits streak threshold for "warning" severity */
  bashStreakThreshold: number;
}

export interface HealthSnapshot {
  fileVsBashRatio: number;
  totalEvents: number;
  alerts: Alert[];
  breakdown: Record<string, number>;
  repetitionScore: number;
  autoIntervene: boolean;
  activeBash: ActiveBashInfo | null;
  stuckDetected: boolean;
  struggleSignals: StruggleSignals;
  config: MonitorConfig;
}

export interface PrRequest {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  branch: string;
  baseBranch: string;
  status: "pending" | "pulling" | "merging" | "creating_pr" | "completed" | "failed" | "dismissed";
  result?: { prUrl?: string; error?: string; action?: string };
  createdAt: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
}

export interface DockerLogEntry {
  stream: "stdout" | "stderr";
  data: string;
  timestamp?: string;
}

export type DockerWsOutgoing =
  | { type: "containers"; data: DockerContainer[] }
  | { type: "log"; containerId: string; stream: "stdout" | "stderr"; data: string }
  | { type: "log_end"; containerId: string; exitCode: number }
  | { type: "inspect"; containerId: string; data: Record<string, any> }
  | { type: "error"; message: string };

export interface SecretRequest {
  id: string;
  sessionId: string;
  name: string;
  envVar: string;
  baseUrl: string;
  headerName: string;
  status: "pending" | "fulfilled" | "dismissed";
  createdAt: number;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  author: string;
  createdAt: string;
}

export interface GitHubIssuesResult {
  issues: GitHubIssue[];
  repoOwner: string;
  repoName: string;
  error?: string;
}


export interface Profile {
  id: string;
  name: string;
  description: string | null;
  autoSave: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface GitPolicy {
  enabled: boolean;
  gitHosts: string[];
  allowFetch: boolean;
  allowPush: boolean;
  allowPrCreation: boolean;
  protectedBranches: string[];
  allowReadFromUpstream: boolean;
}

export interface SandboxImage {
  id: number;
  name: string;
  image: string;
  isDefault: boolean;
  createdAt: string;
}

export interface GitHubAuthStatus {
  configured: boolean;
  login?: string;
  scopes?: string[];
  addedAt?: string;
}

export interface GitHubRepo {
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  kind: "owned" | "org" | "starred";
  cloneUrl: string;
}

export interface GitHubBranch {
  name: string;
  commitSha: string;
  isDefault: boolean;
}

export interface GitHubRepoSelection {
  owner: string;
  name: string;
  branch: string;
}
