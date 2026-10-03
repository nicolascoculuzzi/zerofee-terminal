/**
 * `wallet:<address>` and `orders` topics. SHAPES ONLY in Phase 2: the server does not publish them yet
 * (wallet tracking arrives with Phase 3 identity; armed orders with Phase 5).
 */
import type { Trade } from "./market";

export interface WalletTokenBalance {
  mint: string;
  /** Token account holding the balance (usually the ATA). */
  account: string;
  /** Base units. */
  amount: string;
  decimals: number;
  tokenProgram: string;
}

export interface WalletSnapshot {
  address: string;
  /** Lamports. */
  lamports: string;
  tokens: WalletTokenBalance[];
  /** Most recent fills by this wallet, newest first. */
  fills: Trade[];
  slot: number | null;
}

export interface WalletDelta {
  lamports?: string;
  /** Upserted balances (amount "0" = account emptied). */
  tokens?: WalletTokenBalance[];
  /** Closed token accounts. */
  closed?: string[];
  /** New fills, oldest first. */
  fills?: Trade[];
  slot?: number;
}

export type OrderKind = "limit" | "take_profit" | "stop_loss" | "trailing_stop" | "migration";
export type OrderStatus = "armed" | "triggered" | "submitted" | "filled" | "failed" | "cancelled" | "expired" | "stranded";

export interface OrderTrigger {
  /** What the trigger compares. */
  metric: "price_sol" | "mc_sol" | "mc_usd" | "migration";
  op: "gte" | "lte";
  value: number;
}

export interface Order {
  id: string;
  kind: OrderKind;
  status: OrderStatus;
  mint: string;
  side: "buy" | "sell";
  /** buy: quote base units to spend; sell: base units to sell. */
  amount: string;
  trigger: OrderTrigger;
  /** Durable-nonce account the pre-signed variants are bound to. */
  nonceAccount: string | null;
  /** Signature of the landed variant, once filled. */
  signature: string | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
}

export interface OrdersSnapshot {
  orders: Order[];
}

export interface OrdersDelta {
  upsert: Order[];
  remove: string[];
}
