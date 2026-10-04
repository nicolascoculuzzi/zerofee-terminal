import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Candle, Topic } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";

/**
 * Data for the wide+ card mini chart (DESIGN.md 4.4): 1-minute closes over the last 30
 * minutes. History comes from one candles snapshot per token (subscribe, take the snapshot,
 * unsubscribe), the live tail from the Pulse stream. Only tokens a mounted chart asked for are
 * sampled, and each chart re-renders only when its own series changes.
 */

export const SPARK_MINUTES = 30;

interface Spark {
  closes: Map<number, number>;
  seeded: boolean;
  version: number;
}

const sparks = new Map<string, Spark>();
const listeners = new Set<() => void>();
let mounted = 0;
let stopRecorder: (() => void) | null = null;

function notify(): void {
  for (const l of listeners) l();
}

function trim(s: Spark, minute: number): void {
  for (const m of s.closes.keys()) if (m <= minute - SPARK_MINUTES) s.closes.delete(m);
}

function record(mint: string, priceSol: number | null, now: number): boolean {
  const s = sparks.get(mint);
  if (!s || priceSol === null || !(priceSol > 0)) return false;
  const minute = Math.floor(now / 60_000);
  if (s.closes.get(minute) === priceSol) return false;
  s.closes.set(minute, priceSol);
  trim(s, minute);
  s.version++;
  return true;
}

function startRecorder(): () => void {
  return useMarket.subscribe((state, prev) => {
    if (state.tokens === prev.tokens) return;
    const now = Date.now();
    let changed = false;
    for (const mint of sparks.keys()) {
      const t = state.tokens[mint];
      if (t && t !== prev.tokens[mint] && record(mint, t.priceSol, now)) changed = true;
    }
    if (changed) notify();
  });
}

function prune(): void {
  if (sparks.size <= 300) return;
  const tokens = useMarket.getState().tokens;
  for (const mint of sparks.keys()) if (!tokens[mint]) sparks.delete(mint);
}

function seed(mint: string): void {
  if (sparks.has(mint)) return;
  prune();
  const s: Spark = { closes: new Map(), seeded: false, version: 0 };
  sparks.set(mint, s);
  const t = useMarket.getState().tokens[mint];
  if (t) record(mint, t.priceSol, Date.now());
  const topic = `candles:${mint}:1m` as Topic;
  let unsub: (() => void) | null = null;
  let done = false;
  unsub = getServices().data.subscribe(topic, (msg) => {
    if (done || msg.type !== "snapshot") return;
    done = true;
    const candles = (msg.data as { candles: Candle[] }).candles;
    const nowMinute = Math.floor(Date.now() / 60_000);
    for (const c of candles) {
      const minute = Math.floor(c.time / 60);
      // Live samples taken since mounting are newer than the snapshot: keep them.
      if (minute > nowMinute - SPARK_MINUTES && !s.closes.has(minute)) s.closes.set(minute, c.close);
    }
    s.seeded = true;
    s.version++;
    notify();
    queueMicrotask(() => unsub?.());
  });
  if (done) unsub();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 30 values (oldest first), NaN before the first known close; null while nothing is known. */
export function sparkPoints(mint: string, now = Date.now()): number[] | null {
  const s = sparks.get(mint);
  if (!s || s.closes.size === 0) return null;
  const nowMinute = Math.floor(now / 60_000);
  const out: number[] = [];
  let last = Number.NaN;
  for (let m = nowMinute - SPARK_MINUTES + 1; m <= nowMinute; m++) {
    const v = s.closes.get(m);
    if (v !== undefined) last = v;
    out.push(last);
  }
  return out;
}

export function useSpark(mint: string): number[] | null {
  useEffect(() => {
    mounted++;
    if (!stopRecorder) stopRecorder = startRecorder();
    seed(mint);
    return () => {
      mounted--;
      if (mounted === 0 && stopRecorder) {
        stopRecorder();
        stopRecorder = null;
      }
    };
  }, [mint]);
  const version = useSyncExternalStore(
    subscribe,
    () => sparks.get(mint)?.version ?? -1,
    () => -1,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the series' change signal
  return useMemo(() => sparkPoints(mint), [mint, version]);
}
