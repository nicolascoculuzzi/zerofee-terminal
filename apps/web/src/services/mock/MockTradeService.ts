import type { LandingPreset, LatencyBreakdown, Order } from "../../protocol";
import type {
  BuyRequest,
  LimitOrderRequest,
  MigrationOrderRequest,
  SellRequest,
  TpSlRequest,
  TradeProgress,
  TradeReceipt,
  TradeService,
} from "../tradeService";
import { fakeSignature } from "./addresses";
import type { SimEngine } from "./engine";

const LANES: Record<LandingPreset, string[]> = {
  reduced: ["Helius Sender (swqos + mev-protect)"],
  secure: ["Jito bundle-only (jitodontfront)"],
  fast: ["Helius Sender", "Jito", "Fallback RPC"],
};

const INFRA_FAILURES = [
  "Not landed: blockhash expired (lastValidBlockHeight passed)",
  "Not landed: bundle not included within 4 slots",
  "Lane rate limited (429); nothing was sent",
  "Simulation failed: account data changed (curve state moved), please retry",
] as const;

const BASE_FEE_SOL = 0.000005;

/**
 * Simulated trade engine: optimistic pending state, then a confirmation 400–900 ms after the
 * click with a fake signature and a latency breakdown. About 5% fail with an infrastructure
 * reason; the engine itself rejects on slippage, balance or a migrating curve.
 */
export class MockTradeService implements TradeService {
  constructor(private readonly engine: SimEngine) {}

  buy(request: BuyRequest, onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    return this.run(request, "buy", onProgress);
  }

  sell(request: SellRequest, onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    return this.run(request, "sell", onProgress);
  }

  private run(request: BuyRequest | SellRequest, side: "buy" | "sell", onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    const rng = this.engine.rng;
    const preset = request.settings.landing;
    const built = 3 + rng.next() * 6;
    const signed = built + 1 + rng.next() * 3;
    const received = signed + 22 + rng.next() * 45;
    const lanes = LANES[preset].map((lane, i) => ({ lane, sentMs: received + 1 + i * 1.5 + rng.next() * 2 }));
    const landedTarget = preset === "fast" ? 400 + rng.next() * 260 : 430 + rng.next() * 470;
    const latency: LatencyBreakdown = {
      clickedAt: request.clickedAt,
      builtMs: round(built),
      signedMs: round(signed),
      receivedMs: round(received),
      lanes: lanes.map((l) => ({ lane: l.lane, sentMs: round(l.sentMs) })),
      landedMs: null,
      slot: null,
    };
    const elapsed = () => Date.now() - request.clickedAt;
    const at = (ms: number, fn: () => void) => setTimeout(fn, Math.max(0, ms - elapsed()));

    return new Promise((resolve) => {
      at(built, () => onProgress?.({ stage: "built", atMs: latency.builtMs }));
      at(signed, () => onProgress?.({ stage: "signed", atMs: latency.signedMs }));
      at(received, () => onProgress?.({ stage: "received", atMs: latency.receivedMs }));
      at(lanes[lanes.length - 1]?.sentMs ?? received, () =>
        onProgress?.({ stage: "sent", atMs: lanes[lanes.length - 1]?.sentMs ?? received }),
      );
      at(landedTarget, () => {
        const landedMs = round(elapsed());
        const fail = (error: string): void => {
          onProgress?.({ stage: "failed", atMs: landedMs });
          resolve({
            clientId: request.clientId,
            status: "failed",
            signature: null,
            error,
            latency: { ...latency, landedMs: null },
            fill: null,
          });
        };
        if (rng.chance(0.05)) {
          fail(rng.pick(INFRA_FAILURES));
          return;
        }
        const signature = fakeSignature(rng);
        const res = this.engine.executeUserSwap({
          wallet: request.wallet,
          mint: request.mint,
          side,
          solAmount: "solAmount" in request ? request.solAmount : undefined,
          pct: "pct" in request ? request.pct : undefined,
          tokenAmount: "tokenAmount" in request ? request.tokenAmount : undefined,
          expectedPriceSol: request.expectedPriceSol,
          slippagePct: request.settings.slippagePct,
          priorityFeeSol: request.settings.priorityFeeSol,
          tipSol: request.settings.tipSol,
          signature,
        });
        if (!res.ok) {
          fail(res.error);
          return;
        }
        onProgress?.({ stage: "landed", atMs: landedMs });
        resolve({
          clientId: request.clientId,
          status: "confirmed",
          signature,
          error: null,
          latency: { ...latency, landedMs, slot: res.slot },
          fill: {
            side,
            solAmount: res.fill.solAmount,
            tokenAmount: res.fill.tokenAmount,
            priceSol: res.fill.priceSol,
            fees: {
              venueSol: res.fill.venueFeeSol,
              priorityFeeSol: request.settings.priorityFeeSol,
              tipSol: request.settings.tipSol,
              baseFeeSol: BASE_FEE_SOL,
            },
          },
        });
      });
    });
  }

