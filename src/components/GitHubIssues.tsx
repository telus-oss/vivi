import { useState, useEffect, useCallback } from "react";
import { Github, RefreshCw, ChevronUp, ChevronDown, CheckSquare, Square, AlertCircle, Tag, ExternalLink } from "lucide-react";
import type { GitHubIssue, GitHubIssuesResult } from "../lib/types";
import * as api from "../lib/api";

interface GitHubIssuesProps {
  repoPath: string;
  onTaskDescriptionChange: (description: string) => void;
}

/** Build a task description for Claude from an ordered list of selected issues. */
function buildTaskDescription(issues: GitHubIssue[]): string {
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

export function GitHubIssues({ repoPath, onTaskDescriptionChange }: GitHubIssuesProps) {
  const [result, setResult] = useState<GitHubIssuesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedNumbers, setSelectedNumbers] = useState<Set<number>>(new Set());
  // Ordered list of selected issue numbers (for multi-issue plan)
  const [orderedSelected, setOrderedSelected] = useState<number[]>([]);

  // Reset on repo path change
  useEffect(() => {
    setResult(null);
    setSelectedNumbers(new Set());
    setOrderedSelected([]);
    onTaskDescriptionChange("");
  }, [repoPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep task description in sync with selection
  useEffect(() => {
    if (!result) return;
    const issues = orderedSelected
      .map((n) => result.issues.find((i) => i.number === n))
      .filter(Boolean) as GitHubIssue[];
    onTaskDescriptionChange(buildTaskDescription(issues));
  }, [orderedSelected, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadIssues = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    setSelectedNumbers(new Set());
    setOrderedSelected([]);
    try {
      const data = await api.getGitHubIssues(repoPath);
      setResult(data);
    } catch (err: any) {
      setResult({ issues: [], repoOwner: "", repoName: "", error: err.message });
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  const toggleIssue = (number: number) => {
    setSelectedNumbers((prev) => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
    setOrderedSelected((o) => (o.includes(number) ? o.filter((n) => n !== number) : [...o, number]));
  };

  const moveIssue = (index: number, direction: -1 | 1) => {
    setOrderedSelected((prev) => {
      const next = [...prev];
      const swapIdx = index + direction;
      if (swapIdx < 0 || swapIdx >= next.length) return prev;
      [next[index], next[swapIdx]] = [next[swapIdx], next[index]];
      return next;
    });
  };

  if (!repoPath) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Github className="w-4 h-4 text-gray-400" />
          <span className="text-xs font-medium text-gray-400">GitHub Issues</span>
          {result && !result.error && (
            <span className="text-xs text-gray-500">
              {result.repoOwner}/{result.repoName}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={loadIssues}
          disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] text-gray-400 hover:text-gray-200 hover:border-gray-500 rounded transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          {result ? "Refresh" : "Load Issues"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-3 text-xs text-gray-500">
          <RefreshCw className="w-3 h-3 animate-spin" />
          Fetching open issues...
        </div>
      )}

      {result?.error && (
        <div className="flex items-start gap-2 px-3 py-2 text-xs bg-yellow-500/10 border border-yellow-500/30 rounded text-yellow-400">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{result.error}</span>
        </div>
      )}

      {result && !result.error && result.issues.length === 0 && (
        <p className="text-xs text-gray-500 py-2 text-center">No open issues found.</p>
      )}

      {result && !result.error && result.issues.length > 0 && (
        <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
          {result.issues.map((issue) => {
            const isSelected = selectedNumbers.has(issue.number);
            return (
              <button
                key={issue.number}
                type="button"
                onClick={() => toggleIssue(issue.number)}
                className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-colors ${
                  isSelected
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]/20 text-white"
                    : "border-[var(--color-border)] bg-[var(--color-surface)] text-gray-400 hover:text-gray-200 hover:border-gray-600"
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {isSelected ? (
                    <CheckSquare className="w-3.5 h-3.5 text-[var(--color-accent)]" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-gray-500 font-mono">#{issue.number}</span>
                    <span className="font-medium truncate">{issue.title}</span>
                  </div>
                  {issue.labels.length > 0 && (
                    <div className="flex items-center gap-1 mt-1 flex-wrap">
                      <Tag className="w-2.5 h-2.5 text-gray-600" />
                      {issue.labels.map((label) => (
                        <span
                          key={label}
                          className="px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--color-border)] text-gray-400"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 mt-0.5 text-gray-600 hover:text-gray-400 transition-colors"
                  title="Open on GitHub"
                >
                  <ExternalLink className="w-3 h-3" />
                </a>
              </button>
            );
          })}
        </div>
      )}

      {/* Multi-issue order (compact — titles already visible in the list above) */}
      {orderedSelected.length > 1 && result && (
        <div className="space-y-2 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
          <p className="text-xs font-medium text-gray-300">Implementation Order</p>
          <p className="text-xs text-gray-500">
            Claude will implement these in order, creating a PR after each to avoid merge conflicts.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {orderedSelected.map((num, idx) => (
              <div
                key={num}
                className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-surface-raised)] border border-[var(--color-border)]"
              >
                <span className="text-xs text-gray-500 font-mono">{idx + 1}.</span>
                <span className="text-xs text-gray-200 font-mono">#{num}</span>
                <button
                  type="button"
                  onClick={() => moveIssue(idx, -1)}
                  disabled={idx === 0}
                  className="p-0.5 text-gray-600 hover:text-gray-300 disabled:opacity-20 transition-colors"
                  title="Move up"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => moveIssue(idx, 1)}
                  disabled={idx === orderedSelected.length - 1}
                  className="p-0.5 text-gray-600 hover:text-gray-300 disabled:opacity-20 transition-colors"
                  title="Move down"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {orderedSelected.length === 1 && result && (
        <p className="text-xs text-gray-500 px-1">
          1 issue selected — Claude will implement it when the session starts.
        </p>
      )}
    </div>
  );
}
