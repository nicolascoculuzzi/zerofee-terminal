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
 *  4. `correction` rewrites history already sent (late events, dead-slot rollbacks, backfilled history); apply it
 *     like a delta.
 *
 * Re-sending `subscribe` for a topic you already hold re-sends the snapshot (cheap resync).
 */

import type { WalletDelta, WalletSnapshot } from "./account";
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
import type { OrdersDelta, OrdersSnapshot } from "./orders";
import type {
  CandlesTopic,
  ChainTopic,
  CopyTopic,
  OrdersTopic,
  PulseTopic,
  TokenTopic,
  Topic,
  TrackedTopic,
  TradeContextTopic,
  TradesTopic,
  WalletTopic,
} from "./topics";
import type { CopyDelta, CopySnapshot, TrackedCorrection, TrackedDelta, TrackedSnapshot } from "./trackers";

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
  /** `tracked` and `tracked:<mint>`: rows of the user's tracked wallets; corrections drop rows of dead slots. */
  tracked: { snapshot: TrackedSnapshot; delta: TrackedDelta; correction: TrackedCorrection };
  copy: { snapshot: CopySnapshot; delta: CopyDelta; correction: never };
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
                : T extends TrackedTopic
                  ? "tracked"
                  : T extends CopyTopic
                    ? "copy"
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

/**
 * late_event: an out-of-order event; dead_slot: a rolled-back slot; backfill: history read back from chain
 * (older trades / rebuilt candles of a coin first seen mid-life, or a repaired feed gap). Apply all alike.
 */
export type CorrectionReason = "late_event" | "dead_slot" | "backfill";

export interface CorrectionMessage<T extends Topic = Topic> {
  type: "correction";
  topic: T;
  seq: number;
  data: CorrectionData<T>;
  reason: CorrectionReason;
}

/**
 * Error codes shared by WebSocket `error` messages and REST error bodies.
 *   unauthorized    no valid session (REST 401; WS: user topics need a signed-in session)
 *   forbidden       signed in, but not allowed (REST 403: cross-origin mutation, foreign wallet topic)
 *   conflict        the resource already exists or changed underneath (REST 409)
 *   limit_exceeded  a per-user cap was reached (REST 422, e.g. 10,000 tracked wallets)
 *   halted          the admin kill switch is on; POST /api/tx refuses (REST 503)
 */
export type ErrorCode =
  | "bad_request"
  | "unknown_topic"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "too_many_subscriptions"
  | "not_found"
  | "conflict"
  | "limit_exceeded"
  | "halted"
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
