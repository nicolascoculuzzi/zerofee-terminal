/**
 * Alert evaluation.
 *
 * Price and market-cap alerts run on the server from live market state, so they fire with the tab
 * closed. Enabled alerts are indexed by mint in memory; each Pulse flush passes the mints that changed
 * (onTokensChanged) and a periodic sweep re-checks everything (USD values move with SOL/USD even
 * without trades). An alert fires when its condition holds ("above": value >= threshold; "below":
 * value <= threshold), including right after it is created. `once` alerts are then disabled; `rearm`
 * alerts disarm and re-arm only after the value moves back past the threshold by 1% (hysteresis), and
 * never fire more often than their cooldown. Armed state is persisted, so a restart does not re-fire.
 *
 * Hooks for sources wired later (AlertHooks):
 *  - onWalletActivity: the firehose matcher (Phase 6) reports a trade or launch by a wallet in
 *    trackedAddresses(), the deduplicated union of every user's alerting tracked wallets;
 *  - onOrderEvent: the armed-orders engine (Phase 5) reports fills, failures and re-arm needs.
 * Both route to the channels in the user's notification settings.
 */
import type {
  AlertCurrency,
  AlertPriority,
  ChannelKind,
  NotificationPrefs,
  OrderKind,
  OrderStatus,
  TokenSummary,
  TrackedWalletAlerts,
} from "@zerofee/protocol";
import { DEFAULT_USER_SETTINGS } from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import type { AlertRule } from "../db/pg/notify";
import { logger } from "../log";
import { BoundedSet } from "../util/lru";
import { fmtCap, fmtPrice, fmtSol, sanitizeUntrusted, shortAddress } from "./format";
import type { Notification } from "./types";

const log = logger("alerts");

export interface TokenQuote {
  symbol: string;
  priceSol: number;
  priceUsd: number | null;
  mcSol: number;
  mcUsd: number | null;
}

export type QuoteSource = (mint: string) => TokenQuote | null;

export function quoteFromSummary(s: TokenSummary | null): TokenQuote | null {
  return s ? { symbol: s.symbol, priceSol: s.priceSol, priceUsd: s.priceUsd, mcSol: s.mcSol, mcUsd: s.mcUsd } : null;
}

export interface WalletActivity {
  /** The tracked wallet (transaction signer). */
  address: string;
  kind: "buy" | "sell" | "create";
  mint: string;
  symbol?: string;
  /** Trade size in SOL (0 for create). */
  amountSol: number;
  signature: string;
  ts: number;
}

export interface OrderEvent {
  userId: string;
  orderId: string;
  kind: OrderKind;
  status: OrderStatus;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  signature: string | null;
  detail?: string | null;
}

/** Entry points for alert sources that arrive in later phases. */
export interface AlertHooks {
  onWalletActivity(ev: WalletActivity): void;
  onOrderEvent(ev: OrderEvent): void;
}

interface TrackedEntry {
  userId: string;
  label: string;
  emoji: string;
  alerts: TrackedWalletAlerts;
}

export interface AlertEngineOptions {
  store: UserStore;
  notify: (n: Notification) => void;
  /** PUBLIC_ORIGIN: links in alerts point at the app's own pages. */
  appUrl: string;
  now?: () => number;
  /** Re-arm band for `rearm` alerts (default 0.01 = 1%). */
  hysteresis?: number;
}

const ORDER_LABEL: Record<OrderKind, string> = {
  limit: "Limit order",
  take_profit: "Take profit",
  stop_loss: "Stop loss",
  trailing_stop: "Trailing stop",
  migration: "Migration order",
};

export class AlertEngine implements AlertHooks {
  private readonly now: () => number;
  private readonly h: number;
  private quotes: QuoteSource = () => null;
  private readonly rules = new Map<string, AlertRule>();
  private readonly byMint = new Map<string, Set<string>>();
  private readonly tracked = new Map<string, TrackedEntry[]>();
  private readonly prefs = new Map<string, NotificationPrefs>();
  private readonly seen = new BoundedSet<string>(20_000);
  readonly stats = { evaluations: 0, fired: 0, walletAlerts: 0, orderAlerts: 0 };

  constructor(private readonly o: AlertEngineOptions) {
    this.now = o.now ?? Date.now;
    this.h = o.hysteresis ?? 0.01;
  }

  attachQuotes(q: QuoteSource): void {
    this.quotes = q;
  }

  /** Loads every enabled alert and the tracked-wallet index (start-up). */
  async load(): Promise<void> {
    for (const r of await this.o.store.notify.listEnabledAlerts()) this.index(r);
    this.tracked.clear();
    for (const w of await this.o.store.tracked.listAlerting()) this.addTracked(w.address, w);
    log.info(
      `alerts: ${this.rules.size} price/market-cap alerts on ${this.byMint.size} tokens, ${this.tracked.size} tracked wallets with alerts`,
    );
  }

