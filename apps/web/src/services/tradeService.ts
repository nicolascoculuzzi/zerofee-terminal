import type { LandingPreset, LatencyBreakdown, Order, OrderSize, OrderTrigger } from "../protocol";

/** Per-side execution settings held by a preset (P1/P2/P3). */
export interface ExecutionSettings {
  /** Max allowed price movement between quote and landing, %. */
  slippagePct: number;
  /** Priority fee in SOL (clamped to the Helius estimate by the engine). */
  priorityFeeSol: number;
  /** Tip in SOL paid to the landing lane. */
  tipSol: number;
  landing: LandingPreset;
}

/** Instant = trading wallet in this browser signs; direct = connected wallet approves each trade. */
export type TradeMode = "instant" | "direct";

export type TradeSource = "pulse" | "token" | "instant" | "hotkey" | "search" | "tracker" | "social" | "mobile" | "paste" | "portfolio";

interface TradeRequestBase {
  /** Client-generated id; also used as the optimistic-UI key. */
  clientId: string;
  mint: string;
  /** Trading-wallet address that signs (instant) or the connected wallet (direct). */
  wallet: string;
  settings: ExecutionSettings;
  mode: TradeMode;
  source: TradeSource;
  /** `performance.timeOrigin + performance.now()` at the click, for the latency record. */
  clickedAt: number;
  /** Quote at click time; the engine enforces slippage against it. */
  expectedPriceSol: number;
}

export interface BuyRequest extends TradeRequestBase {
  solAmount: number;
}

export interface SellRequest extends TradeRequestBase {
  /** Exactly one of these is set. */
  pct?: number;
  tokenAmount?: number;
}

export type TradeStage = "built" | "signed" | "received" | "sent" | "landed" | "failed";

export interface TradeProgress {
  stage: TradeStage;
  /** ms since the click. */
  atMs: number;
}

export interface TradeFees {
  /** Launchpad/AMM fee (pump.fun curve: 1.25% per side). */
  venueSol: number;
  priorityFeeSol: number;
  tipSol: number;
  baseFeeSol: number;
}

export interface TradeReceipt {
  clientId: string;
  status: "confirmed" | "failed";
  signature: string | null;
  error: string | null;
  latency: LatencyBreakdown;
  fill: {
    side: "buy" | "sell";
    solAmount: number;
    tokenAmount: number;
    priceSol: number;
    fees: TradeFees;
  } | null;
}

export interface LimitOrderRequest {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  trigger: OrderTrigger;
  size: OrderSize;
  settings: ExecutionSettings;
}

export interface TpSlLeg {
  kind: "take_profit" | "stop_loss";
  /** Trigger distance from the entry price, % (TP positive, SL positive = drawdown). */
  triggerPct: number;
  /** Share of the holding to sell when it fires, %. */
  sellPct: number;
}

export interface TpSlRequest {
  mint: string;
  wallet: string;
  /** Entry price the ladder is measured from (SOL per token). */
  entryPriceSol: number;
  legs: TpSlLeg[];
  settings: ExecutionSettings;
  /** Pair each TP with the SL on one durable nonce (OCO). */
  oco: boolean;
}

export interface MigrationOrderRequest {
  mint: string;
  wallet: string;
  side: "buy" | "sell";
  size: OrderSize;
  settings: ExecutionSettings;
}

/**
 * Trade engine boundary. The production implementation builds transactions with
 * `packages/core` from the streamed trade context, runs them through the signer firewall,
 * signs in the isolated signer (instant) or via Wallet Standard (direct), and POSTs the
 * signed bytes to `/api/tx`. Armed orders pre-sign durable-nonce transactions in the browser
 * and hand them to the server (SPEC "Armed orders").
 *
 * The UI shows an optimistic pending state the moment it calls `buy`/`sell`; `onProgress`
 * reports each latency stage, and the returned promise settles on landing or failure.
 */
export interface TradeService {
  buy(request: BuyRequest, onProgress?: (progress: TradeProgress) => void): Promise<TradeReceipt>;
  sell(request: SellRequest, onProgress?: (progress: TradeProgress) => void): Promise<TradeReceipt>;

  /** Limit order by market cap or price, armed as pre-signed transactions. */
  placeLimit(request: LimitOrderRequest): Promise<Order>;
  /** TP/SL ladder measured from an entry price, armed. */
  armTpSl(request: TpSlRequest): Promise<Order[]>;
  /** Buy or sell when a pump.fun coin migrates (canonical pool address is deterministic). */
  armMigration(request: MigrationOrderRequest): Promise<Order>;

  /** Fires the stored pre-signed cancel (nonce advance). */
  cancel(orderId: string): Promise<void>;
  /** Re-signs a stale order against fresh accounts; needs the browser and an unlocked wallet. */
  rearm(orderId: string): Promise<Order>;
  /** User kill switch: cancel every armed order. The caller also locks the keystore. */
  panic(): Promise<{ cancelled: number }>;
}
