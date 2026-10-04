/**
 * Alert delivery. A notification fans out to the user's active targets for its channels (every push
 * subscription, linked Telegram chat and Discord webhook) and lands in one queue per target. A ticker
 * drains the queues under token-bucket rate limits:
 *
 *   Telegram   1 msg/s per chat (burst 1), 30 msg/s for the whole bot
 *   Discord    30 msg/min per webhook (burst 5), 25 msg/s overall
 *   Web Push   1 msg/s per subscription (burst 5), 100 msg/s overall
 *
 * Priority classes: `high` (order fills, urgent price alerts) is sent alone, ahead of everything else;
 * `normal` goes out on the next tick (100 ms) when the target has capacity; normal alerts that arrive
 * together, or pile up while the target is rate limited, go out as one digest (any held low alerts ride
 * along); `low` is otherwise held and digested at most once per `notifications.digestSeconds`
 * (default 60 s). A digest carries up to 20 alerts.
 *
 * Failures: 429 pauses the target (or the whole channel kind for a bot-wide limit) for retry_after
 * without counting an attempt; network errors and 5xx retry with backoff (1 s, 5 s, 20 s), three
 * attempts; permanent errors (webhook deleted, bot blocked, subscription expired) disable or delete the
 * target. Alerts older than an hour are dropped rather than delivered late. Every outcome is written to
 * alert_deliveries in batches.
 */
import type { AlertPriority, ChannelKind } from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import type { DeliveryTarget, DeliveryWrite } from "../db/pg/notify";
import { logger } from "../log";
import type { DiscordTransport } from "./discord";
import type { PushTransport } from "./push";
import { discordAad, type SecretBox } from "./secretBox";
import type { TelegramTransport } from "./telegram";
import type { Notification, OutboundMessage, ResolvedTarget, SendResult } from "./types";

const log = logger("alerts");

export interface RateSpec {
  perSec: number;
  burst: number;
}

export interface DispatcherLimits {
  telegramPerChat: RateSpec;
  telegramGlobal: RateSpec;
  discordPerWebhook: RateSpec;
  discordGlobal: RateSpec;
  pushPerSubscription: RateSpec;
  pushGlobal: RateSpec;
  /** Per-target queue length; beyond it the oldest lowest-priority alert is dropped. */
  queueMax: number;
  /** Alerts per digest message. */
  maxDigest: number;
  /** Delivery attempts for network / server errors. */
  maxAttempts: number;
  /** Concurrent sends. */
  maxInflight: number;
  /** Undelivered alerts older than this are dropped. */
  maxAgeMs: number;
}

export const DEFAULT_LIMITS: DispatcherLimits = {
  telegramPerChat: { perSec: 1, burst: 1 },
  telegramGlobal: { perSec: 30, burst: 30 },
  discordPerWebhook: { perSec: 0.5, burst: 5 },
  discordGlobal: { perSec: 25, burst: 25 },
  pushPerSubscription: { perSec: 1, burst: 5 },
  pushGlobal: { perSec: 100, burst: 100 },
  queueMax: 50,
  maxDigest: 20,
  maxAttempts: 3,
  maxInflight: 32,
  maxAgeMs: 3_600_000,
};

const BACKOFF_MS = [1_000, 5_000, 20_000];
const RANK: Record<AlertPriority, number> = { high: 2, normal: 1, low: 0 };
const TARGET_CACHE_MS = 30_000;
const DEFAULT_DIGEST_MS = 60_000;

class Bucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly spec: RateSpec,
    now: number,
  ) {
    this.tokens = spec.burst;
    this.last = now;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.spec.burst, this.tokens + (Math.max(0, now - this.last) / 1000) * this.spec.perSec);
    this.last = Math.max(this.last, now);
  }

  ready(now: number): boolean {
    this.refill(now);
    return this.tokens >= 1;
  }

  take(now: number): void {
    this.refill(now);
    this.tokens -= 1;
  }

  /** ms until the next token. */
  waitMs(now: number): number {
    this.refill(now);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.spec.perSec) * 1000);
  }
}

