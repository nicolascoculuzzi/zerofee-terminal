/**
 * Raydium LaunchLab curves and CPMM graduation pools in MarketState, from real mainnet transactions and
 * accounts (core's offline snapshot): launches, trades from gRPC records (wallet + mints from instruction
 * accounts) and logs-only records (mints from the pool account, no wallet), bonding progress from the
 * curve's own total_base_sell, graduation through migrate_to_cpswap / a first CPMM swap / the logs hint /
 * classification of unknown pools, quotes (SOL, USDC, exotic -> null SOL values), Token-2022 transfer fees,
 * Pulse columns, trade contexts that core can build from, and dead-slot rollbacks.
 */
import { describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import {
  type CpmmSwapEvent,
  cpmmFeeRates,
  type LaunchLabTradeEvent,
  launchLabMarketCap,
  launchLabTradeParams,
  quoteCpmmSwapBaseInput,
  quoteLaunchLabBuyExactIn,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  transferFeeFor,
  USDC_MINT,
  WSOL_MINT,
} from "@zerofee/core";
import type { CpmmTradeContext, LaunchLabTradeContext } from "@zerofee/protocol";
import { RaydiumRegistry } from "../src/accounts/raydium";
import type { IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { classify } from "../src/market/pulse";
import { MarketState } from "../src/market/state";
import { deserializeRecord, serializeRecord } from "../src/storage/codec";
import { FakeResolver } from "./helpers";
import {
  ammConfigOf,
  CPMM,
  cpmmPoolOf,
  FixtureFetcher,
  LL,
  llGlobal,
  llPlatform,
  llPool,
  mintOf,
  raydiumGrpc,
  raydiumLogs,
  rtx,
  type TxLabel,
} from "./raydiumFixtures";

setLogLevel("error");

const CFG = { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] };
const NOW = 1_791_060_000_000;
const PULSE = { finalStretchBps: 6_000, migratedWindowMs: 86_400_000, newMaxAgeMs: 3_600_000, finalMaxIdleMs: 3_600_000, listLimit: 50 };

function market(solUsd: number | null = 150) {
  const resolver = new FakeResolver();
  const fetcher = new FixtureFetcher();
  let m: MarketState | null = null;
  const reg = new RaydiumRegistry(fetcher, {
    launchLabPool: (i) => m?.onLaunchLabPoolReady(i),
    launchLabPoolMissing: (p) => m?.onLaunchLabPoolMissing(p),
    platform: (a) => m?.onPlatformConfig(a),
    cpmmPool: (i) => m?.onCpmmPoolReady(i),
    cpmmRejected: (p) => m?.onCpmmRejected(p),
  });
  m = new MarketState(CFG, { resolver, solUsd: () => solUsd, now: () => NOW, raydium: reg });
  return { m, reg, fetcher, resolver };
}

/** Resolves a mint the way the account resolver reports it (snapshot account). */
function resolveMint(m: MarketState, mint: string): void {
  const info = mintOf(mint);
  m.onMintResolved({
    mint,
    tokenProgram: info.tokenProgram,
    decimals: info.decimals,
    supply: info.supply,
    metadata: null,
    dangers: [],
    transferFeeConfig: info.extensions.transferFeeConfig,
  });
}

const tradeOf = (tx: IngestTx): LaunchLabTradeEvent => {
  const ev = tx.events.find((e) => e.kind === "launchlabTrade");
  if (ev?.kind !== "launchlabTrade") throw new Error("no LaunchLab trade");
  return ev;
};
const swapOf = (tx: IngestTx): CpmmSwapEvent => {
  const ev = tx.events.find((e) => e.kind === "cpmmSwap");
  if (ev?.kind !== "cpmmSwap") throw new Error("no CPMM swap");
  return ev;
};
const ui = (v: bigint, d: number) => Number(v) / 10 ** d;

describe("LaunchLab launch", () => {
  test("initialize + dev buy (gRPC): a LaunchLab coin with its platform, creator, curve and dev trade", async () => {
    const { m, fetcher } = market();
    const tx = raydiumGrpc("create", { receivedAt: NOW - 1_000 });
    m.applyTx(tx);
    const mint = "GMoT4hnb9g4QkaStKSFgmfwxxZ1iucH3odHv6emC3nLr";
    const rec = m.tokens.get(mint);
    expect(rec).toMatchObject({
      launchpad: "launchlab",
      platform: "StonkFun",
      name: "Catetober",
      symbol: "CATETOBER",
      decimals: 6,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      creator: "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM",
      createUser: "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM",
      createdAt: NOW - 1_000, // no timestamp in LaunchLab events: the receive time
      createSignature: rtx("create").signature,
      quoteMint: "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump",
    });
    expect(rec?.launchLab).toMatchObject({
      pool: "3CKWpKJnutMhH8QtJFd3hP9hWMmMX7HzMBgzbpC1adL5",
      totalBaseSell: 793_100_000_000_000n,
      totalQuoteFundRaising: 141_521_683_411n,
      migrateType: 1,
      virtualBase: 1_073_025_605_595_375n,
      virtualQuote: 49_950_249_569n,
    });
    expect(m.stats).toMatchObject({ launches: 1, launchLabLaunches: 1, launchLabTrades: 1 });
    const [trade] = m.recentTrades(mint);
    expect(trade).toMatchObject({ venue: "launchlab", side: "buy", trader: "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM", tags: ["dev"] });
    // Quoted in a pump.fun coin: no SOL value, ever reported as 0.
    expect(trade?.amountSol).toBeNull();
    expect(trade?.priceSol).toBeNull();
    expect(trade?.mcSol).toBeNull();
    const ev = tradeOf(tx);
    // quote moved on the curve, excluding the protocol + platform fees
    expect(trade?.quoteAmount).toBe((ev.amountIn - ev.protocolFee - ev.platformFee).toString());
    const s = m.summary(mint);
    expect(s).toMatchObject({ launchpad: "launchlab", platform: "StonkFun", priceSol: null, mcSol: null, liquidity: null, volume5m: null });
    expect(s?.holders).toBe(1);
    expect(s?.devPct).toBeGreaterThan(0);
    // progress = base sold / the curve's own total_base_sell
    expect(s?.bondingProgressBps).toBe(Number((ev.realBaseAfter * 10_000n) / ev.totalBaseSell));
    expect(classify(s as NonNullable<typeof s>, PULSE, NOW)).toBe("new");
    // the quote (a Token-2022 pump coin) is read for its decimals and transfer fee
    await fetcher.flush();
  });

  test("logs-only launch: the PoolCreateEvent waits for the pool account, then the coin appears", async () => {
    const { m, fetcher, reg } = market();
    // The snapshot has no account for this pool: answer it with the letsbonk pool's layout, re-keyed.
    const tx = raydiumLogs("create");
    m.applyTx(tx);
    expect(m.tokens.size).toBe(0);
    expect(m.pendingPoolEvents).toBe(2);
    await fetcher.flush();
    // pool account missing in the snapshot: the waiting events are dropped, never misattributed
    expect(m.pendingPoolEvents).toBe(0);
    expect(m.stats.pendingDropped).toBe(2);
    expect(reg.stats.missing).toBeGreaterThan(0);
  });
});

describe("LaunchLab trades", () => {
  test("SOL pair (gRPC): wallet and mint from the instruction, price / MC / progress from the event", async () => {
    const { m, fetcher } = market();
    const tx = raydiumGrpc("bonkBuy", { receivedAt: NOW - 500 });
    m.applyTx(tx);
    const ev = tradeOf(tx);
    const mint = llPool(LL.bonk).baseMint;
    const [trade] = m.recentTrades(mint);
    expect(trade).toMatchObject({ venue: "launchlab", side: "buy", trader: rtx("bonkBuy").feePayer, tokenAmount: ev.amountOut.toString() });
    expect(trade?.amountSol).toBeCloseTo(Number(ev.amountIn - ev.protocolFee - ev.platformFee) / 1e9, 12);
    await fetcher.flush(); // pool account: supply, creator; configs
    const s = m.summary(mint);
    const curve = {
      virtualBase: ev.virtualBase,
      virtualQuote: ev.virtualQuote,
      realBase: ev.realBaseAfter,
      realQuote: ev.realQuoteAfter,
      status: 0,
      totalBaseSell: ev.totalBaseSell,
      totalQuoteFundRaising: 0n,
    };
    const supply = llPool(LL.bonk).supply;
    expect(s?.mcSol).toBeCloseTo(Number(launchLabMarketCap(curve, supply)) / 1e9, 6);
    expect(s?.priceSol).toBeCloseTo(ui(ev.virtualQuote + ev.realQuoteAfter, 9) / ui(ev.virtualBase - ev.realBaseAfter, 6), 12);
    expect(s?.liquidity).toBeCloseTo(ui(ev.realQuoteAfter, 9), 9);
    expect(s?.bondingProgressBps).toBe(Number((ev.realBaseAfter * 10_000n) / ev.totalBaseSell));
    expect(s).toMatchObject({ launchpad: "launchlab", platform: "letsbonk.fun", quoteMint: WSOL_MINT, holders: null, migrated: false });
    expect(s?.mcUsd).toBeCloseTo((s?.mcSol ?? 0) * 150, 6);
    expect(m.stats.unattributedTrades).toBe(0);
  });

  test("logs-only trade: parked until the pool account names the mint; recorded without a wallet", async () => {
    const { m, fetcher } = market();
    m.applyTx(raydiumLogs("bonkBuy"));
    const mint = llPool(LL.bonk).baseMint;
    expect(m.tokens.has(mint)).toBe(false);
    await fetcher.flush();
    const [trade] = m.recentTrades(mint);
    expect(trade).toMatchObject({ venue: "launchlab", trader: "" });
    expect(m.stats.unattributedTrades).toBe(1);
    expect(m.summary(mint)?.holders).toBeNull();
    expect(m.pendingPoolEvents).toBe(0);
  });

  test("exotic quote (Token-2022 xStock): SOL values are null, never 0; quote-unit values are known", async () => {
    const { m, fetcher } = market();
    const tx = raydiumGrpc("stonkXstockSell");
    m.applyTx(tx);
    const mint = llPool(LL.stonkXstock).baseMint;
    await fetcher.flush(); // pool account: the xStock's 8 decimals and Token-2022 flag
    const s = m.summary(mint);
    expect(s).toMatchObject({ priceSol: null, mcSol: null, priceUsd: null, mcUsd: null, liquidity: null, liquidityUsd: null });
    expect(s?.volume5m).toBeNull();
    expect(s?.athMcSol).toBeNull();
    const ev = tradeOf(tx);
    expect(s?.priceQuote).toBeCloseTo(ui(ev.virtualQuote + ev.realQuoteAfter, 8) / ui(ev.virtualBase - ev.realBaseAfter, 6), 15);
    expect(s?.mcQuote).toBeGreaterThan(0);
    const [trade] = m.recentTrades(mint);
    expect([trade?.amountSol, trade?.amountUsd, trade?.priceSol, trade?.mcSol]).toEqual([null, null, null, null]);
    expect(m.candles.range(mint, "1s")).toEqual([]);
  });

  test("USDC pair: SOL values through SOL/USD, USD amounts exact even without a rate", () => {
    for (const solUsd of [125, null]) {
      const { m } = market(solUsd);
      const tx = raydiumGrpc("bonkBuy");
      const acc = tx.raydium?.accounts[0];
      if (acc?.kind !== "launchlabSwap") throw new Error("fixture");
      tx.raydium = { accounts: [{ ...acc, quoteMint: USDC_MINT }], migrations: [] };
      m.applyTx(tx);
      const ev = tradeOf(tx);
      const usd = Number(ev.amountIn - ev.protocolFee - ev.platformFee) / 1e6;
      const [trade] = m.recentTrades(acc.baseMint);
      expect(trade?.amountUsd).toBeCloseTo(usd, 9);
      if (solUsd) expect(trade?.amountSol).toBeCloseTo(usd / solUsd, 9);
      else expect(trade?.amountSol).toBeNull();
      expect(m.summary(acc.baseMint)?.quoteMint).toBe(USDC_MINT);
    }
  });

  test("Token-2022 coin with a 3% transfer fee: the tape shows what the trader received / sent", async () => {
    const { m, fetcher } = market();
    const mint = llPool(LL.stonkFee).baseMint;
    m.applyTx(raydiumGrpc("stonkFeeSell"));
    await fetcher.flush();
    resolveMint(m, mint);
    expect(m.tokens.get(mint)?.transferFeeConfig).not.toBeNull();
    const buy = raydiumGrpc("stonkFeeBuy");
    m.applyTx(buy);
    const ev = tradeOf(buy);
    const t = rtx("stonkFeeBuy");
    const fee = transferFeeFor(mintOf(mint).extensions.transferFeeConfig, t.epoch, ev.amountOut);
    expect(fee).toBeGreaterThan(0n);
    const [trade] = m.recentTrades(mint);
    expect(trade?.tokenAmount).toBe((ev.amountOut - fee).toString());
    // equals the trader's post-trade balance change in the transaction
    const acc = buy.raydium?.accounts[0];
    if (acc?.kind !== "launchlabSwap") throw new Error("fixture");
    const pre = t.preTokenBalances.find((b) => b.account === acc.userBaseToken)?.amount ?? "0";
    const post = t.postTokenBalances.find((b) => b.account === acc.userBaseToken)?.amount ?? "0";
    expect(BigInt(post) - BigInt(pre)).toBe(ev.amountOut - fee);
  });

  test("a dead slot rolls the trade back", () => {
    const { m } = market();
    const tx = raydiumGrpc("bonkBuy");
    m.applyTx(tx);
    const mint = llPool(LL.bonk).baseMint;
    expect(m.recentTrades(mint)).toHaveLength(1);
    m.dropSlot(tx.slot);
    expect(m.recentTrades(mint)).toHaveLength(0);
    expect(m.changes.tradeCorrections.get(mint)?.remove).toEqual([`${tx.signature}:0`]);
  });

  test("trade context: everything core needs to quote and build a LaunchLab buy", async () => {
    const { m, fetcher } = market();
    const tx = raydiumGrpc("bonkBuy");
    m.applyTx(tx);
    const mint = llPool(LL.bonk).baseMint;
    expect(m.tradeContext(mint)).toBeNull(); // configs not read yet
    await fetcher.flush();
    const ctx = m.tradeContext(mint) as LaunchLabTradeContext;
    const pool = llPool(LL.bonk);
    const ev = tradeOf(tx);
    expect(ctx).toMatchObject({
      venue: "launchlab",
      mint,
      pool: LL.bonk,
      globalConfig: pool.globalConfig,
      platformConfig: pool.platformConfig,
      platform: "letsbonk.fun",
      baseVault: pool.baseVault,
      quoteVault: pool.quoteVault,
      creator: pool.creator,
      tokenProgramFlag: pool.tokenProgramFlag,
      tokenProgram: TOKEN_PROGRAM_ID,
      quoteMint: WSOL_MINT,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      status: 0,
      migrateType: 1,
      realBase: ev.realBaseAfter.toString(),
      realQuote: ev.realQuoteAfter.toString(),
      virtualBase: ev.virtualBase.toString(),
      totalBaseSell: ev.totalBaseSell.toString(),
      curveType: 0,
      protocolFeeRate: llGlobal(pool.globalConfig).tradeFeeRate.toString(),
      platformFeeRate: llPlatform(pool.platformConfig).feeRate.toString(),
      creatorFeeRate: llPlatform(pool.platformConfig).creatorFeeRate.toString(),
      baseTransferFee: null,
      quoteTransferFee: null,
      cpswapConfig: llPlatform(pool.platformConfig).cpswapConfig,
    });
    expect(ctx.graduationPool).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // The browser quotes with core from these strings alone.
    const q = quoteLaunchLabBuyExactIn(
      {
        status: ctx.status,
        virtualBase: BigInt(ctx.virtualBase),
        virtualQuote: BigInt(ctx.virtualQuote),
        realBase: BigInt(ctx.realBase),
        realQuote: BigInt(ctx.realQuote),
        totalBaseSell: BigInt(ctx.totalBaseSell),
        totalQuoteFundRaising: BigInt(ctx.totalQuoteFundRaising),
      },
      10_000_000n,
      launchLabTradeParams({
        globalConfig: { curveType: ctx.curveType, tradeFeeRate: BigInt(ctx.protocolFeeRate), maxShareFeeRate: 0n },
        platformConfig: { feeRate: BigInt(ctx.platformFeeRate), creatorFeeRate: BigInt(ctx.creatorFeeRate) },
      }),
    );
    expect(q.baseOut).toBeGreaterThan(0n);
  });
});

/**
 * The graduated letsbonk pool as it read between its last buy and migrate_to_cpswap: status 1 (the snapshot
 * was taken after graduation, status 2). PoolState: discriminator, epoch u64, auth_bump u8, then status.
 */
function curveCompleteAccount(fetcher: FixtureFetcher): void {
  const real = fetcher.lookup(LL.graduated);
  if (!real) throw new Error("fixture");
  const data = new Uint8Array(real.data);
  data[17] = 1;
  fetcher.accounts.set(LL.graduated, { ...real, data });
}

/** A synthetic final buy completing the graduated letsbonk curve (its real migrate tx is in the snapshot). */
function completingBuy(): IngestTx {
  const base = raydiumGrpc("bonkBuy", { slot: 452_341_400, signature: "complete".padEnd(88, "1"), receivedAt: NOW - 10_000 });
  const pool = llPool(LL.graduated);
  const ev = tradeOf(base);
  const acc = base.raydium?.accounts[0];
  if (acc?.kind !== "launchlabSwap") throw new Error("fixture");
  const done: LaunchLabTradeEvent = {
    ...ev,
    pool: LL.graduated as Address,
    totalBaseSell: pool.totalBaseSell,
    virtualBase: pool.virtualBase,
    virtualQuote: pool.virtualQuote,
    realBaseAfter: pool.totalBaseSell,
    realQuoteAfter: pool.realQuote,
    poolStatus: 1,
  };
  return {
    ...base,
    events: [done],
    raydium: {
      accounts: [
        {
          ...acc,
          pool: LL.graduated,
          baseMint: pool.baseMint,
          quoteMint: pool.quoteMint,
          platformConfig: pool.platformConfig,
          globalConfig: pool.globalConfig,
        },
      ],
      migrations: [],
    },
  };
}

describe("graduation to CPMM", () => {
  test("completing buy -> Final Stretch; migrate_to_cpswap -> Migrated with its CPMM pool; CPMM swaps price the coin", async () => {
    const { m, fetcher } = market();
    const mint = llPool(LL.graduated).baseMint;
    curveCompleteAccount(fetcher);
    m.applyTx(completingBuy());
    await fetcher.flush();
    let s = m.summary(mint);
    expect(s).toMatchObject({ complete: true, migrated: false, bondingProgressBps: 10_000 });
    expect(m.stats.launchLabCompletes).toBe(1);
    // the graduation pool is known before it exists (armed migration snipes)
    expect(m.tokens.get(mint)?.launchLab?.graduationPool).toBe(CPMM.bonk);

    const mig = raydiumGrpc("migrate", { receivedAt: NOW - 60_000 });
    m.applyTx(mig);
    s = m.summary(mint);
    expect(s).toMatchObject({ migrated: true, migratedAt: NOW - 60_000, pool: CPMM.bonk, launchpad: "launchlab" });
    expect(classify(s as NonNullable<typeof s>, PULSE, NOW)).toBe("migrated");
    expect(m.stats).toMatchObject({ migrations: 1, launchLabGraduations: 1 });
    // opening reserves = the new vaults (no fees owed yet)
    expect(s?.priceSol).toBeCloseTo(ui(85_000_000_066n, 9) / ui(267_478_890_000_000n, 6), 12);
    expect(m.changes.feed.some((f) => f.kind === "migration" && f.mint === mint)).toBe(true);

    await fetcher.flush(); // CPMM pool, AmmConfig, vaults
    const buy = raydiumGrpc("cpmmBonkBuy");
    m.applyTx(buy);
    const ev = swapOf(buy);
    const cfg = ammConfigOf(cpmmPoolOf(CPMM.bonk).ammConfig);
    const protocol = (ev.tradeFee * cfg.protocolFeeRate) / 1_000_000n;
    const fund = (ev.tradeFee * cfg.fundFeeRate) / 1_000_000n;
    const quoteAfter = ev.inputVaultBefore + ev.inputAmount - protocol - fund - (ev.creatorFeeOnInput ? ev.creatorFee : 0n);
    const baseAfter = ev.outputVaultBefore - ev.outputAmount - (ev.creatorFeeOnInput ? 0n : ev.creatorFee);
    const rec = m.tokens.get(mint);
    expect(rec?.poolState).toEqual({ base: baseAfter, quoteVault: quoteAfter, virtualQuote: 0n });
    const [trade] = m.recentTrades(mint);
    expect(trade).toMatchObject({
      venue: "cpmm",
      side: "buy",
      trader: rtx("cpmmBonkBuy").feePayer,
      tokenAmount: ev.outputAmount.toString(),
    });
    expect(trade?.priceSol).toBeCloseTo(ui(quoteAfter, 9) / ui(baseAfter, 6), 12);
    expect(trade?.mcSol).toBeCloseTo((trade?.priceSol ?? 0) * ui(rec?.supply ?? 0n, 6), 6);
    const sell = raydiumGrpc("cpmmBonkSell");
    m.applyTx(sell);
    expect(m.recentTrades(mint)[0]).toMatchObject({ venue: "cpmm", side: "sell" });
    expect(m.stats.cpmmTrades).toBe(2);
  });

  test("CPMM trade context: reserves net of fees owed and the pool's rates; core quotes from it", async () => {
    const { m, fetcher } = market();
    const mint = llPool(LL.graduated).baseMint;
    curveCompleteAccount(fetcher);
    m.applyTx(completingBuy());
    m.applyTx(raydiumGrpc("migrate"));
    await fetcher.flush();
    m.applyTx(raydiumGrpc("cpmmBonkBuy"));
    resolveMint(m, mint);
    const ctx = m.tradeContext(mint) as CpmmTradeContext;
    const pool = cpmmPoolOf(CPMM.bonk);
    const cfg = ammConfigOf(pool.ammConfig);
    expect(ctx).toMatchObject({
      venue: "cpmm",
      pool: CPMM.bonk,
      ammConfig: pool.ammConfig,
      token0Mint: pool.token0Mint,
      token1Mint: pool.token1Mint,
      token0Vault: pool.token0Vault,
      token1Vault: pool.token1Vault,
      observation: pool.observationKey,
      creatorFeeOn: pool.creatorFeeOn,
      enableCreatorFee: pool.enableCreatorFee,
      tradeFeeRate: cfg.tradeFeeRate.toString(),
      creatorFeeRate: cfg.creatorFeeRate.toString(),
      launchLabPool: LL.graduated,
      platform: "letsbonk.fun",
    });
    const rec = m.tokens.get(mint);
    const baseIs0 = pool.token0Mint === mint;
    expect(ctx.token0Reserve).toBe(String(baseIs0 ? rec?.poolState?.base : rec?.poolState?.quoteVault));
    const q = quoteCpmmSwapBaseInput({
      pool: {
        ...pool,
        protocolFeesToken0: 0n,
        protocolFeesToken1: 0n,
        fundFeesToken0: 0n,
        fundFeesToken1: 0n,
        creatorFeesToken0: 0n,
        creatorFeesToken1: 0n,
      },
      vault0Amount: BigInt(ctx.token0Reserve),
      vault1Amount: BigInt(ctx.token1Reserve),
      inputMint: WSOL_MINT,
      rates: cpmmFeeRates(cfg, pool),
      amountIn: 100_000_000n,
    });
    expect(q.amountReceived).toBeGreaterThan(0n);
  });

  test("logs feed: a watched curve that completed graduates at its first swap on the derived pool", async () => {
    const { m, fetcher } = market();
    const mint = llPool(LL.graduated).baseMint;
    curveCompleteAccount(fetcher);
    m.applyTx(completingBuy());
    await fetcher.flush();
    const swap = raydiumLogs("cpmmBonkBuy", { receivedAt: NOW - 5_000 });
    m.applyTx(swap);
    const s = m.summary(mint);
    expect(s).toMatchObject({ migrated: true, pool: CPMM.bonk, migratedAt: NOW - 5_000 });
    expect(m.recentTrades(mint)[0]).toMatchObject({ venue: "cpmm", trader: "" });
  });

  test("logs feed: the migrate hint re-reads completed curves; status 2 = graduated", async () => {
    const { m, fetcher } = market();
    const mint = llPool(LL.graduated).baseMint;
    curveCompleteAccount(fetcher);
    m.applyTx(completingBuy());
    await fetcher.flush();
    expect(m.summary(mint)?.migrated).toBe(false);
    fetcher.accounts.delete(LL.graduated); // migrate_to_cpswap ran: the account now reads status 2
    m.onLaunchLabMigrationHint();
    await fetcher.flush();
    expect(m.summary(mint)).toMatchObject({ migrated: true, pool: CPMM.bonk, migratedAt: NOW });
    expect(m.tokens.get(mint)?.poolState).not.toBeNull(); // from the vaults
  });

  test("an unknown CPMM pool is classified once: a graduate becomes a migrated LaunchLab coin, others are ignored", async () => {
    const { m, fetcher, reg } = market();
    const mint = llPool(LL.graduated).baseMint;
    m.applyTx(raydiumLogs("cpmmBonkSell"));
    expect(m.pendingPoolEvents).toBe(1);
    await fetcher.flush();
    const s = m.summary(mint);
    expect(s).toMatchObject({ launchpad: "launchlab", migrated: true, pool: CPMM.bonk, migratedAt: null, platform: "letsbonk.fun" });
    expect(m.recentTrades(mint)).toHaveLength(1);
    expect(reg.stats.classified).toBe(1);

    // a pair with no LaunchLab pool: rejected once, later swaps on it are dropped without reads
    const foreign = raydiumLogs("cpmmStonkSell");
    m.applyTx(foreign);
    await fetcher.flush();
    expect(reg.isRejected(CPMM.stonk)).toBe(true);
    const reads = fetcher.requested.length;
    m.applyTx({ ...foreign, signature: "again".padEnd(88, "2") });
    await fetcher.flush();
    expect(fetcher.requested.length).toBe(reads);
    expect(m.stats.cpmmIgnored).toBe(2);
    expect(m.pendingPoolEvents).toBe(0);
  });
});

describe("RPC logs fetch policy", () => {
  test("LaunchLab events and graduations always; CPMM swaps only on graduation pools", async () => {
    const { m, fetcher } = market();
    curveCompleteAccount(fetcher);
    const ll = raydiumLogs("bonkBuy").events;
    const cp = raydiumLogs("cpmmBonkBuy").events;
    expect(m.wantsRaydiumTx(ll, false)).toBe(true);
    expect(m.wantsRaydiumTx([], true)).toBe(true);
    expect(m.wantsRaydiumTx(cp, false)).toBe(false);
    m.applyTx(completingBuy());
    await fetcher.flush();
    expect(m.wantsRaydiumTx(cp, false)).toBe(true); // the derived graduation pool of a watched coin
  });
});

describe("restore", () => {
  test("a persisted LaunchLab coin seeds pool -> mint without reads", () => {
    const a = market();
    a.m.applyTx(raydiumGrpc("bonkBuy"));
    const mint = llPool(LL.bonk).baseMint;
    const rec = a.m.tokens.get(mint);
    if (!rec) throw new Error("no record");
    const b = market();
    b.m.restore(deserializeRecord(serializeRecord(rec), NOW).rec);
    expect(b.reg.baseMintOf(LL.bonk)).toBe(mint);
    expect(b.fetcher.requested).not.toContain(LL.bonk); // only the shared configs are read
    b.m.applyTx(raydiumLogs("bonkBuy" as TxLabel, { slot: rtx("bonkBuy").slot + 10, signature: "later".padEnd(88, "3") }));
    expect(b.m.recentTrades(mint)).toHaveLength(1); // applied at once: the mint was known
  });
});
