import { v4 as uuidv4 } from "uuid";

const STORAGE_KEY = "vivi:backends";

export interface BackendConfig {
  id: string;
  name: string;
  url: string; // e.g. "https://myserver.example.com" — empty string means same-origin
  isActive: boolean;
}

export function getBackends(): BackendConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.warn("Failed to read backends from localStorage:", err);
    return [];
  }
}

function saveBackends(backends: BackendConfig[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(backends));
}

export function getActiveBackend(): BackendConfig | null {
  return getBackends().find((b) => b.isActive) ?? null;
}

export function setActiveBackendId(id: string): void {
  const backends = getBackends().map((b) => ({ ...b, isActive: b.id === id }));
  saveBackends(backends);
}

export function clearActiveBackend(): void {
  const backends = getBackends().map((b) => ({ ...b, isActive: false }));
  saveBackends(backends);
}

export function addBackend(name: string, url: string): BackendConfig {
  const backends = getBackends();
  const config: BackendConfig = {
    id: uuidv4(),
    name,
    url: url.replace(/\/+$/, ""), // strip trailing slashes
    isActive: false,
  };
  backends.push(config);
  saveBackends(backends);
  return config;
}

export function updateBackend(id: string, patch: Partial<Pick<BackendConfig, "name" | "url">>): void {
  const backends = getBackends().map((b) => {
    if (b.id !== id) return b;
    return {
      ...b,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url !== undefined ? { url: patch.url.replace(/\/+$/, "") } : {}),
    };
  });
  saveBackends(backends);
}

export function removeBackend(id: string): void {
  saveBackends(getBackends().filter((b) => b.id !== id));
}

/**
 * Returns the API base URL for fetch calls.
 * "/api" for same-origin, "https://remote/api" for remote backends.
 */
export function getApiBase(): string {
  const active = getActiveBackend();
  if (!active || !active.url) return "/api";
  return `${active.url}/api`;
}

/**
 * Returns the WebSocket base URL.
 * "ws://localhost:7700/ws" for same-origin, "wss://remote/ws" for remote.
 */
export function getWsBase(): string {
  const active = getActiveBackend();
  if (!active || !active.url) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
  }
  const wsProto = active.url.startsWith("https") ? "wss:" : "ws:";
  const host = active.url.replace(/^https?:\/\//, "");
  return `${wsProto}//${host}/ws`;
}

/**
 * Test connectivity to a backend URL. Returns true if reachable.
 */
export async function testBackendConnection(url: string): Promise<boolean> {
  try {
    const base = url ? `${url.replace(/\/+$/, "")}/api` : "/api";
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