interface Item {
  n: Notification;
  attempts: number;
  queuedAt: number;
}

interface Queue {
  key: string;
  userId: string;
  target: DeliveryTarget;
  /** Decrypted / ready-to-send form, filled on first use. */
  resolved: ResolvedTarget | null;
  items: Item[];
  pausedUntil: number;
  inflight: boolean;
  lastActive: number;
}

export interface Transports {
  push?: PushTransport | null;
  telegram?: TelegramTransport | null;
  discord?: DiscordTransport | null;
}

export interface DispatcherOptions {
  store: UserStore;
  transports: Transports;
  /** Decrypts Discord webhook URLs; without it Discord is unavailable. */
  box: SecretBox | null;
  appUrl: string;
  now?: () => number;
  limits?: Partial<DispatcherLimits>;
  tickMs?: number;
}

export class Dispatcher {
  private readonly now: () => number;
  private readonly limits: DispatcherLimits;
  private readonly queues = new Map<string, Queue>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly kindPausedUntil = new Map<ChannelKind, number>();
  private readonly targetCache = new Map<string, { at: number; targets: DeliveryTarget[] }>();
  private readonly digestMs = new Map<string, number>();
  private readonly lastOkWrite = new Map<string, number>();
  private readonly pending = new Set<Promise<unknown>>();
  private deliveries: DeliveryWrite[] = [];
  private inflight = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  readonly stats = { notified: 0, sent: 0, digests: 0, failed: 0, dropped: 0, retries: 0, noChannel: 0 };

  constructor(private readonly o: DispatcherOptions) {
    this.now = o.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
  }

  /** Channel kinds this server can deliver to. */
  available(kind: ChannelKind): boolean {
    if (kind === "push") return !!this.o.transports.push;
    if (kind === "telegram") return !!this.o.transports.telegram;
    return !!this.o.transports.discord && !!this.o.box;
  }

