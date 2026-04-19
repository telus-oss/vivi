/**
 * ghostty-web terminal component.
 *
 * Connects to the backend WebSocket PTY server and renders a full interactive
 * terminal. Adapted from the breach/quack terminal component.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { getWsBase } from "../lib/backend";
import type { Terminal as GhosttyTerminal } from "ghostty-web";

interface TerminalProps {
  /** "claude" for Claude Code session, "shell" for raw bash, "setup-token" for auth */
  mode?: "claude" | "shell" | "setup-token";
  /** Session ID for multi-session support */
  sessionId?: string;
  className?: string;
  onConnected?: (sessionId: string) => void;
  onDisconnected?: () => void;
}

type Status = "connecting" | "connected" | "disconnected" | "fatal";

// Lazy-load ghostty-web (WASM)
let ghosttyModule: any = null;
let initPromise: Promise<void> | null = null;

async function ensureGhosttyInit() {
  if (ghosttyModule) return ghosttyModule;
  if (initPromise) {
    await initPromise;
    return ghosttyModule;
  }
  initPromise = (async () => {
    const mod = await import("ghostty-web");
    await mod.init();
    ghosttyModule = mod;
  })();
  await initPromise;
  return ghosttyModule;
}

export function Terminal({
  mode = "claude",
  sessionId,
  className,
  onConnected,
  onDisconnected,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<GhosttyTerminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pasteHandlerRef = useRef<((e: ClipboardEvent) => void) | null>(null);
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const pingWorkerRef = useRef<Worker | null>(null);
  const visibilityHandlerRef = useRef<(() => void) | null>(null);
  const visualViewportHandlerRef = useRef<(() => void) | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const callbacksRef = useRef({ onConnected, onDisconnected });
  const [status, setStatus] = useState<Status>("disconnected");
  const [refreshKey, setRefreshKey] = useState(0);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [isSmallScreen, setIsSmallScreen] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches,
  );

  // Track the iOS on-screen keyboard via visualViewport so we can show a
  // dismiss hint on the status bar. The status bar itself is the blur target.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const check = () => setKeyboardOpen(window.innerHeight - vv.height > 120);
    check();
    vv.addEventListener("resize", check);
    vv.addEventListener("scroll", check);
    return () => {
      vv.removeEventListener("resize", check);
      vv.removeEventListener("scroll", check);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const handler = (e: MediaQueryListEvent) => setIsSmallScreen(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const dismissKeyboardIfMobile = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSmallScreen) return;
    // Ignore taps that land on actual interactive controls so the refresh
    // button still works.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") active.blur();
  }, [isSmallScreen]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  callbacksRef.current = { onConnected, onDisconnected };

  useEffect(() => {
    let cancelled = false;
    let fatalError = false;

    let fitAddonRef: any = null;

    function connect(term: GhosttyTerminal) {
      if (cancelled || fatalError) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      setStatus("connecting");

      // Get dimensions from the FitAddon which calculates them from the
      // actual DOM container size and font metrics — not hardcoded defaults.
      const proposed = fitAddonRef?.proposeDimensions?.();
      const cols = proposed?.cols || (term as any).cols || 80;
      const rows = proposed?.rows || (term as any).rows || 24;
      const sessionParam = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
      const url = `${getWsBase()}/terminal?cols=${cols}&rows=${rows}&mode=${mode}${sessionParam}`;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("connected");
        // If the terminal was resized while disconnected, send the stashed
        // resize now. Defer it so the replay buffer is processed first.
        if (pendingResizeRef.current) {
          const dims = pendingResizeRef.current;
          pendingResizeRef.current = null;
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
            }
          }, 100);
        }
        // Keepalive ping every 30s to prevent proxies/LBs from closing idle connections.
        // We use a Web Worker for the interval so it keeps firing even when the tab is
        // hidden — browsers throttle main-thread timers on background tabs, which would
        // cause the ping to be delayed and the connection to drop.
        if (!pingWorkerRef.current) {
          pingWorkerRef.current = new Worker("/timer-worker.js");
        }
        const worker = pingWorkerRef.current;
        worker.onmessage = () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        };
        worker.postMessage({ type: "interval:start", id: "ping", ms: 30_000 });
        ws.addEventListener("close", () => {
          worker.postMessage({ type: "interval:stop", id: "ping" });
          worker.onmessage = null;
        });
      };

      ws.onmessage = (event) => {
        const data = event.data as string;

        // Check for session info JSON
        if (data.startsWith("{")) {
          const nlIdx = data.indexOf("\n");
          const jsonPart = nlIdx >= 0 ? data.slice(0, nlIdx) : data;
          try {
            const msg = JSON.parse(jsonPart);
            if (msg.type === "session" && msg.id) {
              callbacksRef.current.onConnected?.(msg.id);
              if (nlIdx >= 0 && nlIdx < data.length - 1) {
                term.write(data.slice(nlIdx + 1));
              }
              return;
            }
            if (msg.type === "error") {
              if (msg.fatal) {
                fatalError = true;
                setStatus("fatal");
              }
              term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
              return;
            }
          } catch {
            // Not JSON
          }
        }

        term.write(data);
      };

      ws.onclose = () => {
        if (fatalError) {
          setStatus("fatal");
        } else {
          setStatus("disconnected");
        }
        callbacksRef.current.onDisconnected?.();
        wsRef.current = null;

        if (!cancelled && !fatalError) {
          reconnectTimer.current = setTimeout(() => connect(term), 3000);
        }
      };

      ws.onerror = () => {};
    }

    (async () => {
      const mod = await ensureGhosttyInit();
      if (cancelled || !containerRef.current) return;

      const term: GhosttyTerminal = new mod.Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "JetBrains Mono, Menlo, Monaco, Consolas, monospace",
        theme: {
          background: "#0d1117",
          foreground: "#e6edf3",
          cursor: "#e6edf3",
          cursorAccent: "#0d1117",
          selectionBackground: "#264f78",
          selectionForeground: "#ffffff",
          black: "#484f58",
          red: "#ff7b72",
          green: "#3fb950",
          yellow: "#d29922",
          blue: "#58a6ff",
          magenta: "#bc8cff",
          cyan: "#39d353",
          white: "#e6edf3",
          brightBlack: "#6e7681",
          brightRed: "#ffa198",
          brightGreen: "#56d364",
          brightYellow: "#e3b341",
          brightBlue: "#79c0ff",
          brightMagenta: "#d2a8ff",
          brightCyan: "#56d364",
          brightWhite: "#ffffff",
        },
        scrollback: 10000,
      });

      const fitAddon = new mod.FitAddon();
      fitAddonRef = fitAddon;
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      // Initial fit — may get wrong dimensions if flex layout hasn't settled.
      // We'll re-fit after layout completes before connecting the WebSocket.
      fitAddon.fit();
      (term as any).scrollToBottom?.();

      // Use a debounced ResizeObserver instead of fitAddon.observeResize() to
      // avoid the scroll-to-top flash that occurs when fit() is called mid-output.
      const debouncedRefit = () => {
        if (resizeDebounce.current) clearTimeout(resizeDebounce.current);
        resizeDebounce.current = setTimeout(() => {
          fitAddon.fit();
          // Re-anchor to the latest output after every fit — otherwise iOS
          // keyboard open/close, orientation change, or panel resize can leave
          // the last lines cut off with no way to scroll.
          (term as any).scrollToBottom?.();
        }, 50);
      };
      resizeObserverRef.current = new ResizeObserver(debouncedRefit);
      resizeObserverRef.current.observe(containerRef.current!);

      // iOS Safari: the DOM container doesn't resize when the on-screen keyboard
      // opens — only the visual viewport shrinks. Hook that too so the terminal
      // reflows above the keyboard.
      const vv = typeof window !== "undefined" ? window.visualViewport : null;
      if (vv) {
        vv.addEventListener("resize", debouncedRefit);
        visualViewportHandlerRef.current = debouncedRefit;
      }

      termRef.current = term;

      // Expose a send hook for the on-screen MobileKeyToolbar. We overwrite the
      // global on each mount so whichever Terminal is currently mounted owns it;
      // cleanup below clears it so a stale reference never points at a dead WS.
      window.__viviSendKey = (data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      };

      term.onData((data: string) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      // Intercept Shift+Tab before the browser steals it for focus navigation.
      // Send the standard reverse-tab escape sequence (\x1b[Z) so Claude Code
      // can use it for mode switching.
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Tab" && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send("\x1b[Z");
          }
        }
      };
      keydownHandlerRef.current = handleKeyDown;
      containerRef.current!.addEventListener("keydown", handleKeyDown, true);

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
          pendingResizeRef.current = null;
        } else {
          // Stash the resize so we can send it when the WS reconnects.
          pendingResizeRef.current = { cols, rows };
        }
      });

      // Image paste: intercept paste events containing images, upload to container,
      // then type the file path so Claude can reference the image with @path.
      const handlePaste = (e: ClipboardEvent) => {
        if (!e.clipboardData || !sessionId) return;
        const items = Array.from(e.clipboardData.items);
        const imageItem = items.find((i) => i.type.startsWith("image/"));
        if (!imageItem) return;

        // Prevent the terminal from trying to handle image data as text
        e.preventDefault();
        e.stopPropagation();

        const file = imageItem.getAsFile();
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const ext = imageItem.type.split("/")[1]?.split("+")[0] || "png";
          try {
            const res = await fetch(`/api/sessions/${sessionId}/upload-image`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data: base64, ext }),
            });
            const json = await res.json();
            if (json.path && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(`@${json.path}`);
            }
          } catch {
            // silently ignore upload failures
          }
        };
        reader.readAsDataURL(file);
      };

      pasteHandlerRef.current = handlePaste;
      // Use capture phase so we intercept before ghostty-web's canvas handler.
      window.addEventListener("paste", handlePaste, true);

      // When the tab becomes visible again, reconnect immediately instead of
      // waiting for the throttled reconnect timer to fire.
      const handleVisibilityChange = () => {
        if (
          document.visibilityState === "visible" &&
          wsRef.current?.readyState !== WebSocket.OPEN &&
          wsRef.current?.readyState !== WebSocket.CONNECTING
        ) {
          if (reconnectTimer.current) {
            clearTimeout(reconnectTimer.current);
            reconnectTimer.current = null;
          }
          connect(term);
        }
      };
      visibilityHandlerRef.current = handleVisibilityChange;
      document.addEventListener("visibilitychange", handleVisibilityChange);

      // Defer connection until the browser has completed layout so
      // fitAddon.fit() calculates accurate cols/rows from the container's
      // final dimensions. Without this, flex layout may not have settled
      // and the PTY gets spawned with wrong dimensions.
      requestAnimationFrame(() => {
        if (cancelled) return;
        fitAddon.fit();
        connect(term);
      });
    })();

    return () => {
      cancelled = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (resizeDebounce.current) clearTimeout(resizeDebounce.current);
      if (pasteHandlerRef.current) {
        window.removeEventListener("paste", pasteHandlerRef.current, true);
        pasteHandlerRef.current = null;
      }
      if (keydownHandlerRef.current && containerRef.current) {
        containerRef.current.removeEventListener("keydown", keydownHandlerRef.current, true);
        keydownHandlerRef.current = null;
      }
      if (visibilityHandlerRef.current) {
        document.removeEventListener("visibilitychange", visibilityHandlerRef.current);
        visibilityHandlerRef.current = null;
      }
      if (visualViewportHandlerRef.current && typeof window !== "undefined" && window.visualViewport) {
        window.visualViewport.removeEventListener("resize", visualViewportHandlerRef.current);
        visualViewportHandlerRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      // Clear container so old terminal content doesn't overlay the next session
      if (containerRef.current) {
        containerRef.current.innerHTML = "";
      }
      if (pingWorkerRef.current) {
        pingWorkerRef.current.terminate();
        pingWorkerRef.current = null;
      }
      if (typeof window !== "undefined" && window.__viviSendKey) {
        window.__viviSendKey = undefined;
      }
    };
  }, [mode, sessionId, refreshKey]);

  // Key the container on sessionId + refreshKey so React creates a fresh DOM
  // node when switching sessions or refreshing. This guarantees the old
  // terminal's canvas/WebGL context is fully discarded — no leftover artifacts.
  const containerKey = `${sessionId || mode}-${refreshKey}`;

  return (
    <div className={`flex flex-col ${className || ""}`}>
      <div
        onPointerUp={dismissKeyboardIfMobile}
        className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] cursor-pointer select-none"
      >
        <div
          className={`h-2 w-2 rounded-full ${
            status === "connected"
              ? "bg-[var(--color-success)]"
              : status === "connecting"
                ? "bg-[var(--color-warning)] animate-pulse"
                : "bg-[var(--color-danger)]"
          }`}
        />
        <span className="text-xs text-gray-400 font-mono">
          {status === "connected"
            ? `Connected (${mode})`
            : status === "connecting"
              ? "Connecting..."
              : status === "fatal"
                ? "Error"
                : "Disconnected"}
        </span>
        {isSmallScreen && keyboardOpen && (
          <span className="text-[10px] text-[var(--color-accent)] font-medium ml-2">
            Tap here to close keyboard
          </span>
        )}
        <button
          onClick={refresh}
          className="ml-auto p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-[var(--color-border)] transition-colors"
          title="Refresh terminal"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
      <div
        key={containerKey}
        ref={containerRef}
        className="flex-1 overflow-hidden min-h-0"
        style={{ backgroundColor: "#0d1117" }}
      />
    </div>
  );
}
