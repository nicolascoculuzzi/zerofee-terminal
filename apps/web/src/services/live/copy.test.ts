import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CopySignal, CopySignalResult, CopyTask } from "@zerofee/protocol";
import { useCopy } from "../../state/copy";
import { useWallet } from "../../state/wallet";
import type { BuyRequest, SellRequest, TradeReceipt } from "../tradeService";
import { CopyEngine } from "./copy";
import { MINT, wireChain } from "./fixtures";
import type { WireListener } from "./socket";

const W = "TradingWa11et111111111111111111111111111111";

function signal(over: Partial<CopySignal> = {}): CopySignal {
  return {
    id: crypto.randomUUID(),
    taskId: "task-1",
    side: "buy",
    status: "pending",
    reason: null,
    mint: MINT,
    symbol: "SCAT",
    venue: "pump",
    leader: "Leader1111111111111111111111111111111111111",
    leaderSignature: "lsig",
    leaderSlot: 1,
    leaderSol: 1,
    leaderTokenAmount: "1000",
    leaderPriceSol: 0.00000003,
    priceSol: 0.00000003,
    mcSol: 30,
    mcUsd: 3_600,
    sizeSol: 0.05,
    maxPriceSol: 0.000000033,
    slippageBps: 1_000,
    preset: 1,
    takeProfitPct: null,
    stopLossPct: null,
    trigger: null,
    sellFraction: null,
    sellTokenAmount: null,
    fractionSource: null,
    delivered: true,
    createdAt: Date.now(),
    expiresAt: Date.now() + 30_000,
    resolvedAt: null,
    signature: null,
    filledSol: null,
    filledTokens: null,
    confirmed: false,
    ...over,
  };
}

function receipt(over: Partial<TradeReceipt> = {}): TradeReceipt {
  return {
    clientId: "x",
    status: "confirmed",
    signature: "copysig",
    error: null,
    latency: { clickedAt: 0, builtMs: 10, signedMs: 20, receivedMs: 30, lanes: [], landedMs: 400, slot: 5 },
    fill: {
      side: "buy",
      solAmount: 0.05,
      tokenAmount: 1_500_000,
      priceSol: 0.0000000333,
      fees: { venueSol: 0.000625, priorityFeeSol: 0.0001, tipSol: 0.0001, baseFeeSol: 0.000005 },
    },
    ...over,
  };
}

describe("copy engine", () => {
  let listener: WireListener | null;
  let buys: BuyRequest[];
  let sells: SellRequest[];
  let reports: { path: string; body: CopySignalResult }[];
  let next: TradeReceipt;
  let locked: boolean;
  let engine: CopyEngine;

  beforeEach(() => {
    listener = null;
    buys = [];
    sells = [];
    reports = [];
    next = receipt();
    locked = false;
    useWallet.setState({ activeAddress: W });
    engine = new CopyEngine({
      data: {
        socket: {
          subscribe: (_topic: string, l: WireListener) => {
            listener = l;
            return () => {};
          },
        } as never,
        decimalsOf: () => 6,
        chain: () => wireChain(),
      },
      trade: {
        buy: async (r) => {
          buys.push(r);
          return next;
        },
        sell: async (r) => {
          sells.push(r);
          return next;
        },
      },
      locked: () => locked,
      claim: async (_id, run) => run(),
      rest: async <T>(path: string, o: { method?: string; body?: unknown } = {}) => {
        if (path.endsWith("/result")) reports.push({ path, body: o.body as CopySignalResult });
        if (path === "/api/copy/tasks" && o.method === "POST") {
          return { id: "task-2", leader: "L", label: "Leader", status: "active", pausedReason: null } as unknown as T;
        }
        return {} as T;
      },
    });
    engine.start();
  });

  afterEach(() => {
    engine.stop();
    useCopy.getState().setAvailable(false);
    useWallet.setState({ activeAddress: null });
  });

  test("a pending buy is copied with the signal's size, price limit and slippage; a real fill is reported executed", async () => {
    const sig = signal();
    await engine.handle(sig);
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({ mint: MINT, wallet: W, solAmount: 0.05, maxPriceSol: 0.000000033, mode: "instant", source: "tracker" });
    expect(buys[0]?.settings.slippagePct).toBe(10);
    expect(reports).toEqual([
      {
        path: `/api/copy/signals/${sig.id}/result`,
        body: { status: "executed", signature: "copysig", solAmount: 0.05, tokenAmount: "1500000000000" },
      },
    ]);
    // Handled once.
    await engine.handle(sig);
    expect(buys).toHaveLength(1);
  });

  test("dry run: the simulated copy is declined (nothing was sent); a refused price is declined as price_moved", async () => {
    next = receipt({ simulated: true });
    await engine.handle(signal());
    next = receipt({ status: "failed", error: "Price moved past the copy's limit", fill: null, signature: null });
    await engine.handle(signal());
    expect(reports.map((r) => r.body)).toEqual([
      { status: "declined", reason: "dry_run" },
      { status: "declined", reason: "price_moved" },
    ]);
  });

  test("expired, locked or halted: nothing is traded or reported (the server expires it); unlocking later picks it up", async () => {
    await engine.handle(signal({ expiresAt: Date.now() - 1 }));
    locked = true;
    const waiting = signal();
    await engine.handle(waiting);
    expect(buys).toHaveLength(0);
    expect(reports).toHaveLength(0);
    locked = false;
    await engine.handle(waiting);
    expect(buys).toHaveLength(1);
  });

  test("a sell signal sells the signalled token amount", async () => {
    next = receipt({ fill: { ...receipt().fill!, side: "sell" } });
    await engine.handle(
      signal({ side: "sell", sizeSol: null, maxPriceSol: null, trigger: "leader_sell", sellFraction: 0.5, sellTokenAmount: "2500000" }),
    );
    expect(sells).toHaveLength(1);
    expect(sells[0]?.tokenAmount).toBe(2.5);
  });

  test("the copy topic feeds the store; pending signals in a delta are acted on", async () => {
    const task = { id: "task-1", leader: "L", label: "Leader", status: "active" } as unknown as CopyTask;
    listener?.onMessage({ type: "snapshot", topic: "copy", seq: 1, data: { tasks: [task], positions: [], signals: [] } } as never);
    expect(useCopy.getState().available).toBe(true);
    expect(useCopy.getState().tasks).toHaveLength(1);
    listener?.onMessage({ type: "delta", topic: "copy", seq: 2, data: { signals: [signal()] } } as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(buys).toHaveLength(1);
    expect(useCopy.getState().signals).toHaveLength(1);
    await engine.create({ leader: "L" });
    expect(
      useCopy
        .getState()
        .tasks.map((t) => t.id)
        .sort(),
    ).toEqual(["task-1", "task-2"]);
    listener?.onError?.({ type: "error", topic: "copy", code: "unauthorized", message: "sign in" } as never);
    expect(useCopy.getState().available).toBe(false);
  });
});
