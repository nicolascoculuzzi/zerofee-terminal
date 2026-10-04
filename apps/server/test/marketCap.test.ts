/**
 * Market-cap regressions from real mainnet transactions and accounts (test/fixtures/market-cap.json), one
 * block per cause found by the 2026-10-04 live run (NOTES.md). Every market cap is checked against
 * @zerofee/core's verified curve math with the real mint supply. Offline.
 */
import { describe, expect, test } from "bun:test";
import { getBase58Encoder } from "@solana/kit";
import { curveMarketCapForDisplay, type PumpCreateEvent, type PumpTradeEvent, TOKEN_2022_PROGRAM_ID } from "@zerofee/core";
import { MarketState } from "../src/market/state";
import type { TokenRecord } from "../src/market/token";
import { bigintReplacer, bigintReviver, deserializeRecord, serializeRecord } from "../src/storage/codec";
import { FakeResolver, waitFor } from "./helpers";
import { curveResolved, mcFixture, mcLogs, mintResolved, poolResolved } from "./marketCapFixtures";

const CFG = { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] };
const SOL_USD = 120.11; // the run's SOL/USD

function market(solUsd: number | null = SOL_USD) {
  const resolver = new FakeResolver();
  const m = new MarketState(CFG, { resolver, solUsd: () => solUsd, now: () => 1_791_079_500_000 });
  return { m, resolver };
}

const MHK = "FaNi7NixrJqkMgqYFazFxv77KZcVW2GC64P65qBSpump";
const TWO_B = 2_000_000_000_000_000n;

function lastTrade(label: string): PumpTradeEvent {
  const ev = mcLogs(label)
    .events.filter((e) => e.kind === "pumpTrade")
    .pop();
  if (ev?.kind !== "pumpTrade") throw new Error(`no trade in ${label}`);
  return ev;
}

/** Core's market cap (SOL) for a SOL curve's post-trade reserves and a mint supply. */
function coreMcSol(ev: PumpTradeEvent, mintSupply: bigint): number {
  return (
    Number(
      curveMarketCapForDisplay(
        { virtualQuoteReserves: ev.virtualQuoteReserves, virtualTokenReserves: ev.virtualTokenReserves },
        mintSupply,
      ),
    ) / 1e9
  );
}

