import { useState, useEffect, useCallback } from "react";
import { Github, CheckCircle2, AlertTriangle, Eye, EyeOff, Trash2, ExternalLink } from "lucide-react";
import type { GitHubAuthStatus } from "../lib/types";
import * as api from "../lib/api";

interface GitHubSettingsProps {
  onStatusChange?: (status: GitHubAuthStatus) => void;
}

const REQUIRED_SCOPES = ["repo"];

export function GitHubSettings({ onStatusChange }: GitHubSettingsProps) {
  const [status, setStatus] = useState<GitHubAuthStatus | null>(null);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getGitHubStatus();
      setStatus(s);
      onStatusChange?.(s);
    } catch (err: any) {
      setError(err.message);
    }
  }, [onStatusChange]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const s = await api.saveGitHubToken(token.trim());
      setStatus(s);
      onStatusChange?.(s);
      setToken("");
      setShowToken(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    setError(null);
    try {
      await api.clearGitHubToken();
      await refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const missingScopes = status?.configured
    ? REQUIRED_SCOPES.filter((s) => !(status.scopes || []).some((x) => x === s || x.startsWith(`${s}:`)))
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Github className="w-5 h-5 text-[var(--color-accent)]" />
        <h2 className="text-lg font-semibold">GitHub</h2>
      </div>

      <p className="text-sm text-gray-400">
        Connect a Personal Access Token so Vivi can list your GitHub repositories and clone them
        directly into a session. The token stays on the host &mdash; it is never passed into the
        sandbox. Vivi also uses it to push branches and open PRs when you approve one from the
        intercepted PR flow.
      </p>

      {error && (
        <div className="px-3 py-2 text-sm bg-red-500/10 border border-red-500/30 rounded text-red-400 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {status?.configured ? (
        <div className="space-y-3">
          <div className="px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Connected as <span className="font-mono">@{status.login}</span></div>
              <div className="text-xs text-gray-500 truncate">
                Scopes: {(status.scopes || []).length === 0 ? "(fine-grained token)" : (status.scopes || []).join(", ")}
              </div>
            </div>
            <button
              onClick={handleDisconnect}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" /> Disconnect
            </button>
          </div>
          {missingScopes.length > 0 && (
            <div className="px-3 py-2 text-xs bg-amber-500/10 border border-amber-500/30 rounded text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Missing scope(s): <strong>{missingScopes.join(", ")}</strong>. Classic tokens need
                the <code>repo</code> scope to clone private repos and push branches. For fine-grained
                tokens, make sure the token grants Contents and Pull requests read/write.
              </span>
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSave} className="space-y-3">
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">Personal Access Token</span>
            <div className="relative">
              <input
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="ghp_... or github_pat_..."
                className="w-full pl-3 pr-9 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-500 hover:text-gray-300"
              >
                {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={saving || !token.trim()}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white rounded transition-colors"
            >
              {saving ? "Connecting..." : "Connect"}
            </button>
            <a
              href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=vivi"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 px-2 py-2 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              Create a token <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <p className="text-xs text-gray-500">
            Classic token: check the <code>repo</code> scope (and <code>read:org</code> if you want
            to see org repos). Fine-grained token: grant Contents and Pull requests (read &amp; write)
            on the repos you want to use.
          </p>
        </form>
      )}
    </div>
  );
}
