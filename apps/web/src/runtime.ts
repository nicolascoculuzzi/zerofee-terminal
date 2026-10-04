/**
 * Build-time runtime selection (see src/env.d.ts for the variables).
 *
 *   VITE_DATA_SOURCE=mock (default)  everything runs on the in-browser simulation (design preview)
 *   VITE_DATA_SOURCE=live            the real gateway: WebSocket topics, REST, SIWS, the signer worker
 *
 * Vite replaces `import.meta.env.*` with literals, so the branch that is not taken (and the modules
 * only it imports) drops out of the bundle.
 */

export type DataSourceKind = "mock" | "live";

export const DATA_SOURCE: DataSourceKind = import.meta.env.VITE_DATA_SOURCE === "live" ? "live" : "mock";

export const IS_LIVE = DATA_SOURCE === "live";

/**
 * Origin of the gateway (REST + WebSocket), without a trailing slash. Empty = this page's own origin.
 * The dev server always proxies `/api` and `/ws` to VITE_API_ORIGIN (vite.config.ts), so in dev the app
 * stays same-origin: the session cookie and the server's CSRF Origin check need that.
 */
export const API_ORIGIN: string = import.meta.env.DEV ? "" : (import.meta.env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");

/** Absolute or same-origin URL of a gateway path ("/api/..."). */
export function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/** WebSocket URL of the gateway's `/ws`. */
export function wsUrl(): string {
  if (API_ORIGIN) return `${API_ORIGIN.replace(/^http/, "ws")}/ws`;
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}
