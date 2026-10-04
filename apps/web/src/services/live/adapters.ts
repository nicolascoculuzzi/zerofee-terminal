/**
 * Thin adapters from the gateway's wire shapes (@zerofee/protocol, the source of truth) to the UI's
 * view models (src/protocol.ts). Pure functions, unit-tested in adapters.test.ts.
 *
 * Unknown values: the wire uses `null` for "not known / not computed by this deployment", and SOL values
 * are null when the token's quote has no known SOL value (packages/protocol market.ts). They stay null in
 * the view models (every formatter renders "–", every filter treats them as failing a min or max), never
 * 0. View fields the server does not publish at all are null too; the few view fields typed as plain
 * numbers (token creation time, curve totals the display quote does not use) get NaN, which renders the
 * same way. Nothing here invents a number.
 */
import type {
  ChainState,
  HealthResponse,
  TrackedTradeRow,
  TradeContext,
  Candle as WireCandle,
  TokenSummary as WireToken,
  Trade as WireTrade,
} from "@zerofee/protocol";
import { imageProxyUrl } from "@zerofee/protocol";
import { FINAL_STRETCH_PROGRESS } from "../../config";
import type {
  Candle,
  CurveState,
  FeedHealth,
  Launchpad,
  MarketStatus,
  PoolState,
  PulseColumnId,
  QuoteToken,
  TokenRef,
  TokenSummary,
  TrackedTrade,
  Trade,
  Venue,
  WalletTag,
} from "../../protocol";

/**
 * The quote mints the UI names (packages/core USDC_MINT / WSOL_MINT). Literals here so the first screen's
 * chunk does not pull in core's constants module; adapters.test.ts checks they match core's.
 */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const NaN_ = Number.NaN;
/** For view fields typed as plain numbers: unknown becomes NaN (rendered "–"). */
const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN_);
/** A known finite number, else null. */
export const known = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** a × b when both are known, else null. */
export const mul = (a: number | null | undefined, b: number | null | undefined): number | null => {
  const x = known(a);
  const y = known(b);
  return x === null || y === null ? null : x * y;
};

/** Base units (decimal string) to UI units. */
export function uiAmount(raw: string | bigint, decimals: number): number {
  const n = typeof raw === "bigint" ? raw : BigInt(raw || "0");
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const v = Number(whole) + Number(frac) / Number(scale);
  return neg ? -v : v;
}

export function quoteTokenOf(quoteMint: string): QuoteToken {
  if (quoteMint === WSOL_MINT) return "SOL";
  if (quoteMint === USDC_MINT) return "USDC";
  return "OTHER";
}

export function launchpadOf(t: Pick<WireToken, "launchpad" | "isMayhem">): Launchpad {
  if (t.isMayhem) return "mayhem";
  return t.launchpad === "pump" ? "pump" : "other";
}

export function venueOf(t: Pick<WireToken, "launchpad" | "migrated">): Venue {
  // "other": a coin opened by address that only Jupiter routes (no curve or pool the server prices)
  if (t.launchpad === "other") return "other";
  if (t.launchpad === "launchlab") return t.migrated ? "raydium_cpmm" : "launchlab";
  return t.migrated || t.launchpad === "pumpswap" ? "pumpswap" : "pump_curve";
}

/** The Pulse column a token belongs in, for summaries that did not come from a column topic. */
export function columnOf(t: Pick<WireToken, "migrated" | "launchpad" | "bondingProgressBps">): PulseColumnId {
  if (t.migrated || t.launchpad === "pumpswap") return "migrated";
  return t.bondingProgressBps / 10_000 >= FINAL_STRETCH_PROGRESS ? "final" : "new";
}

/** Wire summaries carry every field; a patch for a token the client never saw in full cannot be applied. */
export function isFullSummary(p: Partial<WireToken>): p is WireToken {
  return (
    typeof p.mint === "string" &&
    typeof p.symbol === "string" &&
    typeof p.launchpad === "string" &&
    typeof p.bondingProgressBps === "number" &&
    typeof p.updatedAt === "number" &&
    "socials" in p
  );
}

export interface TokenAdaptContext {
  /** SOL/USD from the `chain` topic (NaN or null while unknown). */
  solUsd: number | null;
  /** Pulse column when the summary came from a column topic. */
  column?: PulseColumnId;
}

