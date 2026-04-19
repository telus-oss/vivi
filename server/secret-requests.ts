/**
 * Secret request management — in-memory store for secret requests from sandboxes.
 *
 * When Claude needs an API key it doesn't have, it calls `request-secret` from
 * within the sandbox. The request is stored here and broadcast to the UI via
 * the monitor WebSocket so the user can add the secret.
 */

import crypto from "node:crypto";

export interface SecretRequest {
  id: string;
  sessionId: string;
  name: string;
  envVar: string;
  baseUrl: string;
  headerName: string;
  status: "pending" | "fulfilled" | "dismissed";
  createdAt: number;
}

const requests: Map<string, SecretRequest> = new Map();
const listeners: Set<(req: SecretRequest) => void> = new Set();

function notify(req: SecretRequest) {
  for (const fn of listeners) {
    try { fn(req); } catch {}
  }
}

export function addSecretRequest(opts: {
  sessionId: string;
  name: string;
  envVar: string;
  baseUrl: string;
  headerName?: string;
}): SecretRequest {
  // Deduplicate: if a pending request with the same envVar already exists, return it
  for (const existing of requests.values()) {
    if (existing.envVar === opts.envVar && existing.status === "pending") {
      return existing;
    }
  }

  const req: SecretRequest = {
    id: crypto.randomUUID().slice(0, 8),
    sessionId: opts.sessionId,
    name: opts.name,
    envVar: opts.envVar,
    baseUrl: opts.baseUrl,
    headerName: opts.headerName || "x-api-key",
    status: "pending",
    createdAt: Date.now(),
  };
  requests.set(req.id, req);
  notify(req);
  return req;
}

export function listPendingRequests(): SecretRequest[] {
  return [...requests.values()].filter((r) => r.status === "pending");
}

export function getSecretRequest(id: string): SecretRequest | undefined {
  return requests.get(id);
}

export function fulfillRequest(id: string): boolean {
  const req = requests.get(id);
  if (!req || req.status !== "pending") return false;
  req.status = "fulfilled";
  notify(req);
  return true;
}

export function dismissRequest(id: string): boolean {
  const req = requests.get(id);
  if (!req || req.status !== "pending") return false;
  req.status = "dismissed";
  notify(req);
  return true;
}

/** Fulfill any pending request matching the given envVar. */
export function fulfillByEnvVar(envVar: string): void {
  for (const req of requests.values()) {
    if (req.envVar === envVar && req.status === "pending") {
      req.status = "fulfilled";
      notify(req);
    }
  }
}

/** Subscribe to secret request changes. Returns unsubscribe function. */
export function onSecretRequestUpdate(fn: (req: SecretRequest) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