describe("mayhem coins: market caps use the 2B mint supply, not the curve's 1e15", () => {
  test("create_v2 mints token_total_supply twice; the summary and trade context keep the two apart", async () => {
    const f = mcFixture("mayhem-create");
    // the mint gets two MintTo of 1e15 (curve + Mayhem vault) while the CreateEvent says 1e15
    const keys = [
      ...f.tx.transaction.message.accountKeys,
      ...(f.tx.meta.loadedAddresses?.writable ?? []),
      ...(f.tx.meta.loadedAddresses?.readonly ?? []),
    ];
    const b58 = getBase58Encoder();
    const mintTos = f.tx.meta.innerInstructions
      .flatMap((g) => g.instructions)
      .filter((ix) => keys[ix.programIdIndex] === TOKEN_2022_PROGRAM_ID)
      .map((ix) => new Uint8Array(b58.encode(ix.data)))
      .filter((d) => d[0] === 7 && d.length === 9)
      .map((d) => new DataView(d.buffer, d.byteOffset).getBigUint64(1, true));
    expect(mintTos).toEqual([1_000_000_000_000_000n, 1_000_000_000_000_000n]);
    const create = mcLogs("mayhem-create").events.find((e) => e.kind === "pumpCreate") as PumpCreateEvent;
    expect(create).toMatchObject({ isMayhemMode: true, tokenTotalSupply: 1_000_000_000_000_000n, virtualSolReserves: 30_000_000_000n });

    const { m } = market();
    m.applyTx(mcLogs("mayhem-create"));
    const s = m.summary(MHK);
    expect(s?.supply).toBe(2e9);
    const buy = lastTrade("mayhem-create");
    // 30.0587 SOL / 1,070.9M tokens x 2B = 56.14 SOL (was 28.07 SOL with the curve's 1e15)
    expect(s?.mcSol).toBeCloseTo(coreMcSol(buy, TWO_B), 6);
    expect(s?.mcSol).toBeCloseTo(56.14, 2);
    expect(m.recentTrades(MHK)[0]?.mcSol).toBeCloseTo(coreMcSol(buy, TWO_B), 6);
    // the trade context still carries the curve's own token_total_supply (migration estimates use it)
    const ctx = await waitFor(() => m.tradeContext(MHK));
    expect(ctx).toMatchObject({ venue: "pump", supply: "2000000000000000", tokenTotalSupply: "1000000000000000" });
  });

  test("the Mayhem agent's trades rewrite the curve's virtual SOL: sub-28 SOL caps are real, and match core's math", () => {
    const { m } = market();
    m.applyTx(mcLogs("mayhem-create"));
    m.applyTx(mcLogs("mayhem-agent-sell"));
    const sell = lastTrade("mayhem-agent-sell");
    // a 0.019 SOL sell took 9.85 SOL off the virtual reserves: the offset over real SOL went from 30 to 20.17 SOL
    expect(sell.virtualQuoteReserves - sell.realQuoteReserves).toBe(20_169_916_947n);
    expect(m.summary(MHK)?.mcSol).toBeCloseTo(coreMcSol(sell, TWO_B), 6);
    m.applyTx(mcLogs("mayhem-agent-buy-late"));
    const late = lastTrade("mayhem-agent-buy-late");
    expect(late.virtualQuoteReserves - late.realQuoteReserves).toBe(532_608_591n);
    const mc = m.summary(MHK)?.mcSol ?? 0;
    expect(mc).toBeCloseTo(coreMcSol(late, TWO_B), 6);
    expect(mc).toBeGreaterThan(1.2);
    expect(mc).toBeLessThan(1.3); // 0.5707 SOL / 933.0M tokens x 2B: genuinely ~1.22 SOL on chain
  });

  test("first seen mid-life: the mint account wins over the curve account, whatever order they resolve in", async () => {
    for (const order of ["mint-first", "curve-first"] as const) {
      const { m, resolver } = market();
      m.applyTx(mcLogs("mayhem-agent-sell"));
      expect(resolver.requested.mints).toContain(MHK);
      expect(resolver.requested.curves).toContain(MHK);
      const mint = mintResolved("mhk-mint");
      const curve = curveResolved("mhk-curve", MHK);
      expect(mint.supply).toBe(TWO_B);
      expect(curve.curve.tokenTotalSupply).toBe(1_000_000_000_000_000n);
      if (order === "mint-first") {
        m.onMintResolved(mint);
        m.onCurveResolved(curve);
      } else {
        m.onCurveResolved(curve);
        m.onMintResolved(mint);
      }
      const s = m.summary(MHK);
      expect(s?.supply).toBe(2e9);
      expect(s?.mcSol).toBeCloseTo(coreMcSol(lastTrade("mayhem-agent-sell"), TWO_B), 6);
      const ctx = await waitFor(() => m.tradeContext(MHK));
      expect(ctx).toMatchObject({ supply: "2000000000000000", tokenTotalSupply: "1000000000000000" });
    }
  });

  test("a curve account alone (mint not read yet) still gives the mayhem mint supply", () => {
    const { m } = market();
    m.applyTx(mcLogs("mayhem-agent-sell"));
    m.onCurveResolved(curveResolved("mhk-curve", MHK));
    expect(m.summary(MHK)?.supply).toBe(2e9);
  });

  test("records saved before the fix come back with the mayhem mint supply", () => {
    const { m } = market();
    m.applyTx(mcLogs("mayhem-create"));
    // the state column as the previous version wrote it: the curve's 1e15 as supply, no provenance fields
    const old = JSON.parse(serializeRecord(m.tokens.get(MHK) as TokenRecord), bigintReviver) as Record<string, unknown>;
    old.supply = 1_000_000_000_000_000n;
    delete old.supplyExact;
    delete old.curveTokenTotalSupply;
    const { m: m2 } = market();
    m2.restore(deserializeRecord(JSON.stringify(old, bigintReplacer), 0).rec);
    expect(m2.summary(MHK)?.supply).toBe(2e9);
  });

  test("drained mayhem pool: base_supply (a fixed 1e15) does not replace the ~2e15 mint supply", async () => {
    const HALH = "DD8sR4dwMJKuUvzczuJGenZutvAbgiNTW7zzr31vpump";
    const base = mintResolved("halh-mint");
    const pool = await poolResolved("halh-pool", base, { decimals: 9, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" });
    expect(pool.isMayhemMode).toBe(true);
    const ev = mcLogs("mayhem-pool-sell").events[0];
    if (ev?.kind !== "ammSell") throw new Error("expected an ammSell");
    expect(ev.baseSupply).toBe(1_000_000_000_000_000n);
    // both with the pool account read and with only what a gRPC source learns from the instruction (no flags)
    for (const info of [pool, { ...pool, isMayhemMode: null, baseSupply: null, fromAccount: false }]) {
      const { m, resolver } = market();
      resolver.learnPool(info);
      m.applyTx(mcLogs("mayhem-pool-sell"));
      if (info.baseSupply === null) m.onMintResolved(base);
      const s = m.summary(HALH);
      expect(s?.supply).toBeCloseTo(1_999_815_108.096582, 6);
      expect(s?.isMayhem).toBe(true);
      // post-trade: 0.196610736 SOL against 1,998.3M tokens: ~0.197 SOL with the real supply (0.098 with 1e15)
      const price = (197_188_059 - 577_323) / 1e9 / ((1_992_497_664_231_634 + 5_851_909_667_261) / 1e6);
      expect(s?.mcSol).toBeCloseTo(price * 1_999_815_108.096582, 9);
    }
  });
});

describe("a token's quote follows the pool that prices it", () => {
  const GMK6 = "GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump";
  const PUMP = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
  const WSOL = "So11111111111111111111111111111111111111112";
  const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  // the arbitrage's sell leaves the canonical pool at (vault - quote out, base + base in)
  const canonicalPrice = (248_588_143_374 - 5_831_866) / 1e9 / ((241_755_705_265_302 + 5_683_077_877) / 1e6);

  async function pools() {
    const base = mintResolved("gmk6-mint");
    const thirdParty = await poolResolved("gmk6-pump-pool", base, mintResolved("pump-mint"));
    const canonical = await poolResolved("gmk6-canonical-pool", base, { decimals: 9, tokenProgram: TOKENKEG });
    return { thirdParty, canonical };
  }

  for (const order of ["third-party pool first", "canonical pool first"] as const) {
    test(`GMk6/PUMP arbitrage against the canonical GMk6/wSOL pool (${order})`, async () => {
      const { thirdParty, canonical } = await pools();
      expect(thirdParty).toMatchObject({ quoteMint: PUMP, quoteDecimals: 6, isCanonical: false });
      expect(canonical).toMatchObject({ quoteMint: WSOL, quoteDecimals: 9, isCanonical: true });
      const { m, resolver } = market();
      const tx = mcLogs("arb-third-party-pool"); // event 0: buy in the PUMP pool, event 1: sell in the canonical pool
      m.applyTx(tx);
      expect(m.pendingPoolEvents).toBe(2);
      for (const p of order === "third-party pool first" ? [thirdParty, canonical] : [canonical, thirdParty]) {
        resolver.learnPool(p);
        m.onPoolReady(p);
      }
      const s = m.summary(GMK6);
      expect(s).toMatchObject({ quoteMint: WSOL, launchpad: "pump", migrated: true, pool: canonical.pool });
      expect(s?.priceSol).toBeCloseTo(canonicalPrice, 15);
      expect(s?.mcSol).toBeCloseTo(canonicalPrice * 988_481_743.497611, 6);
      expect(s?.mcUsd).toBeCloseTo((s?.mcSol ?? 0) * SOL_USD, 4);
      expect(m.tokens.get(GMK6)).toMatchObject({ quoteDecimals: 9, quoteTokenProgram: TOKENKEG });
      // each trade is valued in its own pool's quote: wSOL is SOL, PUMP has no SOL value
      const trade = (i: number) => m.recentTrades(GMK6).find((t) => t.id === `${tx.signature}:${i}`);
      expect(trade(1)?.priceSol).toBeCloseTo(canonicalPrice, 15);
      expect(trade(1)?.amountSol).toBeCloseTo(5_843_554 / 1e9, 12);
      expect(trade(0)).toMatchObject({ priceSol: null, mcSol: null, amountSol: null, amountUsd: null });
    });
  }
});

describe("quotes without a known SOL value: null, never 0", () => {
  const BOOTY = "Wqqhu1wGrCYh5W7ZBRidjdx2gJDHKtUpS6mkUhapump";
  const TED = "7xQ3vnLUnzgCc2bTKHgyR7wpzTQFVgBCCh2AtNskyiD3";

  test("USDC curve: converted at SOL/USD (6-decimal USDC, not lamports), with the mayhem 2B supply", () => {
    const { m } = market();
    m.applyTx(mcLogs("usdc-mayhem-create"));
    const buy = lastTrade("usdc-mayhem-create");
    // sol_* fields are 0 on a USDC curve; the trailing quote_* fields carry the trade
    expect(buy).toMatchObject({ quoteAmount: 0n, virtualQuoteReserves: 0n });
    const q = buy.quote as NonNullable<PumpTradeEvent["quote"]>;
    // 4,292 USDC initial virtual reserves (Global.initial_virtual_quote_reserves) + the dev buy
    const mcQuote =
      Number(curveMarketCapForDisplay({ virtualQuoteReserves: q.virtualReserves, virtualTokenReserves: buy.virtualTokenReserves }, TWO_B)) /
      1e6;
    expect(mcQuote).toBeGreaterThan(8_000); // ~8,040 USDC: a fresh 2B mayhem USDC curve
    const s = m.summary(BOOTY);
    expect(s?.quoteMint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(s?.mcQuote).toBeCloseTo(mcQuote, 4);
    expect(s?.mcUsd).toBeCloseTo(mcQuote, 4);
    expect(s?.mcSol).toBeCloseTo(mcQuote / SOL_USD, 6); // ~66.9 SOL
    const t = m.recentTrades(BOOTY)[0];
    expect(t?.amountUsd).toBeCloseTo(Number(q.amount) / 1e6, 9);
    expect(t?.amountSol).toBeCloseTo(Number(q.amount) / 1e6 / SOL_USD, 9);
    expect(t?.mcSol).toBeCloseTo(mcQuote / SOL_USD, 6);
  });

  test("USDC curve before the server has a SOL/USD rate: SOL values null, USD values still known", () => {
    const { m } = market(null);
    m.applyTx(mcLogs("usdc-mayhem-create"));
    const s = m.summary(BOOTY);
    expect(s).toMatchObject({
      priceSol: null,
      mcSol: null,
      liquidity: null,
      volume5m: null,
      volume1h: null,
      volume24h: null,
      athMcSol: null,
    });
    expect(s?.mcUsd).toBeCloseTo(s?.mcQuote ?? Number.NaN, 6);
    expect(s?.liquidityUsd).toBeGreaterThan(0);
    expect(m.recentTrades(BOOTY)[0]).toMatchObject({ priceSol: null, mcSol: null, amountSol: null });
    expect(m.recentTrades(BOOTY)[0]?.amountUsd).toBeGreaterThan(0);
  });

  test("exotic quote (SPYx): SOL and USD values null; quote values once the quote mint's decimals are read", () => {
    const { m, resolver } = market();
    m.applyTx(mcLogs("exotic-create"));
    const spyx = mintResolved("spyx-mint");
    expect(resolver.requested.mints).toContain(spyx.mint);
    const before = m.summary(TED);
    expect(before).toMatchObject({ quoteMint: spyx.mint, priceSol: null, mcSol: null, mcUsd: null, priceQuote: null, mcQuote: null });
    m.onMintResolved(spyx);
    const s = m.summary(TED);
    expect(spyx.decimals).toBe(8);
    // 5.571584 SPYx / 1.073B virtual tokens x 1B: ~5.19 SPYx (about $3.7k), never a SOL figure
    expect(s?.mcQuote).toBeCloseTo((557_158_400 / 1e8 / 1_073_000_000) * 1e9, 9);
    expect(s).toMatchObject({ priceSol: null, mcSol: null, priceUsd: null, mcUsd: null, liquidity: null, volume24h: null, athMcSol: null });
  });
});
