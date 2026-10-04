/**
 * Jupiter-only coins (launchpad "other": no curve or pool the server decodes, but Jupiter routes them).
 *
 * The keyless Jupiter `/build` endpoint (the one the core client uses; `/order` charges a platform fee) quotes a
 * 0.01 SOL buy. Its outAmount is both the routability answer (resolve.ts) and the coin's price:
 * priceSol = 0.01 / (outAmount / 10^decimals), and the market cap is that price x the mint supply. Nothing is
 * signed or sent: the taker is the system program, which holds nothing.
 *
 * Keyless access allows 0.5 RPS, so every call (route probes and price refreshes) goes through one serialized
 * quoter spaced ~2.2 s apart. The pricer refreshes at most one viewed coin per tick, each about every 30 s, so
 * refreshes never take more than a fraction of that budget and a probe never waits long behind them.
 */
import { JUPITER_BUILD_PATH, JUPITER_SWAP_API_BASE, SYSTEM_PROGRAM_ID, WSOL_MINT } from "@zerofee/core";
import { LruMap } from "../util/lru";
import type { TokenRecord } from "./token";

/** System program: a taker that holds nothing; /build quotes and builds for it, nothing is ever signed. */
export const PROBE_TAKER: string = SYSTEM_PROGRAM_ID;
/** The quoted buy: 0.01 SOL, small enough that price impact stays negligible on any routable coin. */
export const QUOTE_IN_LAMPORTS = 10_000_000n;
/** Keyless /build allows 0.5 RPS: one call per 2.2 s, all callers included. */
const SPACING_MS = 2_200;
/** Route answers (routable or not) are reused for this long by the probe. */
const ROUTE_CACHE_MS = 10 * 60_000;
/** A viewed Jupiter-only coin is re-quoted this often. */
export const QUOTE_REFRESH_MS = 30_000;

/** outAmount (output base units) for a QUOTE_IN_LAMPORTS SOL buy of `mint`; null = no route or the call failed. */
export type JupiterQuoter = (mint: string) => Promise<bigint | null>;

export interface JupiterQuoterOptions {
  spacingMs?: number;
  timeoutMs?: number;
}

/** One serialized keyless /build caller shared by the route probe and the pricer. */
export function jupiterQuoter(fetchFn: typeof fetch = fetch, o: JupiterQuoterOptions = {}): JupiterQuoter {
  const spacing = o.spacingMs ?? SPACING_MS;
  let chain: Promise<unknown> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;
  return (mint) => {
    const run = chain.then(async () => {
      const wait = last + spacing - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      last = Date.now();
      const q = new URLSearchParams({
        inputMint: WSOL_MINT,
        outputMint: mint,
        amount: QUOTE_IN_LAMPORTS.toString(),
        slippageBps: "500",
        taker: PROBE_TAKER,
      });
      try {
        const res = await fetchFn(`${JUPITER_SWAP_API_BASE}${JUPITER_BUILD_PATH}?${q}`, {
          signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { outAmount?: unknown };
        if (typeof body.outAmount !== "string" || !/^\d+$/.test(body.outAmount)) return null;
        const out = BigInt(body.outAmount);
        return out > 0n ? out : null;
      } catch {
        return null;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

/**
 * Does Jupiter route SOL -> mint? Answers with the quote's outAmount (null: no route), cached for 10 minutes per
 * mint so a re-opened address costs nothing.
 */
export function jupiterRouteProbe(quote: JupiterQuoter): (mint: string) => Promise<bigint | null> {
  const cache = new LruMap<string, { out: bigint | null; at: number }>(2_000);
  return async (mint) => {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < ROUTE_CACHE_MS) return hit.out;
    const out = await quote(mint);
    cache.set(mint, { out, at: Date.now() });
    return out;
  };
}

/** SOL per whole token from a quote of `inLamports` SOL that buys `outAmount` base units; null when meaningless. */
export function priceSolFromQuote(inLamports: bigint, outAmount: bigint, decimals: number): number | null {
  if (inLamports <= 0n || outAmount <= 0n || !Number.isInteger(decimals) || decimals < 0) return null;
  const p = Number(inLamports) / 1e9 / (Number(outAmount) / 10 ** decimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export interface JupiterPricerDeps {
  quote: JupiterQuoter;
  market: {
    tokens: { get(mint: string): TokenRecord | undefined };
    setJupiterQuote(mint: string, inLamports: bigint, outAmount: bigint, at: number): void;
  };
  /** Mints someone is viewing now (token / trades / candles subscriptions). */
  watched: () => Iterable<string>;
  refreshMs?: number;
  now?: () => number;
}

/**
 * Keeps the price of viewed Jupiter-only coins fresh: each tick re-quotes the viewed "other" coin whose quote is
 * the oldest, when it is older than QUOTE_REFRESH_MS. Coins nobody views are never quoted.
 */
export class JupiterPricer {
  private busy = false;
  /** Last attempt per mint (a failed quote waits a full period too). */
  private readonly tried = new LruMap<string, number>(5_000);
  readonly stats = { quotes: 0, failures: 0 };

  constructor(private readonly d: JupiterPricerDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /**
   * A Jupiter-only coin opened again while it has no price (reloaded from storage, or its last quote failed):
   * quote it now rather than at the next tick. At most once per refresh period per coin, whoever asks.
   */
  async prime(mint: string): Promise<void> {
    const rec = this.d.market.tokens.get(mint);
    if (rec?.launchpad !== "other" || rec.quotePrice) return;
    const now = this.now();
    if (now - (this.tried.get(mint) ?? Number.NEGATIVE_INFINITY) < (this.d.refreshMs ?? QUOTE_REFRESH_MS)) return;
    this.tried.set(mint, now);
    const out = await this.d.quote(mint);
    if (out === null) this.stats.failures++;
    else {
      this.stats.quotes++;
      this.d.market.setJupiterQuote(mint, QUOTE_IN_LAMPORTS, out, this.now());
    }
  }

  /** Re-quotes at most one coin; resolves with that mint, or null when nothing was due. */
  async tick(): Promise<string | null> {
    if (this.busy) return null;
    const now = this.now();
    const every = this.d.refreshMs ?? QUOTE_REFRESH_MS;
    let due: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const mint of this.d.watched()) {
      const rec = this.d.market.tokens.get(mint);
      if (rec?.launchpad !== "other") continue;
      const at = Math.max(rec.quotePrice?.at ?? 0, this.tried.get(mint) ?? 0);
      if (now - at < every || at >= oldest) continue;
      oldest = at;
      due = mint;
    }
    if (due === null) return null;
    this.busy = true;
    this.tried.set(due, now);
    try {
      const out = await this.d.quote(due);
      if (out === null) this.stats.failures++;
      else {
        this.stats.quotes++;
        this.d.market.setJupiterQuote(due, QUOTE_IN_LAMPORTS, out, this.now());
      }
    } finally {
      this.busy = false;
    }
    return due;
  }
}
