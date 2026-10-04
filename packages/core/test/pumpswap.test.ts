import { describe, expect, test } from "bun:test";
import { address } from "@solana/kit";
import {
  ACCOUNT_DISCRIMINATORS,
  type AmmFeeRates,
  type AmmReserves,
  ammFeeRates,
  DEFAULT_PUBKEY,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodeMint,
  decodePool,
  decodeTokenAccount,
  effectiveQuoteReserve,
  isCanonicalPumpPool,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK,
  poolMarketCap,
  quoteAmmBuyExactBase,
  quoteAmmBuyExactQuoteIn,
  quoteAmmSell,
} from "../src";
import { fixture, POOL } from "./fixtures";

const gc = decodeAmmGlobalConfig(fixture(PUMP_AMM_GLOBAL_CONFIG).data);
const feeConfig = decodeFeeConfig(fixture(PUMP_AMM_FEE_CONFIG).data);

describe("mainnet replay tx 4kQsV2g3… (boost pool, effective reserves)", () => {
  const reserves: AmmReserves = {
    baseReserve: 199_716_599_650_519n,
    quoteVaultReserve: 81_222_842_078n,
    virtualQuoteReserves: 17_584_505_289n,
  };
  const pool = {
    quoteMint: address("So11111111111111111111111111111111111111112"),
    isMayhemMode: false,
    coinCreator: address("DCSnCM6zfy12By5gcWUqPUgeraF1nfmzsH6m2hRxL6by"),
    creatorFeeBps: 0n,
  };

  test("fee tier from the live FeeConfig: mcap ~480 SOL -> LP 20 / protocol 5 / creator 95", () => {
    const rates = ammFeeRates({ pool, isCanonical: true, reserves, baseMintSupply: 971_633_722_474_935n, feeConfig, globalConfig: gc });
    expect(rates).toEqual({ lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, buybackBps: 5000n });
    const mcap = poolMarketCap({
      baseReserve: reserves.baseReserve,
      effectiveQuoteReserve: effectiveQuoteReserve(reserves),
      baseMintSupply: 971_633_722_474_935n,
      isMayhemMode: false,
    });
    expect(mcap > 420_000_000_000n && mcap < 1_470_000_000_000n).toBe(true);
  });

  test("buy exact base out reproduces quote_amount_in and every fee", () => {
    const rates: AmmFeeRates = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 95n, buybackBps: 5000n };
    const q = quoteAmmBuyExactBase(reserves, 8_814_029_166_853n, rates);
    expect(q.quoteIn).toBe(4_561_964_983n);
    expect(q.lpFee).toBe(9_123_930n);
    expect(q.protocolFee).toBe(2_280_983n);
    expect(q.creatorFee).toBe(43_338_668n);
    expect(q.buybackFee).toBe(1_140_491n);
    expect(q.totalQuote).toBe(4_616_708_564n); // event user_quote_amount_in
    // Raw-vault pricing (ignoring virtual reserves) under-quotes by ~18%.
    const raw = quoteAmmBuyExactBase({ ...reserves, virtualQuoteReserves: 0n }, 8_814_029_166_853n, rates);
    expect(raw.quoteIn).toBe(3_750_083_078n);
  });
});

describe("vectors confirmed by mainnet simulation (2026-10-03)", () => {
  const rates: AmmFeeRates = { lpFeeBps: 2n, protocolFeeBps: 93n, creatorFeeBps: 30n, buybackBps: 5000n };

  test("buy_exact_quote_in 0.01 SOL on DN5CZBVz… (3nK1vwb8…)", () => {
    const q = quoteAmmBuyExactQuoteIn(
      { baseReserve: 939_976_962_722_015n, quoteVaultReserve: 1_145_739_940n, virtualQuoteReserves: 17_584_505_495n },
      10_000_000n,
      rates,
    );
    expect(q.baseOut).toBe(495_392_774_031n);
    expect(q.quoteIn).toBe(9_876_542n);
    expect([q.lpFee, q.protocolFee, q.creatorFee]).toEqual([1_976n, 91_852n, 29_630n]);
    expect(q.totalQuote).toBe(10_000_000n);
  });

  test("sell on 5RxfsBsy… (3fr6BBob…)", () => {
    const q = quoteAmmSell(
      { baseReserve: 935_760_430_150_998n, quoteVaultReserve: 3_559_290_396n, virtualQuoteReserves: 17_584_505_289n },
      2_299_467_152_525n,
      rates,
    );
    expect(q.quoteOutGross).toBe(51_829_807n);
    expect([q.lpFee, q.protocolFee, q.creatorFee]).toEqual([10_366n, 482_018n, 155_490n]);
    expect(q.quoteOutNet).toBe(51_181_933n);
  });
});