export function adaptToken(t: WireToken, ctx: TokenAdaptContext): TokenSummary {
  return {
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    // Same-origin proxy URL (TokenAvatar appends &s=<px>); the raw metadata URL is never loaded directly.
    imageUri: t.imageProxied ?? t.image,
    launchpad: launchpadOf(t),
    quote: quoteTokenOf(t.quoteMint),
    venue: venueOf(t),
    column: ctx.column ?? columnOf(t),
    createdAt: num(t.createdAt),
    creator: t.creator ?? "",
    fundingWallet: null,
    socials: {
      ...(t.socials.x ? { x: t.socials.x } : {}),
      ...(t.socials.telegram ? { telegram: t.socials.telegram } : {}),
      ...(t.socials.website ? { website: t.socials.website } : {}),
    },
    supply: t.supply,
    decimals: t.decimals,
    priceSol: known(t.priceSol),
    priceUsd: known(t.priceUsd),
    marketCapSol: known(t.mcSol),
    marketCapUsd: known(t.mcUsd),
    liquidityUsd: known(t.liquidityUsd),
    volumeUsd: mul(t.volume24h, ctx.solUsd),
    txns: t.txns,
    buys: t.buys,
    sells: t.sells,
    holders: known(t.holders),
    proTraders: known(t.proTraders),
    bondingProgress: t.migrated || t.complete ? 1 : t.bondingProgressBps / 10_000,
    // Migrated at an unknown time (the server saw the pool, not the migration): NaN, which still reads as migrated.
    migratedAt: t.migratedAt ?? (t.migrated ? Number.NaN : null),
    risk: {
      top10Pct: known(t.top10Pct),
      devPct: known(t.devPct),
      devSold: t.devSoldAll === true,
      snipersPct: known(t.snipersPct),
      insidersPct: known(t.insidersPct),
      bundlersPct: known(t.bundlersPct),
    },
    dexPaid: t.dexPaid === true,
    dexPaidAt: t.dexPaidAt,
    lpBurnedPct: null,
    token2022: null,
    feesPaidSol: null,
    netBuyUsd: null,
    lastTradeAt: num(t.lastTradeAt),
    change5mPct: null,
    historyState: t.historyState ?? t.history?.state,
    ...(t.holdersPending === true ? { holdersPending: true } : {}),
    ...(t.priceSource === "jupiter_quote" ? { priceSource: "jupiter_quote" as const } : {}),
  };
}

/** Small token reference for tracker rows, from a summary. */
export function tokenRefOf(t: TokenSummary): TokenRef {
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    imageUri: t.imageUri,
    launchpad: t.launchpad,
    createdAt: t.createdAt,
    marketCapUsd: t.marketCapUsd,
  };
}

export interface TradeAdaptContext {
  decimals: number;
  /** SOL/USD now, used when the trade itself carries no USD amount. */
  solUsd: number | null;
  /** Token supply (UI units), for a USD market cap when only the USD price is known. */
  supply?: number | null;
  /** The user's own wallets (trading wallets and the connected wallet): their trades get "you". */
  own?: ReadonlySet<string>;
}

/** SOL/USD at a trade: from its own SOL and USD amounts when both are known, else the current rate. */
function rateAt(amountUsd: number | null, amountSol: number | null, solUsdNow: number | null): number | null {
  return amountUsd !== null && amountSol !== null && amountSol > 0 ? amountUsd / amountSol : known(solUsdNow);
}

export function adaptTrade(t: WireTrade, ctx: TradeAdaptContext): Trade {
  const tokens = uiAmount(t.tokenAmount, ctx.decimals);
  const rate = rateAt(t.amountUsd, t.amountSol, ctx.solUsd);
  // A USDC trade's amountUsd is its USDC amount: its USD price is known even when its SOL values are not.
  const priceUsd = mul(t.priceSol, rate) ?? (t.amountUsd !== null && tokens > 0 ? t.amountUsd / tokens : null);
  // The wire's market badges (dev, sniper, bundler, pro) are a subset of the UI's wallet tags.
  const tags: WalletTag[] = [...t.tags];
  if (ctx.own?.has(t.trader)) tags.unshift("you");
  return {
    id: t.id,
    signature: t.signature,
    mint: t.mint,
    ts: t.blockTime,
    slot: t.slot,
    side: t.side,
    solAmount: known(t.amountSol),
    tokenAmount: tokens,
    priceSol: known(t.priceSol),
    priceUsd,
    marketCapUsd: mul(t.mcSol, rate) ?? mul(priceUsd, ctx.supply),
    maker: t.trader,
    tags,
  };
}