  private index(r: AlertRule): void {
    this.rules.set(r.id, r);
    const set = this.byMint.get(r.params.mint) ?? new Set();
    set.add(r.id);
    this.byMint.set(r.params.mint, set);
  }

  /** Adds or replaces an alert after a REST change; disabled alerts leave the index. */
  upsert(r: AlertRule): void {
    this.remove(r.id);
    if (r.enabled) {
      this.index(r);
      const q = this.quotes(r.params.mint);
      if (q) this.evaluate(r, q, this.now());
    }
  }

  remove(id: string): void {
    const r = this.rules.get(id);
    if (!r) return;
    this.rules.delete(id);
    const set = this.byMint.get(r.params.mint);
    set?.delete(id);
    if (set && !set.size) this.byMint.delete(r.params.mint);
  }

  /** Keeps a token in memory while an alert watches it. */
  watches(mint: string): boolean {
    return this.byMint.has(mint);
  }

  get ruleCount(): number {
    return this.rules.size;
  }

  onTokensChanged(mints: Iterable<string>): void {
    const now = this.now();
    for (const mint of mints) {
      const ids = this.byMint.get(mint);
      if (!ids) continue;
      const q = this.quotes(mint);
      if (!q) continue;
      for (const id of [...ids]) {
        const r = this.rules.get(id);
        if (r) this.evaluate(r, q, now);
      }
    }
  }

  /** Re-checks every alert (USD thresholds move with SOL/USD even when the token is quiet). */
  sweep(): void {
    this.onTokensChanged([...this.byMint.keys()]);
  }

  private metric(r: AlertRule, q: TokenQuote): number | null {
    const usd = r.params.currency === "usd";
    const v = r.type === "price" ? (usd ? q.priceUsd : q.priceSol) : usd ? q.mcUsd : q.mcSol;
    return v !== null && Number.isFinite(v) && v > 0 ? v : null;
  }

  private evaluate(r: AlertRule, q: TokenQuote, now: number): void {
    this.stats.evaluations++;
    const v = this.metric(r, q);
    if (v === null) return;
    const { direction, value } = r.params;
    const met = direction === "above" ? v >= value : v <= value;
    if (r.armed) {
      if (!met) return;
      if (r.repeat === "rearm" && r.lastFiredAt !== null && now - r.lastFiredAt < r.cooldownSec * 1000) return;
      this.fire(r, v, q, now);
      return;
    }
    if (r.repeat === "rearm") {
      const cleared = direction === "above" ? v < value * (1 - this.h) : v > value * (1 + this.h);
      if (cleared) {
        r.armed = true;
        void this.o.store.notify.setArmed(r.id, true).catch((e) => log.warn(`re-arm of ${r.id} not saved: ${e}`));
      }
    }
  }

  private fire(r: AlertRule, v: number, q: TokenQuote, now: number): void {
    this.stats.fired++;
    r.armed = false;
    r.lastFiredAt = now;
    r.fireCount++;
    const once = r.repeat === "once";
    if (once) {
      r.enabled = false;
      this.remove(r.id);
    }
    void this.o.store.notify.recordFire(r.id, now, once).catch((e) => log.warn(`firing of ${r.id} not saved: ${e}`));
    const c: AlertCurrency = r.params.currency;
    const sym = sanitizeUntrusted(q.symbol, 16) || shortAddress(r.params.mint);
    const what = r.type === "price" ? "" : " market cap";
    const fmt = (x: number) => (r.type === "price" ? fmtPrice(x, c) : fmtCap(x, c));
    const price = c === "usd" ? q.priceUsd : q.priceSol;
    const cap = c === "usd" ? q.mcUsd : q.mcSol;
    const parts = [`${r.type === "price" ? "Price" : "Market cap"} ${fmt(v)}`];
    if (r.type === "price" && cap) parts.push(`MC ${fmtCap(cap, c)}`);
    if (r.type === "market_cap" && price) parts.push(`price ${fmtPrice(price, c)}`);
    if (r.note) parts.push(sanitizeUntrusted(r.note, 200));
    this.o.notify({
      userId: r.userId,
      alertId: r.id,
      source: r.type,
      priority: r.priority,
      title: `${sym}${what} ${r.params.direction} ${fmt(r.params.value)}`,
      body: parts.join(" · "),
      url: `${this.o.appUrl}/token/${r.params.mint}`,
      channels: r.channels,
      tag: `alert:${r.id}`,
      createdAt: now,
    });
  }

  // -------------------------------------------------------------------------------------------
  // tracked wallets and orders
  // -------------------------------------------------------------------------------------------

