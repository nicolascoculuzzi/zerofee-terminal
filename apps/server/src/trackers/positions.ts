/**
 * A watched wallet's token balance around one of its trades, for "first buy" (the wallet's opening buy
 * of a token) and for the fraction a copy-trade leader sold.
 *
 * Sources, most exact first:
 *  1. balances: the transaction's post-token balances (gRPC meta) give the wallet's balance after the
 *     trade exactly;
 *  2. holders:  the market's holder book, kept from every trade of tokens whose history the server
 *     observed (created while watching, or replayed at start-up);
 *  3. tracked:  WalletPositions below, the sum of this wallet's trades since the server started
 *     watching it (bounded LRU). Blind to transfers and other venues, so a wallet with no record is
 *     assumed to start from zero ("first buy since we started watching").
 */
import type { Trade } from "@zerofee/protocol";
import type { TokenBalanceUpdate } from "../ingest/types";
import { LruMap } from "../util/lru";

export type BalanceSource = "balances" | "holders" | "tracked";

export interface BalanceView {
  /** Base units before / after the trade; null when unknown. */
  before: bigint | null;
  after: bigint | null;
  source: BalanceSource | null;
}

/** Holder balance lookup for one mint (the market's HolderBook), when the token's history is known. */
export interface HolderLookup {
  balanceOf(wallet: string): bigint;
}

/** Per-(wallet, mint) balances of watched wallets from the trades seen, oldest evicted first. */
export class WalletPositions {
  private readonly map: LruMap<string, bigint>;

  constructor(max: number) {
    this.map = new LruMap(max);
  }

  get size(): number {
    return this.map.size;
  }

  get(wallet: string, mint: string): bigint | undefined {
    return this.map.peek(`${wallet}|${mint}`);
  }

  set(wallet: string, mint: string, amount: bigint): void {
    this.map.set(`${wallet}|${mint}`, amount < 0n ? 0n : amount);
  }
}

const max0 = (v: bigint): bigint => (v < 0n ? 0n : v);

/**
 * The trader's balance around `trade`, from the most exact source available, and records the result in
 * `positions` when the trader is watched (`track`).
 */
export function balanceAround(
  trade: Trade,
  tokenBalances: readonly TokenBalanceUpdate[] | null,
  holders: HolderLookup | null,
  positions: WalletPositions,
  track: boolean,
): BalanceView {
  const amount = BigInt(trade.tokenAmount);
  const buy = trade.side === "buy";
  let view: BalanceView = { before: null, after: null, source: null };
  const post = tokenBalances?.find((b) => b.mint === trade.mint && b.owner === trade.trader);
  if (post) {
    view = { after: post.amount, before: max0(buy ? post.amount - amount : post.amount + amount), source: "balances" };
  } else if (holders) {
    // The market applied this trade's delta to the holder book before the trade reached us.
    const after = holders.balanceOf(trade.trader);
    view = { after, before: buy ? max0(after - amount) : after + amount, source: "holders" };
  } else {
    const known = positions.get(trade.trader, trade.mint);
    if (known !== undefined) view = { before: known, after: max0(buy ? known + amount : known - amount), source: "tracked" };
    else if (buy) view = { before: 0n, after: amount, source: "tracked" };
  }
  if (track) {
    if (view.after !== null) positions.set(trade.trader, trade.mint, view.after);
  }
  return view;
}

/** The trader's opening buy of the token (null for sells and when the balance is unknown). */
export function isFirstBuy(trade: Trade, view: BalanceView): boolean | null {
  if (trade.side !== "buy" || view.before === null) return null;
  return view.before === 0n;
}
