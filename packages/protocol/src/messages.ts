/**
 * WebSocket message envelope.
 *
 * Client -> server: `{ type: "subscribe" | "unsubscribe", topic }`.
 * Server -> client: `{ type: "snapshot" | "delta" | "correction", topic, seq, data }` and `{ type: "error", ... }`.
 *
 * Sequencing (per topic; every subscriber of a topic sees the same numbers):
 *  1. `subscribe` is answered with a `snapshot` whose `seq` is the topic's current sequence number S.
 *  2. Every later `delta` / `correction` on that topic carries S+1, S+2, ... in order.
 *  3. Drop messages with seq <= the last applied seq (stale). On a gap (seq > last + 1) resubscribe
 *     (`unsubscribe` + `subscribe`) to get a fresh snapshot.
 *  4. `correction` rewrites history already sent (late events, dead-slot rollbacks); apply it like a delta.
 *
 * Re-sending `subscribe` for a topic you already hold re-sends the snapshot (cheap resync).
 */

import type { OrdersDelta, OrdersSnapshot, WalletDelta, WalletSnapshot } from "./account";
import type { ChainDelta, ChainSnapshot } from "./chain";
import type {
  CandlesCorrection,
  CandlesDelta,
  CandlesSnapshot,
  PulseDelta,
  PulseSnapshot,
  TokenPatch,
  TokenSummary,
  TradeContext,
  TradesCorrection,
  TradesDelta,
  TradesSnapshot,
} from "./market";
import type {
  CandlesTopic,
  ChainTopic,
  OrdersTopic,
  PulseTopic,
  TokenTopic,
  Topic,
  TradeContextTopic,
  TradesTopic,
  WalletTopic,
} from "./topics";

/** Payload types per topic kind. `never` = the topic does not send that message type. */
export interface TopicPayloads {
  pulse: { snapshot: PulseSnapshot; delta: PulseDelta; correction: never };
  /** null snapshot: the mint is unknown so far (deltas start flowing if it appears). */
  token: { snapshot: TokenSummary | null; delta: TokenPatch; correction: never };
  trades: { snapshot: TradesSnapshot; delta: TradesDelta; correction: TradesCorrection };
  candles: { snapshot: CandlesSnapshot; delta: CandlesDelta; correction: CandlesCorrection };
  /** Deltas are full replacements (the browser needs a consistent set of reserves). */
  tradectx: { snapshot: TradeContext | null; delta: TradeContext; correction: never };
  chain: { snapshot: ChainSnapshot; delta: ChainDelta; correction: never };
  wallet: { snapshot: WalletSnapshot; delta: WalletDelta; correction: never };
  orders: { snapshot: OrdersSnapshot; delta: OrdersDelta; correction: never };
}

export type TopicKindOf<T extends Topic> = T extends PulseTopic
  ? "pulse"
  : T extends CandlesTopic
    ? "candles"
    : T extends TokenTopic
      ? "token"
      : T extends TradesTopic
        ? "trades"
        : T extends TradeContextTopic
          ? "tradectx"
          : T extends ChainTopic
            ? "chain"
            : T extends WalletTopic
              ? "wallet"
              : T extends OrdersTopic
                ? "orders"
                : never;

export type SnapshotData<T extends Topic> = TopicPayloads[TopicKindOf<T>]["snapshot"];
export type DeltaData<T extends Topic> = TopicPayloads[TopicKindOf<T>]["delta"];
export type CorrectionData<T extends Topic> = TopicPayloads[TopicKindOf<T>]["correction"];

export interface SnapshotMessage<T extends Topic = Topic> {
  type: "snapshot";
  topic: T;
  seq: number;
  data: SnapshotData<T>;
}

export interface DeltaMessage<T extends Topic = Topic> {
  type: "delta";
  topic: T;
  seq: number;
  data: DeltaData<T>;
}

export type CorrectionReason = "late_event" | "dead_slot";

export interface CorrectionMessage<T extends Topic = Topic> {
  type: "correction";
  topic: T;
  seq: number;
  data: CorrectionData<T>;
  reason: CorrectionReason;
}

export type ErrorCode =
  | "bad_request"
  | "unknown_topic"
  | "unauthorized"
  | "rate_limited"
  | "too_many_subscriptions"
  | "not_found"
  | "unavailable"
  | "internal";

export interface ErrorMessage {
  type: "error";
  /** The topic the error relates to, if any. */
  topic?: string;
  code: ErrorCode;
  message: string;
}

export interface SubscribeMessage {
  type: "subscribe";
  topic: Topic;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  topic: Topic;
}

export type ClientMessage = SubscribeMessage | UnsubscribeMessage;
export type ServerMessage = SnapshotMessage | DeltaMessage | CorrectionMessage | ErrorMessage;
