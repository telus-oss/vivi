/**
 * GitHub Issues integration — fetches open issues for a repo using the gh CLI.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export interface IssuesResult {
  issues: GitHubIssue[];
  repoOwner: string;
  repoName: string;
  error?: string;
}

function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } | null {
  // Matches:
  //   https://github.com/owner/repo.git
  //   git@github.com:owner/repo.git
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

function resolveSafeRepoPath(repoPath: string): string | null {
  // crazyclaude is a local dev tool and repoPath is typed by the user in the
  // UI, so we don't sandbox it to process.cwd() (that broke the common case
  // of pointing at a repo outside the server's working directory). We just
  // need to confirm the path resolves to an existing directory — any deeper
  // "is this a git repo" check is left to the git remote call below, which
  // reports a clean error.
  if (!repoPath) return null;
  const resolved = path.resolve(repoPath);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch (err: any) {
    if (err.code !== "ENOENT" && err.code !== "ENOTDIR") {
      console.warn(`[github-issues] stat failed for ${resolved}: ${err.message}`);
    }
    return null;
  }
  return resolved;
}

export function fetchGitHubIssues(repoPath: string): IssuesResult {
  const safeRepoPath = resolveSafeRepoPath(repoPath);
  if (!safeRepoPath) {
    return {
      issues: [],
      repoOwner: "",
      repoName: "",
      error: "Invalid repoPath",
    };
  }
  // Resolve git remote
  let remoteUrl = "";
  try {
    remoteUrl = execSync("git remote get-url origin", {
      cwd: safeRepoPath,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch {
    return {
      issues: [],
      repoOwner: "",
      repoName: "",
      error: "No git remote found — cannot determine GitHub repository",
    };
  }

  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    return {
      issues: [],
      repoOwner: "",
      repoName: "",
      error: "Not a GitHub repository (remote URL does not match github.com)",
    };
  }

  try {
    const output = execSync(
      `gh issue list --repo ${parsed.owner}/${parsed.repo} --state open --limit 100 --json number,title,body,state,labels,url,author,createdAt`,
      { encoding: "utf-8", timeout: 15_000 },
    );
    const raw: any[] = JSON.parse(output);
    const issues: GitHubIssue[] = raw.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body || "",
      state: i.state,
      labels: (i.labels ?? []).map((l: any) => l.name as string),
      url: i.url,
      author: i.author?.login ?? "",
      createdAt: i.createdAt,
    }));
    return { issues, repoOwner: parsed.owner, repoName: parsed.repo };
  } catch (err: any) {
    return {
      issues: [],
      repoOwner: parsed.owner,
      repoName: parsed.repo,
      error: `Failed to fetch issues: ${err.message}`,
    };
  }
}

/**
 * Build a task description string from an ordered list of issues.
 * This gets written to CLAUDE.md inside the sandbox so Claude knows what to work on.
 */
export function buildTaskDescription(issues: GitHubIssue[]): string {
  if (issues.length === 0) return "";

  if (issues.length === 1) {
    const issue = issues[0];
    return `Please implement the following GitHub issue:\n\n## #${issue.number} — ${issue.title}\n\n${issue.body || "(no description provided)"}`;
  }

  const lines: string[] = [
    "Please implement the following GitHub issues. Implement them **one at a time in the order listed**, creating a PR with `gh pr create` after completing each issue before starting the next. This prevents merge conflicts between implementations.",
    "",
  ];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    lines.push(`## Issue ${i + 1} of ${issues.length}: #${issue.number} — ${issue.title}`);
    lines.push("");
    lines.push(issue.body || "(no description provided)");
    lines.push("");
  }

  return lines.join("\n");
}
