/**
 * GitHub integration — host-wide Personal Access Token + REST client.
 *
 * The token is stored once per Vivi host in the `config` KV table under
 * key `github_auth`. It is used for two host-side operations only:
 *   1. Cloning a selected GitHub repo into a session's staging dir when the
 *      user starts a session via the "From GitHub" option.
 *   2. Authenticating `git push` + `gh pr create` in server/pr.ts when the
 *      intercepted-PR flow ships a branch back to GitHub.
 *
 * The token is never injected into the sandbox container — the existing
 * intercepted-PR flow handles everything that would need it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getConfig, setConfig } from "./db.js";

const GITHUB_API = "https://api.github.com";
const AUTH_CONFIG_KEY = "github_auth";

export interface GitHubAuth {
  token: string;
  login: string;
  scopes: string[];
  addedAt: string;
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

export class GitHubAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export function getAuth(): GitHubAuth | null {
  const raw = getConfig(AUTH_CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitHubAuth;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  setConfig(AUTH_CONFIG_KEY, "");
}

export async function saveToken(token: string): Promise<{ login: string; scopes: string[] }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Token is empty");
  const { login, scopes } = await verifyToken(trimmed);
  const auth: GitHubAuth = {
    token: trimmed,
    login,
    scopes,
    addedAt: new Date().toISOString(),
  };
  setConfig(AUTH_CONFIG_KEY, JSON.stringify(auth));
  return { login, scopes };
}

export function status(): { configured: boolean; login?: string; scopes?: string[]; addedAt?: string } {
  const auth = getAuth();
  if (!auth || !auth.token) return { configured: false };
  return { configured: true, login: auth.login, scopes: auth.scopes, addedAt: auth.addedAt };
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

async function ghFetch(pathWithQuery: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${pathWithQuery}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "vivi",
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => "");
    throw new GitHubAuthError(
      `GitHub rejected the request (${res.status}). ${body.slice(0, 200)}`,
      res.status,
    );
  }
  return res;
}

async function verifyToken(token: string): Promise<{ login: string; scopes: string[] }> {
  const res = await ghFetch("/user", token);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub /user failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { login?: string };
  const login = data.login;
  if (!login) throw new Error("GitHub /user returned no login");
  const scopeHeader = res.headers.get("X-OAuth-Scopes") || "";
  const scopes = scopeHeader
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { login, scopes };
}

// Parse the Link header (RFC 5988) to extract a rel="next" URL if present.
function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const [urlPart, ...params] = part.split(";").map((s) => s.trim());
    if (params.some((p) => p === 'rel="next"')) {
      const m = urlPart.match(/^<(.+)>$/);
      if (m) return m[1];
    }
  }
  return null;
}

async function ghFetchAllPages<T>(firstPath: string, token: string, maxItems = 300): Promise<T[]> {
  const out: T[] = [];
  let nextUrl: string | null = `${GITHUB_API}${firstPath}`;
  while (nextUrl && out.length < maxItems) {
    const res = await fetch(nextUrl, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vivi",
      },
    });
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new GitHubAuthError(`GitHub rejected the request (${res.status}). ${body.slice(0, 200)}`, res.status);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub request failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const batch = (await res.json()) as T[];
    out.push(...batch);
    nextUrl = parseNextLink(res.headers.get("Link"));
  }
  return out.slice(0, maxItems);
}

interface GhRepoRaw {
  full_name: string;
  name: string;
  owner: { login: string; type?: string };
  private: boolean;
  default_branch: string;
  description: string | null;
  pushed_at: string | null;
  clone_url: string;
  fork?: boolean;
}

function toRepo(raw: GhRepoRaw, kind: GitHubRepo["kind"]): GitHubRepo {
  return {
    owner: raw.owner.login,
    name: raw.name,
    fullName: raw.full_name,
    description: raw.description,
    isPrivate: raw.private,
    defaultBranch: raw.default_branch,
    pushedAt: raw.pushed_at,
    cloneUrl: raw.clone_url,
    kind,
  };
}

// In-memory repo cache — listing user repos takes several round trips; cache
// for 5 minutes to keep the UI snappy when the user opens the picker repeatedly.
interface RepoCacheEntry {
  repos: GitHubRepo[];
  fetchedAt: number;
}
const REPO_CACHE_TTL_MS = 5 * 60 * 1000;
let repoCache: RepoCacheEntry | null = null;

export function invalidateRepoCache(): void {
  repoCache = null;
}

export async function listRepos(opts?: { search?: string; force?: boolean }): Promise<GitHubRepo[]> {
  const auth = requireAuth();
  if (!opts?.force && repoCache && Date.now() - repoCache.fetchedAt < REPO_CACHE_TTL_MS) {
    return filterRepos(repoCache.repos, opts?.search);
  }

  const [owned, starred] = await Promise.all([
    ghFetchAllPages<GhRepoRaw>(
      "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100",
      auth.token,
      300,
    ),
    ghFetchAllPages<GhRepoRaw>("/user/starred?per_page=100", auth.token, 200),
  ]);

  const byFullName = new Map<string, GitHubRepo>();
  for (const raw of owned) {
    const ownerType = raw.owner.type;
    const kind: GitHubRepo["kind"] =
      ownerType && ownerType.toLowerCase() === "organization" ? "org" : "owned";
    byFullName.set(raw.full_name, toRepo(raw, kind));
  }
  for (const raw of starred) {
    if (byFullName.has(raw.full_name)) continue;
    byFullName.set(raw.full_name, toRepo(raw, "starred"));
  }

  const repos = [...byFullName.values()].sort((a, b) => {
    const at = a.pushedAt || "";
    const bt = b.pushedAt || "";
    return bt.localeCompare(at);
  });

  repoCache = { repos, fetchedAt: Date.now() };
  return filterRepos(repos, opts?.search);
}

function filterRepos(repos: GitHubRepo[], search?: string): GitHubRepo[] {
  if (!search) return repos;
  const needle = search.toLowerCase();
  return repos.filter(
    (r) =>
      r.fullName.toLowerCase().includes(needle) ||
      (r.description || "").toLowerCase().includes(needle),
  );
}

export async function listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
  validateRepoIdent(owner, repo);
  const auth = requireAuth();
  const branches = await ghFetchAllPages<{ name: string; commit: { sha: string }; protected?: boolean }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    auth.token,
    200,
  );
  // Fetch default branch name so we can flag it. We could also read it from
  // the repo cache if present; cheaper to hit /repos/{owner}/{repo} once.
  const repoRes = await ghFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, auth.token);
  let defaultBranch = "";
  if (repoRes.ok) {
    const data = (await repoRes.json()) as { default_branch?: string };
    defaultBranch = data.default_branch || "";
  }
  return branches.map((b) => ({
    name: b.name,
    commitSha: b.commit.sha,
    isDefault: b.name === defaultBranch,
  }));
}

function requireAuth(): GitHubAuth {
  const auth = getAuth();
  if (!auth || !auth.token) {
    throw new GitHubAuthError("GitHub is not connected. Configure a token in the Secrets tab.", 401);
  }
  return auth;
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

// Repo identifier segments must match GitHub's allowed charset to avoid URL
// injection (e.g. a slash in `owner` could redirect the clone target).
const REPO_IDENT_RE = /^[A-Za-z0-9._-]+$/;

function validateRepoIdent(owner: string, name: string): void {
  if (!REPO_IDENT_RE.test(owner) || !REPO_IDENT_RE.test(name)) {
    throw new Error(`Invalid GitHub repo identifier: ${owner}/${name}`);
  }
}

/**
 * Clone a GitHub repo into destDir using the stored token for auth, then
 * rewrite origin to the un-authed HTTPS URL so the token is not persisted
 * in .git/config. Returns the clean origin URL.
 */
