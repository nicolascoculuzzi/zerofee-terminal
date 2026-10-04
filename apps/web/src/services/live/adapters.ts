/**
 * Thin adapters from the gateway's wire shapes (@zerofee/protocol, the source of truth) to the UI's
 * view models (src/protocol.ts). Pure functions, unit-tested in adapters.test.ts.
 *
 * Unknown values: the wire uses `null` for "not known / not computed by this deployment". Numeric view
 * fields the server does not publish become NaN, which every formatter renders as "–" (DESIGN.md 3.12)
 * and every risk band reads as "unknown". Nothing here invents a number.
 */
import { USDC_MINT, WSOL_MINT } from "@zerofee/core";
import type {
  ChainState,
  HealthResponse,
  TrackedTradeRow,
  TradeContext,
  Candle as WireCandle,
  TokenSummary as WireToken,
  Trade as WireTrade,
} from "@zerofee/protocol";
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

const NaN_ = Number.NaN;
const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN_);

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
  /** SOL/USD from the `chain` topic (NaN while unknown). */
  solUsd: number;
  /** Pulse column when the summary came from a column topic. */
  column?: PulseColumnId;
}

export function adaptToken(t: WireToken, ctx: TokenAdaptContext): TokenSummary {
  const solUsd = num(ctx.solUsd);
  return {
    mint: t.mint,
    name: t.name,
    symbol: t.symbol,
    imageUri: t.image,
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
    priceSol: t.priceSol,
    priceUsd: num(t.priceUsd),
    marketCapSol: t.mcSol,
    marketCapUsd: num(t.mcUsd),
    liquidityUsd: num(t.liquidityUsd),
    volumeUsd: t.volume24h * solUsd,
    txns: t.txns,
    buys: t.buys,
    sells: t.sells,
    holders: num(t.holders),
    proTraders: num(t.proTraders),
    bondingProgress: t.migrated || t.complete ? 1 : t.bondingProgressBps / 10_000,
    migratedAt: t.migratedAt,
    risk: {
      top10Pct: num(t.top10Pct),
      devPct: num(t.devPct),
      devSold: t.devSoldAll === true,
      snipersPct: num(t.snipersPct),
      insidersPct: num(t.insidersPct),
      bundlersPct: num(t.bundlersPct),
    },
    dexPaid: t.dexPaid === true,
    dexPaidAt: t.dexPaidAt,
    lpBurnedPct: null,
    token2022: null,
    feesPaidSol: NaN_,
    netBuyUsd: NaN_,
    lastTradeAt: num(t.lastTradeAt),
    change5mPct: NaN_,
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
  solUsd: number;
  /** The user's own wallets (trading wallets and the connected wallet): their trades get "you". */
  own?: ReadonlySet<string>;
}

export function adaptTrade(t: WireTrade, ctx: TradeAdaptContext): Trade {
  // The rate at the trade when the server priced it in USD, else the current one.
  const rate = t.amountUsd !== null && t.amountSol > 0 ? t.amountUsd / t.amountSol : num(ctx.solUsd);
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
    solAmount: t.amountSol,
    tokenAmount: uiAmount(t.tokenAmount, ctx.decimals),
    priceSol: t.priceSol,
    priceUsd: t.priceSol * rate,
    marketCapUsd: t.mcSol * rate,
    maker: t.trader,
    tags,
  };
}

/**
 * OHLCV bucket. The wire counts trades (`n`) without splitting buys and sells, so those view fields are
 * unknown. A bucket without a recorded SOL/USD takes the current rate (USD charts stay continuous).
 */
export function adaptCandle(c: WireCandle, solUsdNow: number): Candle {
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
export function adaptTrackedRow(r: TrackedTradeRow, ctx: { decimals: number; solUsd: number; token?: TokenSummary | null }): TrackedTrade {
  const rate = r.mcUsd !== null && r.mcSol > 0 ? r.mcUsd / r.mcSol : num(ctx.solUsd);
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
      solAmount: r.amountSol,
      tokenAmount: uiAmount(r.tokenAmount, ctx.decimals),
      priceSol: r.priceSol,
      priceUsd: r.priceSol * rate,
      marketCapUsd: r.mcSol * rate,
      maker: r.wallet,
      tags: ["tracked", ...r.marketTags],
    },
    token: {
      mint: r.mint,
      symbol: r.symbol || t?.symbol || "",
      name: r.name || t?.name || "",
      imageUri: r.image ?? t?.imageUri ?? null,
      launchpad: r.launchpad === "pump" ? "pump" : "other",
      createdAt: t?.createdAt ?? NaN_,
      marketCapUsd: r.mcUsd ?? r.mcSol * rate,
    },
  };
}
