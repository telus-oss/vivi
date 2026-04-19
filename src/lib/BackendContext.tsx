import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import {
  type BackendConfig,
  getBackends,
  getApiBase,
  getWsBase,
  addBackend as addBackendStorage,
  removeBackend as removeBackendStorage,
  updateBackend as updateBackendStorage,
  setActiveBackendId,
  clearActiveBackend,
  getActiveBackend,
} from "./backend";

interface BackendContextValue {
  activeBackend: BackendConfig | null;
  backends: BackendConfig[];
  apiBase: string;
  wsBase: string;
  switchBackend: (id: string | null) => void;
  addBackend: (name: string, url: string) => BackendConfig;
  removeBackend: (id: string) => void;
  updateBackend: (id: string, patch: Partial<Pick<BackendConfig, "name" | "url">>) => void;
}

const BackendContext = createContext<BackendContextValue | null>(null);

// Simple external store for localStorage-backed backends list.
// Fires subscribers on any mutation so React re-renders.
// The snapshot must be referentially stable between calls (React requirement).
let listeners: Array<() => void> = [];
let cachedSnapshot: BackendConfig[] = getBackends();

function subscribe(cb: () => void) {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}
function emitChange() {
  cachedSnapshot = getBackends();
  for (const l of listeners) l();
}
function getSnapshot(): BackendConfig[] {
  return cachedSnapshot;
}

export function BackendProvider({ children }: { children: React.ReactNode }) {
  const backends = useSyncExternalStore(subscribe, getSnapshot);
  const activeBackend = useMemo(() => getActiveBackend(), [backends]);
  const apiBase = useMemo(() => getApiBase(), [backends]);
  const wsBase = useMemo(() => getWsBase(), [backends]);

  const switchBackend = useCallback((id: string | null) => {
    if (id === null) {
      clearActiveBackend();
    } else {
      setActiveBackendId(id);
    }
    // Full reload for clean WS reconnection and state reset
    window.location.reload();
  }, []);

  const addBackend = useCallback((name: string, url: string) => {
    const config = addBackendStorage(name, url);
    emitChange();
    return config;
  }, []);

  const removeBackend = useCallback((id: string) => {
    removeBackendStorage(id);
    emitChange();
  }, []);

  const updateBackend = useCallback((id: string, patch: Partial<Pick<BackendConfig, "name" | "url">>) => {
    updateBackendStorage(id, patch);
    emitChange();
  }, []);

  const value = useMemo<BackendContextValue>(
    () => ({ activeBackend, backends, apiBase, wsBase, switchBackend, addBackend, removeBackend, updateBackend }),
    [activeBackend, backends, apiBase, wsBase, switchBackend, addBackend, removeBackend, updateBackend],
  );

  return <BackendContext value={value}>{children}</BackendContext>;
}

export function useBackend(): BackendContextValue {
  const ctx = useContext(BackendContext);
  if (!ctx) throw new Error("useBackend must be used within BackendProvider");
  return ctx;
}
