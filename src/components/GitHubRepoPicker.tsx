import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Search, Github, Lock, Star, Building2, User, RefreshCw, AlertTriangle, Loader2, GitBranch } from "lucide-react";
import type { GitHubRepo, GitHubBranch, GitHubRepoSelection } from "../lib/types";
import * as api from "../lib/api";

interface GitHubRepoPickerProps {
  value: GitHubRepoSelection | null;
  onChange: (selection: GitHubRepoSelection | null) => void;
  onNotConnected?: () => void;
}

const KIND_META: Record<GitHubRepo["kind"], { label: string; icon: React.ReactNode; order: number }> = {
  owned: { label: "Owned", icon: <User className="w-3 h-3" />, order: 0 },
  org: { label: "Organization", icon: <Building2 className="w-3 h-3" />, order: 1 },
  starred: { label: "Starred", icon: <Star className="w-3 h-3" />, order: 2 },
};

export function GitHubRepoPicker({ value, onChange, onNotConnected }: GitHubRepoPickerProps) {
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedFullName, setSelectedFullName] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[] | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const loadRepos = useCallback(async (opts?: { refresh?: boolean }) => {
    const isRefresh = !!opts?.refresh;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const rs = await api.listGitHubRepos(undefined, isRefresh);
      setRepos(rs);
    } catch (err: any) {
      setError(err.message);
      if (err.message && /not connected/i.test(err.message)) {
        onNotConnected?.();
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [onNotConnected]);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(needle) ||
        (r.description || "").toLowerCase().includes(needle),
    );
  }, [repos, search]);

  const grouped = useMemo(() => {
    const groups: Record<GitHubRepo["kind"], GitHubRepo[]> = { owned: [], org: [], starred: [] };
    for (const r of filtered) groups[r.kind].push(r);
    return groups;
  }, [filtered]);

  const selectedRepo = useMemo(
    () => repos.find((r) => r.fullName === selectedFullName) || null,
    [repos, selectedFullName],
  );

  // When a repo is selected, fetch its branches and default the selection to
  // the default branch.
  useEffect(() => {
    if (!selectedRepo) {
      setBranches(null);
      setBranchesError(null);
      return;
    }
    let cancelled = false;
    setBranches(null);
    setBranchesLoading(true);
    setBranchesError(null);
    api
      .listGitHubBranches(selectedRepo.owner, selectedRepo.name)
      .then((bs) => {
        if (cancelled) return;
        setBranches(bs);
        const preferred = bs.find((b) => b.isDefault) || bs[0];
        if (preferred) {
          onChange({
            owner: selectedRepo.owner,
            name: selectedRepo.name,
            branch: preferred.name,
          });
        } else {
          onChange(null);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        setBranchesError(err.message);
        onChange(null);
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => { cancelled = true; };
    // onChange intentionally excluded — it's a parent setter and re-running
    // the effect on every parent render would wipe the user's branch pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRepo?.fullName]);

  const handleBranchChange = (branchName: string) => {
    if (!selectedRepo) return;
    onChange({ owner: selectedRepo.owner, name: selectedRepo.name, branch: branchName });
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading GitHub repositories...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-sm bg-red-500/10 border border-red-500/30 rounded text-red-400 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div>{error}</div>
          <button
            type="button"
            onClick={() => loadRepos({ refresh: true })}
            className="mt-2 text-xs text-gray-300 underline hover:text-white"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            className="w-full pl-10 pr-3 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => loadRepos({ refresh: true })}
          disabled={refreshing}
          title="Refresh repository list"
          className="p-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-gray-400 hover:text-white disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      <div
        ref={listRef}
        className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] divide-y divide-[var(--color-border)]/60"
      >
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-sm text-gray-500">
            No repositories match your search.
          </div>
        ) : (
          (Object.keys(grouped) as GitHubRepo["kind"][])
            .filter((k) => grouped[k].length > 0)
            .sort((a, b) => KIND_META[a].order - KIND_META[b].order)
            .map((kind) => (
              <div key={kind}>
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-gray-500 bg-[var(--color-surface-raised)] flex items-center gap-1.5">
                  {KIND_META[kind].icon}
                  {KIND_META[kind].label}
                  <span className="text-gray-600">({grouped[kind].length})</span>
                </div>
                {grouped[kind].map((repo) => {
                  const active = repo.fullName === selectedFullName;
                  return (
                    <button
                      key={repo.fullName}
                      type="button"
                      onClick={() => setSelectedFullName(repo.fullName)}
                      className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
                        active
                          ? "bg-[var(--color-accent-muted)]/20 border-l-2 border-[var(--color-accent)]"
                          : "hover:bg-[var(--color-surface-raised)] border-l-2 border-transparent"
                      }`}
                    >
                      <Github className="w-4 h-4 mt-0.5 text-gray-500 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-sm truncate">{repo.fullName}</span>
                          {repo.isPrivate && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
                        </div>
                        {repo.description && (
                          <div className="text-xs text-gray-500 truncate">{repo.description}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
        )}
      </div>

      {selectedRepo && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <GitBranch className="w-3.5 h-3.5 text-gray-500 shrink-0" />
            <span className="shrink-0">Branch</span>
            {branchesLoading ? (
              <div className="flex items-center gap-1.5 text-gray-500">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading branches...
              </div>
            ) : branchesError ? (
              <span className="text-red-400">{branchesError}</span>
            ) : branches && branches.length > 0 ? (
              <select
                value={value?.branch || ""}
                onChange={(e) => handleBranchChange(e.target.value)}
                className="flex-1 px-2 py-1.5 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none text-gray-300"
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-gray-500">No branches available.</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
