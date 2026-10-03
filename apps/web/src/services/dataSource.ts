import type { PnlPoint, SearchResults, ServerMessage, Topic, WalletStatus } from "../protocol";

export type FeedConnectionState = "connecting" | "live" | "degraded" | "offline";

export type TopicHandler<T extends Topic> = (message: ServerMessage<T>) => void;

/**
 * Live market data. The production implementation wraps one authenticated WebSocket to the
 * gateway (`/ws`, SIWS session cookie) plus a few REST calls; `MockDataSource` simulates it.
 *
 * Contract:
 * - `subscribe` delivers one `snapshot`, then `delta`s with `seq` increasing by 1. Several
 *   subscribers to one topic share a single server subscription.
 * - Handlers may be called at any rate up to the server's coalescing rate; the UI applies
 *   its own requestAnimationFrame batching on top.
 * - After a reconnect the implementation resubscribes and sends fresh snapshots.
 */
export interface DataSource {
  subscribe<T extends Topic>(topic: T, handler: TopicHandler<T>): () => void;

  getConnectionState(): FeedConnectionState;
  onConnectionState(listener: (state: FeedConnectionState) => void): () => void;

  /** REST `GET /api/search?q=` by name, ticker, contract address or wallet. */
  search(query: string, limit?: number): Promise<SearchResults>;

  /** REST `PUT /api/trackers/wallets`. The server matches these signers for the `tracked` topic. */
  setTrackedWallets(addresses: string[]): Promise<void>;

  /** REST `PUT /api/trackers/x`. The server pools handles for the `social` topic. */
  setTrackedHandles(handles: string[]): Promise<void>;

  /** REST `GET /api/wallets/:address`: any wallet's positions (Portfolio "search other wallets"). */
  getWallet(address: string): Promise<WalletStatus | null>;

  /** REST `GET /api/pnl/:address?range=`: daily cumulative PnL for the Portfolio chart. */
  getPnlHistory(address: string, range: "7d" | "30d" | "max"): Promise<PnlPoint[]>;

  close(): void;
}
