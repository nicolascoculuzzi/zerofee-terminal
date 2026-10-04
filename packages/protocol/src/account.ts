/**
 * `wallet:<address>` topic (a user topic: it needs a signed-in session and the user's main wallet or one of
 * their registered trading wallets, see topics.ts). The `orders` topic is in orders.ts.
 *
 *   snapshot  lamports and every token account (both token programs) read over RPC at subscribe time, plus
 *             the wallet's most recent fills from the server's trade history (TRADES_RETENTION_HOURS)
 *   deltas    `fills` as the ingest decodes the wallet's own trades; balance changes (`lamports`, `tokens`,
 *             `closed`) re-read shortly after such a fill and every WALLET_REFRESH_MS, sent as changes only
 *
 * Fills are pump / PumpSwap trades the server decoded (the wallet as the trade's own wallet), so SOL deposits,
 * withdrawals and other transfers change balances without a fill. An RPC failure on subscribe answers
 * `internal`; subscribe again to retry.
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
