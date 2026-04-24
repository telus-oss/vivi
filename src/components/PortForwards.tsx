import { useState, useEffect, useCallback } from "react";
import { Network, ExternalLink, X, RefreshCw, Loader2, GitBranch, Copy, Check, Eye } from "lucide-react";
import type { PortForward } from "../lib/types";
import * as api from "../lib/api";
import { fetchHost, gitRemoteUrl } from "../lib/host";
import { getPortForwardUrl } from "../lib/api";

interface PortForwardsProps {
  sessionId: string;
  onPreview?: (port: PortForward) => void;
}

function GitRemoteHint({ hostPort, host }: { hostPort: number; host: string }) {
  const [copied, setCopied] = useState(false);
  const command = `git remote add sandbox ${gitRemoteUrl(host, hostPort)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("handleCopy: failed to copy to clipboard", err);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-2 px-2 py-1.5 bg-[var(--color-surface)] rounded text-xs font-mono text-gray-400">
      <GitBranch className="w-3 h-3 shrink-0 text-gray-500" />
      <span className="truncate select-all">{command}</span>
      <button
        onClick={handleCopy}
        className="shrink-0 p-0.5 text-gray-500 hover:text-gray-300 transition-colors"
        title="Copy command"
      >
        {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

export function PortForwards({ sessionId, onPreview }: PortForwardsProps) {
  const [ports, setPorts] = useState<PortForward[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingPorts, setClosingPorts] = useState<Set<number>>(new Set());
  const [host, setHost] = useState("localhost");

  useEffect(() => {
    fetchHost().then(setHost);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setPorts(await api.getOpenPorts(sessionId));
    } catch (err) {
      console.warn(`PortForwards.refresh: failed to fetch ports for session ${sessionId}`, err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleClose = async (port: number) => {
    setClosingPorts((prev) => new Set(prev).add(port));
    try {
      await api.closePort(sessionId, port);
      refresh();
    } catch (err) {
      console.warn(`PortForwards.handleClose: failed to close port ${port} for session ${sessionId}`, err);
    } finally {
      setClosingPorts((prev) => {
        const next = new Set(prev);
        next.delete(port);
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        Loading ports...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Network className="w-5 h-5 text-[var(--color-accent)]" />
        <h2 className="text-lg font-semibold">Port Forwards</h2>
      </div>

      {(() => {
        const builtInPorts = ports.filter((p) => p.type === "vscode");
        const userPorts = ports.filter((p) => p.type !== "vscode");

        const renderRow = (pf: PortForward, isBuiltIn: boolean) => {
          const isClosing = closingPorts.has(pf.containerPort) || pf.status === "closing";
          return (
            <div
              key={`${pf.containerPort}-${pf.hostPort}`}
              className={`p-3 bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-border)] ${
                isClosing ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    {pf.label && (
                      <span className="text-sm font-medium text-gray-200 truncate">{pf.label}</span>
                    )}
                    <div className="flex items-center gap-1.5 text-sm">
                      {pf.containerName ? (
                        <span className="font-mono text-gray-400">{pf.containerName}:{pf.containerPort}</span>
                      ) : (
                        <span className="font-mono text-gray-400">:{pf.containerPort}</span>
                      )}
                      <span className="text-gray-600">&rarr;</span>
                      <a
                        href={getPortForwardUrl(pf)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 font-mono text-[var(--color-accent)] hover:text-blue-300 transition-colors"
                      >
                        {pf.proxySubdomain || `:${pf.hostPort}`}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {pf.type !== "git" && onPreview && (
                    <button
                      onClick={() => onPreview(pf)}
                      disabled={isClosing}
                      className="p-1.5 text-gray-500 hover:text-[var(--color-accent)] disabled:opacity-50 transition-colors"
                      title="Preview in iframe"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {!isBuiltIn && (
                    <button
                      onClick={() => handleClose(pf.containerPort)}
                      disabled={isClosing}
                      className="p-1.5 text-gray-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                      title="Close port forward"
                    >
                      {isClosing ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <X className="w-3.5 h-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
              {pf.type === "git" && <GitRemoteHint hostPort={pf.hostPort} host={host} />}
            </div>
          );
        };

        return (
          <>
            {builtInPorts.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">Built-in</h3>
                <div className="space-y-2">
                  {builtInPorts.map((pf) => renderRow(pf, true))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              {builtInPorts.length > 0 && (
                <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide">Forwarded</h3>
              )}
              {userPorts.length === 0 ? (
                <div className="py-8 text-center text-gray-500 text-sm border border-dashed border-[var(--color-border)] rounded-lg">
                  <Network className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  No ports forwarded. Claude can run{" "}
                  <code className="px-1 py-0.5 bg-[var(--color-surface)] rounded text-xs font-mono">
                    open-port &lt;port&gt;
                  </code>{" "}
                  to forward a port.
                </div>
              ) : (
                <div className="space-y-2">
                  {userPorts.map((pf) => renderRow(pf, false))}
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}
