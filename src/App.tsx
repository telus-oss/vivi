import { useState, useEffect, useCallback, useRef } from "react";
import {
  KeyRound, Shield, Activity, Play, GitBranch, GitPullRequest,
  AlertTriangle, X, Plus, PanelRightOpen, Loader2, Network,
  ArrowDownToLine, Container, RefreshCw, UserCircle, FileCode2,
  Settings, FolderGit2, ScrollText, Box, Maximize2, Minimize2, ExternalLink,
  Menu, ChevronDown, Github,
} from "lucide-react";
import { Terminal } from "./components/Terminal";
import { SecretManager } from "./components/SecretManager";
import { Allowlist } from "./components/Allowlist";
import { SandboxImages } from "./components/SandboxImages";
import { ProfileManager } from "./components/ProfileManager";
import { ProgressMonitor } from "./components/ProgressMonitor";
import { Approvals } from "./components/Approvals";
import { PortForwards } from "./components/PortForwards";
import { DockerContainers } from "./components/DockerContainers";
import { SandboxLogs } from "./components/SandboxLogs";
import { DiffView } from "./components/DiffView";
import { LiveDiffView } from "./components/LiveDiffView";
import { PathInput } from "./components/PathInput";
import { GitHubIssues } from "./components/GitHubIssues";
import { GitHubSettings } from "./components/GitHubSettings";
import { GitHubRepoPicker } from "./components/GitHubRepoPicker";
import { MobileKeyToolbar } from "./components/MobileKeyToolbar";
import { BackendSwitcher } from "./components/BackendSwitcher";
import type { SessionState, HealthSnapshot, Profile, SecretRequest, SandboxImage, PortForward, GitHubRepoSelection } from "./lib/types";
import * as api from "./lib/api";
import { fetchHost } from "./lib/host";
import { getWsBase } from "./lib/backend";
import { getPortForwardUrl } from "./lib/api";
import { getRecentPaths, saveRecentPath } from "./lib/recentPaths";
import { getPanelWidth, clampWidth, PANEL_WIDTH_KEY } from "./lib/panelResize";
import { shouldShowRenameTip, markRenameTipSeen } from "./lib/renameTip";
import { useViewportHeight } from "./lib/useViewportHeight";

type Tab = "secrets" | "allowlist" | "profiles" | "images" | "diff" | "monitor" | "approvals" | "ports" | "docker" | "logs" | "branch-diff";

const GLOBAL_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "secrets", label: "Secrets", icon: <KeyRound className="w-4 h-4" /> },
  { id: "allowlist", label: "Allowlist", icon: <Shield className="w-4 h-4" /> },
  { id: "profiles", label: "Profiles", icon: <UserCircle className="w-4 h-4" /> },
  { id: "images", label: "Images", icon: <Box className="w-4 h-4" /> },
];

const SESSION_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "diff", label: "Diff", icon: <FileCode2 className="w-4 h-4" /> },
  // { id: "monitor", label: "Monitor", icon: <Activity className="w-4 h-4" /> }, // TODO: re-enable after fixing reliability
  { id: "approvals", label: "Branches", icon: <GitBranch className="w-4 h-4" /> },
  { id: "ports", label: "Ports", icon: <Network className="w-4 h-4" /> },
  { id: "docker", label: "Docker", icon: <Container className="w-4 h-4" /> },
  { id: "logs", label: "Logs", icon: <ScrollText className="w-4 h-4" /> },
];

