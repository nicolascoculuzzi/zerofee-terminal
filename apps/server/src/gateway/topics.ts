/**
 * Per-topic sequencing for the snapshot + delta protocol (packages/protocol/src/messages.ts).
 *
 * Every subscriber of a topic sees the same sequence numbers: a snapshot carries the topic's current
 * seq S; each published delta/correction increments it. Topics without subscribers are not published
 * (and do not advance), so a later subscriber's snapshot simply starts from the current number.
 * Publishing goes through Bun's native pub/sub (one serialization, fan-out in uWebSockets).
 */
import type { CorrectionReason } from "@zerofee/protocol";

export class TopicHub {
  private readonly seqs = new Map<string, number>();
  private readonly subs = new Map<string, number>();
  readonly stats = { published: 0, bytes: 0 };

  constructor(private readonly publishRaw: (topic: string, payload: string) => void) {}

  seq(topic: string): number {
    return this.seqs.get(topic) ?? 0;
  }

  hasSubscribers(topic: string): boolean {
    return (this.subs.get(topic) ?? 0) > 0;
  }

  get topicCount(): number {
    return this.subs.size;
  }

  get subscriptionCount(): number {
    let n = 0;
    for (const v of this.subs.values()) n += v;
    return n;
  }

  /** Topics with at least one subscriber whose name starts with `prefix`. */
  *subscribed(prefix: string): Generator<string> {
    for (const t of this.subs.keys()) if (t.startsWith(prefix)) yield t;
  }

  addSubscriber(topic: string): void {
    this.subs.set(topic, (this.subs.get(topic) ?? 0) + 1);
  }

  removeSubscriber(topic: string): void {
    const n = (this.subs.get(topic) ?? 0) - 1;
    if (n <= 0) this.subs.delete(topic);
    else this.subs.set(topic, n);
  }

  /**
   * Serialized snapshot message at the topic's current seq. `wireTopic` is the name the client
   * subscribed to when it differs from the internal pub/sub topic (per-user topics: `orders`).
   */
  snapshot(topic: string, data: unknown, wireTopic: string = topic): string {
    return JSON.stringify({ type: "snapshot", topic: wireTopic, seq: this.seq(topic), data });
  }

  /** Publishes a delta / correction to subscribers; returns false (and does not advance) when nobody listens. */
  publish(topic: string, type: "delta" | "correction", data: unknown, reason?: CorrectionReason, wireTopic: string = topic): boolean {
    if (!this.hasSubscribers(topic)) return false;
    const seq = this.seq(topic) + 1;
    this.seqs.set(topic, seq);
    const t = wireTopic;
    const ts = Date.now();
    const payload = JSON.stringify(type === "correction" ? { type, topic: t, seq, data, reason, ts } : { type, topic: t, seq, data, ts });
    this.stats.published++;
    this.stats.bytes += payload.length;
    this.publishRaw(topic, payload);
    return true;
  }
}