  private addTracked(address: string, e: TrackedEntry): void {
    const list = this.tracked.get(address) ?? [];
    list.push({ userId: e.userId, label: e.label, emoji: e.emoji, alerts: e.alerts });
    this.tracked.set(address, list);
  }

  /** Rebuilds one user's part of the tracked-wallet index (after REST changes). */
  async reloadTracked(userId: string): Promise<void> {
    for (const [addr, list] of this.tracked) {
      const rest = list.filter((e) => e.userId !== userId);
      if (rest.length) this.tracked.set(addr, rest);
      else this.tracked.delete(addr);
    }
    for (const w of await this.o.store.tracked.listAlerting(userId)) this.addTracked(w.address, w);
  }

  /** Deduplicated union of every user's alerting tracked wallets (the firehose matcher's filter). */
  trackedAddresses(): ReadonlySet<string> {
    return new Set(this.tracked.keys());
  }

  setPrefs(userId: string, prefs: NotificationPrefs): void {
    this.prefs.set(userId, prefs);
  }

  private async prefsOf(userId: string): Promise<NotificationPrefs> {
    const cached = this.prefs.get(userId);
    if (cached) return cached;
    const s = (await this.o.store.prefs.getSettings(userId)) as { notifications?: Partial<NotificationPrefs> } | null;
    const p = { ...DEFAULT_USER_SETTINGS.notifications, ...(s?.notifications ?? {}) };
    this.prefs.set(userId, p);
    if (this.prefs.size > 100_000) this.prefs.clear();
    return p;
  }

  onWalletActivity(ev: WalletActivity): void {
    const entries = this.tracked.get(ev.address);
    if (!entries) return;
    const sym = sanitizeUntrusted(ev.symbol, 16) || shortAddress(ev.mint);
    for (const e of entries) {
      if (!e.alerts[ev.kind]) continue;
      if (ev.kind !== "create" && ev.amountSol < e.alerts.minSol) continue;
      const key = `${e.userId}:${ev.signature}:${ev.address}:${ev.kind}:${ev.mint}`;
      if (!this.seen.add(key)) continue; // the same event twice (duplicate delivery from the feed)
      const who = `${e.emoji ? `${e.emoji} ` : ""}${sanitizeUntrusted(e.label, 32) || shortAddress(ev.address)}`;
      const title =
        ev.kind === "create"
          ? `${who} launched ${sym}`
          : `${who} ${ev.kind === "buy" ? "bought" : "sold"} ${fmtSol(ev.amountSol)} of ${sym}`;
      void this.prefsOf(e.userId)
        .then((p) =>
          this.emit(
            e.userId,
            "wallet",
            "normal",
            title,
            `Wallet ${shortAddress(ev.address)} · tx ${shortAddress(ev.signature)}`,
            `/token/${ev.mint}`,
            p.walletChannels,
            `wallet:${ev.address}`,
          ),
        )
        .catch((err) => log.warn(`wallet alert dropped: ${err}`));
    }
  }

  onOrderEvent(ev: OrderEvent): void {
    const sym = sanitizeUntrusted(ev.symbol, 16) || shortAddress(ev.mint);
    const label = ORDER_LABEL[ev.kind];
    const [verb, priority]: [string, AlertPriority] =
      ev.status === "filled"
        ? ["filled", "high"]
        : ev.status === "failed"
          ? ["failed, re-arm it", "high"]
          : ev.status === "stranded"
            ? ["stranded by an interface change, re-arm it", "high"]
            : ev.status === "triggered" || ev.status === "submitted"
              ? [ev.status, "normal"]
              : [ev.status, "low"];
    const body = [
      ev.side === "buy" ? "Buy" : "Sell",
      ev.signature ? `tx ${shortAddress(ev.signature)}` : null,
      ev.detail ? sanitizeUntrusted(ev.detail, 200) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    void this.prefsOf(ev.userId)
      .then((p) =>
        this.emit(ev.userId, "order", priority, `${label} ${verb}: ${sym}`, body, "/orders", p.orderChannels, `order:${ev.orderId}`),
      )
      .catch((err) => log.warn(`order alert dropped: ${err}`));
  }

  private emit(
    userId: string,
    source: "wallet" | "order",
    priority: AlertPriority,
    title: string,
    body: string,
    path: string,
    channels: ChannelKind[],
    tag: string,
  ): void {
    if (!channels.length) return;
    if (source === "wallet") this.stats.walletAlerts++;
    else this.stats.orderAlerts++;
    this.o.notify({
      userId,
      alertId: null,
      source,
      priority,
      title,
      body,
      url: `${this.o.appUrl}${path}`,
      channels,
      tag,
      createdAt: this.now(),
    });
  }
}
