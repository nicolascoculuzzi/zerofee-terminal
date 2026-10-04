/** Event decoders against real mainnet transactions (test/fixtures/event-txs.json). Offline. */
import { describe, expect, test } from "bun:test";
import { getBase64Decoder, getBase64Encoder } from "@solana/kit";
import {
  type AmmCreatePoolEvent,
  type AmmSwapEvent,
  bondingCurvePda,
  canonicalPoolPda,
  type DecodedEvent,
  decodeEventInstructionData,
  decodeEventPayload,
  decodeLogEvents,
  decodeTransactionEvents,
  EVENT_DISCRIMINATORS,
  EventDecodeError,
  extractAmmPoolMints,
  MAYHEM_FEE_RECIPIENTS,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  type PumpCreateEvent,
  type PumpMigrationEvent,
  type PumpTradeEvent,
  parseProgramDataLogs,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src";
import { CAPTURED, fixtureTx, toEventInput } from "./eventFixtures";

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function eventsOf(label: string): DecodedEvent[] {
  const r = decodeTransactionEvents(toEventInput(fixtureTx(label).tx));
  expect(r.failures).toBe(0);
  return r.events;
}

function only<K extends DecodedEvent["kind"]>(events: DecodedEvent[], kind: K): Extract<DecodedEvent, { kind: K }>[] {
  return events.filter((e) => e.kind === kind) as Extract<DecodedEvent, { kind: K }>[];
}

describe("every captured transaction", () => {
  test.each(CAPTURED.txs.map((t) => [t.labels.join("+"), t] as const))("%s: event-CPI and log decodes agree", (_l, t) => {
    const cpi = decodeTransactionEvents(toEventInput(t.tx));
    const logs = decodeLogEvents(t.tx.meta.logMessages);
    expect(cpi.via).toBe("cpi");
    expect(cpi.events.length).toBeGreaterThan(0);
    expect(cpi.failures).toBe(0);
    expect(logs.failures).toBe(0);
    expect(logs.truncated).toBe(false);
    expect(JSON.stringify(cpi.events, big)).toBe(JSON.stringify(logs.events, big));
  });

  test("without inner instructions the tx decoder falls back to logs", () => {
    const input = { ...toEventInput(fixtureTx("pump-buy").tx), innerInstructions: null };
    const r = decodeTransactionEvents(input);
    expect(r.via).toBe("logs");
    expect(r.events).toHaveLength(1);
  });
});

describe("pump CreateEvent", () => {
  test("create_v2 (Token-2022) with the dev buy in the same transaction", () => {
    const events = eventsOf("pump-create-v2");
    const [create] = only(events, "pumpCreate") as [PumpCreateEvent];
    expect(create).toMatchObject({
      name: "SPECTRE",
      symbol: "SPEC",
      uri: "https://ipfs.io/ipfs/Qme95r8YzjeMNFeE8UTE6LRr3ZQRSHrktTYi97hPbNPjNF",
      mint: "F62MDKs1XcNtTFmh6aeCDGhd2Q1u1Jt86mnWTK3Gpump",
      bondingCurve: "AHyxTxjFHPFVC2BbyvM62B7hBm9iBjHUe9nMkiLy9HbX",
      user: "5zrQwJugYV1mwdvqEhsRmZ9BFwz16YZs2BnREUysH3yj",
      creator: "5zrQwJugYV1mwdvqEhsRmZ9BFwz16YZs2BnREUysH3yj",
      timestamp: 1_791_048_949n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      virtualSolReserves: 30_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      isMayhemMode: false,
      quoteMint: "11111111111111111111111111111111",
    });
    expect(events[0]?.kind).toBe("pumpCreate"); // emission order: create, then the buy
    const [buy] = only(events, "pumpTrade") as [PumpTradeEvent];
    expect(buy.user).toBe(create.creator);
    expect(buy.isBuy).toBe(true);
    // post-trade reserves = initial reserves moved by exactly the traded amounts
    expect(buy.virtualTokenReserves).toBe(create.virtualTokenReserves - buy.tokenAmount);
    expect(buy.virtualQuoteReserves).toBe(create.virtualSolReserves + buy.quoteAmount);
    expect(buy.realTokenReserves).toBe(create.realTokenReserves - buy.tokenAmount);
  });

  test("bonding curve in the event is the curve PDA of the mint", async () => {
    const [create] = only(eventsOf("pump-create-v2"), "pumpCreate") as [PumpCreateEvent];
    expect(await bondingCurvePda(create.mint)).toBe(create.bondingCurve);
  });

  test("legacy create uses SPL Token", () => {
    const [create] = only(eventsOf("pump-create-legacy"), "pumpCreate") as [PumpCreateEvent];
    expect(create.tokenProgram).toBe(TOKEN_PROGRAM_ID);
    expect(create.symbol).toBe("TALUN");
  });
});

describe("pump TradeEvent", () => {
  test("buy: amounts, post-trade reserves, fees, live creator, trailing quote fields mirror the SOL fields", () => {
    const [t] = only(eventsOf("pump-buy"), "pumpTrade") as [PumpTradeEvent];
    expect(t).toMatchObject({
      mint: "ER4ciu9k4jYYobVPjcyJr7fzLv6kgnX7SfRiG7Vpump",
      isBuy: true,
      quoteAmount: 217_944_294n,
      tokenAmount: 751_522_662_188n,
      virtualQuoteReserves: 96_727_958_276n,
      virtualTokenReserves: 332_788_995_468_792n,
      realQuoteReserves: 66_727_958_276n,
      realTokenReserves: 52_888_995_468_792n,
      feeBps: 95n,
      fee: 2_070_471n,
      creatorFeeBps: 30n,
      creatorFee: 653_833n,
      creator: "22wF98PC7gAFh1eQuNRbzxteSyeyA1d4LmwnszggmSUp",
      ixName: "buy",
      buybackFeeBps: 5000n,
    });
    expect(t.quote).toEqual({
      mint: "11111111111111111111111111111111",
      amount: t.quoteAmount,
      virtualReserves: t.virtualQuoteReserves,
      realReserves: t.realQuoteReserves,
    });
  });

  test("sell", () => {
    const [t] = only(eventsOf("pump-sell"), "pumpTrade") as [PumpTradeEvent];
    expect(t).toMatchObject({ isBuy: false, ixName: "sell", tokenAmount: 2_244_677_950_938n, quoteAmount: 122_861_305n });
  });

  test("mayhem coin: reserved fee recipient, mayhem flag", () => {
    const [t] = only(eventsOf("pump-mayhem-trade"), "pumpTrade") as [PumpTradeEvent];
    expect(t.mayhemMode).toBe(true);
    expect(MAYHEM_FEE_RECIPIENTS).toContain(t.feeRecipient);
  });

  test("non-SOL quote curve: legacy sol_* fields are zero, the trailing quote_* fields carry the trade", () => {
    const [t] = only(eventsOf("pump-non-sol-trade"), "pumpTrade") as [PumpTradeEvent];
    expect(t.quoteAmount).toBe(0n);
    expect(t.virtualQuoteReserves).toBe(0n);
    expect(t.quote).toEqual({
      mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
      amount: 49_081_420n,
      virtualReserves: 4_503_010_774n,
      realReserves: 2_667_766_209n,
    } as never);
    expect(t.ixName).toBe("buy_exact_quote_in");
  });

  test("one transaction buying for two wallets (bundle signature)", () => {
    const trades = only(eventsOf("pump-multi-buyer-tx"), "pumpTrade");
    expect(trades).toHaveLength(2);
    expect(new Set(trades.map((t) => t.user)).size).toBe(2);
    // second buy sees the first one's post-trade reserves
    const [a, b] = trades as [PumpTradeEvent, PumpTradeEvent];
    expect(b.virtualTokenReserves).toBe(a.virtualTokenReserves - b.tokenAmount);
    expect(b.virtualQuoteReserves).toBe(a.virtualQuoteReserves + b.quoteAmount);
  });
});

describe("curve completion and migration", () => {
  test("CompleteEvent rides in the buy that empties the curve", async () => {
    const events = eventsOf("pump-complete");
    const [trade] = only(events, "pumpTrade") as [PumpTradeEvent];
    const [complete] = only(events, "pumpComplete");
    expect(trade.realTokenReserves).toBe(0n);
    expect(complete?.mint).toBe(trade.mint);
    expect(complete?.bondingCurve).toBe(await bondingCurvePda(trade.mint));
  });

  test("migrate emits PumpSwap CreatePoolEvent + CompletePumpAmmMigrationEvent for the canonical pool", async () => {
    const events = eventsOf("pump-migrate");
    const [pool] = only(events, "ammCreatePool") as [AmmCreatePoolEvent];
    const [mig] = only(events, "pumpMigrate") as [PumpMigrationEvent];
    expect(mig.pool).toBe(pool.pool);
    expect(mig.mint).toBe(pool.baseMint);
    expect(pool.quoteMint).toBe(WSOL_MINT);
    expect(pool.index).toBe(0);
    expect(pool.poolBaseAmount).toBe(mig.mintAmount);
    expect(mig.poolMigrationFee).toBe(15_000_001n);
    expect(await canonicalPoolPda(mig.mint)).toBe(mig.pool);
  });

  test("the completing buy and the migration of the same coin, back to back", () => {
    const [trade] = only(eventsOf("pump-pair-1"), "pumpTrade") as [PumpTradeEvent];
    const [mig] = only(eventsOf("pump-pair-2"), "pumpMigrate") as [PumpMigrationEvent];
    expect(mig.mint).toBe(trade.mint);
    // the pool receives the curve's real quote minus the migration fee
    expect(mig.solAmount).toBe(trade.realQuoteReserves - mig.poolMigrationFee);
  });
});

describe("PumpSwap Buy/Sell events", () => {
  test("buy fields and the boost pool's virtual quote reserves", () => {
    const [b] = only(eventsOf("amm-buy"), "ammBuy") as [AmmSwapEvent];
    expect(b).toMatchObject({
      pool: "37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y",
      baseAmount: 151_678_413_440n,
      quoteAmount: 73_651_823n,
      lpFee: 147_304n,
      protocolFee: 36_826n,
      coinCreatorFee: 699_693n,
      userQuoteAmount: 74_535_646n,
      virtualQuoteReserves: 17_584_505_512n,
      canBoost: true,
      baseSupply: 984_455_400_319_645n,
      ixName: "buy",
    });
    expect(b.quoteAmountVault).toBe(b.quoteAmount + b.lpFee);
    expect(b.userQuoteAmount).toBe(b.quoteAmount + b.lpFee + b.protocolFee + b.coinCreatorFee);
  });

  test("the base mint comes from the swap instruction's accounts", () => {
    const [m] = extractAmmPoolMints(toEventInput(fixtureTx("amm-buy").tx));
    expect(m).toMatchObject({
      pool: "37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y",
      baseMint: "kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump",
      quoteMint: WSOL_MINT,
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    });
  });

  test("pool reserves in events are PRE-trade: consecutive trades chain exactly", () => {
    const [s] = only(eventsOf("amm-pair-1"), "ammSell") as [AmmSwapEvent];
    const [b] = only(eventsOf("amm-pair-2"), "ammBuy") as [AmmSwapEvent];
    expect(s.pool).toBe(b.pool);
    // sell: base vault += base in; quote vault -= quote_amount_out_without_lp_fee
    expect(b.poolBaseReserves).toBe(s.poolBaseReserves + s.baseAmount);
    expect(b.poolQuoteReserves).toBe(s.poolQuoteReserves - s.quoteAmountVault);
  });
});

describe("log attribution and tolerance", () => {
  const tradeLine = fixtureTx("pump-buy").tx.meta.logMessages.find((l) => l.startsWith("Program data:")) as string;
  const payload = new Uint8Array(getBase64Encoder().encode(tradeLine.slice("Program data: ".length)));
  const b64 = getBase64Decoder();

  test("a pump-shaped event emitted by another program is ignored", () => {
    // (Raydium LaunchLab's TradeEvent has the same discriminator but is decoded with LaunchLab's own layout.)
    const logs = [
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
      tradeLine, // pump's TradeEvent discriminator, but another program is on top of the stack
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
    ];
    const r = decodeLogEvents(logs);
    expect(r.events).toHaveLength(0);
    expect(r.foreign).toBe(1);
    expect(decodeEventPayload(payload, PUMP_AMM_PROGRAM_ID)).toBeNull();
  });

  test("attribution follows the invoke stack (nested CPI into pump)", () => {
    const logs = [
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]",
      `Program ${PUMP_PROGRAM_ID} invoke [2]`,
      tradeLine,
      `Program ${PUMP_PROGRAM_ID} success`,
      "Program data: AAAAAAAAAAA=",
      "Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 success",
    ];
    const p = parseProgramDataLogs(logs);
    expect(p.lines.map((l) => [l.program, l.depth])).toEqual([
      [PUMP_PROGRAM_ID, 2],
      ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", 1],
    ]);
    expect(decodeLogEvents(logs).events).toHaveLength(1);
  });

  test("extra trailing bytes are ignored", () => {
    const longer = new Uint8Array([...payload, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(JSON.stringify(decodeEventPayload(longer, PUMP_PROGRAM_ID), big)).toBe(
      JSON.stringify(decodeEventPayload(payload, PUMP_PROGRAM_ID), big),
    );
  });

  test("missing trailing fields decode as defaults (older program versions)", () => {
    // cut right after real_token_reserves (8 disc + 121 bytes): the 2024 TradeEvent layout
    const ev = decodeEventPayload(payload.subarray(0, 8 + 121), PUMP_PROGRAM_ID) as PumpTradeEvent;
    expect(ev.realTokenReserves).toBe(52_888_995_468_792n);
    expect(ev.fee).toBe(0n);
    expect(ev.ixName).toBe("");
    expect(ev.quote).toBeNull();
  });

  test("a payload ending inside required fields is a decode failure, not garbage", () => {
    expect(() => decodeEventPayload(payload.subarray(0, 60), PUMP_PROGRAM_ID)).toThrow(EventDecodeError);
    const logs = [`Program ${PUMP_PROGRAM_ID} invoke [1]`, `Program data: ${b64.decode(payload.subarray(0, 60))}`];
    expect(decodeLogEvents(logs)).toMatchObject({ failures: 1, events: [] });
  });

  test("corrupt string length in a CreateEvent is rejected", () => {
    const bad = new Uint8Array([...EVENT_DISCRIMINATORS.pumpCreate, 0xff, 0xff, 0xff, 0x7f, 65, 66]);
    expect(() => decodeEventPayload(bad, PUMP_PROGRAM_ID)).toThrow(EventDecodeError);
  });

  test("unknown discriminators and non-event instruction data yield null", () => {
    expect(decodeEventPayload(new Uint8Array(40), PUMP_PROGRAM_ID)).toBeNull();
    expect(decodeEventInstructionData(payload, PUMP_PROGRAM_ID)).toBeNull(); // no EVENT_IX_TAG prefix
  });

  test('"Log truncated" stops parsing and is reported', () => {
    const logs = [`Program ${PUMP_PROGRAM_ID} invoke [1]`, tradeLine, "Log truncated"];
    expect(decodeLogEvents(logs)).toMatchObject({ truncated: true });
  });
});
