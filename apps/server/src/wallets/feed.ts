/**
 * The `wallet:<address>` feed (packages/protocol account.ts) for the signed-in user's own wallets: the
 * web app needs a trading wallet's SOL and token balances to size sells and show positions, and its fills
 * for cost basis and activity.
 *
 *   snapshot  lamports + every token account (both token programs, getTokenAccountsByOwner) read over RPC,
 *             plus the wallet's recent trades from the trade history (SQLite, TRADES_RETENTION_HOURS)
 *   deltas    `fills` the moment the ingest decodes a trade by the wallet; balances re-read a moment after
 *             such a fill and every WALLET_REFRESH_MS while someone watches (deposits, withdrawals and
 *             transfers do not show up as trades), published as changes only
 *
 * Reads only; it never sends anything. Wallets nobody watches cost nothing (who may watch is the gateway's
 * job: the user's main wallet or a registered trading wallet).
 */

import type { Address } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@zerofee/core";
import type { Trade, WalletDelta, WalletSnapshot, WalletTokenBalance } from "@zerofee/protocol";
import { logger } from "../log";
import type { RpcClient } from "../util/rpc";

const log = logger("wallets");

export interface WalletFeedOptions {
  rpc: Pick<RpcClient, "getMultipleAccounts" | "getTokenAccountsByOwner">;
  /** The wallet's recent trades from storage, newest first. */
  history(address: string, limit: number): Trade[];
  /** True while a socket watches `wallet:<address>`. */
  watched(address: string): boolean;
  /** Every watched address. */
  watchedAll(): Iterable<string>;
  publish(address: string, delta: WalletDelta): boolean;
  refreshMs: number;
  afterFillMs: number;
  /** Fills in a snapshot. Default 100. */
  fillsLimit?: number;
}

export interface Balances {
  slot: number;
  lamports: string;
  /** By token account. */
  tokens: Map<string, WalletTokenBalance>;
}

export class WalletFeed {
  /** Last balances sent per watched wallet (deltas are diffs against these). */
  private readonly last = new Map<string, Balances>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly stats = { snapshots: 0, refreshes: 0, fills: 0, deltas: 0, errors: 0 };

  constructor(private readonly o: WalletFeedOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const address of this.o.watchedAll()) void this.refresh(address);
    }, this.o.refreshMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  /** Snapshot for a new subscriber: fresh balances (they also become the baseline for deltas) and history. */
  async snapshot(address: string): Promise<WalletSnapshot> {
    const b = await this.read(address);
    this.last.set(address, b);
    this.stats.snapshots++;
    return {
      address,
      lamports: b.lamports,
      tokens: [...b.tokens.values()],
      fills: this.o.history(address, this.o.fillsLimit ?? 100),
      slot: b.slot,
    };
  }

  /** Every trade the market records: a watched wallet's own trade goes out as a fill, then balances follow. */
  onTrade(trade: Trade): void {
    const address = trade.trader;
    if (!this.o.watched(address)) return;
    this.stats.fills++;
    if (this.o.publish(address, { fills: [trade], slot: trade.slot })) this.stats.deltas++;
    this.schedule(address);
  }

  private schedule(address: string): void {
    if (this.pending.has(address)) return;
    this.pending.set(
      address,
      setTimeout(() => {
        this.pending.delete(address);
        void this.refresh(address);
      }, this.o.afterFillMs),
    );
  }

  /** Re-reads a watched wallet's balances and publishes what changed. */
  async refresh(address: string): Promise<void> {
    if (!this.o.watched(address)) {
      this.last.delete(address);
      return;
    }
    if (this.inFlight.has(address)) return;
    this.inFlight.add(address);
    try {
      const next = await this.read(address);
      this.stats.refreshes++;
      const prev = this.last.get(address);
      this.last.set(address, next);
      if (!prev) return; // no baseline: the next snapshot carries everything
      const delta = diffBalances(prev, next);
      if (delta && this.o.publish(address, delta)) this.stats.deltas++;
    } catch (e) {
      this.stats.errors++;
      log.debug(`balance read of ${address} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.inFlight.delete(address);
    }
  }

  private async read(address: string): Promise<Balances> {
    const [acc, legacy, t22] = await Promise.all([
      this.o.rpc.getMultipleAccounts([address as Address]),
      this.o.rpc.getTokenAccountsByOwner(address, TOKEN_PROGRAM_ID),
      this.o.rpc.getTokenAccountsByOwner(address, TOKEN_2022_PROGRAM_ID),
    ]);
    const tokens = new Map<string, WalletTokenBalance>();
    for (const t of [...legacy.accounts, ...t22.accounts]) tokens.set(t.account, t);
    return {
      slot: Math.max(acc.slot, legacy.slot, t22.slot),
      // A wallet that never received SOL has no account: 0 lamports is the chain's own answer.
      lamports: (acc.accounts[0]?.lamports ?? 0n).toString(),
      tokens,
    };
  }
}

/** Changed lamports, upserted token accounts (new or changed amount) and closed accounts; null when equal. */
export function diffBalances(prev: Balances, next: Balances): WalletDelta | null {
  const delta: WalletDelta = {};
  if (prev.lamports !== next.lamports) delta.lamports = next.lamports;
  const tokens: WalletTokenBalance[] = [];
  for (const [account, t] of next.tokens) {
    const p = prev.tokens.get(account);
    if (!p || p.amount !== t.amount || p.mint !== t.mint) tokens.push(t);
  }
  const closed = [...prev.tokens.keys()].filter((a) => !next.tokens.has(a));
  if (tokens.length) delta.tokens = tokens;
  if (closed.length) delta.closed = closed;
  if (delta.lamports === undefined && !tokens.length && !closed.length) return null;
  delta.slot = next.slot;
  return delta;
}
