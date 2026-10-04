/**
 * DexScreener "Dex Paid" (SPEC.md metric table): `GET /orders/v1/solana/{mint}` lists the paid orders of a
 * token; an approved `tokenProfile` order is Dex Paid. `GET /token-profiles/latest/v1` lists the newest
 * paid profiles across chains and serves as a trigger to check those mints first.
 *
 * DexScreener's OpenAPI spec (linked from https://docs.dexscreener.com/api/reference) documents
 * "rate-limit 60 requests per minute" for orders and for the profile / boost feeds, and an array of
 * `{type, status, paymentTimestamp}`. The live API answered `{"orders":[{chainId, tokenAddress, type,
 * status, paymentTimestamp}],"boosts":[...]}` on 2026-10-03; both shapes are accepted. Responses carry
 * `cache-control: public, max-age=60`, so re-checking a mint more often than once a minute is pointless.
 */

export interface DexOrder {
  type: string;
  status: string;
  paymentTimestamp: number | null;
}

export class DexScreenerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DexScreenerError";
  }
}

/** Orders from either response shape; anything malformed is skipped. */
export function parseOrders(body: unknown): DexOrder[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? (body as { orders?: unknown }).orders : null;
  if (!Array.isArray(list)) return [];
  const out: DexOrder[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const r = o as Record<string, unknown>;
    if (typeof r.type !== "string" || typeof r.status !== "string") continue;
    out.push({ type: r.type, status: r.status, paymentTimestamp: typeof r.paymentTimestamp === "number" ? r.paymentTimestamp : null });
  }
  return out;
}

/** Dex Paid = an approved token profile; paidAt = its (earliest) payment time. */
export function dexPaidFrom(orders: readonly DexOrder[]): { paid: boolean; paidAt: number | null } {
  const approved = orders.filter((o) => o.type === "tokenProfile" && o.status === "approved");
  if (!approved.length) return { paid: false, paidAt: null };
  const times = approved.map((o) => o.paymentTimestamp).filter((t): t is number => t !== null);
  return { paid: true, paidAt: times.length ? Math.min(...times) : null };
}

/** Solana mints in a `/token-profiles/latest/v1` response. */
export function parseProfileMints(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  const out: string[] = [];
  for (const p of body) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (r.chainId === "solana" && typeof r.tokenAddress === "string") out.push(r.tokenAddress);
  }
  return out;
}

export interface DexScreenerOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class DexScreenerClient {
  private readonly fetchFn: typeof fetch;
  readonly stats = { calls: 0, errors: 0, rateLimited: 0 };

  constructor(private readonly opts: DexScreenerOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async get(path: string): Promise<unknown> {
    this.stats.calls++;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
      });
    } catch (e) {
      this.stats.errors++;
      throw new DexScreenerError(0, e instanceof Error ? e.message : String(e));
    }
    if (res.status === 429) this.stats.rateLimited++;
    if (!res.ok) {
      this.stats.errors++;
      throw new DexScreenerError(res.status, `HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      this.stats.errors++;
      throw new DexScreenerError(res.status, "invalid JSON");
    }
  }

  async orders(mint: string): Promise<DexOrder[]> {
    return parseOrders(await this.get(`/orders/v1/solana/${encodeURIComponent(mint)}`));
  }

  async latestProfiles(): Promise<string[]> {
    return parseProfileMints(await this.get("/token-profiles/latest/v1"));
  }
}
