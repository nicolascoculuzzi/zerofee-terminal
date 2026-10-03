/**
 * Offline regressions for program behaviour first observed by the mainnet-fork e2e suite (packages/core/e2e,
 * 2026-10-03, real pump / PumpSwap binaries). Inputs are program output captured from the fork; nothing here
 * touches the network.
 */
import { describe, expect, test } from "bun:test";
import { address } from "@solana/kit";
import {
  curveFeeRates,
  curveFees,
  decodeEventsFromLogs,
  decodeFeeConfig,
  decodePumpGlobal,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  quoteAmmBuyExactQuoteIn,
  quoteBuyExactQuoteIn,
  WSOL_MINT,
} from "../src";
import { fixture } from "./fixtures";

/** BuyEvent emitted by PumpSwap for a 0.01 SOL buy_exact_quote_in on a canonical boost pool (fork tx 3vMjrDNv…). */
const BUY_EXACT_QUOTE_IN_EVENT =
  "Program data: Z/RSHyz1d3e5UsFqAAAAAFeNcVoAAAAAgJaYAAAAAAAAAAAAAAAAAICWmAAAAAAA/uaWREUvAABgWVHdSgAAAICWmAAAAAAAFAAAAAAAAABaTQAAAAAAAAUAAAAAAAAAVxMAAAAAAAAXYZcAAAAAAL0TlwAAAAAA6GDf/9d+wPH+WqvEEaiAD1thx8EgPyo6zcqekrJlwAHnp7DA4tDk6XLop+D8QkgJQ7q+3bfB20BPBFRY89ChSylqxAxhZq2w51bEYwdGx9/BFu5OX1UiAQUYrEkNnacszKtXw7cpOAO8jENO3elnLZ1qary9Mnnb/rh3dG5dFanXqo+wYNgpG0xNR12v92LJa9wNrOs2wBLq0S7TqUhBYQHIIfOo8I/viNwxQkp2gK6MloFwTPHl9ciOJ5m3+YIh8UTFsYD2cuXwWhNCaQrTcgkJAtSWrvIDRA4LbOhD6n1LAAAAAAAAABIiAQAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8ITgTAAAAAASAAAAYnV5X2V4YWN0X3F1b3RlX2luAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAqwkAAAAAAAAtSBIYBAAAAAAAAAAAAAAAAfFcsAEGiQMAAAAAAAAAAAAAAAAAAAAAAJv5CwAAAAAA";

describe("PumpSwap buy_exact_quote_in event", () => {
  test("quote_amount_in is the total paid incl. fees and user_quote_amount_in the pre-fee quote", () => {
    const [ev] = decodeEventsFromLogs([BUY_EXACT_QUOTE_IN_EVENT]);
    expect(ev).toMatchObject({
      kind: "ammBuy",
      baseAmount: 1_517_391_191n,
      quoteLimit: 10_000_000n,
      poolBaseReserves: 51_974_549_989_118n,
      poolQuoteReserves: 321_540_675_936n,
      quoteAmount: 10_000_000n,
      lpFeeBps: 20n,
      lpFee: 19_802n,
      protocolFeeBps: 5n,
      protocolFee: 4_951n,
      quoteAmountVault: 9_920_791n,
      userQuoteAmount: 9_900_989n,
      coinCreatorFeeBps: 75n,
      coinCreatorFee: 74_258n,
      ixName: "buy_exact_quote_in",
      buybackFeeBps: 5000n,
      buybackFee: 2_475n,
      virtualQuoteReserves: 17_583_720_493n,
    });
    // Our quote over the same pool state (vault + boost virtual reserves) reproduces every field.
    const q = quoteAmmBuyExactQuoteIn(
      { baseReserve: 51_974_549_989_118n, quoteVaultReserve: 321_540_675_936n, virtualQuoteReserves: 17_583_720_493n },
      10_000_000n,
      { lpFeeBps: 20n, protocolFeeBps: 5n, creatorFeeBps: 75n, buybackBps: 5000n },
    );
    expect(q).toMatchObject({ baseOut: 1_517_391_191n, quoteIn: 9_900_989n, totalQuote: 10_000_000n, lpFee: 19_802n });
    expect(q).toMatchObject({ protocolFee: 4_951n, creatorFee: 74_258n, buybackFee: 2_475n });
    expect(q.quoteIn + q.lpFee).toBe(9_920_791n); // quote_amount_in_with_lp_fee: what enters the pool vault
  });
});

describe("mayhem curve fees", () => {
  const global = decodePumpGlobal(fixture(PUMP_GLOBAL).data);
  const feeConfig = decodeFeeConfig(fixture(PUMP_FEE_CONFIG).data);
  const curve = {
    virtualTokenReserves: 1_073_000_000_000_000n,
    virtualQuoteReserves: 30_000_000_000n,
    realTokenReserves: 793_100_000_000_000n,
    realQuoteReserves: 0n,
    complete: false,
    creator: address("Hht9YRdb69rf4E6h7fJjvL3ratdgiAramsZxs5incC2R"),
    isMayhemMode: true,
    quoteMint: WSOL_MINT,
    creatorFeeBps: 0n,
  };

  test("no buyback carve-out: the reserved recipient receives the whole protocol fee", () => {
    const rates = curveFeeRates({ curve, global, feeConfig, mintSupply: 2_000_000_000_000_000n });
    expect(rates).toEqual({ protocolFeeBps: 95n, creatorFeeBps: 30n, buybackBps: 0n });
    // fork tx 2CH3kDnQ…: 0.01 SOL buy -> reserved fee recipient +93,828, creator vault +29,630, buyback +0
    const q = quoteBuyExactQuoteIn(curve, 10_000_000n, rates);
    expect(q).toMatchObject({ quoteNet: 9_876_542n, protocolFee: 93_828n, creatorFee: 29_630n, buybackFee: 0n });
    expect(curveFees(q.quoteNet, rates).totalFee).toBe(123_458n);
  });

  test("non-mayhem coins keep the 50% buyback carve-out", () => {
    const rates = curveFeeRates({ curve: { ...curve, isMayhemMode: false }, global, feeConfig });
    expect(rates.buybackBps).toBe(5000n);
    // fork tx 3LGmc9R7…: fee recipient +46,914 and buyback recipient +46,914 of a 93,828 protocol fee
    expect(curveFees(9_876_542n, rates)).toMatchObject({ protocolFee: 93_828n, buybackFee: 46_914n });
  });
});
