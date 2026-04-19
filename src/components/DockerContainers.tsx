import { useState, useEffect, useRef, useCallback } from "react";
import {
  Container, Network, ChevronDown, ChevronRight, ScrollText, Info,
  Trash2, Circle, Wifi, WifiOff,
} from "lucide-react";
import { useDockerWs } from "../lib/useDockerWs";
import type { DockerContainer, DockerLogEntry } from "../lib/types";

interface DockerContainersProps {
  sessionId: string;
  onContainerCount?: (count: number) => void;
}

export function DockerContainers({ sessionId, onContainerCount }: DockerContainersProps) {
  const {
    containers, connected, subscribeLogs, unsubscribeLogs,
    requestInspect, logs, inspectData, clearLogs,
  } = useDockerWs(sessionId);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"logs" | "details">("logs");

  // Report container count to parent
  useEffect(() => {
    onContainerCount?.(containers.filter((c) => c.state === "running").length);
  }, [containers, onContainerCount]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => {
      if (prev === id) {
        unsubscribeLogs(id);
        return null;
      }
      // Collapse previous
      if (prev) unsubscribeLogs(prev);
      // Expand new
      subscribeLogs(id);
      requestInspect(id);
      setSubTab("logs");
      return id;
    });
  }, [subscribeLogs, unsubscribeLogs, requestInspect]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Container className="w-5 h-5 text-[var(--color-accent)]" />
        <h2 className="text-lg font-semibold">Docker Containers</h2>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
          {connected
            ? <><Wifi className="w-3 h-3 text-green-400" /><span className="text-green-400">live</span></>
            : <><WifiOff className="w-3 h-3 text-gray-500" />connecting...</>
          }
        </span>
      </div>

      {containers.length === 0 ? (
        <div className="py-8 text-center text-gray-500 text-sm border border-dashed border-[var(--color-border)] rounded-lg">
          <Container className="w-8 h-8 mx-auto mb-2 opacity-50" />
          No containers yet. Claude can run{" "}
          <code className="px-1 py-0.5 bg-[var(--color-surface)] rounded text-xs font-mono">
            docker run ...
          </code>{" "}
          inside the sandbox.
        </div>
      ) : (
        <div className="space-y-2">
          {containers.map((c) => (
            <ContainerCard
              key={c.id}
              container={c}
              expanded={expandedId === c.id}
              subTab={expandedId === c.id ? subTab : "logs"}
              onToggle={() => toggleExpand(c.id)}
              onSubTabChange={setSubTab}
              logEntries={logs.get(c.id) ?? []}
              inspect={inspectData.get(c.id)}
              onClearLogs={() => clearLogs(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Container card
// ---------------------------------------------------------------------------

interface ContainerCardProps {
  container: DockerContainer;
  expanded: boolean;
  subTab: "logs" | "details";
  onToggle: () => void;
  onSubTabChange: (tab: "logs" | "details") => void;
  logEntries: DockerLogEntry[];
  inspect?: Record<string, any>;
  onClearLogs: () => void;
}

function ContainerCard({
  container: c, expanded, subTab, onToggle, onSubTabChange,
  logEntries, inspect, onClearLogs,
}: ContainerCardProps) {
  return (
    <div className="bg-[var(--color-surface-raised)] rounded-lg border border-[var(--color-border)] overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.02] transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
          : <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" />
        }
        <div className={`w-2 h-2 rounded-full shrink-0 ${
          c.state === "running" ? "bg-green-400" :
          c.state === "exited" ? "bg-gray-500" :
          "bg-yellow-400 animate-pulse"
        }`} />
        <span className="font-mono text-sm font-medium truncate">
          {c.name || c.id.slice(0, 12)}
        </span>
        <span className="text-xs text-gray-500 font-mono truncate hidden sm:inline">{c.image}</span>
        {c.ports && (
          <span className="text-xs text-gray-500 flex items-center gap-1 hidden sm:flex">
            <Network className="w-3 h-3" />{c.ports}
          </span>
        )}
        <span className={`ml-auto text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${
          c.state === "running" ? "bg-green-500/15 text-green-400" :
          c.state === "exited" ? "bg-gray-500/15 text-gray-400" :
          "bg-yellow-500/15 text-yellow-400"
        }`}>
          {c.state}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-[var(--color-border)]">
          {/* Sub-tab bar */}
          <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <SubTabBtn active={subTab === "logs"} onClick={() => onSubTabChange("logs")}>
              <ScrollText className="w-3.5 h-3.5" /> Logs
            </SubTabBtn>
            <SubTabBtn active={subTab === "details"} onClick={() => onSubTabChange("details")}>
              <Info className="w-3.5 h-3.5" /> Details
            </SubTabBtn>
            {subTab === "logs" && (
              <button
                onClick={(e) => { e.stopPropagation(); onClearLogs(); }}
                className="ml-auto mr-2 flex items-center gap-1 px-2 py-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
              >
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            )}
          </div>

          {subTab === "logs" ? (
            <LogViewer entries={logEntries} />
          ) : (
            <InspectView data={inspect} container={c} />
          )}
        </div>
      )}
    </div>
  );
}

function SubTabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
        active
          ? "border-[var(--color-accent)] text-white"
          : "border-transparent text-gray-500 hover:text-gray-300"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Log viewer
// ---------------------------------------------------------------------------

function LogViewer({ entries }: { entries: DockerLogEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinBottom, setPinBottom] = useState(true);
  const prevLenRef = useRef(0);

  // Auto-scroll when pinned and new entries arrive
  useEffect(() => {
    if (pinBottom && containerRef.current && entries.length > prevLenRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
    prevLenRef.current = entries.length;
  }, [entries.length, pinBottom]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPinBottom(atBottom);
  }, []);

  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-xs">
        <Circle className="w-3 h-3 animate-pulse mr-2" />
        Waiting for logs...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="h-72 overflow-auto font-mono text-[11px] leading-relaxed bg-[#0d1117] p-2 select-text"
    >
      {entries.map((entry, i) => (
        <div key={i} className={`whitespace-pre-wrap break-all ${
          entry.stream === "stderr" ? "text-red-400/90" : "text-gray-300"
        }`}>
          {entry.data}
        </div>
      ))}
      {!pinBottom && (
        <button
          onClick={() => {
            setPinBottom(true);
            containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: "smooth" });
          }}
          className="sticky bottom-1 left-1/2 -translate-x-1/2 px-2 py-0.5 text-[10px] bg-[var(--color-accent-muted)] text-white rounded-full opacity-80 hover:opacity-100"
        >
          ↓ Scroll to bottom
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspect / details view
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = /key|secret|token|password|credential|auth/i;

function InspectView({ data, container: c }: { data?: Record<string, any>; container: DockerContainer }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-xs">
        <Circle className="w-3 h-3 animate-pulse mr-2" />
        Loading inspect data...
      </div>
    );
  }

  const config = data.Config ?? {};
  const hostConfig = data.HostConfig ?? {};
  const netSettings = data.NetworkSettings ?? {};
  const state = data.State ?? {};
  const mounts = data.Mounts ?? [];

  const cmd = config.Cmd ? config.Cmd.join(" ") : config.Entrypoint?.join(" ") ?? "—";
  const env = (config.Env ?? []) as string[];

  // Build port mapping string
  const portBindings = hostConfig.PortBindings ?? {};
  const portPairs = Object.entries(portBindings)
    .filter(([, bindings]) => Array.isArray(bindings) && (bindings as any[]).length > 0)
    .map(([containerPort, bindings]) => {
      const b = (bindings as any[])[0];
      return `${b.HostPort || "?"} → ${containerPort}`;
    });

  // Network IPs
  const networks = netSettings.Networks ?? {};
  const networkEntries = Object.entries(networks).map(([name, net]: [string, any]) => ({
    name,
    ip: net.IPAddress || "—",
  }));

  return (
    <div className="h-72 overflow-auto p-3 text-xs space-y-3">
      <Section title="General">
        <Row label="ID" value={data.Id?.slice(0, 12) ?? c.id} mono />
        <Row label="Image" value={config.Image ?? c.image} mono />
        <Row label="Command" value={cmd} mono />
        <Row label="Working Dir" value={config.WorkingDir || "/"} mono />
        <Row label="Created" value={data.Created ?? c.createdAt} />
        <Row label="Status" value={`${state.Status ?? c.state} (exit ${state.ExitCode ?? "—"})`} />
        {state.StartedAt && <Row label="Started" value={state.StartedAt} />}
        {state.FinishedAt && state.FinishedAt !== "0001-01-01T00:00:00Z" && (
          <Row label="Finished" value={state.FinishedAt} />
        )}
      </Section>

      {portPairs.length > 0 && (
        <Section title="Ports">
          {portPairs.map((p, i) => <Row key={i} label="" value={p} mono />)}
        </Section>
      )}

      {networkEntries.length > 0 && (
        <Section title="Networks">
          {networkEntries.map((n) => <Row key={n.name} label={n.name} value={n.ip} mono />)}
        </Section>
      )}

      {mounts.length > 0 && (
        <Section title="Mounts">
          {mounts.map((m: any, i: number) => (
            <Row
              key={i}
              label={m.Type}
              value={`${m.Source ?? "—"} → ${m.Destination} ${m.RW ? "" : "(ro)"}`}
              mono
            />
          ))}
        </Section>
      )}

      {env.length > 0 && (
        <Section title="Environment">
          {env.map((e, i) => {
            const eqIdx = e.indexOf("=");
            const name = eqIdx >= 0 ? e.slice(0, eqIdx) : e;
            const value = eqIdx >= 0 ? e.slice(eqIdx + 1) : "";
            const masked = SENSITIVE_PATTERNS.test(name);
            return (
              <Row
                key={i}
                label={name}
                value={masked ? "••••••••" : value}
                mono
              />
            );
          })}
        </Section>
      )}

      {(hostConfig.Memory > 0 || hostConfig.CpuShares > 0) && (
        <Section title="Resources">
          {hostConfig.Memory > 0 && (
            <Row label="Memory" value={`${Math.round(hostConfig.Memory / 1024 / 1024)} MB`} />
          )}
          {hostConfig.CpuShares > 0 && (
            <Row label="CPU Shares" value={String(hostConfig.CpuShares)} />
          )}
        </Section>
      )}

      <Section title="Restart Policy">
        <Row
          label="Policy"
          value={`${hostConfig.RestartPolicy?.Name ?? "no"} (max: ${hostConfig.RestartPolicy?.MaximumRetryCount ?? 0})`}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{title}</div>
      <div className="space-y-0.5 pl-1">{children}</div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      {label && <span className="text-gray-500 shrink-0 w-24 text-right">{label}</span>}
      <span className={`text-gray-300 break-all ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
