import type { PnlPoint, SearchResults, ServerMessage, Topic, WalletStatus } from "../../protocol";
import type { DataSource, FeedConnectionState, TopicHandler } from "../dataSource";
import type { SimEngine } from "./engine";

/** DataSource backed by the in-browser SimEngine. No network calls. */
export class MockDataSource implements DataSource {
  private state: FeedConnectionState = "connecting";
  private readonly listeners = new Set<(state: FeedConnectionState) => void>();

  constructor(private readonly engine: SimEngine) {
    setTimeout(() => this.setState("live"), 300);
  }

  private setState(state: FeedConnectionState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  subscribe<T extends Topic>(topic: T, handler: TopicHandler<T>): () => void {
    return this.engine.subscribe(topic, handler as unknown as (m: ServerMessage<Topic>) => void);
  }

  getConnectionState(): FeedConnectionState {
    return this.state;
  }

  onConnectionState(listener: (state: FeedConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    await delay(25);
    return this.engine.search(query, limit);
  }

  async setTrackedWallets(addresses: string[]): Promise<void> {
    this.engine.setTrackedWallets(addresses);
  }

  async setTrackedHandles(handles: string[]): Promise<void> {
    this.engine.setTrackedHandles(handles);
  }

  async getWallet(address: string): Promise<WalletStatus | null> {
    await delay(120);
    return this.engine.getWalletStatus(address);
  }

  async getPnlHistory(address: string, range: "7d" | "30d" | "max"): Promise<PnlPoint[]> {
    await delay(80);
    return this.engine.pnlHistory(address, range);
  }

  close(): void {
    this.engine.stop();
    this.setState("offline");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
