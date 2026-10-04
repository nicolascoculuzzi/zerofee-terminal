/**
 * Raydium LaunchLab / CPMM events through the events module: attribution to the emitting program, event-CPI
 * first, CPMM (log-only) merged from the logs, and the tolerance rules. Offline (test/fixtures/raydium-mainnet.json).
 */
import { describe, expect, test } from "bun:test";
import { type Address, getBase64Decoder } from "@solana/kit";
import {
  type CpmmSwapEvent,
  DEFAULT_PUBKEY,
  decodeCpmmEventPayload,
  decodeEventInstructionData,
  decodeEventPayload,
  decodeLaunchLabEventPayload,
  decodeLogEvents,
  decodeTransactionEvents,
  EVENT_IX_TAG,
  EVENT_PROGRAMS,
  EventDecodeError,
  isEventProgram,
  type LaunchLabTradeEvent,
  LOG_ONLY_EVENT_PROGRAMS,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  parseProgramDataLogs,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  type TransactionEventInput,
  type TxInstruction,
} from "../src";
import { type CapturedTx, eventCpiPayloads, rtx } from "./raydium-fixtures";

/**
 * Decoder input for one or more fixture transactions (their logs and instructions concatenated, as if they
 * were one transaction). The slimmed fixture keeps only the LaunchLab / CPMM instructions and their position
 * (`top<i>` / `inner<i>`); each transaction's instruction indexes are offset by 100 to keep them apart.
 */
function eventInput(...txs: CapturedTx[]): TransactionEventInput {
  const accountKeys: Address[] = [];
  const keyIndex = (a: Address) => {
    if (!accountKeys.includes(a)) accountKeys.push(a);
    return accountKeys.indexOf(a);
  };
  const instructions: TxInstruction[] = [];
  const inner = new Map<number, TxInstruction[]>();
  txs.forEach((tx, n) => {
    for (const ix of tx.instructions) {
      const m = /^(top|inner)(\d+)$/.exec(ix.where);
      if (!m) throw new Error(`unexpected position ${ix.where}`);
      const compiled = { programIdIndex: keyIndex(ix.programId), accounts: ix.accounts.map(keyIndex), data: ix.data };
      if (m[1] === "top") instructions.push(compiled);
      else {
        const group = n * 100 + Number(m[2]);
        inner.set(group, [...(inner.get(group) ?? []), compiled]);
      }
    }
  });
  return {
    accountKeys,
    instructions,
    innerInstructions: [...inner].map(([index, ixs]) => ({ index, instructions: ixs })),
    logs: txs.flatMap((tx) => tx.logs),
  };
}

/** Payloads of the `Program data:` lines attributed to `program`. */
function loggedPayloads(tx: CapturedTx, program: Address): Uint8Array[] {
  return parseProgramDataLogs(tx.logs)
    .lines.filter((l) => l.program === program)
    .map((l) => l.data as Uint8Array);
}

const tradePayload = eventCpiPayloads(rtx("bonkBuy"), RAYDIUM_LAUNCHLAB_PROGRAM_ID)[0] as Uint8Array;
const createPayload = eventCpiPayloads(rtx("create"), RAYDIUM_LAUNCHLAB_PROGRAM_ID)[0] as Uint8Array;
const swapPayload = loggedPayloads(rtx("cpmmStonkSell"), RAYDIUM_CPMM_PROGRAM_ID)[0] as Uint8Array;
const b64 = getBase64Decoder();
const logsEmitting = (program: Address, payload: Uint8Array) => [
  `Program ${program} invoke [1]`,
  `Program data: ${b64.decode(payload)}`,
  `Program ${program} success`,
];