  start(): void {
    this.timers.push(
      setInterval(() => this.tick(), this.o.tickMs ?? 100),
      setInterval(() => void this.flushDeliveries(), 1_000),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.idle();
    await this.flushDeliveries();
  }

  /** Forget cached targets (channel linked, removed, subscription added). */
  invalidate(userId: string): void {
    this.targetCache.delete(userId);
  }

  setDigestSeconds(userId: string, seconds: number): void {
    this.digestMs.set(userId, seconds * 1000);
  }

  /** Queues a notification for every matching target of its user. */
  notify(n: Notification): void {
    this.stats.notified++;
    const p = this.fanOut(n).catch((e) => log.error(`alert fan-out failed: ${e instanceof Error ? e.message : e}`));
    this.track(p);
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Resolves when nothing is being fanned out or sent (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Queued alerts (all targets). */
  get queued(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.items.length;
    return n;
  }

  private async fanOut(n: Notification): Promise<void> {
    const kinds = n.channels.filter((k) => this.available(k));
    const targets = kinds.length ? (await this.targetsOf(n.userId)).filter((t) => kinds.includes(t.kind)) : [];
    if (!targets.length) {
      this.stats.noChannel++;
      this.deliveries.push({
        userId: n.userId,
        alertId: n.alertId,
        source: n.source,
        channel: n.channels[0] ?? "push",
        targetId: null,
        priority: n.priority,
        status: "dropped",
        title: n.title,
        digestCount: 1,
        error: kinds.length ? "no linked channel of the requested kinds" : "requested channels are not configured on this server",
        createdAt: this.now(),
      });
      return;
    }
    if (!this.digestMs.has(n.userId)) {
      const s = (await this.o.store.prefs.getSettings(n.userId)) as { notifications?: { digestSeconds?: number } } | null;
      this.digestMs.set(n.userId, (s?.notifications?.digestSeconds ?? DEFAULT_DIGEST_MS / 1000) * 1000);
    }
    for (const t of targets) this.enqueue(n.userId, t, n);
  }

  private async targetsOf(userId: string): Promise<DeliveryTarget[]> {
    const c = this.targetCache.get(userId);
    const now = this.now();
    if (c && now - c.at < TARGET_CACHE_MS) return c.targets;
    const targets = await this.o.store.notify.targets(userId, ["push", "telegram", "discord"]);
    this.targetCache.set(userId, { at: now, targets });
    if (this.targetCache.size > 50_000) this.targetCache.clear();
    return targets;
  }

  private queueFor(userId: string, target: DeliveryTarget): Queue {
    const key = `${target.kind}:${target.id}`;
    let q = this.queues.get(key);
    if (!q) {
      q = { key, userId, target, resolved: null, items: [], pausedUntil: 0, inflight: false, lastActive: this.now() };
      this.queues.set(key, q);
    }
    return q;
  }

  private enqueue(userId: string, target: DeliveryTarget, n: Notification): void {
    const now = this.now();
    const q = this.queueFor(userId, target);
    q.items.push({ n, attempts: 0, queuedAt: now });
    q.lastActive = now;
    if (q.items.length > this.limits.queueMax) {
      for (const p of ["low", "normal", "high"] as const) {
        const i = q.items.findIndex((x) => x.n.priority === p);
        if (i >= 0) {
          const [dropped] = q.items.splice(i, 1);
          this.stats.dropped++;
          this.record(q, [dropped as Item], "dropped", "too many queued alerts for this channel", 1);
          break;
        }
      }
    }
  }

  private bucket(key: string, spec: RateSpec, now: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = new Bucket(spec, now);
      this.buckets.set(key, b);
    }
    return b;
  }

  private targetBucket(q: Queue, now: number): Bucket {
    const t = q.target;
    if (t.kind === "telegram") return this.bucket(`tg:${t.chatId}`, this.limits.telegramPerChat, now);
    if (t.kind === "discord") return this.bucket(`dc:${t.id}`, this.limits.discordPerWebhook, now);
    return this.bucket(`push:${t.id}`, this.limits.pushPerSubscription, now);
  }

  private globalBucket(kind: ChannelKind, now: number): Bucket {
    const spec = kind === "telegram" ? this.limits.telegramGlobal : kind === "discord" ? this.limits.discordGlobal : this.limits.pushGlobal;
    return this.bucket(`global:${kind}`, spec, now);
  }

  /** The next message for a queue: a lone high alert, a digest of normal (+ low) alerts, or a due low digest. */
  private pick(q: Queue, now: number): Item[] | null {
    const stale = q.items.filter((i) => now - i.queuedAt > this.limits.maxAgeMs);
    if (stale.length) {
      q.items = q.items.filter((i) => !stale.includes(i));
      this.stats.dropped += stale.length;
      this.record(q, stale, "dropped", "not deliverable within an hour", 1);
    }
    const high = q.items.find((i) => i.n.priority === "high");
    if (high) return [high];
    const normal = q.items.filter((i) => i.n.priority === "normal");
    const low = q.items.filter((i) => i.n.priority === "low");
    if (normal.length) return [...normal, ...low].slice(0, this.limits.maxDigest);
    const digestMs = this.digestMs.get(q.userId) ?? DEFAULT_DIGEST_MS;
    if (low[0] && now - low[0].queuedAt >= digestMs) return low.slice(0, this.limits.maxDigest);
    return null;
  }

  /** Drains what the rate limits allow right now. Called by the ticker; tests call it with a fake clock. */
  tick(now = this.now()): void {
    if (!this.queues.size) return;
    const head = (q: Queue) => Math.max(-1, ...q.items.map((i) => RANK[i.n.priority]));
    const order = [...this.queues.values()].sort((a, b) => head(b) - head(a));
    for (const q of order) {
      if (this.inflight >= this.limits.maxInflight) break;
      if (q.inflight || !q.items.length || now < q.pausedUntil || now < (this.kindPausedUntil.get(q.target.kind) ?? 0)) continue;
      const batch = this.pick(q, now);
      if (!batch) continue;
      const tb = this.targetBucket(q, now);
      const gb = this.globalBucket(q.target.kind, now);
      if (!tb.ready(now) || !gb.ready(now)) continue;
      tb.take(now);
      gb.take(now);
      q.items = q.items.filter((i) => !batch.includes(i));
      q.inflight = true;
      this.inflight++;
      this.track(
        this.deliver(q, batch, now).finally(() => {
          q.inflight = false;
          this.inflight--;
        }),
      );
    }
    for (const [k, q] of this.queues) if (!q.items.length && !q.inflight && now - q.lastActive > 600_000) this.queues.delete(k);
  }

  private compose(batch: Item[], now: number): OutboundMessage {
    const first = batch[0] as Item;
    if (batch.length === 1) {
      const n = first.n;
      return { title: n.title, body: n.body, url: n.url, priority: n.priority, tag: n.tag, ts: n.createdAt, count: 1 };
    }
    const priority = batch.reduce<AlertPriority>((p, i) => (RANK[i.n.priority] > RANK[p] ? i.n.priority : p), "low");
    return {
      title: `${batch.length} alerts`,
      body: batch.map((i) => `- ${i.n.title}`).join("\n"),
      url: batch.find((i) => i.n.url)?.n.url ?? this.o.appUrl,
      priority,
      tag: "digest",
      ts: now,
      count: batch.length,
    };
  }

  private async resolve(q: Queue): Promise<ResolvedTarget | null> {
    if (q.resolved) return q.resolved;
    const t = q.target;
    if (t.kind !== "discord") q.resolved = t;
    else {
      if (!this.o.box) return null;
      try {
        q.resolved = { kind: "discord", id: t.id, url: await this.o.box.open(t.webhookEnc, discordAad(t.id, q.userId)) };
      } catch {
        return null;
      }
    }
    return q.resolved;
  }

  private async send(q: Queue, msg: OutboundMessage): Promise<SendResult> {
    const target = await this.resolve(q);
    if (!target) return { ok: false, error: "cannot decrypt the webhook (CHANNEL_ENCRYPTION_KEY changed?)", permanent: true };
    const tr = this.o.transports;
    try {
      if (target.kind === "push" && tr.push) return await tr.push.send(target, msg);
      if (target.kind === "telegram" && tr.telegram) return await tr.telegram.send(target, msg);
      if (target.kind === "discord" && tr.discord) return await tr.discord.send(target, msg);
      return { ok: false, error: `${target.kind} is not configured on this server` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async deliver(q: Queue, batch: Item[], startedAt: number): Promise<void> {
    const result = await this.send(q, this.compose(batch, startedAt));
    const now = this.now();
    q.lastActive = now;
    if (result.ok) {
      this.stats.sent++;
      if (batch.length > 1) this.stats.digests++;
      this.record(q, batch, "sent", null, batch.length);
      this.markOk(q, now);
      return;
    }
    if (result.permanent) {
      const rest = q.items.splice(0);
      this.stats.failed += batch.length + rest.length;
      this.record(q, [...batch, ...rest], "failed", result.error, batch.length);
      this.queues.delete(q.key);
      this.invalidate(q.userId);
      await this.disable(q, result.error).catch((e) => log.warn(`could not disable a dead target: ${e instanceof Error ? e.message : e}`));
      return;
    }
    if (result.retryAfterMs !== undefined) {
      // Rate limited: not the message's fault, so no attempt is counted.
      if (result.global) this.kindPausedUntil.set(q.target.kind, now + result.retryAfterMs);
      q.pausedUntil = now + result.retryAfterMs;
      q.items.unshift(...batch);
      this.stats.retries += batch.length;
      return;
    }
    for (const i of batch) i.attempts++;
    const failed = batch.filter((i) => i.attempts >= this.limits.maxAttempts);
    const retry = batch.filter((i) => i.attempts < this.limits.maxAttempts);
    if (failed.length) {
      this.stats.failed += failed.length;
      this.record(q, failed, "failed", result.error, batch.length);
    }
    if (retry.length) {
      q.items.unshift(...retry);
      this.stats.retries += retry.length;
      q.pausedUntil = now + (BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, (retry[0]?.attempts ?? 1) - 1)] ?? 1_000);
    }
    if (q.target.kind !== "push") void this.o.store.notify.channelFailed(q.target.id, result.error, false, now).catch(() => {});
    else void this.o.store.notify.pushFailed(q.target.id).catch(() => {});
  }

  private markOk(q: Queue, now: number): void {
    if (now - (this.lastOkWrite.get(q.key) ?? 0) < 300_000) return;
    this.lastOkWrite.set(q.key, now);
    if (this.lastOkWrite.size > 50_000) this.lastOkWrite.clear();
    const p = q.target.kind === "push" ? this.o.store.notify.pushOk(q.target.id, now) : this.o.store.notify.channelOk(q.target.id);
    void p.catch(() => {});
  }

  private async disable(q: Queue, error: string): Promise<void> {
    if (q.target.kind === "push") await this.o.store.notify.deletePushById(q.target.id);
    else await this.o.store.notify.channelFailed(q.target.id, error, true, this.now());
  }

  private record(q: Queue, items: Item[], status: DeliveryWrite["status"], error: string | null, digestCount: number): void {
    const now = this.now();
    for (const i of items) {
      this.deliveries.push({
        userId: q.userId,
        alertId: i.n.alertId,
        source: i.n.source,
        channel: q.target.kind,
        targetId: q.target.id,
        priority: i.n.priority,
        status,
        title: i.n.title,
        digestCount,
        error,
        createdAt: now,
      });
    }
  }

  async flushDeliveries(): Promise<void> {
    if (!this.deliveries.length) return;
    const rows = this.deliveries;
    this.deliveries = [];
    try {
      for (let i = 0; i < rows.length; i += 500) await this.o.store.notify.recordDeliveries(rows.slice(i, i + 500));
    } catch (e) {
      log.warn(`could not record ${rows.length} deliveries: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Sends a test message to one target right away (still rate limited). */
  async sendTest(userId: string, target: DeliveryTarget): Promise<SendResult> {
    if (!this.available(target.kind)) return { ok: false, error: `${target.kind} is not configured on this server` };
    const now = this.now();
    const q = this.queueFor(userId, target);
    const tb = this.targetBucket(q, now);
    const gb = this.globalBucket(target.kind, now);
    if (!tb.ready(now) || !gb.ready(now))
      return { ok: false, error: "rate limited, try again shortly", retryAfterMs: Math.max(tb.waitMs(now), gb.waitMs(now)) };
    tb.take(now);
    gb.take(now);
    const msg: OutboundMessage = {
      title: "zerofee test alert",
      body: "Alerts you route to this channel will arrive like this.",
      url: this.o.appUrl,
      priority: "normal",
      tag: "test",
      ts: now,
      count: 1,
    };
    const r = await this.send(q, msg);
    const item: Item = {
      n: {
        userId,
        alertId: null,
        source: "test",
        priority: "normal",
        title: msg.title,
        body: msg.body,
        url: msg.url,
        channels: [target.kind],
        tag: "test",
        createdAt: now,
      },
      attempts: 1,
      queuedAt: now,
    };
    this.record(q, [item], r.ok ? "sent" : "failed", r.ok ? null : r.error, 1);
    if (!r.ok && r.permanent) {
      this.queues.delete(q.key);
      this.invalidate(userId);
      await this.disable(q, r.error).catch(() => {});
    }
    return r;
  }
}
