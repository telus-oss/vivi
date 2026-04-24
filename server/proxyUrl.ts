/**
 * Port-forward proxy URL builder.
 *
 * Lives in its own module so it can be unit-tested without importing the
 * rest of `server/ports.ts` (which transitively pulls in `bun:sqlite`, a
 * built-in that vitest can't bundle).
 */

/** Server port for constructing fallback proxy URLs. Set via setServerPort(). */
let serverPort = parseInt(process.env.PORT || "5151", 10);

export function setServerPort(port: number): void {
  serverPort = port;
}

/**
 * Build a full proxy URL for a port forward.
 *
 * When `PUBLIC_PORT_URL_BASE` is set, the subdomain is prepended to that
 * base's hostname. Example:
 *   PUBLIC_PORT_URL_BASE=https://friendzi.xyz
 *   subdomain=p-3000-abc12345
 *   → https://p-3000-abc12345.friendzi.xyz
 *
 * This lets Cloudflare-tunnel deploys (where Universal SSL doesn't cover a
 * nested wildcard like `*.vivi.friendzi.xyz`) opt into a flat subdomain
 * scheme covered by the free zone cert without patching source.
 *
 * Falls back to `http://{subdomain}.{HOST}:{PORT}` when the env var is
 * unset or unparseable.
 */
export function makeProxyUrl(subdomain: string): string {
  const base = process.env.PUBLIC_PORT_URL_BASE;
  if (base) {
    try {
      const url = new URL(base);
      const portPart = url.port ? `:${url.port}` : "";
      const pathPart = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
      return `${url.protocol}//${subdomain}.${url.hostname}${portPart}${pathPart}`;
    } catch {
      console.warn(`[ports] Invalid PUBLIC_PORT_URL_BASE: ${base} — falling back to HOST/PORT.`);
    }
  }
  const host = process.env.HOST || "localhost";
  return `http://${subdomain}.${host}:${serverPort}`;
}
