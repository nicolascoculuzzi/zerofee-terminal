/** Fixtures for the wallet tracker / copy-trading suites: a recording topic hub, trades and token views. */
import type { CorrectionReason, Trade } from "@zerofee/protocol";
import { loadConfig } from "../src/config";
import type { TokenView } from "../src/trackers/copy";
import type { Publisher } from "../src/trackers/feed";
import type { BalanceView } from "../src/trackers/positions";

export interface Published {
  topic: string;
  type: "delta" | "correction";
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect payloads loosely
  data: any;
  reason?: CorrectionReason;
  wire?: string;
}

/** TopicHub stand-in: only subscribed topics receive (and record) publishes, like the real hub. */
export class FakeHub implements Publisher {
  readonly subs = new Set<string>();
  readonly msgs: Published[] = [];

  hasSubscribers(topic: string): boolean {
    return this.subs.has(topic);
  }

  publish(topic: string, type: "delta" | "correction", data: unknown, reason?: CorrectionReason, wire?: string): boolean {
    if (!this.subs.has(topic)) return false;
    this.msgs.push({ topic, type, data, reason, wire });
    return true;
  }

  of(topic: string): Published[] {
    return this.msgs.filter((m) => m.topic === topic);
  }

  // biome-ignore lint/suspicious/noExplicitAny: tests inspect payloads loosely
  signals(topic: string): any[] {
    return this.of(topic).flatMap((m) => m.data.signals ?? []);
  }

  // biome-ignore lint/suspicious/noExplicitAny: tests inspect payloads loosely
  rows(topic: string): any[] {
    return this.of(topic).flatMap((m) => m.data.rows ?? []);
  }

  clear(): void {
    this.msgs.length = 0;
  }
}

/** The trackers' config block with test-friendly overrides. */
export function trackerConfig(env: Record<string, string> = {}) {
  return loadConfig({ LOG_LEVEL: "error", ...env }).trackers;
}

let sigN = 0;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A unique, base58-shaped 88-character signature (a fixed-width counter, then filler from `tag`). */
export function sig(tag = "s"): string {
  let n = ++sigN;
  let head = "";
  for (let i = 0; i < 8; i++) {
    head = B58[n % 58] + head;
    n = Math.floor(n / 58);
  }
  const fill = (tag.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "") || "x").repeat(88);
  return `5${head}${fill}`.slice(0, 88);
}

export interface TradeOpts extends Partial<Trade> {
  side: "buy" | "sell";
  mint: string;
  trader: string;
}

/** A Trade as MarketState records it: `amountSol` SOL for `tokens` whole tokens (6 decimals). */
export function mkTrade(o: TradeOpts & { tokens?: number }): Trade {
  const signature = o.signature ?? sig(o.trader);
  const amountSol = o.amountSol ?? 1;
  const tokens = o.tokens ?? 30_000_000;
  return {
    id: `${signature}:0`,
    signature,
    slot: o.slot ?? 1_000,
    txIndex: null,
    venue: "pump",
    quoteAmount: String(Math.round(amountSol * 1e9)),
    tokenAmount: o.tokenAmount ?? String(BigInt(Math.round(tokens)) * 1_000_000n),
    amountSol,
    amountUsd: o.amountUsd ?? null,
    priceSol: o.priceSol ?? amountSol / tokens,
    mcSol: o.mcSol ?? (amountSol / tokens) * 1e9,
    blockTime: o.blockTime ?? 1_791_000_000_000,
    receivedAt: o.receivedAt ?? 1_791_000_000_500,
    tags: o.tags ?? [],
    ...o,
  };
}

export const noBalance: BalanceView = { before: null, after: null, source: null };

/** A tradable curve token: price 1/30M SOL (the default mkTrade fill), 40 SOL MC, 10 SOL liquidity, 60 s old. */
export function tokenView(mint: string, now: number, o: Partial<TokenView> = {}): TokenView {
  return {
    mint,
    symbol: "COPY",
    decimals: 6,
    venue: "pump",
    priceSol: 1 / 30_000_000,
    mcSol: 1e9 / 30_000_000,
    mcUsd: (1e9 / 30_000_000) * 150,
    liquiditySol: 10,
    liquidityUsd: 1_500,
    createdAt: now - 60_000,
    creator: "Dev1111111111111111111111111111111111111111",
    onCurve: true,
    curveComplete: false,
    dangerous: false,
    ...o,
  };
}