describe("pool decoding", () => {
  test("live canonical boost pool (301 B): signed virtual_quote_reserves at offset 245", async () => {
    const acc = fixture(POOL);
    expect(acc.data.length).toBe(301);
    const pool = decodePool(acc.data);
    expect(pool.virtualQuoteReserves).toBe(17_584_505_289n);
    expect(await isCanonicalPumpPool(pool)).toBe(true);
    expect(pool.index).toBe(0);
    const base = decodeTokenAccount(fixture(pool.poolBaseTokenAccount).data);
    const quote = decodeTokenAccount(fixture(pool.poolQuoteTokenAccount).data);
    expect(base.mint).toBe(pool.baseMint);
    expect(quote.mint).toBe(pool.quoteMint);
    expect(decodeMint(fixture(pool.baseMint).data, fixture(pool.baseMint).owner).decimals).toBe(6);
  });

  test("negative virtual_quote_reserves decode as signed i128 and price off vault + virtual", () => {
    const data = new Uint8Array(301);
    data.set(ACCOUNT_DISCRIMINATORS.pool, 0);
    const view = new DataView(data.buffer);
    // -5 SOL as i128 little-endian at offset 245.
    const neg = (1n << 128n) - 5_000_000_000n;
    view.setBigUint64(245, neg & ((1n << 64n) - 1n), true);
    view.setBigUint64(253, neg >> 64n, true);
    const pool = decodePool(data);
    expect(pool.virtualQuoteReserves).toBe(-5_000_000_000n);
    expect(effectiveQuoteReserve({ quoteVaultReserve: 20_000_000_000n, virtualQuoteReserves: pool.virtualQuoteReserves })).toBe(
      15_000_000_000n,
    );
    expect(() => effectiveQuoteReserve({ quoteVaultReserve: 1n, virtualQuoteReserves: -2n })).toThrow();
  });

  test("GlobalConfig: AMM protocol recipients differ from the curve list as documented", () => {
    expect(gc.protocolFeeRecipients).toContain(address("JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU"));
    expect(gc.protocolFeeRecipients).not.toContain(address("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"));
    expect([...gc.protocolFeeRecipients].sort()).toEqual([...PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK].sort());
    expect(gc.buybackBasisPoints).toBe(5000n);
  });

  test("non-canonical pools pay flat fees; no coin creator -> no creator fee", () => {
    const reserves = { baseReserve: 1_000_000_000_000n, quoteVaultReserve: 10_000_000_000n, virtualQuoteReserves: 0n };
    const pool = {
      quoteMint: address("So11111111111111111111111111111111111111112"),
      isMayhemMode: false,
      coinCreator: DEFAULT_PUBKEY,
      creatorFeeBps: 0n,
    };
    const r = ammFeeRates({ pool, isCanonical: false, reserves, baseMintSupply: 1_000_000_000_000_000n, feeConfig, globalConfig: gc });
    expect(r).toMatchObject({
      lpFeeBps: feeConfig.flatFees.lpFeeBps,
      protocolFeeBps: feeConfig.flatFees.protocolFeeBps,
      creatorFeeBps: 0n,
    });
    expect(feeConfig.flatFees).toEqual({ lpFeeBps: 25n, protocolFeeBps: 5n, creatorFeeBps: 0n });
  });

  test("sell refuses to take more than the REAL quote vault", () => {
    const r: AmmFeeRates = { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 30n, buybackBps: 5000n };
    expect(() => quoteAmmSell({ baseReserve: 1_000n, quoteVaultReserve: 10n, virtualQuoteReserves: 1_000_000n }, 1_000n, r)).toThrow(
      "real quote reserves",
    );
  });
});
