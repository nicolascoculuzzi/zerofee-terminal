/**
 * CSRF / cross-site WebSocket defence: a request that carries the session cookie and changes state
 * (POST/PUT/PATCH/DELETE, including POST /api/tx), sign-in and sign-out, and a cookie-authenticated
 * WebSocket upgrade must send an `Origin` header naming one of the allowed origins. Browsers attach
 * Origin to every non-GET request and to WebSocket handshakes, and scripts cannot forge it. This sits
 * on top of SameSite=Strict, which already keeps the cookie off cross-site requests in current browsers.
 */
export class OriginPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(origins: readonly string[]) {
    this.allowed = new Set(origins.map((o) => new URL(o).origin));
  }

  /** True for an exact match with an allowed origin. Missing, "null" (opaque) and malformed origins fail. */
  isAllowed(origin: string | null | undefined): boolean {
    if (!origin || origin === "null") return false;
    try {
      return this.allowed.has(new URL(origin).origin) && new URL(origin).origin === origin;
    } catch {
      return false;
    }
  }

  get origins(): string[] {
    return [...this.allowed];
  }
}

export function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
