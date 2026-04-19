import { useState, useEffect, useCallback } from "react";
import { UserCircle, Plus, Trash2 } from "lucide-react";
import type { Profile } from "../lib/types";
import * as api from "../lib/api";

export function ProfileManager() {
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProfileList(await api.listProfiles());
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createProfile({ name: form.name.trim(), description: form.description.trim() || undefined });
      setForm({ name: "", description: "" });
      setShowForm(false);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    try {
      await api.deleteProfile(id);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleToggleAutoSave = async (profile: Profile) => {
    try {
      await api.updateProfile(profile.id, { autoSave: !profile.autoSave });
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCircle className="w-4 h-4 text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold">Claude Profiles</h2>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>
      </div>

      <p className="text-xs text-gray-400">
        Profiles persist <code className="font-mono">~/.claude</code> across sessions — Claude settings, commands, and history.
      </p>

      {error && (
        <div className="px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">{error}</div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-2 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
          <input
            autoFocus
            required
            placeholder="Profile name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-1.5 text-sm bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-1.5 text-sm bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none"
          />
          <div className="flex gap-2">
            <button type="submit" className="px-3 py-1 text-xs bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded transition-colors">
              Create
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {profileList.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-6">No profiles yet. Create one to persist Claude state between sessions.</p>
      ) : (
        <div className="space-y-1.5">
          {profileList.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
              <UserCircle className="w-4 h-4 text-gray-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                {p.description && <div className="text-xs text-gray-400 truncate">{p.description}</div>}
                {p.lastUsedAt && <div className="text-xs text-gray-500">Last used {new Date(p.lastUsedAt).toLocaleDateString()}</div>}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer shrink-0" title="Auto-save ~/.claude on session stop">
                <input
                  type="checkbox"
                  checked={p.autoSave}
                  onChange={() => handleToggleAutoSave(p)}
                  className="accent-[var(--color-accent)]"
                />
                auto-save
              </label>
              <button
                onClick={() => handleDelete(p.id)}
                className="p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                title="Delete profile"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