export function cloneRepo(opts: {
  owner: string;
  name: string;
  branch: string;
  destDir: string;
  token?: string;
}): { originUrl: string } {
  const { owner, name, branch, destDir } = opts;
  validateRepoIdent(owner, name);
  const token = opts.token ?? requireAuth().token;

  if (fs.existsSync(destDir)) {
    throw new Error(`Clone destination already exists: ${destDir}`);
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });

  const cleanUrl = `https://github.com/${owner}/${name}.git`;
  const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;

  try {
    execFileSync(
      "git",
      ["clone", "--branch", branch, "--single-branch", authedUrl, destDir],
      { stdio: "pipe", timeout: 300_000 },
    );
  } catch (err: any) {
    const stderr = err?.stderr ? err.stderr.toString() : "";
    // Redact the token if it leaks into error output.
    const redacted = stderr.replace(token, "***");
    throw new Error(`git clone failed: ${redacted || err.message}`);
  }

  // Strip the token from the persisted remote URL.
  execFileSync("git", ["-C", destDir, "remote", "set-url", "origin", cleanUrl], {
    stdio: "pipe",
    timeout: 10_000,
  });

  return { originUrl: cleanUrl };
}

/**
 * Build an authed URL for a one-shot `git push <authedUrl>` call. Callers
 * should not persist this URL or pass it to a subprocess whose logs get
 * surfaced to the user — embed directly in the argv of the push.
 */
export function authedCloneUrl(owner: string, name: string, token: string): string {
  validateRepoIdent(owner, name);
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

/**
 * Parse a GitHub HTTPS remote URL. Returns null for non-github or malformed URLs.
 */
export function parseGitHubRemote(remoteUrl: string): { owner: string; name: string } | null {
  const m = remoteUrl.match(/^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], name: m[2] };
}
