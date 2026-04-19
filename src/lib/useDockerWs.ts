import { useState, useEffect, useRef, useCallback } from "react";
import type { DockerContainer, DockerLogEntry, DockerWsOutgoing } from "./types";
import { getWsBase } from "./backend";

const MAX_LOG_LINES = 5000;

export interface UseDockerWs {
  containers: DockerContainer[];
  connected: boolean;
  subscribeLogs: (containerId: string, tail?: number) => void;
  unsubscribeLogs: (containerId: string) => void;
  requestInspect: (containerId: string) => void;
  logs: Map<string, DockerLogEntry[]>;
  inspectData: Map<string, Record<string, any>>;
  clearLogs: (containerId: string) => void;
}

export function useDockerWs(sessionId: string): UseDockerWs {
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Map<string, DockerLogEntry[]>>(new Map());
  const [inspectData, setInspectData] = useState<Map<string, Record<string, any>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      if (disposed) return;
      const ws = new WebSocket(
        `${getWsBase()}/docker?sessionId=${encodeURIComponent(sessionId)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (!disposed) setConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const msg: DockerWsOutgoing = JSON.parse(event.data);
          if (msg.type === "containers") {
            setContainers(msg.data);
          } else if (msg.type === "log") {
            setLogs((prev) => {
              const next = new Map(prev);
              const existing = next.get(msg.containerId) ?? [];
              const entry: DockerLogEntry = { stream: msg.stream, data: msg.data };
              const updated = [...existing, entry];
              // Trim to max lines
              next.set(msg.containerId, updated.length > MAX_LOG_LINES
                ? updated.slice(updated.length - MAX_LOG_LINES)
                : updated);
              return next;
            });
          } else if (msg.type === "log_end") {
            // Keep logs, just stop updating
          } else if (msg.type === "inspect") {
            setInspectData((prev) => {
              const next = new Map(prev);
              next.set(msg.containerId, msg.data);
              return next;
            });
          }
        } catch (err) { console.warn("Failed to parse Docker WebSocket message:", err); }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = (err) => { console.warn("Docker WebSocket error:", err); };
    }

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  const send = useCallback((msg: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const subscribeLogs = useCallback((containerId: string, tail?: number) => {
    send({ type: "subscribe_logs", containerId, tail: tail ?? 500 });
  }, [send]);

  const unsubscribeLogs = useCallback((containerId: string) => {
    send({ type: "unsubscribe_logs", containerId });
  }, [send]);

  const requestInspect = useCallback((containerId: string) => {
    send({ type: "inspect", containerId });
  }, [send]);

  const clearLogs = useCallback((containerId: string) => {
    setLogs((prev) => {
      const next = new Map(prev);
      next.set(containerId, []);
      return next;
    });
  }, []);

  return {
    containers,
    connected,
    subscribeLogs,
    unsubscribeLogs,
    requestInspect,
    logs,
    inspectData,
    clearLogs,
  };
}
