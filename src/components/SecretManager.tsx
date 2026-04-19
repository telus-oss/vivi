import { useState, useEffect, useCallback } from "react";
import { KeyRound, Plus, Trash2, Eye, EyeOff, Shield, LogIn, Bell, X, Pencil } from "lucide-react";
import type { SecretPublic, SecretRequest } from "../lib/types";
import * as api from "../lib/api";

interface SecretManagerProps {
  onLoginStart?: () => void;
  refreshKey?: number;
  pendingRequests?: SecretRequest[];
  onDismissRequest?: (id: string) => void;
}

export function SecretManager({ onLoginStart, refreshKey, pendingRequests = [], onDismissRequest }: SecretManagerProps) {
  const [secrets, setSecrets] = useState<SecretPublic[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    key: "",
    baseUrl: "https://api.anthropic.com",
    headerName: "x-api-key",
  });
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    envVar: "",
    key: "",
    baseUrl: "",
    headerName: "",
  });

  const refresh = useCallback(async () => {
    try {
      setSecrets(await api.listSecrets());
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addSecret(form);
      setForm({ name: "", envVar: "CLAUDE_CODE_OAUTH_TOKEN", key: "", baseUrl: "https://api.anthropic.com", headerName: "x-api-key" });
      setShowForm(false);
      setShowKey(false);
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await api.removeSecret(id);
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleStartEdit = (s: SecretPublic) => {
    setEditingId(s.id);
    setEditForm({
      name: s.name,
      envVar: s.envVar,
      key: "",
      baseUrl: s.baseUrl,
      headerName: s.headerName,
    });
    setShowForm(false);
    setError(null);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.updateSecret(editingId!, editForm);
      setEditingId(null);
      refresh();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const hasAnthropic = secrets.some((s) => s.envVar === "CLAUDE_CODE_OAUTH_TOKEN");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[var(--color-accent)]" />
          <h2 className="text-lg font-semibold">Secrets</h2>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Secret
        </button>
      </div>

      <p className="text-sm text-gray-400">
        Register API keys here. Claude gets a dummy key + a reverse-proxy base URL.
        The real key is injected by the proxy only when the request targets the correct API.
      </p>

      {error && (
        <div className="px-3 py-2 text-sm bg-red-500/10 border border-red-500/30 rounded text-red-400">
          {error}
        </div>
      )}

      {/* Pending secret requests from sandbox */}
      {pendingRequests.length > 0 && (
        <div className="space-y-2">
          {pendingRequests.map((req) => (
            <div
              key={req.id}
              className="p-4 bg-orange-500/5 rounded-lg border border-orange-500/20 animate-pulse"
            >
              <div className="flex items-start gap-3">
                <Bell className="w-5 h-5 text-orange-400 mt-0.5 shrink-0" />
                <div className="space-y-2 flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-orange-300">Secret Requested: {req.name}</p>
                    {onDismissRequest && (
                      <button
                        onClick={() => onDismissRequest(req.id)}
                        className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                        title="Dismiss"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-400">
                    Claude is requesting an API key for <strong>{req.name}</strong> (env: <code className="px-1 py-0.5 bg-[var(--color-surface)] rounded">{req.envVar}</code>).
                  </p>
                  <button
                    onClick={() => {
                      setForm({
                        name: req.name,
                        envVar: req.envVar,
                        key: "",
                        baseUrl: req.baseUrl,
                        headerName: req.headerName,
                      });
                      setShowForm(true);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 rounded transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add This Secret
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Claude token setup */}
      {!hasAnthropic && !showForm && (
        <div className="p-4 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-accent-muted)]/30">
          <div className="flex items-start gap-3">
            <LogIn className="w-5 h-5 text-[var(--color-accent)] mt-0.5 shrink-0" />
            <div className="space-y-2 flex-1">
              <p className="text-sm font-medium">Login with Claude</p>
              <p className="text-xs text-gray-400">
                Run the interactive <code className="px-1 py-0.5 bg-[var(--color-surface)] rounded">claude setup-token</code> flow.
                Your token is routed through the secure proxy — it never enters the sandbox.
              </p>
              <button
                onClick={onLoginStart}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded transition-colors"
              >
                <LogIn className="w-3.5 h-3.5" />
                Set Up Token
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-3 p-4 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-border)]">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Anthropic"
                required
                className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">Env Variable</span>
              <input
                value={form.envVar}
                onChange={(e) => setForm({ ...form, envVar: e.target.value })}
                placeholder="CLAUDE_CODE_OAUTH_TOKEN"
                required
                className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">API Key</span>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="sk-ant-..."
                required
                className="w-full px-3 py-2 pr-10 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">Base URL</span>
              <input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="https://api.anthropic.com"
                required
                className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-400 mb-1 block">Header</span>
              <select
                value={form.headerName}
                onChange={(e) => setForm({ ...form, headerName: e.target.value })}
                className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
              >
                <option value="x-api-key">x-api-key (Anthropic)</option>
                <option value="authorization">Authorization: Bearer (OpenAI)</option>
              </select>
            </label>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="px-4 py-2 text-sm bg-[var(--color-success)] hover:bg-green-600 text-white rounded transition-colors"
            >
              Save Secret
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-sm bg-[var(--color-surface)] border border-[var(--color-border)] rounded hover:bg-[var(--color-surface-overlay)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {secrets.length === 0 && !showForm && (
        <div className="py-8 text-center text-gray-500 text-sm border border-dashed border-[var(--color-border)] rounded-lg">
          <KeyRound className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No secrets registered. Set up your Claude token or add a key manually.
        </div>
      )}

      <div className="space-y-2">
        {secrets.map((s) => (
          editingId === s.id ? (
            <form
              key={s.id}
              onSubmit={handleEditSubmit}
              className="space-y-3 p-4 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-accent-muted)]"
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Name</span>
                  <input
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    placeholder="e.g. Anthropic"
                    required
                    className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Env Variable</span>
                  <input
                    value={editForm.envVar}
                    onChange={(e) => setEditForm({ ...editForm, envVar: e.target.value })}
                    placeholder="CLAUDE_CODE_OAUTH_TOKEN"
                    required
                    className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs text-gray-400 mb-1 block">API Key (leave empty to keep current)</span>
                <input
                  type="password"
                  value={editForm.key}
                  onChange={(e) => setEditForm({ ...editForm, key: e.target.value })}
                  placeholder="Leave empty to keep current key"
                  className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Base URL</span>
                  <input
                    value={editForm.baseUrl}
                    onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                    placeholder="https://api.anthropic.com"
                    required
                    className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-gray-400 mb-1 block">Header</span>
                  <select
                    value={editForm.headerName}
                    onChange={(e) => setEditForm({ ...editForm, headerName: e.target.value })}
                    className="w-full px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    <option value="x-api-key">x-api-key (Anthropic)</option>
                    <option value="authorization">Authorization: Bearer (OpenAI)</option>
                  </select>
                </label>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  className="px-4 py-2 text-sm bg-[var(--color-success)] hover:bg-green-600 text-white rounded transition-colors"
                >
                  Save Changes
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="px-4 py-2 text-sm bg-[var(--color-surface)] border border-[var(--color-border)] rounded hover:bg-[var(--color-surface-overlay)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div
              key={s.id}
              className="flex items-center justify-between p-3 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-border)]"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[var(--color-accent)]" />
                  <span className="font-medium text-sm">{s.name}</span>
                  <code className="text-xs text-gray-500 bg-[var(--color-surface)] px-1.5 py-0.5 rounded">
                    {s.envVar}
                  </code>
                </div>
                <div className="text-xs text-gray-500 font-mono">
                  Proxy intercepts {s.sandboxBaseUrl} — real key injected via MITM
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => handleStartEdit(s)}
                  className="p-1.5 text-gray-500 hover:text-[var(--color-accent)] transition-colors"
                  title="Edit secret"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleRemove(s.id)}
                  className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          )
        ))}
      </div>
    </div>
  );
}