describe("Raydium events in the events module", () => {
  test("LaunchLab and CPMM are event programs; only CPMM is log-only", () => {
    expect(EVENT_PROGRAMS).toEqual([PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID]);
    expect(isEventProgram(RAYDIUM_LAUNCHLAB_PROGRAM_ID) && isEventProgram(RAYDIUM_CPMM_PROGRAM_ID)).toBe(true);
    expect(LOG_ONLY_EVENT_PROGRAMS).toEqual([RAYDIUM_CPMM_PROGRAM_ID]);
    expect(swapPayload.length).toBe(170);
    expect([tradePayload.length, createPayload.length]).toEqual([147, 255]);
  });

  test("Raydium layouts are only tried for payloads attributed to their program", () => {
    expect(decodeEventPayload(tradePayload, RAYDIUM_LAUNCHLAB_PROGRAM_ID)).toEqual(decodeLaunchLabEventPayload(tradePayload));
    expect(decodeEventPayload(tradePayload, RAYDIUM_LAUNCHLAB_PROGRAM_ID)?.kind).toBe("launchlabTrade");
    expect(decodeEventPayload(createPayload, RAYDIUM_LAUNCHLAB_PROGRAM_ID)?.kind).toBe("launchlabPoolCreate");
    expect(decodeEventPayload(swapPayload, RAYDIUM_CPMM_PROGRAM_ID)).toEqual(decodeCpmmEventPayload(swapPayload));
    expect(decodeEventPayload(swapPayload, RAYDIUM_CPMM_PROGRAM_ID)?.kind).toBe("cpmmSwap");
    // Unattributed (legacy) decoding and other programs never produce Raydium events.
    expect(decodeEventPayload(swapPayload)).toBeNull();
    expect(decodeEventPayload(swapPayload, PUMP_AMM_PROGRAM_ID)).toBeNull();
    expect(decodeEventPayload(swapPayload, RAYDIUM_LAUNCHLAB_PROGRAM_ID)).toBeNull();
    expect(decodeEventPayload(tradePayload, RAYDIUM_CPMM_PROGRAM_ID)).toBeNull();
    expect(decodeEventPayload(tradePayload)?.kind).not.toBe("launchlabTrade");
    const cpi = new Uint8Array([...EVENT_IX_TAG, ...tradePayload]);
    expect(decodeEventInstructionData(cpi, RAYDIUM_LAUNCHLAB_PROGRAM_ID)).toEqual(decodeLaunchLabEventPayload(tradePayload));
  });

  test("LaunchLab events come from the event-CPI copies and agree with the logged ones", () => {
    for (const label of ["bonkBuy", "stonkFeeSell", "trixSell2", "stonkXstockSell", "create"] as const) {
      const tx = rtx(label);
      const r = decodeTransactionEvents(eventInput(tx));
      expect(r).toMatchObject({ via: "cpi", failures: 0, truncated: false });
      const cpi = eventCpiPayloads(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID).map((p) => decodeLaunchLabEventPayload(p));
      expect(cpi.length).toBeGreaterThan(0);
      expect(r.events).toEqual(cpi as typeof r.events);
      expect(r.events).toEqual(decodeLogEvents(tx.logs).events);
      expect(r.events.some((e) => e.kind === "pumpTrade")).toBe(false);
    }
  });

  test("CPMM only logs: with inner instructions present its events still come from the logs", () => {
    for (const label of ["cpmmBonkBuy", "cpmmStonkSell", "cpmmBaseOutput"] as const) {
      const tx = rtx(label);
      expect(eventCpiPayloads(tx, RAYDIUM_CPMM_PROGRAM_ID)).toEqual([]);
      const r = decodeTransactionEvents(eventInput(tx));
      expect(r).toMatchObject({ via: "logs", failures: 0 });
      expect(r.events.map((e) => e.kind)).toEqual(["cpmmSwap"]);
      expect(r.events[0]).toEqual(decodeCpmmEventPayload(loggedPayloads(tx, RAYDIUM_CPMM_PROGRAM_ID)[0] as Uint8Array) as CpmmSwapEvent);
    }
  });

  test("after a successful event-CPI pass, CPMM events are appended from the logs", () => {
    const launchLab = rtx("bonkBuy");
    const cpmm = rtx("cpmmStonkSell");
    const [trade] = decodeTransactionEvents(eventInput(launchLab)).events;
    const [swap] = decodeLogEvents(cpmm.logs).events;
    for (const txs of [
      [launchLab, cpmm],
      [cpmm, launchLab], // log-only events follow the CPI-decoded ones, whatever their position
    ]) {
      const r = decodeTransactionEvents(eventInput(...txs));
      expect(r).toMatchObject({ via: "cpi", failures: 0, truncated: false });
      expect(r.events).toEqual([trade, swap] as typeof r.events);
    }
    // The program filter behind the merge: only CPMM-attributed lines are decoded.
    const logs = [...launchLab.logs, ...cpmm.logs];
    const filtered = decodeLogEvents(logs, LOG_ONLY_EVENT_PROGRAMS);
    expect(filtered.events).toEqual([swap] as typeof filtered.events);
    expect(filtered.foreign).toBe(parseProgramDataLogs(logs).lines.filter((l) => l.program !== RAYDIUM_CPMM_PROGRAM_ID).length);
    expect(filtered.foreign).toBeGreaterThan(0);
    // Truncated logs are reported: CPMM events after the cut are lost.
    const cut = decodeTransactionEvents({ ...eventInput(launchLab, cpmm), logs: [...launchLab.logs, "Log truncated"] });
    expect(cut).toMatchObject({ via: "cpi", truncated: true });
    expect(cut.events).toEqual([trade] as typeof cut.events);
  });
});