  async placeLimit(request: LimitOrderRequest): Promise<Order> {
    await wait(180);
    const symbol = this.engine.tokenSymbol(request.mint) ?? "TOKEN";
    const armed = this.engine.addOrder({
      wallet: request.wallet,
      mint: request.mint,
      symbol,
      kind: request.side === "buy" ? "limit_buy" : "limit_sell",
      side: request.side,
      trigger: request.trigger,
      size: request.size,
      landing: request.settings.landing,
      slippagePct: request.settings.slippagePct,
      priorityFeeSol: request.settings.priorityFeeSol,
      tipSol: request.settings.tipSol,
    });
    if (!armed) throw new Error("No free durable-nonce slots (10/10 in use). Cancel an order first.");
    return armed.order;
  }

  async armTpSl(request: TpSlRequest): Promise<Order[]> {
    await wait(220);
    const symbol = this.engine.tokenSymbol(request.mint) ?? "TOKEN";
    const tps = request.legs.filter((l) => l.kind === "take_profit");
    const sls = request.legs.filter((l) => l.kind === "stop_loss");
    // OCO pairs TP[i] with SL[i] on one durable nonce; every other leg gets its own nonce.
    const pairs = request.oco ? Math.min(tps.length, sls.length) : 0;
    const needed = request.legs.length - pairs;
    if (this.engine.freeNonceSlots(request.wallet) < needed) {
      throw new Error(`Not enough free nonce slots: need ${needed}.`);
    }
    const orders: Order[] = [];
    const make = (leg: (typeof request.legs)[number], group: string | null, nonceSlots: number) => {
      const price =
        leg.kind === "take_profit"
          ? request.entryPriceSol * (1 + leg.triggerPct / 100)
          : request.entryPriceSol * (1 - leg.triggerPct / 100);
      const armed = this.engine.addOrder({
        wallet: request.wallet,
        mint: request.mint,
        symbol,
        kind: leg.kind,
        side: "sell",
        trigger: { metric: "price", direction: leg.kind === "take_profit" ? "above" : "below", value: price },
        size: { kind: "pct", pct: leg.sellPct },
        landing: request.settings.landing,
        slippagePct: request.settings.slippagePct,
        priorityFeeSol: request.settings.priorityFeeSol,
        tipSol: request.settings.tipSol,
        ocoGroupId: group,
        nonceSlots,
      });
      if (armed) orders.push(armed.order);
    };
    for (let i = 0; i < pairs; i++) {
      const tp = tps[i];
      const sl = sls[i];
      const group = `oco-${Date.now().toString(36)}-${i}`;
      if (tp) make(tp, group, 1);
      if (sl) make(sl, group, 0);
    }
    for (const leg of [...tps.slice(pairs), ...sls.slice(pairs)]) make(leg, null, 1);
    return orders;
  }

  async armMigration(request: MigrationOrderRequest): Promise<Order> {
    await wait(180);
    const symbol = this.engine.tokenSymbol(request.mint) ?? "TOKEN";
    const armed = this.engine.addOrder({
      wallet: request.wallet,
      mint: request.mint,
      symbol,
      kind: request.side === "buy" ? "migration_buy" : "migration_sell",
      side: request.side,
      trigger: { metric: "migration", direction: null, value: null },
      size: request.size,
      landing: request.settings.landing,
      slippagePct: request.settings.slippagePct,
      priorityFeeSol: request.settings.priorityFeeSol,
      tipSol: request.settings.tipSol,
    });
    if (!armed) throw new Error("No free durable-nonce slots (10/10 in use). Cancel an order first.");
    return armed.order;
  }

  async cancel(orderId: string): Promise<void> {
    await wait(150);
    if (!this.engine.cancelOrder(orderId)) throw new Error("Order is not cancellable");
  }

  async rearm(orderId: string): Promise<Order> {
    await wait(350);
    const order = this.engine.rearmOrder(orderId);
    if (!order) throw new Error("Order not found");
    return order;
  }

  async panic(): Promise<{ cancelled: number }> {
    await wait(120);
    return { cancelled: this.engine.cancelAll() };
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
