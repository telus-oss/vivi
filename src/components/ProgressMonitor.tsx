import { useState, useEffect, useRef, useCallback } from "react";
import { getWsBase } from "../lib/backend";
import {
  Activity,
  AlertTriangle,
  AlertCircle,
  FileText,
  RefreshCw,
  CheckCircle2,
  Clock,
  Zap,
  ToggleLeft,
  ToggleRight,
  Bug,
  Repeat,
  FileSearch,
  Terminal,
  Settings2,
  Volume2,
  VolumeX,
  MonitorDot,
} from "lucide-react";
import type { HealthSnapshot, Alert, StruggleSignals, MonitorConfig } from "../lib/types";
import * as api from "../lib/api";

const SEVERITY_STYLES = {
  warning: { bg: "bg-yellow-500/10", border: "border-yellow-500/30", text: "text-yellow-400", icon: AlertTriangle },
  critical: { bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-400", icon: AlertCircle },
};

interface ProgressMonitorProps {
  sessionId?: string;
  /** Called when stuck state or alert preferences change, so parent can flash the tab */
  onStuckChange?: (stuck: boolean, flashEnabled: boolean) => void;
}

/** LocalStorage key for client-side alert preferences */
const PREFS_KEY = "monitor-alert-prefs";

interface AlertPrefs {
  audioCue: boolean;
  flashTab: boolean;
}

function loadAlertPrefs(): AlertPrefs {
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    if (stored) return JSON.parse(stored);
  } catch (err) { console.warn("Failed to parse alert prefs from localStorage:", err); }
  return { audioCue: false, flashTab: false };
}

function saveAlertPrefs(prefs: AlertPrefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

/** Generate a short alert beep using Web Audio API */
function playAlertSound() {
  try {
    const ctx = new AudioContext();
    // Two-tone alert: 880Hz then 660Hz
    for (const [freq, start] of [[880, 0], [660, 0.15]] as [number, number][]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.12);
    }
    // Close context after sounds finish
    setTimeout(() => ctx.close(), 500);
  } catch (err) { console.warn("Failed to play alert sound:", err); }
}