export function App() {
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [host, setHost] = useState("localhost");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [tab, setTab] = useState<Tab | null>("secrets");
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [pendingPrCounts, setPendingPrCounts] = useState<Record<string, number>>({});
  const [portCounts, setPortCounts] = useState<Record<string, number>>({});
  const [containerCounts, setContainerCounts] = useState<Record<string, number>>({});
  const [form, setForm] = useState<{
    repoPath: string;
    taskDescription: string;
    profileId: string;
    imageId: string;
    githubRepo: GitHubRepoSelection | null;
  }>({ repoPath: "", taskDescription: "", profileId: "", imageId: "", githubRepo: null });
  const [availableProfiles, setAvailableProfiles] = useState<Profile[]>([]);
  const [sandboxImages, setSandboxImages] = useState<SandboxImage[]>([]);
  const [sessionMode, setSessionMode] = useState<"new" | "github" | "attach">("new");
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);
  const [attachTarget, setAttachTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [diffPr, setDiffPr] = useState<{ id: string; title: string } | null>(null);
  const [loginMode, setLoginMode] = useState(false);
  const [secretsRefreshKey, setSecretsRefreshKey] = useState(0);
  const monitorWsRef = useRef<WebSocket | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<api.UpdateStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [swUpdateAvailable, setSwUpdateAvailable] = useState(false);
  const [sessionNames, setSessionNames] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem("session-names") || "{}"); } catch (err) { console.warn("Failed to parse session-names from localStorage:", err); return {}; }
  });
  const [panelWidth, setPanelWidth] = useState<number>(getPanelWidth);
  const flexContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const panelTabBarRef = useRef<HTMLDivElement>(null);
  const panelTabsContainerRef = useRef<HTMLDivElement>(null);
  const [visibleTabCount, setVisibleTabCount] = useState<number>(Infinity);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [monitorFlashing, setMonitorFlashing] = useState(false);
  const [secretRequests, setSecretRequests] = useState<SecretRequest[]>([]);
  const [showRenameTip, setShowRenameTip] = useState(false);
  const [previewPort, setPreviewPort] = useState<PortForward | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [isSmallScreen, setIsSmallScreen] = useState(() => window.matchMedia("(max-width: 1023px)").matches);
  const [isLandscape, setIsLandscape] = useState(() => window.matchMedia("(orientation: landscape)").matches);
  const [landscapeSplit, setLandscapeSplit] = useState(() => {
    try { return localStorage.getItem("mobile-landscape-split") === "true"; } catch (err) { console.warn("Failed to read mobile-landscape-split from localStorage:", err); return false; }
  });
  const isMobile = isSmallScreen && !(landscapeSplit && isLandscape);
  const compactMode = isSmallScreen && isLandscape;
  const { keyboardOpen } = useViewportHeight();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileTab, setMobileTab] = useState<Tab | null>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const monitorFlashEnabledRef = useRef((() => {
    try { const p = JSON.parse(localStorage.getItem("monitor-alert-prefs") || "{}"); return !!p.flashTab; } catch (err) { console.warn("Failed to parse monitor-alert-prefs from localStorage:", err); return false; }
  })());

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const isRunning = activeSession?.status === "running";
  const alertCount = health?.alerts.length || 0;
  const activePrCount = activeSessionId ? (pendingPrCounts[activeSessionId] || 0) : 0;
  const activePortCount = activeSessionId ? (portCounts[activeSessionId] || 0) : 0;
  const activeContainerCount = activeSessionId ? (containerCounts[activeSessionId] || 0) : 0;
  const secretRequestCount = secretRequests.filter((r) => r.status === "pending").length;
  const runningSessions = sessions.filter((s) => s.status === "running");

  const saveSessionName = (id: string, name: string) => {
    const trimmed = name.trim();
    const updated = { ...sessionNames };
    if (trimmed) updated[id] = trimmed; else delete updated[id];
    setSessionNames(updated);
    localStorage.setItem("session-names", JSON.stringify(updated));
  };

  const commitSessionNameEdit = () => {
    if (editingSessionId) saveSessionName(editingSessionId, editingName);
    setEditingSessionId(null);
  };

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.getSessions();
      // Stabilize reference so effects depending on `sessions` don't re-run when data is unchanged.
      // TODO: replace JSON comparison with shallow-equal or normalized state.
      setSessions((prev) => JSON.stringify(list) === JSON.stringify(prev) ? prev : list);
      if (list.length > 0) {
        setSessions((prev) => {
          const currentId = activeSessionId;
          if (!currentId || !list.find((s) => s.id === currentId)) {
            const running = list.find((s) => s.status === "running");
            setActiveSessionId(running?.id || list[0].id);
          }
          return JSON.stringify(list) === JSON.stringify(prev) ? prev : list;
        });
      }
    } catch (err) {
      console.warn("refreshSessions: failed to fetch session list", err);
    }
  }, [activeSessionId]);

  // Fetch pending secret requests on mount
  useEffect(() => {
    fetchHost().then(setHost);
  }, []);

  useEffect(() => {
    api.listSecretRequests().then(setSecretRequests).catch((err) => {
      console.warn("listSecretRequests: failed to fetch on mount", err);
    });
  }, []);

  useEffect(() => {
    refreshSessions();
    const interval = setInterval(refreshSessions, 10000);
    // Refresh immediately when the tab becomes visible so state is never stale
    // after being in the background (browsers throttle setInterval on hidden tabs).
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshSessions();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshSessions]);

  // Listen for PWA service worker updates
  useEffect(() => {
    const handler = () => setSwUpdateAvailable(true);
    window.addEventListener("sw-update-available", handler);
    return () => window.removeEventListener("sw-update-available", handler);
  }, []);

  // Check for updates periodically (every 60 seconds)
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const status = await api.checkForUpdate();
        setUpdateAvailable(status.available ? status : null);
      } catch (err) {
        console.warn("checkUpdate: failed to check for updates", err);
      }
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleApplyUpdate = async () => {
    setUpdating(true);
    setUpdateError(null);
    try {
      await api.applyUpdate();
      // Server will restart — first wait for it to go DOWN (old server is still
      // running while it builds), then wait for it to come back UP with new code.
      let serverWentDown = false;
      const pollReady = setInterval(async () => {
        try {
          const res = await fetch("/api/health");
          if (res.ok && serverWentDown) {
            // Server is back up after going down — update applied
            clearInterval(pollReady);
            window.location.reload();
          }
        } catch {
          // Server is down — the restart has happened
          serverWentDown = true;
        }
      }, 1000);
      // Give up after 5 minutes
      setTimeout(() => { clearInterval(pollReady); setUpdating(false); setUpdateError("Update timed out — server may still be restarting"); }, 300_000);
    } catch (err: any) {
      setUpdateError(err.message);
      setUpdating(false);
    }
  };

  // Connect monitor WebSocket for the active session
  useEffect(() => {
    if (!activeSessionId) return;
    const activeSessionObj = sessions.find((s) => s.id === activeSessionId);
    if (!activeSessionObj || activeSessionObj.status !== "running") return;
    const ws = new WebSocket(`${getWsBase()}/monitor?sessionId=${encodeURIComponent(activeSessionId)}`);
    monitorWsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "health") setHealth(msg.data);
        else if (msg.type === "pr_request" && msg.data.status === "pending") {
          setPendingPrCounts((prev) => ({ ...prev, [activeSessionId]: (prev[activeSessionId] || 0) + 1 }));
        } else if (msg.type === "port_update") {
          api.getOpenPorts(activeSessionId).then((ports) => setPortCounts((prev) => ({ ...prev, [activeSessionId]: ports.length }))).catch((err) => { console.warn(`port_update: failed to fetch ports for session ${activeSessionId}`, err); });
        } else if (msg.type === "containers") {
          const count = Array.isArray(msg.data) ? msg.data.filter((c: any) => c.state === "running").length : 0;
          setContainerCounts((prev) => ({ ...prev, [activeSessionId]: count }));
        } else if (msg.type === "secret_request") {
          setSecretRequests((prev) => {
            const idx = prev.findIndex((r) => r.id === msg.data.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = msg.data;
              return updated;
            }
            return [...prev, msg.data];
          });
        }
      } catch (err) {
        console.warn(`WebSocket onmessage: failed to parse message for session ${activeSessionId}`, err);
      }
    };
    // Fetch existing pending secret requests on connect
    api.listSecretRequests().then(setSecretRequests).catch((err) => {
      console.warn("listSecretRequests: failed to fetch on WebSocket connect", err);
    });
    ws.onclose = () => { monitorWsRef.current = null; };
    return () => { ws.close(); monitorWsRef.current = null; setHealth(null); };
  }, [activeSessionId, sessions]);

  // Update monitor tab flash from App-level health data (works even when Monitor tab isn't active)
  useEffect(() => {
    if (!health) { setMonitorFlashing(false); return; }
    setMonitorFlashing(health.stuckDetected && monitorFlashEnabledRef.current);
  }, [health]);

  useEffect(() => {
    if (!activeSessionId) return;
    const activeSessionObj = sessions.find((s) => s.id === activeSessionId);
    if (!activeSessionObj || activeSessionObj.status !== "running") return;
    const refreshCounts = async () => {
      try { const prs = await api.getPrRequests(activeSessionId); setPendingPrCounts((prev) => ({ ...prev, [activeSessionId]: prs.filter((p) => p.status === "pending").length })); } catch (err) { console.warn(`refreshCounts: failed to fetch PR requests for session ${activeSessionId}`, err); }
      try { const ports = await api.getOpenPorts(activeSessionId); setPortCounts((prev) => ({ ...prev, [activeSessionId]: ports.length })); } catch (err) { console.warn(`refreshCounts: failed to fetch open ports for session ${activeSessionId}`, err); }
    };
    refreshCounts();
    const interval = setInterval(refreshCounts, 10000);
    return () => clearInterval(interval);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (showNewSessionForm || sessions.length === 0) {
      api.listProfiles().then(setAvailableProfiles).catch((err) => console.warn("Failed to fetch profiles:", err));
      api.getGitHubStatus()
        .then((s) => setGithubConfigured(s.configured))
        .catch((err) => { console.warn("Failed to fetch github status:", err); setGithubConfigured(false); });
      api.listSandboxImages().then((images) => {
        setSandboxImages(images);
        const defaultImg = images.find(i => i.isDefault);
        if (defaultImg) setForm(f => ({ ...f, imageId: String(defaultImg.id) }));
      }).catch((err) => console.warn("Failed to fetch sandbox images:", err));
    }
  }, [showNewSessionForm, sessions.length]);

  useEffect(() => {
    if (shouldShowRenameTip(sessions.length)) {
      setShowRenameTip(true);
    }
  }, [sessions.length]);

  useEffect(() => {
    if (!showRenameTip) return;
    const dismiss = () => {
      setShowRenameTip(false);
      markRenameTipSeen();
    };
    const timer = setTimeout(dismiss, 4000);
    document.addEventListener("click", dismiss, { once: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", dismiss);
    };
  }, [showRenameTip]);

  // Mobile detection via media query
  useEffect(() => {
    const sizeMq = window.matchMedia("(max-width: 1023px)");
    const orientMq = window.matchMedia("(orientation: landscape)");
    const sizeHandler = (e: MediaQueryListEvent) => setIsSmallScreen(e.matches);
    const orientHandler = (e: MediaQueryListEvent) => setIsLandscape(e.matches);
    sizeMq.addEventListener("change", sizeHandler);
    orientMq.addEventListener("change", orientHandler);
    return () => {
      sizeMq.removeEventListener("change", sizeHandler);
      orientMq.removeEventListener("change", orientHandler);
    };
  }, []);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) setMobileMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mobileMenuOpen]);

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setStarting(true);
    try {
      const commonOpts = {
        taskDescription: form.taskDescription || undefined,
        profileId: form.profileId || undefined,
        imageId: form.imageId ? Number(form.imageId) : undefined,
      };
      const body = sessionMode === "attach" && attachTarget
        ? { attachTo: attachTarget }
        : sessionMode === "github" && form.githubRepo
          ? { githubRepo: form.githubRepo, ...commonOpts }
          : { repoPath: form.repoPath, ...commonOpts };
      const s = await api.startSession(body);
      if (sessionMode === "new" && form.repoPath) saveRecentPath(form.repoPath);
      setShowNewSessionForm(false); setActiveSessionId(s.id); setForm({ repoPath: "", taskDescription: "", profileId: "", imageId: "", githubRepo: null }); setAttachTarget(null); refreshSessions();
    } catch (err: any) { setError(err.message); } finally { setStarting(false); }
  };

  const handleStopSession = async (sessionId: string) => {
    try {
      await api.stopSession(sessionId);
      if (sessionId === activeSessionId) {
        const remaining = sessions.filter((s) => s.id !== sessionId);
        if (remaining.length > 0) setActiveSessionId(remaining[0].id);
        else { setActiveSessionId(null); setShowNewSessionForm(true); }
      }
      refreshSessions();
    } catch (err: any) { setError(err.message); }
  };

  const showStartForm = showNewSessionForm || sessions.length === 0;
  const showTerminal = activeSession && !showNewSessionForm;
  const hasSession = !!(activeSession && isRunning);
  const primaryTabs = hasSession ? SESSION_TABS : GLOBAL_TABS;
  const isGlobalTab = (t: Tab) => GLOBAL_TABS.some((g) => g.id === t);

  const allPanelTabs = hasSession ? [...SESSION_TABS, ...GLOBAL_TABS] : GLOBAL_TABS;

  // Measure which panel tabs fit before the burger icon
  useEffect(() => {
    const bar = panelTabBarRef.current;
    const container = panelTabsContainerRef.current;
    if (!bar || !container) return;
    const measure = () => {
      const children = Array.from(container.children) as HTMLElement[];
      if (children.length === 0) { setVisibleTabCount(Infinity); return; }
      // Reserve width for the always-present hamburger/overflow button plus a
      // small gap. The actual rendered button is ~32 px (w-4 icon + p-1 + p-1);
      // keep a generous margin so rounded widths never cause a one-pixel wrap.
      const OVERFLOW_RESERVE = 44;
      const available = bar.clientWidth - OVERFLOW_RESERVE;
      let total = 0;
      let count = 0;
      for (const child of children) {
        total += child.scrollWidth;
        if (total > available) break;
        count++;
      }
      // Guard against a negative available width (extremely narrow panel):
      // send everything to the hamburger rather than leaving stale visibility.
      if (available <= 0) count = 0;
      setVisibleTabCount(count);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
    // Re-measure when the user drags the panel divider or enters compact
    // (landscape-zoom) mode — ResizeObserver covers most cases but these two
    // states change React's rendered tab count/width faster than the observer
    // can fire reliably in Safari.
  }, [tab, panelWidth, compactMode, hasSession]);

  const visiblePanelTabs = allPanelTabs.slice(0, visibleTabCount);
  const overflowPanelTabs = allPanelTabs.slice(visibleTabCount);

  // Close settings menu on outside click
  useEffect(() => {
    if (!settingsMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) setSettingsMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsMenuOpen]);

  useEffect(() => {
    if (tab === "branch-diff" && diffPr) return;
    // If the current tab is a global tab opened from the dropdown, keep it
    if (tab && isGlobalTab(tab)) return;
    if (tab && !primaryTabs.find((t) => t.id === tab)) setTab(primaryTabs[0].id);
  }, [tab, primaryTabs, diffPr]);

  // Switch to global tabs when no session; auto-open session tabs when one starts
  useEffect(() => {
    if (!activeSession) {
      setTab((prev) => prev && !GLOBAL_TABS.some((g) => g.id === prev) ? "secrets" : prev ?? "secrets");
    } else if (isRunning && tab && GLOBAL_TABS.some((g) => g.id === tab)) {
      setTab("diff");
    }
  }, [activeSession, isRunning]);

  const handleDragHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDraggingRef.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDraggingRef.current || !flexContainerRef.current) return;
      const rect = flexContainerRef.current.getBoundingClientRect();
      const rawPct = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setPanelWidth(clampWidth(rawPct));
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      if (!flexContainerRef.current) return;
      const rect = flexContainerRef.current.getBoundingClientRect();
      const rawPct = ((upEvent.clientX - rect.left) / rect.width) * 100;
      const clamped = clampWidth(rawPct);
      setPanelWidth(clamped);
      localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }, []);

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={
        compactMode
          ? {
              // "Landscape compact": lay out the UI as if the viewport were
              // 1/0.82 ≈ 122% its real size, then CSS-zoom back down so the
              // scaled render exactly fills the viewport. Net effect: content
              // reflows at a larger virtual canvas, so more rows/columns of
              // terminal + more of the panel are visible at once — which is
              // what "tilt shrinks everything" is meant to buy you.
              height: "calc(var(--app-height) / 0.82)",
              width: "calc(100vw / 0.82)",
              zoom: 0.82,
            }
          : { height: "var(--app-height)" }
      }
    >
      {/* Update banner */}
      {updateAvailable && (
        <div className="flex items-center justify-between px-4 py-2 bg-blue-500/15 border-b border-blue-500/30">
          <div className="flex items-center gap-3">
            <ArrowDownToLine className="w-4 h-4 text-blue-400" />
            <span className="text-sm text-blue-300">
              New version available — {updateAvailable.behindCount} commit{updateAvailable.behindCount !== 1 ? "s" : ""} behind
            </span>
            {updateAvailable.commitMessages.length > 0 && (
              <span className="text-xs text-blue-400/70 truncate max-w-md" title={updateAvailable.commitMessages.join("\n")}>
                {updateAvailable.commitMessages[0]}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {updateError && (
              <span className="text-xs text-red-400">{updateError}</span>
            )}
            <button
              onClick={() => setUpdateAvailable(null)}
              className="p-1 text-blue-400/60 hover:text-blue-300 transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleApplyUpdate}
              disabled={updating}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white rounded transition-colors"
            >
              {updating ? (
                <>
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <ArrowDownToLine className="w-3 h-3" />
                  Update &amp; Restart
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* PWA update banner */}
      {swUpdateAvailable && (
        <div className="flex items-center justify-between px-4 py-2 bg-green-500/15 border-b border-green-500/30">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-4 h-4 text-green-400" />
            <span className="text-sm text-green-300">A new version of Vivi is available</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSwUpdateAvailable(false)}
              className="p-1 text-green-400/60 hover:text-green-300 transition-colors"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                navigator.serviceWorker.getRegistration().then((reg) => {
                  if (reg?.waiting) {
                    reg.waiting.postMessage({ type: "SKIP_WAITING" });
                  } else {
                    window.location.reload();
                  }
                });
              }}
              className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-green-500 hover:bg-green-600 text-white rounded transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              Reload
            </button>
          </div>
        </div>
      )}

      {/* Updating overlay */}
      {updating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="flex flex-col items-center gap-4 p-8 bg-[var(--color-surface-raised)] rounded-xl border border-[var(--color-border)]">
            <RefreshCw className="w-10 h-10 text-blue-400 animate-spin" />
            <p className="text-sm font-medium">Updating Vivi...</p>
            <p className="text-xs text-gray-400">Pulling changes, rebuilding, and restarting. This page will reload automatically.</p>
          </div>
        </div>
      )}

      {/* Top bar: session tabs */}
      <header className="flex items-center bg-[var(--color-surface-raised)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3 px-2 sm:px-4 py-2 border-r border-[var(--color-border)]"><img src="/icons/vivi-logo.png" alt="Vivi" className="h-6 sm:h-7" /></div>
        <div className="flex items-center flex-1 overflow-x-auto relative">
          {sessions.map((session) => {
            const isActive = session.id === activeSessionId && !showNewSessionForm;
            const sessionPrCount = pendingPrCounts[session.id] || 0;
            return (
              <button key={session.id} onClick={() => { setActiveSessionId(session.id); setShowNewSessionForm(false); }}
                className={`group flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 text-xs sm:text-sm transition-colors relative border-b-2 ${isActive ? "border-[var(--color-accent)] text-white bg-[var(--color-surface)]" : "border-transparent text-gray-500 hover:text-gray-300 hover:bg-[var(--color-surface)]/50"}`}>
                <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.status === "running" ? "bg-green-400" : session.status === "starting" ? "bg-yellow-400 animate-pulse" : session.status === "error" ? "bg-red-400" : "bg-gray-500"}`} />
                {editingSessionId === session.id ? (
                  <input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onBlur={commitSessionNameEdit}
                    onKeyDown={(e) => { if (e.key === "Enter") commitSessionNameEdit(); if (e.key === "Escape") setEditingSessionId(null); }}
                    onClick={(e) => e.stopPropagation()}
                    className="bg-transparent border-b border-[var(--color-accent)] outline-none text-sm w-28"
                  />
                ) : (
                  <span
                    className="truncate max-w-[80px] sm:max-w-[140px]"
                    onDoubleClick={(e) => { e.stopPropagation(); setEditingSessionId(session.id); setEditingName(sessionNames[session.id] || session.repoName || ""); }}
                    title="Double-click to rename"
                  >{sessionNames[session.id] || session.repoName || "Session"}</span>
                )}
                {sessionPrCount > 0 && <span className="px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-purple-500 text-white">{sessionPrCount}</span>}
                <span onClick={(e) => { e.stopPropagation(); handleStopSession(session.id); }} className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--color-border)] transition-all" title="Stop session"><X className="w-3 h-3" /></span>
              </button>
            );
          })}
          {showRenameTip && (
            <div className="absolute left-[120px] top-full mt-1 z-50 flex items-center gap-2 px-3 py-1.5 bg-[var(--color-accent-muted)] border border-[var(--color-accent)]/40 rounded-lg shadow-lg text-xs text-white whitespace-nowrap animate-fade-in">
              <span>Tip: double-click a tab to rename it</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRenameTip(false);
                  markRenameTipSeen();
                }}
                className="p-0.5 rounded hover:bg-white/10 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <button onClick={() => setShowNewSessionForm(true)} className={`flex items-center gap-1 px-3 py-2 text-sm transition-colors border-b-2 ${showNewSessionForm ? "border-[var(--color-accent)] text-white" : "border-transparent text-gray-500 hover:text-gray-300"}`} title="New session"><Plus className="w-4 h-4" /></button>
        </div>
        <div className="flex items-center gap-2 px-4 py-2 border-l border-[var(--color-border)]">
          {activeSession && activePrCount > 0 && <button onClick={() => { if (isMobile) { setMobileTab("approvals"); setMobileMenuOpen(false); } else setTab("approvals"); }} className="flex items-center gap-1 px-2 py-1 text-xs bg-purple-500/15 text-purple-400 rounded hover:bg-purple-500/25 transition-colors animate-pulse"><GitBranch className="w-3 h-3" /><span className="hidden sm:inline">{activePrCount} branch{activePrCount !== 1 ? "es" : ""}</span></button>}
          {activeSession && alertCount > 0 && <button onClick={() => { if (isMobile) { setMobileTab("monitor"); setMobileMenuOpen(false); } else setTab("monitor"); }} className="flex items-center gap-1 px-2 py-1 text-xs bg-yellow-500/15 text-yellow-400 rounded hover:bg-yellow-500/25 transition-colors"><AlertTriangle className="w-3 h-3" /><span className="hidden sm:inline">{alertCount} alert{alertCount !== 1 ? "s" : ""}</span></button>}
          {(window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true) && <BackendSwitcher />}
          {isMobile ? (
            <div className="relative" ref={mobileMenuRef}>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="relative p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
                title="Menu"
              >
                <Menu className="w-4 h-4" />
                {(secretRequestCount > 0 || alertCount > 0 || activePrCount > 0) && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-500" />
                )}
              </button>
              {mobileMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 w-48 py-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg shadow-xl">
                  {primaryTabs.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => { setMobileTab(t.id); setMobileMenuOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${mobileTab === t.id ? "text-white bg-[var(--color-accent-muted)]/20" : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"}`}
                    >
                      {t.icon}{t.label}
                      {t.id === "monitor" && alertCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-[var(--color-warning)] text-black">{alertCount}</span>}
                      {t.id === "approvals" && activePrCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-purple-500 text-white">{activePrCount}</span>}
                      {t.id === "ports" && activePortCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-500 text-white">{activePortCount}</span>}
                      {t.id === "docker" && activeContainerCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500 text-white">{activeContainerCount}</span>}
                    </button>
                  ))}
                  {hasSession && (
                    <>
                      <div className="border-t border-[var(--color-border)] my-1" />
                      {GLOBAL_TABS.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => { setMobileTab(g.id); setMobileMenuOpen(false); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${mobileTab === g.id ? "text-white bg-[var(--color-accent-muted)]/20" : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"}`}
                        >
                          {g.icon}{g.label}
                          {g.id === "secrets" && secretRequestCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-orange-500 text-white">{secretRequestCount}</span>}
                        </button>
                      ))}
                    </>
                  )}
                  <div className="border-t border-[var(--color-border)] my-1" />
                  <button
                    onClick={() => {
                      const val = !landscapeSplit;
                      setLandscapeSplit(val);
                      localStorage.setItem("mobile-landscape-split", String(val));
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] transition-colors"
                  >
                    <div className={`relative w-8 h-[18px] rounded-full transition-colors ${landscapeSplit ? "bg-[var(--color-accent)]" : "bg-gray-600"}`}>
                      <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${landscapeSplit ? "translate-x-[15px]" : "translate-x-[2px]"}`} />
                    </div>
                    Split view in landscape
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button onClick={() => setTab(tab ? null : primaryTabs[0].id)} className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors" title={tab ? "Close panel" : "Open panel"}><PanelRightOpen className="w-4 h-4" /></button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden" ref={flexContainerRef}>
        <div className="overflow-hidden flex flex-col" style={isMobile ? { flex: 1 } : tab ? { width: `${panelWidth}%` } : { flex: 1 }}>
          {loginMode ? (
            <div className="flex-1 flex flex-col relative">
              <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/20 border border-yellow-500/40 rounded text-xs font-medium text-yellow-400">LOGIN FLOW: ON HOST</div>
              <Terminal mode="setup-token" className="flex-1" onDisconnected={async () => { try { const result = await api.extractToken(); if (result.ok) setSecretsRefreshKey((k) => k + 1); } catch (err) { console.warn("extractToken: failed to extract token on disconnect", err); } setLoginMode(false); setTab("secrets"); }} />
            </div>
          ) : showTerminal && isRunning ? (
            <Terminal sessionId={activeSessionId!} mode="claude" className="flex-1" />
          ) : showTerminal && activeSession?.status === "starting" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-gray-400"><Loader2 className="w-8 h-8 animate-spin text-[var(--color-accent)]" /><p className="text-sm font-medium">Starting sandbox containers...</p><p className="text-xs text-gray-500">Building images and waiting for services</p></div>
          ) : showTerminal && activeSession?.status === "error" ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-400 px-8">
              <AlertTriangle className="w-8 h-8 text-red-400" />
              <p className="text-sm font-medium text-red-400">Session error</p>
              {activeSession.error?.startsWith("Filesystem permission denied") ? (
                <div className="max-w-md space-y-3 text-center">
                  <p className="text-xs text-gray-400 leading-relaxed">
                    macOS is blocking your container runtime from reading files in a protected folder (Documents, Desktop, or Downloads).
                  </p>
                  <div className="text-xs text-gray-300 space-y-1.5 text-left bg-[var(--color-surface)] rounded-lg px-4 py-3 border border-[var(--color-border)]">
                    <p className="font-medium">Fix — choose one:</p>
                    <p>1. System Settings → Privacy & Security → Full Disk Access → enable your container runtime, then restart it</p>
                    <p>2. Move the project to <code className="px-1 py-0.5 bg-[var(--color-surface-raised)] rounded">~/Projects/</code> or another non-protected directory</p>
                  </div>
                </div>
              ) : (
                <pre className="text-xs text-gray-500 whitespace-pre-wrap max-w-xl text-center leading-relaxed">{activeSession.error || "Unknown error"}</pre>
              )}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto flex items-start sm:items-center justify-center p-4 sm:p-8">
              <form onSubmit={handleStart} className="w-full max-w-lg space-y-5 p-6 bg-[var(--color-surface-raised)] rounded-xl border border-[var(--color-border)]">
                <div className="text-center space-y-1"><h2 className="text-xl font-bold">Start Session</h2><p className="text-sm text-gray-400">Create a new sandbox or attach to a running container</p></div>
                {error && (
                  error.startsWith("Filesystem permission denied") ? (
                    <div className="px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                        <span className="text-sm font-semibold text-red-400">Filesystem permission denied</span>
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed">
                        macOS is blocking your container runtime from reading files in a protected folder (Documents, Desktop, or Downloads).
                      </p>
                      <div className="text-xs text-gray-300 space-y-1.5 pt-1">
                        <p className="font-medium text-gray-300">Fix — choose one:</p>
                        <div className="flex items-start gap-2 pl-1">
                          <span className="text-gray-500 shrink-0">1.</span>
                          <span>System Settings → Privacy &amp; Security → Full Disk Access → enable your container runtime (Docker Desktop, OrbStack, or Colima), then restart it</span>
                        </div>
                        <div className="flex items-start gap-2 pl-1">
                          <span className="text-gray-500 shrink-0">2.</span>
                          <span>Move the project to a non-protected directory (e.g. <code className="px-1 py-0.5 bg-[var(--color-surface)] rounded text-gray-300">~/Projects/</code>)</span>
                        </div>
                      </div>
                      <button type="button" onClick={() => setError(null)} className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors pt-1">Dismiss</button>
                    </div>
                  ) : (
                    <div className="px-3 py-2 text-sm bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <pre className="whitespace-pre-wrap font-sans leading-relaxed flex-1">{error}</pre>
                    </div>
                  )
                )}
                <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
                  <button type="button" onClick={() => setSessionMode("new")} className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${sessionMode === "new" ? "bg-[var(--color-accent-muted)] text-white" : "bg-[var(--color-surface)] text-gray-500 hover:text-gray-300"}`}><Plus className="w-4 h-4" />Local Path</button>
                  <button type="button" onClick={() => setSessionMode("github")} className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-l border-[var(--color-border)] ${sessionMode === "github" ? "bg-[var(--color-accent-muted)] text-white" : "bg-[var(--color-surface)] text-gray-500 hover:text-gray-300"}`}><Github className="w-4 h-4" />From GitHub</button>
                  <button type="button" onClick={() => setSessionMode("attach")} disabled={runningSessions.length === 0} className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium transition-colors border-l border-[var(--color-border)] ${sessionMode === "attach" ? "bg-[var(--color-accent-muted)] text-white" : "bg-[var(--color-surface)] text-gray-500 hover:text-gray-300 disabled:opacity-30 disabled:cursor-not-allowed"}`}><Container className="w-4 h-4" />Attach to Running</button>
                </div>
                {sessionMode === "new" ? (
                  <div className="space-y-4">
                    <label className="block"><span className="text-xs text-gray-400 mb-1 block">Repository Path</span><PathInput value={form.repoPath} onChange={(v) => setForm({ ...form, repoPath: v, taskDescription: "" })} placeholder="/path/to/your/repo" className="w-full pl-10 pr-9 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg text-sm font-mono focus:border-[var(--color-accent)] focus:outline-none" /></label>
                    {!form.repoPath && getRecentPaths().length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-xs text-gray-500">Recent</span>
                        <div className="flex flex-wrap gap-1.5">
                          {getRecentPaths().map((p) => (
                            <button key={p} type="button" onClick={() => setForm({ ...form, repoPath: p })} className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md text-gray-400 hover:text-white hover:border-[var(--color-accent)] transition-colors truncate max-w-[280px]">
                              <FolderGit2 className="w-3 h-3 shrink-0" />
                              {p.split("/").slice(-2).join("/")}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {form.repoPath && (
                      <GitHubIssues
                        repoPath={form.repoPath}
                        onTaskDescriptionChange={(desc) => setForm((f) => ({ ...f, taskDescription: desc }))}
                      />
                    )}
                  </div>
                ) : sessionMode === "github" ? (
                  githubConfigured === null ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-4"><Loader2 className="w-4 h-4 animate-spin" /> Checking GitHub connection...</div>
                  ) : !githubConfigured ? (
                    <div className="px-4 py-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg space-y-2 text-sm text-gray-300">
                      <div className="flex items-center gap-2"><Github className="w-4 h-4 text-[var(--color-accent)]" /><span className="font-medium">Connect GitHub first</span></div>
                      <p className="text-xs text-gray-400">Paste a Personal Access Token in the Secrets tab to import remote repositories.</p>
                      <button type="button" onClick={() => setTab("secrets")} className="text-xs text-[var(--color-accent)] hover:underline">Open Secrets &rarr;</button>
                    </div>
                  ) : (
                    <GitHubRepoPicker
                      value={form.githubRepo}
                      onChange={(sel) => setForm((f) => ({ ...f, githubRepo: sel }))}
                      onNotConnected={() => setGithubConfigured(false)}
                    />
                  )
                ) : (
                  <div className="space-y-2">
                    <span className="text-xs text-gray-400 block">Running Containers</span>
                    {runningSessions.length === 0 ? <p className="text-sm text-gray-500 py-4 text-center">No running containers to attach to.</p> : (
                      <div className="space-y-1.5 max-h-48 overflow-auto">
                        {runningSessions.map((s) => (
                          <button key={s.id} type="button" onClick={() => setAttachTarget(s.id)} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left text-sm transition-colors ${attachTarget === s.id ? "border-[var(--color-accent)] bg-[var(--color-accent-muted)]/20 text-white" : "border-[var(--color-border)] bg-[var(--color-surface)] text-gray-400 hover:text-gray-200 hover:border-gray-600"}`}>
                            <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
                            <div className="min-w-0 flex-1"><div className="font-medium truncate">{s.repoName || "Session"}</div><div className="text-xs text-gray-500 font-mono truncate">{s.id} &middot; {s.branch}</div></div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {sessionMode !== "attach" && availableProfiles.length > 0 && (
                  <div className="flex items-center gap-2">
                    <UserCircle className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <select
                      value={form.profileId}
                      onChange={(e) => setForm({ ...form, profileId: e.target.value })}
                      className="flex-1 px-2 py-1.5 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none text-gray-300"
                    >
                      <option value="">No profile</option>
                      {availableProfiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {sessionMode !== "attach" && sandboxImages.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Box className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <select
                      value={form.imageId}
                      onChange={(e) => setForm({ ...form, imageId: e.target.value })}
                      className="flex-1 px-2 py-1.5 text-xs bg-[var(--color-surface)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none text-gray-300"
                    >
                      {sandboxImages.map((img) => (
                        <option key={img.id} value={img.id}>{img.name}{img.isDefault ? " (default)" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}
                <button type="submit" disabled={starting || (sessionMode === "new" && !form.repoPath) || (sessionMode === "github" && !form.githubRepo) || (sessionMode === "attach" && !attachTarget)} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
                  {starting ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />{sessionMode === "attach" ? "Attaching..." : "Starting sandbox..."}</> : sessionMode === "attach" ? <><Container className="w-4 h-4" />Attach Session</> : <><Play className="w-4 h-4" />Launch Sandbox</>}
                </button>
                <p className="text-xs text-gray-500 text-center">{sessionMode === "attach" ? "A new terminal session will connect to the selected container." : "Make sure to add your Anthropic API key in the Secrets tab before starting."}</p>
              </form>
            </div>
          )}
        </div>

        {tab && !isMobile && (
          <div
            className="w-1 shrink-0 cursor-col-resize group flex items-center justify-center hover:bg-[var(--color-border)]/40 transition-colors"
            style={{ width: "4px" }}
            onPointerDown={handleDragHandlePointerDown}
          >
            <div className="w-px h-8 bg-[var(--color-border)] group-hover:bg-[var(--color-accent)]/60 transition-colors rounded-full" />
          </div>
        )}

        {tab && !isMobile && (
          <div className="flex flex-col overflow-hidden" style={{ flex: 1 }}>
              <>
                <div className="flex items-center bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] shrink-0 relative z-20" ref={panelTabBarRef}>
                  {/* Hidden measurement container — renders all tabs offscreen to measure widths */}
                  <div ref={panelTabsContainerRef} className="flex items-center absolute invisible pointer-events-none" aria-hidden="true">
                    {allPanelTabs.map((t) => (
                      <span key={t.id} className="flex items-center gap-1.5 px-4 py-2 text-sm whitespace-nowrap">
                        {t.icon}{t.label}
                      </span>
                    ))}
                  </div>
                  {visiblePanelTabs.map((t) => (
                    <button key={t.id} onClick={() => { setTab(t.id); setSettingsMenuOpen(false); if (t.id !== "approvals") setDiffPr(null); }} className={`flex items-center gap-1.5 px-4 py-2 text-sm transition-colors relative border-b-2 shrink-0 ${(tab === t.id || (tab === "branch-diff" && t.id === "approvals")) ? "border-[var(--color-accent)] text-white" : "border-transparent text-gray-500 hover:text-gray-300"}`}>
                      {t.icon}{t.label}
                      {t.id === "monitor" && alertCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-[var(--color-warning)] text-black">{alertCount}</span>}
                      {t.id === "approvals" && activePrCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-purple-500 text-white">{activePrCount}</span>}
                      {t.id === "ports" && activePortCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-500 text-white">{activePortCount}</span>}
                      {t.id === "docker" && activeContainerCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500 text-white">{activeContainerCount}</span>}
                      {t.id === "secrets" && secretRequestCount > 0 && <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-orange-500 text-white">{secretRequestCount}</span>}
                    </button>
                  ))}
                  {overflowPanelTabs.length > 0 && (
                    <div className="ml-auto flex items-center gap-1 mr-2 shrink-0">
                      <div className="relative" ref={settingsMenuRef}>
                        <button
                          onClick={() => setSettingsMenuOpen(!settingsMenuOpen)}
                          className={`relative p-1 rounded transition-colors ${overflowPanelTabs.some((t) => t.id === tab) ? "text-[var(--color-accent)]" : "text-gray-500 hover:text-gray-300"}`}
                          title="More tabs"
                        >
                          <Menu className="w-4 h-4" />
                          {overflowPanelTabs.some((t) =>
                            (t.id === "monitor" && alertCount > 0) ||
                            (t.id === "approvals" && activePrCount > 0) ||
                            (t.id === "ports" && activePortCount > 0) ||
                            (t.id === "docker" && activeContainerCount > 0) ||
                            (t.id === "secrets" && secretRequestCount > 0)
                          ) && (
                            <span className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center text-[9px] font-bold rounded-full bg-orange-500 text-white animate-pulse" />
                          )}
                        </button>
                        {settingsMenuOpen && (
                          <div className="absolute right-0 top-full mt-1 z-50 w-44 py-1 bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded-lg shadow-xl">
                            {overflowPanelTabs.map((t) => (
                              <button
                                key={t.id}
                                onClick={() => { setTab(t.id); setSettingsMenuOpen(false); if (t.id !== "approvals") setDiffPr(null); }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${tab === t.id ? "text-white bg-[var(--color-accent-muted)]/20" : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"}`}
                              >
                                {t.icon}{t.label}
                                {t.id === "monitor" && alertCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-[var(--color-warning)] text-black">{alertCount}</span>}
                                {t.id === "approvals" && activePrCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-purple-500 text-white">{activePrCount}</span>}
                                {t.id === "ports" && activePortCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-blue-500 text-white">{activePortCount}</span>}
                                {t.id === "docker" && activeContainerCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-cyan-500 text-white">{activeContainerCount}</span>}
                                {t.id === "secrets" && secretRequestCount > 0 && <span className="ml-auto px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-orange-500 text-white">{secretRequestCount}</span>}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {previewPort ? (
                  <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] min-h-[36px] shrink-0">
                      <Network className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                      <span className="text-xs font-semibold truncate min-w-0">
                        {previewPort.label || `Port ${previewPort.containerPort}`}
                      </span>
                      <span className="text-[10px] text-gray-600 shrink-0 font-mono">
                        {previewPort.proxySubdomain || `${host}:${previewPort.hostPort}`}
                      </span>
                      <span className="flex-1" />
                      <a
                        href={getPortForwardUrl(previewPort)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
                        title="Open in new tab"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <button
                        onClick={() => setPreviewFullscreen(!previewFullscreen)}
                        className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
                        title={previewFullscreen ? "Exit fullscreen" : "Fullscreen"}
                      >
                        {previewFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => { setPreviewPort(null); setPreviewFullscreen(false); }}
                        className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
                        title="Close preview"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <iframe
                      src={getPortForwardUrl(previewPort)}
                      className="flex-1 w-full border-0 bg-white"
                      title={`Preview: ${previewPort.label || `Port ${previewPort.containerPort}`}`}
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                    />
                  </div>
                ) : tab === "branch-diff" && diffPr ? (
                  <DiffView prId={diffPr.id} prTitle={diffPr.title} onClose={() => { setDiffPr(null); setTab("approvals"); }} />
                ) : tab === "diff" && activeSessionId ? (
                  <LiveDiffView sessionId={activeSessionId} />
                ) : (
                  <div className="flex-1 overflow-auto p-5">
                    {tab === "secrets" && (
                      <div className="space-y-6">
                        <SecretManager onLoginStart={() => setLoginMode(true)} refreshKey={secretsRefreshKey} pendingRequests={secretRequests.filter((r) => r.status === "pending")} onDismissRequest={(id) => { api.dismissSecretRequest(id); setSecretRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: "dismissed" as const } : r)); }} />
                        <div className="pt-6 border-t border-[var(--color-border)]">
                          <GitHubSettings onStatusChange={(s) => setGithubConfigured(s.configured)} />
                        </div>
                      </div>
                    )}
                    {tab === "allowlist" && <Allowlist />}
                    {tab === "profiles" && <ProfileManager />}
                    {tab === "images" && <SandboxImages />}
                    {tab === "monitor" && <ProgressMonitor sessionId={activeSessionId || undefined} onStuckChange={(stuck, flashEnabled) => { monitorFlashEnabledRef.current = flashEnabled; setMonitorFlashing(stuck && flashEnabled); }} />}
                    {tab === "approvals" && activeSessionId && <Approvals sessionId={activeSessionId} sessionNames={Object.fromEntries(sessions.map((s) => [s.id, sessionNames[s.id] || s.repoName || "Session"]))} onViewDiff={(prId, prTitle) => { setDiffPr({ id: prId, title: prTitle }); setTab("branch-diff"); }} />}
                    {tab === "ports" && activeSessionId && <PortForwards sessionId={activeSessionId} onPreview={(pf) => { setPreviewPort(pf); }} />}
                    {tab === "docker" && activeSessionId && <DockerContainers sessionId={activeSessionId} onContainerCount={(count) => setContainerCounts((prev) => ({ ...prev, [activeSessionId]: count }))} />}
                    {tab === "logs" && activeSessionId && <SandboxLogs sessionId={activeSessionId} />}
                  </div>
                )}
              </>
          </div>
        )}
      </div>
      {/* Virtual-keyboard control row — gives coding-agent TUIs the arrow /
          escape / ctrl keys iOS & Android keyboards don't expose. Only
          rendered while the on-screen keyboard is up and a terminal session
          is actually attached. Sits at the bottom of the visual viewport,
          which tracks the keyboard via `--app-height`. */}
      {isSmallScreen && keyboardOpen && showTerminal && isRunning && !mobileTab && (
        <MobileKeyToolbar />
      )}
      {/* Mobile tab overlay */}
      {isMobile && mobileTab && (
        <div className="fixed inset-0 z-40 flex flex-col bg-[var(--color-surface)]">
          <div className="flex items-center gap-2 px-3 py-2 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] shrink-0">
            <button
              onClick={() => setMobileTab(null)}
              className="p-1 text-gray-400 hover:text-white transition-colors"
              title="Back to terminal"
            >
              <X className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium text-white">
              {[...SESSION_TABS, ...GLOBAL_TABS].find((t) => t.id === mobileTab)?.label || ""}
            </span>
          </div>
          <div className="flex-1 overflow-auto">
            {previewPort ? (
              <div className="flex flex-col h-full">
                <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] min-h-[36px] shrink-0">
                  <Network className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                  <span className="text-xs font-semibold truncate min-w-0">{previewPort.label || `Port ${previewPort.containerPort}`}</span>
                  <span className="flex-1" />
                  <button onClick={() => { setPreviewPort(null); }} className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors" title="Close preview"><X className="w-3.5 h-3.5" /></button>
                </div>
                <iframe src={getPortForwardUrl(previewPort)} className="flex-1 w-full border-0 bg-white" title={`Preview: ${previewPort.label || `Port ${previewPort.containerPort}`}`} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" />
              </div>
            ) : mobileTab === "branch-diff" && diffPr ? (
              <DiffView prId={diffPr.id} prTitle={diffPr.title} onClose={() => { setDiffPr(null); setMobileTab("approvals"); }} />
            ) : mobileTab === "diff" && activeSessionId ? (
              <LiveDiffView sessionId={activeSessionId} />
            ) : (
              <div className="flex-1 overflow-auto p-4">
                {mobileTab === "secrets" && (
                  <div className="space-y-6">
                    <SecretManager onLoginStart={() => setLoginMode(true)} refreshKey={secretsRefreshKey} pendingRequests={secretRequests.filter((r) => r.status === "pending")} onDismissRequest={(id) => { api.dismissSecretRequest(id); setSecretRequests((prev) => prev.map((r) => r.id === id ? { ...r, status: "dismissed" as const } : r)); }} />
                    <div className="pt-6 border-t border-[var(--color-border)]">
                      <GitHubSettings onStatusChange={(s) => setGithubConfigured(s.configured)} />
                    </div>
                  </div>
                )}
                {mobileTab === "allowlist" && <Allowlist />}
                {mobileTab === "profiles" && <ProfileManager />}
                {mobileTab === "images" && <SandboxImages />}
                {mobileTab === "monitor" && <ProgressMonitor sessionId={activeSessionId || undefined} onStuckChange={(stuck, flashEnabled) => { monitorFlashEnabledRef.current = flashEnabled; setMonitorFlashing(stuck && flashEnabled); }} />}
                {mobileTab === "approvals" && activeSessionId && <Approvals sessionId={activeSessionId} sessionNames={Object.fromEntries(sessions.map((s) => [s.id, sessionNames[s.id] || s.repoName || "Session"]))} onViewDiff={(prId, prTitle) => { setDiffPr({ id: prId, title: prTitle }); setMobileTab("branch-diff"); }} />}
                {mobileTab === "ports" && activeSessionId && <PortForwards sessionId={activeSessionId} onPreview={(pf) => { setPreviewPort(pf); }} />}
                {mobileTab === "docker" && activeSessionId && <DockerContainers sessionId={activeSessionId} onContainerCount={(count) => setContainerCounts((prev) => ({ ...prev, [activeSessionId]: count }))} />}
                {mobileTab === "logs" && activeSessionId && <SandboxLogs sessionId={activeSessionId} />}
              </div>
            )}
          </div>
        </div>
      )}
      {previewPort && previewFullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
          <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] min-h-[36px] shrink-0">
            <Network className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
            <span className="text-xs font-semibold truncate min-w-0">
              {previewPort.label || `Port ${previewPort.containerPort}`}
            </span>
            <span className="text-[10px] text-gray-600 shrink-0 font-mono">
              {previewPort.proxySubdomain || `${host}:${previewPort.hostPort}`}
            </span>
            <span className="flex-1" />
            <a
              href={getPortForwardUrl(previewPort)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={() => setPreviewFullscreen(false)}
              className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
              title="Exit fullscreen"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => { setPreviewPort(null); setPreviewFullscreen(false); }}
              className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors"
              title="Close preview"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <iframe
            src={getPortForwardUrl(previewPort)}
            className="flex-1 w-full border-0 bg-white"
            title={`Preview: ${previewPort.label || `Port ${previewPort.containerPort}`}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        </div>
      )}
    </div>
  );
}