describe("Raydium event tolerance", () => {
  test("LaunchLab TradeEvent: required through pool_status, exact_in tolerant, bad direction rejected", () => {
    const full = decodeLaunchLabEventPayload(tradePayload) as LaunchLabTradeEvent;
    expect(decodeLaunchLabEventPayload(new Uint8Array([...tradePayload, 1, 2, 3]))).toEqual(full);
    const noExactIn = decodeLaunchLabEventPayload(tradePayload.subarray(0, 146)) as LaunchLabTradeEvent;
    expect(noExactIn).toEqual({ ...full, exactIn: false });
    expect(() => decodeLaunchLabEventPayload(tradePayload.subarray(0, 145))).toThrow(EventDecodeError);
    const badDirection = tradePayload.slice();
    badDirection[144] = 2;
    expect(() => decodeLaunchLabEventPayload(badDirection)).toThrow(/trade_direction/);
  });

  test("LaunchLab PoolCreateEvent: corrupt strings, unknown curve variants and truncation are rejected", () => {
    const full = decodeLaunchLabEventPayload(createPayload);
    expect(decodeLaunchLabEventPayload(createPayload.subarray(0, 254))).toEqual({ ...full, ammFeeOn: 0 } as typeof full);
    expect(() => decodeLaunchLabEventPayload(createPayload.subarray(0, 253))).toThrow(EventDecodeError);
    const badName = createPayload.slice();
    new DataView(badName.buffer).setUint32(8 + 96 + 1, 100_000, true); // name length after pool/creator/config/decimals
    expect(() => decodeLaunchLabEventPayload(badName)).toThrow(EventDecodeError);
    // CurveParams tag follows the three strings.
    const view = new DataView(createPayload.buffer, createPayload.byteOffset);
    let o = 8 + 96 + 1;
    for (let i = 0; i < 3; i++) o += 4 + view.getUint32(o, true);
    expect(createPayload[o]).toBe(0); // Constant
    const badCurve = createPayload.slice();
    badCurve[o] = 3;
    expect(() => decodeLaunchLabEventPayload(badCurve)).toThrow(/CurveParams/);
  });

  test("CPMM SwapEvent: required through base_input, the mint / fee fields tolerant", () => {
    const full = decodeCpmmEventPayload(swapPayload) as CpmmSwapEvent;
    expect(full.inputMint).not.toBe(DEFAULT_PUBKEY);
    // disc 8 + pool 32 + six u64 + base_input = 89 bytes.
    expect(decodeCpmmEventPayload(swapPayload.subarray(0, 89))).toEqual({
      ...full,
      inputMint: DEFAULT_PUBKEY,
      outputMint: DEFAULT_PUBKEY,
      tradeFee: 0n,
      creatorFee: 0n,
      creatorFeeOnInput: false,
    });
    expect(() => decodeCpmmEventPayload(swapPayload.subarray(0, 88))).toThrow(EventDecodeError);
  });

  test("a malformed Raydium line in the logs is a failure, not a foreign line", () => {
    const r = decodeLogEvents([
      ...logsEmitting(RAYDIUM_LAUNCHLAB_PROGRAM_ID, tradePayload.subarray(0, 100)),
      ...logsEmitting(RAYDIUM_CPMM_PROGRAM_ID, swapPayload),
    ]);
    expect(r).toMatchObject({ failures: 1, foreign: 0 });
    expect(r.failureMessages[0]).toContain("launchlabTrade");
    expect(r.events.map((e) => e.kind)).toEqual(["cpmmSwap"]);
  });
});