export function ProgressMonitor({ sessionId, onStuckChange }: ProgressMonitorProps) {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [alertPrefs, setAlertPrefs] = useState<AlertPrefs>(loadAlertPrefs);
  const [showConfig, setShowConfig] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const prevStuckRef = useRef(false);
  const audioCooldownRef = useRef(0);

  const updateAlertPrefs = useCallback((update: Partial<AlertPrefs>) => {
    setAlertPrefs((prev) => {
      const next = { ...prev, ...update };
      saveAlertPrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      const sessionParam = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const ws = new WebSocket(`${getWsBase()}/monitor${sessionParam}`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "health") {
            setHealth(msg.data);
          }
        } catch (err) { console.warn("Failed to parse WebSocket health message:", err); }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    const interval = setInterval(async () => {
      try {
        setHealth(await api.getHealth(sessionId));
      } catch (err) { console.warn(`Failed to poll health for session ${sessionId}:`, err); }
    }, 5000);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearInterval(interval);
      wsRef.current?.close();
    };
  }, [sessionId]);

  // Handle stuck state changes: audio cue + notify parent for flash tab
  useEffect(() => {
    if (!health) return;
    const isStuck = health.stuckDetected;
    const wasStuck = prevStuckRef.current;
    prevStuckRef.current = isStuck;

    // Notify parent about stuck state for tab flashing
    onStuckChange?.(isStuck, alertPrefs.flashTab);

    // Play audio cue on transition to stuck (with 30s cooldown)
    if (isStuck && !wasStuck && alertPrefs.audioCue && Date.now() > audioCooldownRef.current) {
      playAlertSound();
      audioCooldownRef.current = Date.now() + 30_000;
    }
  }, [health?.stuckDetected, alertPrefs.audioCue, alertPrefs.flashTab, onStuckChange]);

  if (!health) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        <RefreshCw className="w-5 h-5 animate-spin mr-2" />
        Connecting to monitor...
      </div>
    );
  }

  const signals = health.struggleSignals;
  const config = health.config;
  const struggleLevel = computeStruggleLevel(signals, config);
  const isHealthy = struggleLevel === "ok" && health.alerts.length === 0;

  return (
    <div className="space-y-6">
      {/* Stuck detection banner */}
      {health.stuckDetected && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-red-500/15 border-red-500/40 animate-pulse">
          <AlertCircle className="w-5 h-5 text-red-400" />
          <div className="flex-1">
            <span className="text-sm font-bold text-red-400">Stuck pattern detected</span>
            <p className="text-xs text-red-300/70 mt-0.5">
              Claude appears to be struggling.
              {health.autoIntervene
                ? " Auto-intervention is ON — will send redirect prompt."
                : " Consider jumping in with guidance or enable auto-intervention below."}
            </p>
          </div>
        </div>
      )}

      {/* Status banner */}
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
          isHealthy
            ? "bg-green-500/10 border-green-500/30"
            : struggleLevel === "struggling"
            ? "bg-red-500/10 border-red-500/30"
            : "bg-yellow-500/10 border-yellow-500/30"
        }`}
      >
        {isHealthy ? (
          <CheckCircle2 className="w-5 h-5 text-[var(--color-success)]" />
        ) : struggleLevel === "struggling" ? (
          <AlertCircle className="w-5 h-5 text-red-400" />
        ) : (
          <AlertTriangle className="w-5 h-5 text-[var(--color-warning)]" />
        )}
        <span className={`text-sm font-medium ${
          isHealthy ? "text-green-400" : struggleLevel === "struggling" ? "text-red-400" : "text-yellow-400"
        }`}>
          {isHealthy
            ? "Claude is working normally"
            : struggleLevel === "struggling"
            ? "Claude appears to be struggling — consider jumping in"
            : "Some signs of difficulty detected"}
        </span>
        <span className="text-xs text-gray-500 ml-auto">
          {health.totalEvents} events tracked
        </span>
      </div>

      {/* Active bash command */}
      {health.activeBash && (
        <div
          className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${
            health.activeBash.durationSec > 120 && !health.activeBash.expectedLong
              ? "bg-orange-500/10 border-orange-500/30"
              : "bg-blue-500/10 border-blue-500/30"
          }`}
        >
          <Clock className={`w-4 h-4 mt-0.5 ${
            health.activeBash.durationSec > 120 && !health.activeBash.expectedLong
              ? "text-orange-400"
              : "text-blue-400"
          }`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400">Running bash command</span>
              <span className="text-xs font-mono text-gray-500">
                {formatDuration(health.activeBash.durationSec)}
              </span>
              {health.activeBash.expectedLong && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  expected long
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-gray-400 mt-1 truncate">
              {health.activeBash.command}
            </p>
          </div>
        </div>
      )}

      {/* Struggle signals — the main value of this tab */}
      <StruggleSignalsPanel signals={signals} config={config} />

      {/* Recent errors */}
      {signals.recentErrors.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-400">Recent Errors</h3>
          <div className="space-y-1.5">
            {signals.recentErrors.map((err, i) => (
              <div
                key={i}
                className="px-3 py-2 rounded border bg-red-500/5 border-red-500/20 font-mono text-xs text-red-300/80 truncate"
              >
                {err}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Hot files */}
      {signals.hotFiles.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-400">Files Visited Repeatedly</h3>
          <div className="space-y-1">
            {signals.hotFiles.map((f, i) => (
              <div
                key={i}
                className="px-3 py-1.5 rounded border bg-yellow-500/5 border-yellow-500/20 font-mono text-xs text-yellow-300/80 truncate"
              >
                {f}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Auto-intervention toggle */}
      <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-gray-400" />
          <div>
            <span className="text-sm font-medium text-gray-300">Auto-intervention</span>
            <p className="text-xs text-gray-500">
              When stuck, automatically send ESC and redirect prompt
            </p>
          </div>
        </div>
        <button
          onClick={async () => {
            if (!sessionId) return;
            try {
              await api.setAutoIntervene(sessionId, !health.autoIntervene);
              setHealth((prev) => prev ? { ...prev, autoIntervene: !prev.autoIntervene } : prev);
            } catch (err) { console.warn(`Failed to toggle auto-intervene for session ${sessionId}:`, err); }
          }}
          className="flex items-center gap-1 text-sm transition-colors"
          title={health.autoIntervene ? "Disable auto-intervention" : "Enable auto-intervention"}
        >
          {health.autoIntervene ? (
            <ToggleRight className="w-8 h-8 text-[var(--color-accent)]" />
          ) : (
            <ToggleLeft className="w-8 h-8 text-gray-500" />
          )}
        </button>
      </div>

      {/* Alert preferences: audio cue + flash tab */}
      <div className="space-y-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            {alertPrefs.audioCue ? <Volume2 className="w-4 h-4 text-gray-400" /> : <VolumeX className="w-4 h-4 text-gray-400" />}
            <div>
              <span className="text-sm font-medium text-gray-300">Audio alert</span>
              <p className="text-xs text-gray-500">
                Play a sound when Claude gets stuck
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              const next = !alertPrefs.audioCue;
              updateAlertPrefs({ audioCue: next });
              // Play a preview sound when enabling
              if (next) playAlertSound();
            }}
            className="flex items-center gap-1 text-sm transition-colors"
            title={alertPrefs.audioCue ? "Disable audio alert" : "Enable audio alert"}
          >
            {alertPrefs.audioCue ? (
              <ToggleRight className="w-8 h-8 text-[var(--color-accent)]" />
            ) : (
              <ToggleLeft className="w-8 h-8 text-gray-500" />
            )}
          </button>
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <MonitorDot className="w-4 h-4 text-gray-400" />
            <div>
              <span className="text-sm font-medium text-gray-300">Flash tab</span>
              <p className="text-xs text-gray-500">
                Flash the Monitor tab red when Claude is stuck
              </p>
            </div>
          </div>
          <button
            onClick={() => updateAlertPrefs({ flashTab: !alertPrefs.flashTab })}
            className="flex items-center gap-1 text-sm transition-colors"
            title={alertPrefs.flashTab ? "Disable tab flashing" : "Enable tab flashing"}
          >
            {alertPrefs.flashTab ? (
              <ToggleRight className="w-8 h-8 text-[var(--color-accent)]" />
            ) : (
              <ToggleLeft className="w-8 h-8 text-gray-500" />
            )}
          </button>
        </div>
      </div>

      {/* Configurable thresholds */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] overflow-hidden">
        <button
          onClick={() => setShowConfig(!showConfig)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm transition-colors hover:bg-white/[0.02]"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-gray-400" />
            <span className="font-medium text-gray-300">Detection Thresholds</span>
          </div>
          <span className="text-xs text-gray-500">{showConfig ? "Hide" : "Configure"}</span>
        </button>
        {showConfig && sessionId && (
          <ThresholdConfig sessionId={sessionId} config={config} onUpdate={(c) => setHealth((prev) => prev ? { ...prev, config: c } : prev)} />
        )}
      </div>

      {/* Tool breakdown */}
      {Object.keys(health.breakdown).length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-gray-400">Activity Breakdown (last minute)</h3>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(health.breakdown)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div
                  key={type}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 bg-[var(--color-surface-raised)] rounded border border-[var(--color-border)]"
                >
                  <span className="text-xs font-mono text-[var(--color-accent)]">{type}</span>
                  <span className="text-xs font-bold text-gray-300">{count}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Alerts */}
      {health.alerts.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-400">Alerts</h3>
            <button
              onClick={() => api.clearAlerts(sessionId)}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Clear all
            </button>
          </div>
          <div className="space-y-2">
            {health.alerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ThresholdConfig({ sessionId, config, onUpdate }: { sessionId: string; config: MonitorConfig; onUpdate: (c: MonitorConfig) => void }) {
  const [local, setLocal] = useState(config);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync if config changes externally
  useEffect(() => { setLocal(config); }, [config]);

  const handleChange = (field: keyof MonitorConfig, value: number) => {
    if (value < 1) return;
    const next = { ...local, [field]: value };
    setLocal(next);

    // Debounced save
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(async () => {
      try {
        const res = await api.setMonitorConfig(sessionId, { [field]: value });
        onUpdate(res.config);
      } catch (err) { console.warn(`Failed to save monitor config field "${field}":`, err); }
    }, 500);
  };

  const fields: { key: keyof MonitorConfig; label: string; description: string }[] = [
    { key: "errorThreshold", label: "Error count", description: "Errors before critical severity" },
    { key: "editFailThreshold", label: "Edit-fail cycles", description: "Edit-fail loops before critical" },
    { key: "fileRevisitThreshold", label: "File revisits", description: "Excess revisits before warning" },
    { key: "bashStreakThreshold", label: "Bash streak", description: "Bash calls w/o edits before warning" },
  ];

  return (
    <div className="px-4 py-3 border-t border-[var(--color-border)] space-y-3">
      <p className="text-xs text-gray-500">
        Adjust when signals are flagged as warnings or critical. Lower values = more sensitive detection.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="text-xs text-gray-400 block mb-1">{f.label}</label>
            <input
              type="number"
              min={1}
              max={50}
              value={local[f.key]}
              onChange={(e) => handleChange(f.key, parseInt(e.target.value) || 1)}
              className="w-full px-2.5 py-1.5 text-sm font-mono bg-[var(--color-surface)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none text-gray-300"
            />
            <p className="text-[10px] text-gray-600 mt-0.5">{f.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function StruggleSignalsPanel({ signals, config }: { signals: StruggleSignals; config: MonitorConfig }) {
  const indicators = [
    {
      label: "Errors",
      value: signals.recentErrorCount,
      icon: <Bug className="w-4 h-4" />,
      severity: signals.recentErrorCount >= config.errorThreshold ? "critical" : signals.recentErrorCount >= Math.ceil(config.errorThreshold / 2) ? "warning" : "ok",
      detail: signals.recentErrorCount > 0 ? `${signals.recentErrorCount} error(s) in bash output` : "No errors detected",
    },
    {
      label: "Edit-Fail Cycles",
      value: signals.editFailCycles,
      icon: <Repeat className="w-4 h-4" />,
      severity: signals.editFailCycles >= config.editFailThreshold ? "critical" : signals.editFailCycles >= Math.max(1, config.editFailThreshold - 1) ? "warning" : "ok",
      detail: signals.editFailCycles > 0
        ? `Edited code then got error ${signals.editFailCycles}x`
        : "No edit-fail loops",
    },
    {
      label: "File Revisits",
      value: signals.fileRevisitCount,
      icon: <FileSearch className="w-4 h-4" />,
      severity: signals.fileRevisitCount >= config.fileRevisitThreshold ? "warning" : "ok",
      detail: signals.hotFiles.length > 0
        ? `${signals.hotFiles.length} file(s) visited 3+ times`
        : "Normal file access pattern",
    },
    {
      label: "Bash w/o Edits",
      value: signals.bashWithoutEditStreak,
      icon: <Terminal className="w-4 h-4" />,
      severity: signals.bashWithoutEditStreak >= config.bashStreakThreshold ? "warning" : "ok",
      detail: signals.bashWithoutEditStreak > 3
        ? `${signals.bashWithoutEditStreak} bash calls without editing`
        : "Normal tool mix",
    },
  ];

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-400">Struggle Indicators</h3>
      <div className="grid grid-cols-2 gap-2">
        {indicators.map((ind) => (
          <div
            key={ind.label}
            className={`p-3 rounded-lg border ${
              ind.severity === "critical"
                ? "bg-red-500/10 border-red-500/30"
                : ind.severity === "warning"
                ? "bg-yellow-500/10 border-yellow-500/30"
                : "bg-[var(--color-surface-raised)] border-[var(--color-border)]"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className={
                ind.severity === "critical" ? "text-red-400" :
                ind.severity === "warning" ? "text-yellow-400" :
                "text-gray-500"
              }>{ind.icon}</span>
              <span className="text-xs text-gray-400">{ind.label}</span>
            </div>
            <div className={`text-xl font-bold font-mono ${
              ind.severity === "critical" ? "text-red-400" :
              ind.severity === "warning" ? "text-yellow-400" :
              "text-gray-300"
            }`}>
              {ind.value}
            </div>
            <p className="text-xs text-gray-500 mt-1">{ind.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function computeStruggleLevel(signals: StruggleSignals, config: MonitorConfig): "ok" | "warning" | "struggling" {
  let score = 0;
  if (signals.recentErrorCount >= config.errorThreshold) score += 3;
  else if (signals.recentErrorCount >= Math.ceil(config.errorThreshold / 2)) score += 1;
  if (signals.editFailCycles >= config.editFailThreshold) score += 3;
  else if (signals.editFailCycles >= Math.max(1, config.editFailThreshold - 1)) score += 1;
  if (signals.fileRevisitCount >= config.fileRevisitThreshold) score += 1;
  if (signals.bashWithoutEditStreak >= config.bashStreakThreshold) score += 1;
  if (signals.claudeMessageRepetition > 0.5) score += 2;

  if (score >= 4) return "struggling";
  if (score >= 2) return "warning";
  return "ok";
}

function AlertCard({ alert }: { alert: Alert }) {
  const style = SEVERITY_STYLES[alert.severity];
  const Icon = style.icon;
  const age = Date.now() - alert.timestamp;
  const ageStr = age < 60_000 ? `${Math.floor(age / 1000)}s ago` : `${Math.floor(age / 60_000)}m ago`;

  const typeLabel: Record<string, string> = {
    stuck_loop: "Stuck Loop",
    similar_loop: "Similar Commands",
    repetitive: "Repetitive Output",
    long_running_bash: "Long-Running Command",
    bash_rate: "High Bash Rate",
  };

  return (
    <div className={`flex items-start gap-3 px-3 py-2.5 rounded border ${style.bg} ${style.border}`}>
      <Icon className={`w-4 h-4 mt-0.5 ${style.text}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${style.text}`}>{alert.message}</p>
        <p className="text-xs text-gray-500 mt-0.5">
          {typeLabel[alert.type] || alert.type} &middot; {ageStr}
        </p>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
