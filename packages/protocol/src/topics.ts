/**
 * WebSocket topics. One topic per view; the client subscribes as views mount and unsubscribes as they
 * unmount. Topic strings are the wire format.
 *
 *   pulse:new | pulse:final | pulse:migrated   Pulse columns (coalesced to 4-10 Hz)
 *   token:<mint>                                one token's summary (header stats)
 *   trades:<mint>                               trade tape (flushed every 50-100 ms)
 *   candles:<mint>:<tf>                         OHLCV, tf in TIMEFRAMES
 *   tradectx:<mint>                             inputs for building a trade locally with @zerofee/core
 *   chain                                       blockhash, slot, priority fees, Jito tip floor, SOL/USD, halt
 *   wallet:<address>                            balances (RPC) and fills (the feed) of one of the user's wallets
 *   orders                                      the session user's armed orders
 *   tracked                                     the session user's tracked-wallet feed (trackers.ts)
 *   tracked:<mint>                              the user's tracked-wallet trades on one token (chart markers)
 *   copy                                        the session user's copy-trade signals, tasks and positions
 *
 * Market topics are public. `wallet:<address>`, `orders`, `tracked`, `tracked:<mint>` and `copy` are
 * user topics: the WebSocket upgrade must carry the session cookie (and an allowed Origin), `wallet:`
 * only accepts the signed-in main wallet or one of the user's registered trading wallets (`forbidden`
 * otherwise), and the others are scoped to the session's user. Without a session they answer
 * `unauthorized`.
 *
 * The few runtime helpers below are pure and dependency-free so the server and the web app parse topics
 * identically.
 */

export const TIMEFRAMES = ["1s", "15s", "1m", "5m", "15m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Bucket length of each timeframe in milliseconds. */
export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  "1s": 1_000,
  "15s": 15_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
};

export const PULSE_COLUMNS = ["new", "final", "migrated"] as const;
export type PulseColumn = (typeof PULSE_COLUMNS)[number];

export type PulseTopic = `pulse:${PulseColumn}`;
export type TokenTopic = `token:${string}`;
export type TradesTopic = `trades:${string}`;
export type CandlesTopic = `candles:${string}:${Timeframe}`;
export type TradeContextTopic = `tradectx:${string}`;
export type ChainTopic = "chain";
export type WalletTopic = `wallet:${string}`;
export type OrdersTopic = "orders";
export type TrackedTopic = "tracked" | `tracked:${string}`;
export type CopyTopic = "copy";

export type Topic =
  | PulseTopic
  | TokenTopic
  | TradesTopic
  | CandlesTopic
  | TradeContextTopic
  | ChainTopic
  | WalletTopic
  | OrdersTopic
  | TrackedTopic
  | CopyTopic;

export type ParsedTopic =
  | { kind: "pulse"; column: PulseColumn }
  | { kind: "token"; mint: string }
  | { kind: "trades"; mint: string }
  | { kind: "candles"; mint: string; tf: Timeframe }
  | { kind: "tradectx"; mint: string }
  | { kind: "chain" }
  | { kind: "wallet"; address: string }
  | { kind: "orders" }
  /** mint null = the whole feed; a mint = that token's markers. */
  | { kind: "tracked"; mint: string | null }
  | { kind: "copy" };

/** Base58 address check (32-44 chars of the bitcoin alphabet). Cheap shape check, not a curve check. */
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isAddressLike(s: string): boolean {
  return ADDRESS_RE.test(s);
}

export function isTimeframe(s: string): s is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(s);
}

/** Parses a topic string; null if it is not a valid topic. */
export function parseTopic(topic: string): ParsedTopic | null {
  if (topic === "chain") return { kind: "chain" };
  if (topic === "orders") return { kind: "orders" };
  if (topic === "tracked") return { kind: "tracked", mint: null };
  if (topic === "copy") return { kind: "copy" };
  const i = topic.indexOf(":");
  if (i <= 0) return null;
  const head = topic.slice(0, i);
  const rest = topic.slice(i + 1);
  switch (head) {
    case "pulse":
      return (PULSE_COLUMNS as readonly string[]).includes(rest) ? { kind: "pulse", column: rest as PulseColumn } : null;
    case "token":
    case "trades":
    case "tradectx":
      return isAddressLike(rest) ? { kind: head, mint: rest } : null;
    case "wallet":
      return isAddressLike(rest) ? { kind: "wallet", address: rest } : null;
    case "tracked":
      return isAddressLike(rest) ? { kind: "tracked", mint: rest } : null;
    case "candles": {
      const j = rest.lastIndexOf(":");
      if (j <= 0) return null;
      const mint = rest.slice(0, j);
      const tf = rest.slice(j + 1);
      return isAddressLike(mint) && isTimeframe(tf) ? { kind: "candles", mint, tf } : null;
    }
    default:
      return null;
  }
}

/** Topic string builders. */
export const topics = {
  pulse: (column: PulseColumn): PulseTopic => `pulse:${column}`,
  token: (mint: string): TokenTopic => `token:${mint}`,
  trades: (mint: string): TradesTopic => `trades:${mint}`,
  candles: (mint: string, tf: Timeframe): CandlesTopic => `candles:${mint}:${tf}`,
  tradectx: (mint: string): TradeContextTopic => `tradectx:${mint}`,
  chain: "chain" as ChainTopic,
  wallet: (address: string): WalletTopic => `wallet:${address}`,
  orders: "orders" as OrdersTopic,
  tracked: (mint?: string): TrackedTopic => (mint ? `tracked:${mint}` : "tracked"),
  copy: "copy" as CopyTopic,
} as const;
