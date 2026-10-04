/**
 * Opening any coin by contract address (the way Axiom does), including coins the server never saw or has pruned:
 * GET /api/tokens/:mint and a token:<mint> subscription for an unknown mint resolve it on demand.
 *
 *  1. Memory: a record with a priced venue answers at once.
 *  2. Storage: a pruned record is reloaded (its last 24 h of trades rebuild the windows and the ring), then
 *     refreshed from chain like a new one; if the chain read fails the stored record still answers.
 *  3. Chain: one getMultipleAccounts (AccountResolver.fetchAccounts) reads the mint, its Metaplex metadata, the
 *     pump.fun bonding curve PDA, the canonical PumpSwap pool PDA and the Raydium LaunchLab pool PDAs (SOL and
 *     USD1 quotes). A second read takes what those name: the PumpSwap vaults (reserves) and the LaunchLab
 *     Platform / Global configs. The record is then built through MarketState's own resolver callbacks
 *     (onMintResolved, onCurveResolved, onPoolReady, onLaunchLabPoolReady), so it is exactly what a coin first seen
 *     mid-life gets: price, market cap, liquidity, bonding progress, supply, on-chain metadata (the metadata JSON
 *     brings image and socials), the trade context (published on tradectx:<mint>, so trading works at once). A
 *     graduated LaunchLab coin's CPMM pool comes through the registry's usual reads right after. Reserves read
 *     from accounts are anchored at the read's slot: an older backfilled trade never takes over the price.
 *  4. The history backfill starts at viewed priority (trades and candles stream in as `backfill` corrections).
 *
 * Not a token (no account, or not an SPL / Token-2022 mint): 404 "not_a_token", with `redirect` when the address
 * is one of a coin's pools (a pasted DexScreener / Axiom pair link). A mint with no venue the server decodes:
 * the keyless Jupiter /build probe decides between a Jupiter-routed "other" record and 404 "no_venue"; its quote
 * prices the "other" record, and market/jupiterPrice.ts re-quotes it while the coin is viewed.
 *
 * Abuse limits: malformed input is refused before any read; chain resolves are rate limited per client
 * (RESOLVE_PER_MIN / RESOLVE_BURST) and capped server-wide (RESOLVE_MAX_CONCURRENT, then 503); concurrent requests
 * for one mint share one resolve; definitive answers are cached for 10 minutes. A resolved coin is pinned in memory
 * (RESOLVE_PIN_MIN after its last request) on top of the watched-topics rule, so it is not pruned while viewed.
 */