/**
 * OHLCV bucket. The wire counts trades (`n`) without splitting buys and sells, so those view fields are
 * unknown. A bucket without a recorded SOL/USD takes the current rate (USD charts stay continuous).
 */
export function adaptCandle(c: WireCandle, solUsdNow: number | null): Candle {
  return {
    time: Math.floor(c.t / 1000),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
    volumeSol: c.v,
    buys: NaN_,
    sells: NaN_,
    solUsd: c.solUsd ?? num(solUsdNow),
  };
}

/** Feed health from /api/health (detection latency and trade rate); the socket state decides "offline". */
export function feedHealthOf(h: HealthResponse | null): FeedHealth {
  if (!h) return { state: "reconnecting", lagMs: NaN_, eventsPerSec: NaN_ };
  const source = h.sources[0];
  const lag = h.ingest.latency.p50;
  const state: FeedHealth["state"] = !source?.connected ? "degraded" : lag !== null && lag > 5_000 ? "degraded" : "connected";
  return { state, lagMs: num(lag), eventsPerSec: h.ingest.tradesPerSec1m };
}

export function marketStatusOf(chain: ChainState, health: HealthResponse | null): MarketStatus {
  return {
    solUsd: num(chain.solUsd?.price),
    slot: chain.slot ?? 0,
    feed: feedHealthOf(health),
  };
}

/**
 * Curve / pool view state for the display quote (lib/quote.ts) from a trade context. `feeBps` is the
 * venue's total fee at the current market cap, computed by the trade engine from the live FeeConfig.
 */
export function curveStateOf(ctx: TradeContext, feeBps: number): CurveState | null {
  if (ctx.venue !== "pump") return null;
  return {
    virtualQuoteReserves: uiAmount(ctx.virtualQuoteReserves, ctx.quoteDecimals),
    virtualTokenReserves: uiAmount(ctx.virtualTokenReserves, ctx.decimals),
    realQuoteReserves: uiAmount(ctx.realQuoteReserves, ctx.quoteDecimals),
    realTokenReserves: uiAmount(ctx.realTokenReserves, ctx.decimals),
    initialRealTokenReserves: NaN_,
    complete: ctx.complete,
    feeBps,
  };
}

export function poolStateOf(ctx: TradeContext, feeBps: number): PoolState | null {
  if (ctx.venue !== "pumpswap") return null;
  const quote = BigInt(ctx.quoteVaultReserve) + BigInt(ctx.virtualQuoteReserves);
  return {
    quoteReserves: uiAmount(quote, ctx.quoteDecimals),
    baseReserves: uiAmount(ctx.baseReserve, ctx.decimals),
    feeBps,
    poolAddress: ctx.pool,
  };
}

/** A tracked-wallet row as the live feed and its token reference. */
export function adaptTrackedRow(
  r: TrackedTradeRow,
  ctx: { decimals: number; solUsd: number | null; token?: TokenSummary | null },
): TrackedTrade {
  const tokens = uiAmount(r.tokenAmount, ctx.decimals);
  const rate = rateAt(r.amountUsd, r.amountSol, ctx.solUsd);
  const priceUsd = mul(r.priceSol, rate) ?? (r.amountUsd !== null && tokens > 0 ? r.amountUsd / tokens : null);
  const t = ctx.token;
  return {
    trade: {
      id: r.id,
      signature: r.signature,
      mint: r.mint,
      ts: r.blockTime,
      slot: r.slot,
      // Launches show as the wallet's own create; the feed renders them like a buy of 0 SOL.
      side: r.kind === "sell" ? "sell" : "buy",
      solAmount: known(r.amountSol),
      tokenAmount: tokens,
      priceSol: known(r.priceSol),
      priceUsd,
      marketCapUsd: r.mcUsd ?? mul(r.mcSol, rate),
      maker: r.wallet,
      tags: ["tracked", ...r.marketTags],
    },
    token: {
      mint: r.mint,
      symbol: r.symbol || t?.symbol || "",
      name: r.name || t?.name || "",
      // Rows carry the raw metadata URL: go through the same-origin proxy like every token image.
      imageUri: t?.imageUri ?? imageProxyUrl(r.mint, r.image),
      launchpad: r.launchpad === "pump" ? "pump" : "other",
      createdAt: t?.createdAt ?? NaN_,
      marketCapUsd: r.mcUsd ?? mul(r.mcSol, rate),
    },
  };
}
