/**
 * Wire-shaped fixtures (@zerofee/protocol) for the live adapter and data-source tests. Not imported by
 * app code.
 */
import type { ChainState, Order, TokenSummary, TrackedTradeRow, Trade, TradeContext } from "@zerofee/protocol";

export const MINT = "So1aNaMint1111111111111111111111111111111pump";
export const MINT2 = "Ano7herMint111111111111111111111111111111pump";
export const TRADER = "Trader1111111111111111111111111111111111111";
export const WALLET = "TradingWa11et111111111111111111111111111111";

export function wireToken(over: Partial<TokenSummary> = {}): TokenSummary {
  return {
    mint: MINT,
    name: "Solana Cat",
    symbol: "SCAT",
    image: "https://ipfs.io/ipfs/Qm1",
    imageProxied: `/api/img?mint=${MINT}&v=1`,
    description: null,
    launchpad: "pump",
    quoteMint: "So11111111111111111111111111111111111111112",
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    supply: 1_000_000_000,
    createdAt: 1_700_000_000_000,
    createdSlot: 300_000_000,
    creator: "Creator111111111111111111111111111111111111",
    priceSol: 0.000000031,
    priceUsd: 0.0000037,
    mcSol: 31,
    mcUsd: 3_704.5,
    priceQuote: 0.000000031,
    mcQuote: 31,
    liquidity: 1.2,
    liquidityUsd: 143.4,
    volume5m: 0.4,
    volume1h: 1.1,
    volume24h: 2.5,
    txns: 12,
    buys: 9,
    sells: 3,
    holders: 7,
    top10Pct: 41.2,
    holdersSource: "trades",
    holdersCheckedAt: null,
    devPct: 3.1,
    devSoldAll: false,
    devLaunches: 2,
    devMigrated: 0,
    snipersPct: 4.4,
    insidersPct: null,
    bundlersPct: 0,
    proTraders: null,
    bondingProgressBps: 1_234,
    complete: false,
    migrated: false,
    migratedAt: null,
    pool: null,
    socials: { x: "scat_sol", telegram: null, website: null },
    dexPaid: null,
    dexPaidAt: null,
    athMcSol: 33,
    isMayhem: false,
    lastTradeAt: 1_700_000_050_000,
    updatedAt: 1_700_000_050_000,
    ...over,
  };
}

export function wireTrade(over: Partial<Trade> = {}): Trade {
  return {
    id: "sig1:0",
    signature: "sig1",
    slot: 300_000_010,
    txIndex: 4,
    mint: MINT,
    venue: "pump",
    side: "buy",
    trader: TRADER,
    quoteAmount: "500000000",
    tokenAmount: "15000000000000",
    amountSol: 0.5,
    amountUsd: 59.75,
    priceSol: 0.000000033,
    mcSol: 33,
    blockTime: 1_700_000_060_000,
    receivedAt: 1_700_000_060_400,
    tags: ["sniper"],
    ...over,
  };
}

export function wireChain(over: Partial<ChainState> = {}): ChainState {
  return {
    slot: 300_000_100,
    blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
    lastValidBlockHeight: 280_000_150,
    blockhashSlot: 300_000_099,
    blockhashUpdatedAt: 1_700_000_100_000,
    priorityFees: { p50: 10_000, p75: 50_000, p95: 200_000, source: "rpc", updatedAt: 1_700_000_100_000 },
    jitoTipFloor: { p25: 1_000, p50: 5_000, p75: 20_000, p95: 100_000, p99: 500_000, emaP50: 6_000, updatedAt: 1_700_000_100_000 },
    solUsd: { price: 119.5, updatedAt: 1_700_000_100_000, stale: false, source: "binance" },
    halt: { halted: false, reason: null, since: null },
    ...over,
  };
}

export function curveCtx(over: Partial<Extract<TradeContext, { venue: "pump" }>> = {}): TradeContext {
  return {
    venue: "pump",
    mint: MINT,
    tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    decimals: 6,
    supply: "1000000000000000",
    quoteMint: "So11111111111111111111111111111111111111112",
    quoteTokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    quoteDecimals: 9,
    isMayhemMode: false,
    isCashbackCoin: false,
    isHolderReward: false,
    creatorFeeBps: "0",
    slot: 300_000_010,
    updatedAt: 1_700_000_060_000,
    bondingCurve: "Curve11111111111111111111111111111111111111",
    virtualTokenReserves: "1000000000000000",
    virtualQuoteReserves: "31000000000",
    realTokenReserves: "720000000000000",
    realQuoteReserves: "1000000000",
    tokenTotalSupply: "1000000000000000",
    complete: false,
    creator: "Creator111111111111111111111111111111111111",
    creatorVault: "CreatorVau1t1111111111111111111111111111111",
    migrated: false,
    pool: null,
    ...over,
  };
}

export function wireOrder(over: Partial<Order> = {}): Order {
  return {
    id: "6d0f6f1c-3a8e-4b1e-9b8e-0c6d9c5e7a11",
    wallet: WALLET,
    kind: "take-profit",
    side: "sell",
    mint: MINT,
    amount: "15000000000000",
    fullExit: false,
    trigger: { type: "quote-at-least", threshold: "900000000" },
    ocoGroup: null,
    status: "armed",
    statusReason: null,
    flags: [],
    attempts: [
      {
        index: 0,
        nonceAccount: "Nonce111111111111111111111111111111111111111",
        status: "live",
        variants: 6,
        minOutLow: "850000000",
        minOutHigh: "900000000",
        submittedVariantId: null,
        submittedAtSlot: null,
        consumedBy: null,
      },
    ],
    venues: ["pump"],
    armingQuoteOut: "450000000",
    armedAt: 1_700_000_070_000,
    reservation: { lamports: "2105000", tokens: "15000000000000" },
    capCost: { buyLamports: "0", feeLamports: "105000" },
    signature: null,
    highWater: null,
    open: true,
    dryRun: true,
    createdAt: 1_700_000_070_000,
    updatedAt: 1_700_000_070_000,
    ...over,
  };
}

export function trackedRow(over: Partial<TrackedTradeRow> = {}): TrackedTradeRow {
  return {
    id: "sig9:0:W",
    kind: "buy",
    wallet: TRADER,
    role: "trader",
    label: "Whale",
    emoji: "",
    tag: "Whale",
    walletTags: [],
    trader: TRADER,
    mint: MINT,
    symbol: "SCAT",
    name: "Solana Cat",
    image: null,
    launchpad: "pump",
    venue: "pump",
    amountSol: 1.25,
    amountUsd: 149.4,
    tokenAmount: "37000000000000",
    priceSol: 0.000000034,
    mcSol: 34,
    mcUsd: 4_063,
    signature: "sig9",
    slot: 300_000_020,
    blockTime: 1_700_000_065_000,
    receivedAt: 1_700_000_065_300,
    firstBuy: true,
    marketTags: ["pro"],
    ...over,
  };
}
