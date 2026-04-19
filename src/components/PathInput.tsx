import { useState, useEffect, useRef, useCallback } from "react";
import { Check, Folder, FolderGit2, FolderOpen } from "lucide-react";
import * as api from "../lib/api";

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function PathInput({ value, onChange, placeholder, className }: PathInputProps) {
  const [suggestions, setSuggestions] = useState<api.FsEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dirIsGit, setDirIsGit] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseEntries, setBrowseEntries] = useState<api.FsEntry[]>([]);
  const [browsePath, setBrowsePath] = useState("~/");
  const [browseLoading, setBrowseLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // When true, skip the next debounced fetch (used after explicit selection)
  const skipNextFetch = useRef(false);

  const fetchSuggestions = useCallback(async (path: string) => {
    if (!path) {
      setSuggestions([]);
      setDirIsGit(false);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const { results, dirIsGit: isGit } = await api.completePath(path);
      setSuggestions(results);
      setDirIsGit(isGit);
      setSelectedIdx(0);
      // If the current directory is a git repo, close the dropdown —
      // the user likely wants this directory, not its children
      if (isGit) {
        setOpen(false);
      } else {
        setOpen(results.length > 0);
      }
    } catch {
      setSuggestions([]);
      setDirIsGit(false);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced fetch on value change
  useEffect(() => {
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    fetchTimer.current = setTimeout(() => fetchSuggestions(value), 100);
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current); };
  }, [value, fetchSuggestions]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const accept = (entry: api.FsEntry) => {
    const newPath = entry.path + "/";
    skipNextFetch.current = true;
    onChange(newPath);
    // Immediately fetch next level
    fetchSuggestions(newPath);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) {
      // Tab with no dropdown: try to complete common prefix
      if (e.key === "Tab") {
        e.preventDefault();
        fetchSuggestions(value);
      }
      // Allow re-opening the dropdown if the path is a git repo and user presses down
      if (e.key === "ArrowDown" && dirIsGit && suggestions.length > 0) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "Tab": {
        e.preventDefault();
        if (suggestions.length === 1) {
          // Single match: accept it
          accept(suggestions[0]);
        } else {
          // Multiple matches: complete to longest common prefix
          const lcp = longestCommonPrefix(suggestions.map((s) => s.path));
          if (lcp.length > value.replace(/\/$/, "").length) {
            skipNextFetch.current = true;
            onChange(lcp);
            fetchSuggestions(lcp);
          } else {
            // Already at LCP — cycle through suggestions
            accept(suggestions[selectedIdx]);
          }
        }
        break;
      }
      case "ArrowDown":
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (open && suggestions.length > 0) {
          e.preventDefault();
          accept(suggestions[selectedIdx]);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
    }
  };

  // --- Browse mode ---
  const fetchBrowseEntries = useCallback(async (dirPath: string) => {
    setBrowseLoading(true);
    try {
      const { results } = await api.completePath(dirPath);
      setBrowseEntries(results);
    } catch {
      setBrowseEntries([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const openBrowser = () => {
    const startPath = value || "~/";
    setBrowsePath(startPath);
    setBrowsing(true);
    fetchBrowseEntries(startPath);
  };

  const navigateTo = (dirPath: string) => {
    const newPath = dirPath + "/";
    setBrowsePath(newPath);
    fetchBrowseEntries(newPath);
  };

  const navigateUp = () => {
    // Go up one directory
    const trimmed = browsePath.replace(/\/+$/, "");
    const parent = trimmed.substring(0, trimmed.lastIndexOf("/") + 1) || "/";
    setBrowsePath(parent);
    fetchBrowseEntries(parent);
  };

  const selectBrowsePath = (entry: api.FsEntry) => {
    skipNextFetch.current = true;
    onChange(entry.path + "/");
    setDirIsGit(true);
    setBrowsing(false);
    setOpen(false);
    setSuggestions([]);
  };

  return (
    <div className="relative">
      <FolderGit2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 z-10" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0 && !dirIsGit) setOpen(true); }}
        onBlur={() => {
          // Delay so click on suggestion registers
          setTimeout(() => setOpen(false), 150);
        }}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={className}
        style={dirIsGit ? { paddingRight: "6rem" } : undefined}
      />
      {/* Git repo confirmed badge */}
      {dirIsGit && value && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-500/15 border border-green-500/30">
          <Check className="w-3.5 h-3.5 text-green-400" />
          <span className="text-[10px] font-medium text-green-400">Git repo</span>
        </div>
      )}
      {!dirIsGit && (
        <button
          type="button"
          onClick={openBrowser}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-[var(--color-surface-raised)] transition-colors"
          title="Browse folders"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      )}
      {loading && !dirIsGit && (
        <div className="absolute right-9 top-1/2 -translate-y-1/2">
          <div className="w-3 h-3 border border-gray-500 border-t-gray-300 rounded-full animate-spin" />
        </div>
      )}

      {open && suggestions.length > 0 && !browsing && (
        <div
          ref={listRef}
          className="absolute left-0 right-0 top-full mt-1 max-h-56 overflow-auto bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-lg shadow-xl z-50"
        >
          {suggestions.map((entry, i) => (
            <button
              key={entry.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                accept(entry);
              }}
              onMouseEnter={() => setSelectedIdx(i)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                i === selectedIdx
                  ? "bg-[var(--color-accent-muted)] text-white"
                  : "text-gray-300 hover:bg-[var(--color-surface-raised)]"
              }`}
            >
              {entry.isGit ? (
                <FolderGit2 className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-gray-500 shrink-0" />
              )}
              <span className="font-mono truncate">
                {entry.name}
                {entry.isDir && "/"}
              </span>
              {entry.isGit && (
                <span className="ml-auto text-[10px] text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 rounded shrink-0">
                  git
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Folder browser modal */}
      {browsing && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-[var(--color-surface-overlay)] border border-[var(--color-border)] rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <button
              type="button"
              onClick={navigateUp}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-[var(--color-surface-raised)] transition-colors text-xs font-medium"
              title="Go up"
            >
              ↑ Up
            </button>
            <span className="text-xs font-mono text-gray-400 truncate flex-1">{browsePath}</span>
            <button
              type="button"
              onClick={() => setBrowsing(false)}
              className="text-xs text-gray-500 hover:text-white transition-colors"
            >
              ✕
            </button>
          </div>

          {/* Entries */}
          <div className="max-h-64 overflow-auto">
            {browseLoading ? (
              <div className="flex items-center justify-center py-6">
                <div className="w-4 h-4 border-2 border-gray-500 border-t-gray-300 rounded-full animate-spin" />
              </div>
            ) : browseEntries.length === 0 ? (
              <div className="text-center py-6 text-xs text-gray-500">No subdirectories</div>
            ) : (
              browseEntries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:bg-[var(--color-surface-raised)] transition-colors group"
                >
                  <button
                    type="button"
                    onClick={() => navigateTo(entry.path)}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    {entry.isGit ? (
                      <FolderGit2 className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                    ) : (
                      <Folder className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    )}
                    <span className="font-mono truncate">
                      {entry.name}/
                    </span>
                    {entry.isGit && (
                      <span className="text-[10px] text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 rounded shrink-0">
                        git
                      </span>
                    )}
                  </button>
                  {entry.isGit && (
                    <button
                      type="button"
                      onClick={() => selectBrowsePath(entry)}
                      className="text-[10px] font-medium px-2 py-1 rounded bg-[var(--color-accent-muted)] text-white hover:bg-[var(--color-accent)] transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                    >
                      Select
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}
