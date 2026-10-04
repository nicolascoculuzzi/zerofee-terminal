/**
 * `wallet:<address>` topic (a user topic: it needs a signed-in session, see topics.ts). Balances are not
 * published yet, so subscribing to an allowed wallet answers `unavailable`. The `orders` topic is in orders.ts.
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
