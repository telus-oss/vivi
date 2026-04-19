import { useState, useEffect, useRef, useCallback } from "react";
import { ScrollText, RefreshCw, Copy, Check, ArrowDownToLine, X } from "lucide-react";
import * as api from "../lib/api";
import type { LogSource } from "../lib/api";

interface SandboxLogsProps {
  sessionId: string;
}

export function SandboxLogs({ sessionId }: SandboxLogsProps) {
  const [logs, setLogs] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tail, setTail] = useState(200);
  const [source, setSource] = useState<LogSource>("sandbox");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinBottom, setPinBottom] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getSessionLogs(sessionId, tail, source);
      setLogs(data.logs);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId, tail, source]);

  // Fetch on mount and every 15 seconds
  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 15000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  // Auto-scroll to bottom when pinned
  useEffect(() => {
    if (pinBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, pinBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPinBottom(atBottom);
  }, []);

  const [copyError, setCopyError] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(logs);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2000);
    }
  }, [logs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ScrollText className="w-5 h-5 text-[var(--color-accent)]" />
        <h2 className="text-lg font-semibold">Sandbox Logs</h2>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={source}
            onChange={(e) => { setSource(e.target.value as LogSource); setLoading(true); }}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value="sandbox">Sandbox</option>
            <option value="proxy">Proxy</option>
            <option value="dind">DinD</option>
          </select>
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-2 py-1 text-xs text-gray-300"
          >
            <option value={100}>100 lines</option>
            <option value={200}>200 lines</option>
            <option value={500}>500 lines</option>
            <option value={1000}>1000 lines</option>
          </select>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            title="Copy logs"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : copyError ? <X className="w-3.5 h-3.5 text-red-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => { setLoading(true); fetchLogs(); }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
            title="Refresh logs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="py-8 text-center text-gray-500 text-sm border border-dashed border-[var(--color-border)] rounded-lg">
          <ScrollText className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>{error}</p>
        </div>
      ) : loading && !logs ? (
        <div className="py-8 text-center text-gray-500 text-sm">
          <RefreshCw className="w-6 h-6 mx-auto mb-2 animate-spin opacity-50" />
          Loading logs...
        </div>
      ) : (
        <div className="relative">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-[calc(100vh-200px)] overflow-auto font-mono text-[11px] leading-relaxed bg-[#0d1117] rounded-lg border border-[var(--color-border)] p-2 select-text"
          >
            {logs ? (
              <pre className="whitespace-pre-wrap break-all text-gray-300">{logs}</pre>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500 text-xs">
                No logs available
              </div>
            )}
          </div>
          {!pinBottom && (
            <button
              onClick={() => {
                setPinBottom(true);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1 text-[10px] bg-[var(--color-accent-muted)] text-white rounded-full opacity-80 hover:opacity-100 flex items-center gap-1"
            >
              <ArrowDownToLine className="w-3 h-3" /> Scroll to bottom
            </button>
          )}
        </div>
      )}
    </div>
  );
}
