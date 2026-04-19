import { useState, useRef, useEffect } from "react";
import { Server, Plus, Trash2, Check, X, Loader2, Pencil, Wifi, WifiOff } from "lucide-react";
import { useBackend } from "../lib/BackendContext";
import { testBackendConnection } from "../lib/backend";

export function BackendSwitcher() {
  const { activeBackend, backends, switchBackend, addBackend, removeBackend, updateBackend } = useBackend();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setEditing(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await testBackendConnection(url);
    setTestResult(ok);
    setTesting(false);
  };

  const handleAdd = () => {
    if (!name.trim() || !url.trim()) return;
    addBackend(name.trim(), url.trim());
    setName("");
    setUrl("");
    setAdding(false);
    setTestResult(null);
  };

  const handleSaveEdit = (id: string) => {
    if (!name.trim() || !url.trim()) return;
    updateBackend(id, { name: name.trim(), url: url.trim() });
    setEditing(null);
    setName("");
    setUrl("");
  };

  const startEdit = (backend: { id: string; name: string; url: string }) => {
    setEditing(backend.id);
    setName(backend.name);
    setUrl(backend.url);
    setAdding(false);
  };

  const label = activeBackend ? activeBackend.name : "Local";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors hover:bg-[var(--color-border)] text-gray-400 hover:text-gray-200"
        title="Switch backend server"
      >
        <Server className="w-3.5 h-3.5" />
        <span className="max-w-[100px] truncate">{label}</span>
        <div className={`w-1.5 h-1.5 rounded-full ${activeBackend ? "bg-blue-400" : "bg-green-400"}`} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-80 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg shadow-xl overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--color-border)] text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Backend Servers
          </div>

          {/* Local (same-origin) option */}
          <button
            onClick={() => { if (activeBackend) switchBackend(null); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface)] ${!activeBackend ? "bg-[var(--color-surface)]" : ""}`}
          >
            <div className={`w-2 h-2 rounded-full ${!activeBackend ? "bg-green-400" : "bg-gray-600"}`} />
            <div className="flex-1 text-left">
              <div className="font-medium text-gray-200">Local</div>
              <div className="text-xs text-gray-500">Same-origin server</div>
            </div>
            {!activeBackend && <Check className="w-4 h-4 text-green-400" />}
          </button>

          {/* Saved backends */}
          {backends.map((b) => (
            <div key={b.id} className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-[var(--color-surface)] ${b.isActive ? "bg-[var(--color-surface)]" : ""}`}>
              {editing === b.id ? (
                <div className="flex-1 space-y-2">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="w-full px-2 py-1 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded outline-none focus:border-[var(--color-accent)]" />
                  <input value={url} onChange={(e) => { setUrl(e.target.value); setTestResult(null); }} placeholder="https://your-server.com" className="w-full px-2 py-1 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded outline-none focus:border-[var(--color-accent)] font-mono" />
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => handleSaveEdit(b.id)} className="px-2 py-0.5 text-xs bg-[var(--color-accent)] text-white rounded hover:bg-[var(--color-accent)]/80">Save</button>
                    <button onClick={() => { setEditing(null); setName(""); setUrl(""); }} className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <button onClick={() => { if (!b.isActive) switchBackend(b.id); }} className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${b.isActive ? "bg-blue-400" : "bg-gray-600"}`} />
                    <div className="flex-1 text-left min-w-0">
                      <div className="font-medium text-gray-200 truncate">{b.name}</div>
                      <div className="text-xs text-gray-500 truncate font-mono">{b.url}</div>
                    </div>
                  </button>
                  {b.isActive && <Check className="w-4 h-4 text-blue-400 shrink-0" />}
                  <button onClick={() => startEdit(b)} className="p-1 text-gray-500 hover:text-gray-300 transition-colors shrink-0" title="Edit"><Pencil className="w-3 h-3" /></button>
                  <button onClick={() => { removeBackend(b.id); if (b.isActive) switchBackend(null); }} className="p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0" title="Remove"><Trash2 className="w-3 h-3" /></button>
                </>
              )}
            </div>
          ))}

          {/* Add form */}
          {adding ? (
            <div className="px-3 py-3 border-t border-[var(--color-border)] space-y-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Server name"
                className="w-full px-2 py-1.5 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded outline-none focus:border-[var(--color-accent)]"
              />
              <input
                value={url}
                onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
                placeholder="https://your-server.com"
                className="w-full px-2 py-1.5 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded outline-none focus:border-[var(--color-accent)] font-mono"
              />
              <div className="flex items-center gap-2">
                <button onClick={handleTest} disabled={testing || !url.trim()} className="flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-40">
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : testResult === true ? <Wifi className="w-3 h-3 text-green-400" /> : testResult === false ? <WifiOff className="w-3 h-3 text-red-400" /> : <Wifi className="w-3 h-3" />}
                  Test
                </button>
                <button onClick={handleAdd} disabled={!name.trim() || !url.trim()} className="px-2 py-1 text-xs bg-[var(--color-accent)] text-white rounded hover:bg-[var(--color-accent)]/80 disabled:opacity-40">Add</button>
                <button onClick={() => { setAdding(false); setName(""); setUrl(""); setTestResult(null); }} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
              </div>
              {testResult === true && <p className="text-xs text-green-400">Connected successfully</p>}
              {testResult === false && <p className="text-xs text-red-400">Connection failed — check URL and ensure CORS is enabled</p>}
            </div>
          ) : (
            <button
              onClick={() => { setAdding(true); setName(""); setUrl(""); setTestResult(null); setEditing(null); }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-gray-400 hover:text-gray-200 hover:bg-[var(--color-surface)] transition-colors border-t border-[var(--color-border)]"
            >
              <Plus className="w-3.5 h-3.5" />
              Add backend server
            </button>
          )}
        </div>
      )}
    </div>
  );
}
