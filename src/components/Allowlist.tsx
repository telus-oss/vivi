import { useState, useEffect, useCallback } from "react";
import { Globe, Plus, Trash2, ShieldOff, ShieldCheck, Pencil, Check, X } from "lucide-react";
import type { AllowlistConfig } from "../lib/types";
import * as api from "../lib/api";

export function Allowlist() {
  const [config, setConfig] = useState<AllowlistConfig | null>(null);
  const [netInput, setNetInput] = useState({ pattern: "", description: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ pattern: "", description: "" });

  const refresh = useCallback(async () => {
    setConfig(await api.getAllowlist());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (!config) return null;

  const addNet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!netInput.pattern.trim()) return;
    await api.addNetworkRule(netInput.pattern.trim(), netInput.description.trim() || undefined);
    setNetInput({ pattern: "", description: "" });
    refresh();
  };

  const toggleEnabled = async () => {
    await api.setAllowlistEnabled(!config.enabled);
    refresh();
  };

  const startEdit = (rule: { id: string; pattern: string; description?: string }) => {
    setEditingId(rule.id);
    setEditValues({ pattern: rule.pattern, description: rule.description || "" });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues({ pattern: "", description: "" });
  };

  const saveEdit = async () => {
    if (!editingId || !editValues.pattern.trim()) return;
    await api.updateNetworkRule(editingId, editValues.pattern.trim(), editValues.description.trim() || undefined);
    setEditingId(null);
    setEditValues({ pattern: "", description: "" });
    refresh();
  };

  return (
    <div className="space-y-6">
      {/* Master toggle */}
      <div
        className={`flex items-center justify-between p-3 rounded-lg border ${
          config.enabled
            ? "bg-green-500/5 border-green-500/20"
            : "bg-yellow-500/5 border-yellow-500/20"
        }`}
      >
        <div className="flex items-center gap-2">
          {config.enabled ? (
            <ShieldCheck className="w-5 h-5 text-[var(--color-success)]" />
          ) : (
            <ShieldOff className="w-5 h-5 text-[var(--color-warning)]" />
          )}
          <div>
            <p className="text-sm font-medium">
              {config.enabled ? "Network filtering active" : "Network filtering disabled"}
            </p>
            <p className="text-xs text-gray-500">
              {config.enabled
                ? "Only allowlisted hosts are reachable from the sandbox."
                : "All outbound traffic is permitted. The sandbox can reach any host."}
            </p>
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            config.enabled
              ? "bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25"
              : "bg-green-500/15 text-green-400 hover:bg-green-500/25"
          }`}
        >
          {config.enabled ? "Disable" : "Enable"}
        </button>
      </div>

      {/* Network allowlist */}
      <section className={`space-y-3 ${!config.enabled ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="flex items-center gap-2">
          <Globe className="w-5 h-5 text-[var(--color-accent)]" />
          <h2 className="text-lg font-semibold">Network Allowlist</h2>
        </div>
        <p className="text-sm text-gray-400">
          Hosts the sandbox can reach via httpjail. Use <code>*.example.com</code> for wildcard matching.
        </p>

        <form onSubmit={addNet} className="flex gap-2">
          <input
            value={netInput.pattern}
            onChange={(e) => setNetInput({ ...netInput, pattern: e.target.value })}
            placeholder="*.example.com"
            className="flex-1 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            value={netInput.description}
            onChange={(e) => setNetInput({ ...netInput, description: e.target.value })}
            placeholder="Description (optional)"
            className="flex-1 px-3 py-2 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <button
            type="submit"
            className="px-3 py-2 bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded text-sm transition-colors"
          >
            <Plus className="w-4 h-4" />
          </button>
        </form>

        <div className="space-y-1">
          {config.network.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center justify-between px-3 py-2 bg-[var(--color-surface-raised)] rounded border border-[var(--color-border)]"
            >
              {editingId === rule.id ? (
                <>
                  <div className="flex items-center gap-2 flex-1 mr-2">
                    <input
                      value={editValues.pattern}
                      onChange={(e) => setEditValues({ ...editValues, pattern: e.target.value })}
                      className="flex-1 px-2 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none"
                      placeholder="Pattern"
                    />
                    <input
                      value={editValues.description}
                      onChange={(e) => setEditValues({ ...editValues, description: e.target.value })}
                      className="flex-1 px-2 py-1 bg-[var(--color-surface)] border border-[var(--color-border)] rounded text-sm focus:border-[var(--color-accent)] focus:outline-none"
                      placeholder="Description (optional)"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={saveEdit}
                      className="p-1 text-green-400 hover:text-green-300 transition-colors"
                      aria-label="Save"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
                      aria-label="Cancel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <code className="text-sm text-[var(--color-accent)] font-mono">{rule.pattern}</code>
                    {rule.description && <span className="text-xs text-gray-500">{rule.description}</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => startEdit(rule)}
                      className="p-1 text-gray-500 hover:text-blue-400 transition-colors"
                      aria-label="Edit"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => { api.removeNetworkRule(rule.id); refresh(); }}
                      className="p-1 text-gray-500 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