import { type Address, isAddress } from "@solana/kit";
import {
  type BondingCurve,
  bondingCurvePda,
  canonicalPoolPda,
  curveQuoteMint,
  decodeBondingCurve,
  decodeCpmmPool,
  decodeLaunchLabPool,
  decodeMetaplexMetadata,
  decodeMint,
  decodeMintExtensions,
  decodePool,
  decodeTokenAccount,
  isCanonicalPumpPool,
  LAUNCHLAB_POOL_STATUS,
  type LaunchLabPool,
  launchLabPoolPda,
  metaplexMetadataPda,
  type Pool,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import type { ErrorCode, NotTokenAccount, TokenMissingReason, TokenSummary, TradeContext } from "@zerofee/protocol";
import type { RaydiumRegistry } from "../accounts/raydium";
import type { AccountResolver, MintResolved } from "../accounts/resolver";
import type { ResolveConfig } from "../config";
import { RateLimiter } from "../gateway/rateLimit";
import { logger } from "../log";
import { deserializeRecord } from "../storage/codec";
import type { StorageReader } from "../storage/reader";
import { replayRecent } from "../storage/restore";
import { LruMap } from "../util/lru";
import { type RpcAccount, RpcError } from "../util/rpc";
import { QUOTE_IN_LAMPORTS } from "./jupiterPrice";
import { knownQuoteDecimals, normalizeQuoteMint } from "./quote";
import type { MarketState } from "./state";
import type { TokenRecord } from "./token";

const log = logger("resolve");

/** USD1 (World Liberty): the other quote of LaunchLab (BONK.fun) pairs. */
export const USD1_MINT = "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB";
/** Definitive answers (not a token, no venue) are not read again for this long. */
const NEGATIVE_TTL_MS = 10 * 60_000;
/** How long a resolve waits for price + trade context (and the metadata JSON) before answering anyway. */
const SETTLE_MS = 3_000;
const METADATA_WAIT_MS = 1_500;

export type ResolveSource = "memory" | "store" | "chain";

export type ResolveOutcome =
  | { ok: true; source: ResolveSource; token: TokenSummary; tradeContext: TradeContext | null }
  | {
      ok: false;
      status: 400 | 404 | 429 | 503;
      code: ErrorCode;
      message: string;
      reason?: TokenMissingReason;
      redirect?: string;
      account?: NotTokenAccount;
      retryAfterSec?: number;
    };

export interface MintResolverDeps {
  cfg: ResolveConfig;
  market: MarketState;
  store: StorageReader | null;
  accounts: Pick<AccountResolver, "fetchAccounts" | "upsertPool" | "mints">;
  raydium: RaydiumRegistry | null;
  history: { request(mint: string, priority?: 0 | 1 | 2, reason?: string): void } | null;
  /**
   * Does Jupiter route SOL -> mint? The outAmount of a QUOTE_IN_LAMPORTS buy, null when it does not
   * (jupiterRouteProbe in the app; absent / null: never asked, "no_venue"). The answer also prices the coin.
   */
  jupiterRoutes?: ((mint: string) => Promise<bigint | null>) | null;
  /** Prices an unpriced Jupiter-only coin found in memory (JupiterPricer.prime; rate limited there). */
  jupiterPrime?: ((mint: string) => Promise<void>) | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A base58 string that decodes to 32 bytes (any account address; whether it is a mint is the chain's answer). */
export function isMintAddress(s: string): boolean {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && isAddress(s);
}

/** SPL Token mints are 82 bytes; Token-2022 mints with extensions carry AccountType 1 at byte 165. */
export function isMintAccount(acc: RpcAccount): boolean {
  if (acc.owner !== TOKEN_PROGRAM_ID && acc.owner !== TOKEN_2022_PROGRAM_ID) return false;
  if (acc.data.length === 82) return true;
  return acc.owner === TOKEN_2022_PROGRAM_ID && acc.data.length > 165 && acc.data[165] === 1;
}

/** The record already prices the coin (or is a resolved Jupiter-only coin): nothing to read. */
function hasVenue(rec: TokenRecord): boolean {
  return rec.curve !== null || rec.poolState !== null || rec.launchpad === "other";
}

function tryDecode<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export class MintResolver {
  private readonly inflight = new Map<string, Promise<ResolveOutcome>>();
  private readonly negative = new LruMap<string, { outcome: ResolveOutcome; at: number }>(5_000);
  private readonly pins = new Map<string, number>();
  private readonly limiter: RateLimiter;
  private active = 0;
  readonly stats = {
    requests: 0,
    memory: 0,
    store: 0,
    chain: 0,
    notToken: 0,
    noVenue: 0,
    jupiterOnly: 0,
    rateLimited: 0,
    busy: 0,
    invalid: 0,
    errors: 0,
    timeouts: 0,
  };

  constructor(private readonly d: MintResolverDeps) {
    this.limiter = new RateLimiter(d.cfg.perMin / 60, d.cfg.burst);
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep ? this.d.sleep(ms) : Bun.sleep(ms);
  }

  /** Chain resolves running right now. */
  get running(): number {
    return this.active;
  }

  /** Resolved recently (RESOLVE_PIN_MIN after the last request): keep in memory. */
  pinned(mint: string): boolean {
    const until = this.pins.get(mint);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.pins.delete(mint);
    return false;
  }

  private pin(mint: string): void {
    this.pins.set(mint, this.now() + this.d.cfg.pinMs);
    if (this.pins.size > 20_000) for (const [m, u] of this.pins) if (u <= this.now()) this.pins.delete(m);
  }

  /**
   * The coin behind `mint` for `client` (rate-limit key: the IP). Answers within RESOLVE_TIMEOUT_MS; a resolve
   * still running then keeps going (its record goes out on token:<mint> as it fills in).
   */
  async resolve(mint: string, client: string): Promise<ResolveOutcome> {
    this.stats.requests++;
    if (!isMintAddress(mint)) {
      this.stats.invalid++;
      return { ok: false, status: 400, code: "bad_request", message: "not a base58 Solana address" };
    }
    const rec = this.d.market.tokens.get(mint);
    if (rec && hasVenue(rec)) {
      this.stats.memory++;
      this.pin(mint);
      if (rec.launchpad === "other" && !rec.quotePrice) await this.d.jupiterPrime?.(mint).catch(() => {});
      return this.found(mint, "memory");
    }
    if (!this.d.cfg.enabled) {
      const stored = this.d.store?.token(mint)?.summary ?? null;
      if (stored) return { ok: true, source: "store", token: stored, tradeContext: null };
      return { ok: false, status: 404, code: "not_found", message: "unknown token" };
    }
    const neg = this.negative.get(mint);
    if (neg && this.now() - neg.at < NEGATIVE_TTL_MS) return neg.outcome;
    const shared = this.inflight.get(mint);
    if (shared) return this.answerWithin(shared, mint);
    if (!this.limiter.allow(client, 1, this.now())) {
      this.stats.rateLimited++;
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: "too many tokens opened by address; try again shortly",
        retryAfterSec: Math.max(1, Math.ceil(60 / this.d.cfg.perMin)),
      };
    }
    if (this.active >= this.d.cfg.maxConcurrent) {
      this.stats.busy++;
      return { ok: false, status: 503, code: "unavailable", message: "busy resolving other tokens; retry", retryAfterSec: 2 };
    }
    this.active++;
    const p = this.run(mint)
      .catch((e): ResolveOutcome => {
        this.stats.errors++;
        log.warn(`resolve ${mint}: ${e instanceof Error ? e.message : e}`);
        return { ok: false, status: 503, code: "unavailable", message: "chain read failed; retry", retryAfterSec: 3 };
      })
      .finally(() => {
        this.active--;
        this.inflight.delete(mint);
      });
    this.inflight.set(mint, p);
    return this.answerWithin(p, mint);
  }

  private async answerWithin(p: Promise<ResolveOutcome>, mint: string): Promise<ResolveOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), this.d.cfg.timeoutMs);
    });
    const out = await Promise.race([p, late]);
    clearTimeout(timer);
    if (out) return out;
    this.stats.timeouts++;
    const rec = this.d.market.tokens.get(mint);
    if (rec && hasVenue(rec)) return this.found(mint, "chain");
    return { ok: false, status: 503, code: "unavailable", message: "still reading the chain; retry", retryAfterSec: 2 };
  }

  private found(mint: string, source: ResolveSource): ResolveOutcome {
    const token = this.d.market.summary(mint);
    if (!token) return { ok: false, status: 503, code: "unavailable", message: "token record not available; retry", retryAfterSec: 2 };
    return { ok: true, source, token, tradeContext: this.d.market.tradeContext(mint) };
  }

  private definitive(
    mint: string,
    reason: TokenMissingReason,
    message: string,
    redirect?: string,
    account?: NotTokenAccount,
  ): ResolveOutcome {
    const outcome: ResolveOutcome = {
      ok: false,
      status: 404,
      code: "not_found",
      message,
      reason,
      ...(redirect ? { redirect } : {}),
      ...(account ? { account } : {}),
    };
    this.negative.set(mint, { outcome, at: this.now() });
    if (reason === "not_a_token") this.stats.notToken++;
    else this.stats.noVenue++;
    return outcome;
  }

  /** A pruned record back from storage; false when there is none (or it no longer decodes). */
  private restoreFromStore(mint: string): boolean {
    const row = this.d.store?.token(mint);
    if (!row) return false;
    try {
      const { rec } = deserializeRecord(row.state, this.now());
      this.d.market.restore(rec);
      this.d.market.forgetReserveKeys(mint);
      replayRecent(this.d.market, this.d.store as StorageReader, rec, this.now());
      return true;
    } catch (e) {
      log.debug(`restore ${mint}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  private async run(mint: string): Promise<ResolveOutcome> {
    const started = this.now();
    const m = mint as Address;
    const restored = !this.d.market.tokens.has(mint) && this.restoreFromStore(mint);
    const source: ResolveSource = restored ? "store" : "chain";
    const [curvePda, metaPda, pumpPoolPda, llSolPda, llUsd1Pda] = await Promise.all([
      bondingCurvePda(m),
      metaplexMetadataPda(m),
      canonicalPoolPda(m, WSOL_MINT),
      launchLabPoolPda(m, WSOL_MINT),
      launchLabPoolPda(m, USD1_MINT as Address),
    ]);
    let r1: Awaited<ReturnType<MintResolverDeps["accounts"]["fetchAccounts"]>>;
    try {
      r1 = await this.read([mint, curvePda, metaPda, pumpPoolPda, llSolPda, llUsd1Pda]);
    } catch (e) {
      if (restored) return this.stored(mint, started);
      throw e;
    }
    const [mintAcc, curveAcc, metaAcc, poolAcc, llSolAcc, llUsd1Acc] = r1.accounts;
    if (!mintAcc || !isMintAccount(mintAcc)) {
      if (restored) return this.stored(mint, started);
      const account: NotTokenAccount = !mintAcc ? "none" : mintAcc.owner === SYSTEM_PROGRAM_ID ? "wallet" : "other";
      return this.definitive(
        mint,
        "not_a_token",
        account === "wallet" ? "this address is a wallet" : mintAcc ? "this address is not a token mint" : "no account at this address",
        mintAcc ? (this.baseMintOfPool(mintAcc) ?? undefined) : undefined,
        account,
      );
    }
    const mi = decodeMint(mintAcc.data, mintAcc.owner);
    const ext = decodeMintExtensions(mintAcc.data);
    const mintInfo: MintResolved = {
      mint,
      tokenProgram: mi.tokenProgram,
      decimals: mi.decimals,
      supply: mi.supply,
      metadata: ext.metadata,
      dangers: ext.dangers,
      transferFeeConfig: mi.extensions.transferFeeConfig,
    };
    const curve = curveAcc?.owner === PUMP_PROGRAM_ID ? tryDecode(() => decodeBondingCurve(curveAcc.data)) : null;
    let poolAddr: string = pumpPoolPda;
    let pool = this.pumpPool(poolAcc ?? null, mint);
    // a pump coin quoted in something else than SOL migrates into the canonical pool of that quote
    if (!pool && curve && curve.complete && curveQuoteMint(curve) !== WSOL_MINT) {
      poolAddr = await canonicalPoolPda(m, curveQuoteMint(curve));
      const r = await this.read([poolAddr]);
      pool = this.pumpPool(r.accounts[0] ?? null, mint);
    }
    let graduating = false;
    const ll: { address: string; acc: RpcAccount; state: LaunchLabPool } | null =
      this.launchLab(llSolPda, llSolAcc ?? null, mint) ?? this.launchLab(llUsd1Pda, llUsd1Acc ?? null, mint);

    // A completed curve without a canonical PumpSwap pool graduated elsewhere (Raydium AMM v4, before PumpSwap
    // existed): the curve's last price is not the market. Jupiter routes those.
    const curveVenue = curve !== null && !(curve.complete && !pool);
    if (curveVenue || pool) await this.applyPump(mint, mintInfo, metaAcc ?? null, curve, curvePda, pool, poolAddr, r1.slot);
    else if (ll) {
      await this.applyLaunchLab(mint, mintInfo, metaAcc ?? null, ll, r1.slot);
      // graduated: the CPMM pool and its vaults come through the registry's reads; wait for them
      if (ll.state.status === LAUNCHLAB_POOL_STATUS.trade) graduating = true;
    } else {
      const routes = this.d.jupiterRoutes ?? null;
      const out = routes ? await routes(mint).catch(() => null) : null;
      if (out === null || out <= 0n) {
        if (restored) return this.stored(mint, started);
        return this.definitive(mint, "no_venue", "no pump.fun, PumpSwap or Raydium market and no Jupiter route for this token");
      }
      this.stats.jupiterOnly++;
      this.d.market.ensureOtherToken(mint);
      this.applyMint(mintInfo, metaAcc ?? null);
      // the probe's quote is the first price (decimals and supply come from the mint just applied)
      this.d.market.setJupiterQuote(mint, QUOTE_IN_LAMPORTS, out, this.now());
      this.pin(mint);
      return this.settled(mint, source, started);
    }
    this.pin(mint);
    // the backfill walks every venue the record names: a graduate's CPMM pool lands during settle()
    if (!graduating) this.d.history?.request(mint, 0, "resolve");
    const out = await this.settled(mint, source, started, graduating);
    if (graduating) this.d.history?.request(mint, 0, "resolve");
    return out.ok ? this.found(mint, source) : out;
  }

  /**
   * The chain read failed (rate limited) or found nothing new for a coin reloaded from storage: the stored record
   * answers (its venues are known), and its backfill starts all the same.
   */
  private async stored(mint: string, started: number): Promise<ResolveOutcome> {
    this.pin(mint);
    this.d.history?.request(mint, 0, "resolve");
    return this.settled(mint, "store", started);
  }

  /**
   * One batched account read; a rate limit (429, or the client's cooldown after one) is waited out and retried while
   * the answer can still come in time (RESOLVE_TIMEOUT_MS), since the endpoint is shared with the live feed.
   */
  private async read(addresses: readonly string[]): Promise<{ slot: number; accounts: (RpcAccount | null)[] }> {
    const until = this.now() + Math.max(0, this.d.cfg.timeoutMs - 1_000);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.d.accounts.fetchAccounts(addresses);
      } catch (e) {
        const limited = e instanceof RpcError && e.code === 429;
        const wait = Math.min(2_000, 400 * 2 ** attempt);
        if (!limited || this.now() + wait > until) throw e;
        await this.sleep(wait);
      }
    }
  }

  /** Waits (briefly) for price, trade context and metadata, then answers with the record as it is. */
  private async settled(mint: string, source: ResolveSource, started: number, graduating = false): Promise<ResolveOutcome> {
    const deadline = started + Math.min(SETTLE_MS, Math.max(0, this.d.cfg.timeoutMs - 500));
    for (;;) {
      const rec = this.d.market.tokens.get(mint);
      if (!rec) break;
      const priced = rec.launchpad === "other" || (this.d.market.summary(mint)?.priceQuote ?? null) !== null;
      const ctx = rec.launchpad === "other" || this.d.market.tradeContext(mint) !== null;
      const meta = rec.metadataState !== "requested" || this.now() - started >= METADATA_WAIT_MS;
      const venue = !graduating || (rec.migrated && rec.poolState !== null);
      if ((priced && ctx && meta && venue) || this.now() >= deadline) break;
      await this.sleep(50);
    }
    if (source === "store") this.stats.store++;
    else this.stats.chain++;
    this.d.market.publishToken(mint);
    return this.found(mint, source);
  }

  private pumpPool(acc: RpcAccount | null, mint: string): Pool | null {
    if (!acc || acc.owner !== PUMP_AMM_PROGRAM_ID) return null;
    const p = tryDecode(() => decodePool(acc.data));
    return p && p.baseMint === mint ? p : null;
  }

  private launchLab(
    address: string,
    acc: RpcAccount | null,
    mint: string,
  ): { address: string; acc: RpcAccount; state: LaunchLabPool } | null {
    if (!acc || acc.owner !== RAYDIUM_LAUNCHLAB_PROGRAM_ID) return null;
    const st = tryDecode(() => decodeLaunchLabPool(acc.data));
    return st && st.baseMint === mint ? { address, acc, state: st } : null;
  }

  /** The coin a pool / pair address belongs to (PumpSwap, LaunchLab, CPMM), for a redirect. */
  private baseMintOfPool(acc: RpcAccount): string | null {
    if (acc.owner === PUMP_AMM_PROGRAM_ID) return tryDecode(() => decodePool(acc.data).baseMint);
    if (acc.owner === RAYDIUM_LAUNCHLAB_PROGRAM_ID) return tryDecode(() => decodeLaunchLabPool(acc.data).baseMint);
    if (acc.owner === RAYDIUM_CPMM_PROGRAM_ID) {
      const p = tryDecode(() => decodeCpmmPool(acc.data));
      if (!p) return null;
      const quotes = new Set<string>([WSOL_MINT, USDC_MINT, USD1_MINT]);
      return quotes.has(p.token0Mint) ? p.token1Mint : p.token0Mint;
    }
    return null;
  }

  /** Mint account, Token-2022 metadata or Metaplex metadata into the record (the metadata JSON is fetched next). */
  private applyMint(info: MintResolved, metaAcc: RpcAccount | null): void {
    this.d.accounts.mints.set(info.mint, info);
    this.d.market.onMintResolved(info);
    if (!info.metadata && metaAcc) {
      const md = tryDecode(() => decodeMetaplexMetadata(metaAcc.data));
      if (md) this.d.market.onMetaplexResolved(info.mint, md);
    }
  }

  private async applyPump(
    mint: string,
    info: MintResolved,
    metaAcc: RpcAccount | null,
    curve: BondingCurve | null,
    curvePda: string,
    pool: Pool | null,
    poolAddr: string,
    slot: number,
  ): Promise<void> {
    const market = this.d.market;
    const rec = market.ensureToken(mint, { launchpad: "pump", bondingCurve: curve ? curvePda : null, bootstrapRequested: true });
    rec.bootstrapRequested = true;
    this.applyMint(info, metaAcc);
    if (curve) market.onCurveResolved({ mint, bondingCurve: curvePda, curve, slot });
    if (!pool) return;
    const quoteMint = normalizeQuoteMint(pool.quoteMint);
    // the vaults hold the reserves; an exotic quote's decimals come from its mint
    const extra = knownQuoteDecimals(quoteMint) === null ? [quoteMint] : [];
    const r2 = await this.read([pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount, ...extra]);
    const [baseVault, quoteVault, quoteMintAcc] = r2.accounts;
    const quoteDecimals =
      knownQuoteDecimals(quoteMint) ??
      (quoteMintAcc ? (tryDecode(() => decodeMint(quoteMintAcc.data, quoteMintAcc.owner).decimals) ?? null) : null);
    const quoteTokenProgram = quoteMint === WSOL_MINT || quoteMint === USDC_MINT ? TOKEN_PROGRAM_ID : (quoteMintAcc?.owner ?? null);
    const pinfo = this.d.accounts.upsertPool({
      pool: poolAddr,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      index: pool.index,
      creator: pool.creator,
      lpMint: pool.lpMint,
      lpSupply: pool.lpSupply.toString(),
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      coinCreator: pool.coinCreator,
      isMayhemMode: pool.isMayhemMode,
      isCashbackCoin: pool.isCashbackCoin,
      creatorFeeBps: pool.creatorFeeBps.toString(),
      canEditCreatorFee: pool.canEditCreatorFee,
      isHolderReward: pool.isHolderReward,
      isCanonical: await isCanonicalPumpPool(pool),
      dataLength: pool.dataLength,
      fromAccount: true,
      baseDecimals: info.decimals,
      quoteDecimals,
      baseTokenProgram: info.tokenProgram,
      quoteTokenProgram,
      baseSupply: info.supply.toString(),
    });
    market.onPoolReady(pinfo);
    const base = baseVault ? tryDecode(() => decodeTokenAccount(baseVault.data).amount) : null;
    const quote = quoteVault ? tryDecode(() => decodeTokenAccount(quoteVault.data).amount) : null;
    if (base !== null && quote !== null) market.seedPoolReserves(mint, poolAddr, base, quote, pool.virtualQuoteReserves, r2.slot);
  }

  private async applyLaunchLab(
    mint: string,
    info: MintResolved,
    metaAcc: RpcAccount | null,
    ll: { address: string; acc: RpcAccount; state: LaunchLabPool },
    slot: number,
  ): Promise<void> {
    const reg = this.d.raydium;
    if (reg) {
      // configs first: the pool's record then needs no reads of its own (label, fees, graduation pool)
      const want = [ll.state.platformConfig, ll.state.globalConfig].filter((a) => !reg.platforms.has(a) && !reg.globals.has(a));
      if (want.length) {
        const r2 = await this.read(want);
        want.forEach((a, i) => {
          const acc = r2.accounts[i] ?? null;
          if (a === ll.state.platformConfig) reg.ingestPlatform(a, acc);
          else reg.ingestGlobal(a, acc);
        });
      }
    }
    this.d.market.ensureLaunchLabToken(mint, ll.address, ll.state.quoteMint);
    this.applyMint(info, metaAcc);
    const pinfo = reg?.ingestLaunchLabPool(ll.address, ll.acc) ?? null;
    if (pinfo) this.d.market.onLaunchLabPoolReady(pinfo);
    this.d.market.anchorReserves(mint, slot);
  }
}
