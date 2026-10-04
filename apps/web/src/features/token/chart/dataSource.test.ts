import { describe, expect, test } from "bun:test";
import type { Candle } from "../../../protocol";
import {
  BACKFILL_POLL_MS,
  type BarChange,
  ChartFeed,
  type FeedDeps,
  type FeedStatus,
  fromWire,
  type HistoryInfo,
  historyStateOf,
  type OlderPage,
} from "./dataSource";

const c = (time: number, close: number): Candle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volumeSol: 1,
  buys: 0,
  sells: 0,
  solUsd: 120,
});

function harness(pages: OlderPage[] = []) {
  let snap: ((c: Candle[]) => void) | null = null;
  let delta: ((c: Candle[]) => void) | null = null;
  let frame: (() => void) | null = null;
  const timers: { fn: () => void; ms: number }[] = [];
  const fetches: number[] = [];
  let unsubscribed = 0;
  const pending: ((p: OlderPage) => void)[] = [];
  const deps: FeedDeps = {
    subscribe: (_m, _tf, s, d) => {
      snap = s;
      delta = d;
      return () => {
        unsubscribed++;
      };
    },
    fetchOlder: (_m, _tf, before) => {
      fetches.push(before);
      const page = pages.shift();
      if (page) return Promise.resolve(page);
      return new Promise((resolve) => pending.push(resolve));
    },
    frame: (fn) => {
      frame = fn;
      return () => {
        frame = null;
      };
    },
    later: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  };
  const changes: BarChange[] = [];
  const statuses: FeedStatus[] = [];
  const history: HistoryInfo[] = [];
  let bars: readonly Candle[] = [];
  const feed = new ChartFeed(
    "MINT",
    "1s",
    {
      onBars: (b, ch) => {
        bars = b;
        changes.push(ch);
      },
      onStatus: (s) => statuses.push(s),
      onHistory: (h) => history.push(h),
    },
    deps,
    true,
  );
  return {
    feed,
    snapshot: (list: Candle[]) => snap?.(list),
    delta: (list: Candle[]) => delta?.(list),
    runFrame: () => frame?.(),
    timers,
    fetches,
    pending,
    changes,
    statuses,
    history,
    bars: () => bars,
    unsubscribed: () => unsubscribed,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ChartFeed", () => {
  test("snapshot resets, deltas batch per frame into live updates", () => {
    const h = harness();
    h.feed.start();
    expect(h.statuses).toEqual(["loading"]);
    h.delta([c(9, 1)]); // before the snapshot: dropped
    h.snapshot([c(10, 1), c(11, 2)]);
    expect(h.changes).toEqual([{ kind: "reset" }]);
    expect(h.statuses.at(-1)).toBe("ready");
    h.delta([c(11, 3)]);
    h.delta([c(12, 4)]);
    expect(h.changes).toHaveLength(1);
    h.runFrame();
    expect(h.changes.at(-1)).toEqual({ kind: "live", touched: [1, 2] });
    expect(h.bars().map((b) => b.close)).toEqual([1, 3, 4]);
    expect(h.bars()[2]?.open).toBe(3);
  });

  test("a re-snapshot (correction) keeps older pages and the view", async () => {
    const h = harness([{ candles: [c(5, 0.5), c(6, 0.6)], hasMore: false, history: "complete" }]);
    h.feed.start();
    h.snapshot([c(10, 1), c(11, 2)]);
    h.feed.requestOlder();
    await tick();
    expect(h.fetches).toEqual([10]);
    expect(h.changes.at(-1)).toEqual({ kind: "keep" });
    expect(h.bars().map((b) => b.time)).toEqual([5, 6, 10, 11]);
    expect(h.history.at(-1)).toEqual({ loading: false, hasMore: false, state: "complete" });
    h.snapshot([c(10, 1), c(11, 2.5)]);
    expect(h.changes.at(-1)).toEqual({ kind: "keep" });
    expect(h.bars().map((b) => b.time)).toEqual([5, 6, 10, 11]);
    // History exhausted: no more fetches.
    h.feed.requestOlder();
    expect(h.fetches).toHaveLength(1);
  });

  test("one older page at a time", () => {
    const h = harness();
    h.feed.start();
    h.snapshot([c(10, 1)]);
    h.feed.requestOlder();
    h.feed.requestOlder();
    expect(h.fetches).toEqual([10]);
    expect(h.history.at(-1)?.loading).toBe(true);
  });

  test("an empty snapshot looks further back, then reports empty", async () => {
    const h = harness([{ candles: [], hasMore: false, history: "complete" }]);
    h.feed.start();
    h.snapshot([]);
    expect(h.statuses).toEqual(["loading"]);
    expect(h.fetches).toHaveLength(1);
    await tick();
    expect(h.statuses.at(-1)).toBe("empty");
  });

  test("an empty snapshot with history before it shows that history", async () => {
    const h = harness([{ candles: [c(1, 1), c(2, 2)], hasMore: false, history: "complete" }]);
    h.feed.start();
    h.snapshot([]);
    await tick();
    expect(h.statuses.at(-1)).toBe("ready");
    expect(h.bars()).toHaveLength(2);
  });

  test("backfilling re-polls an empty page, then stops on complete", async () => {
    const h = harness([
      { candles: [], hasMore: true, history: "backfilling" },
      { candles: [c(1, 1)], hasMore: false, history: "complete" },
    ]);
    h.feed.start();
    h.snapshot([c(10, 1)]);
    h.feed.requestOlder();
    await tick();
    const poll = h.timers.find((t) => t.ms === BACKFILL_POLL_MS);
    expect(poll).toBeDefined();
    poll?.fn();
    await tick();
    expect(h.fetches).toHaveLength(2);
    expect(h.bars().map((b) => b.time)).toEqual([1, 10]);
    expect(h.history.at(-1)?.state).toBe("complete");
  });

  test("no snapshot in time is an error; stop cleans everything up", () => {
    const h = harness();
    h.feed.start();
    h.timers.find((t) => t.ms === 8000)?.fn();
    expect(h.statuses.at(-1)).toBe("error");
    h.feed.stop();
    h.feed.stop();
    expect(h.unsubscribed()).toBe(1);
    h.snapshot([c(1, 1)]);
    expect(h.changes).toHaveLength(0);
  });

  test("a page that lands after stop is ignored", async () => {
    const h = harness();
    h.feed.start();
    h.snapshot([c(10, 1)]);
    h.feed.requestOlder();
    h.feed.stop();
    h.pending[0]?.({ candles: [c(1, 1)], hasMore: false, history: "complete" });
    await tick();
    expect(h.bars()).toHaveLength(1);
  });
});

describe("wire helpers", () => {
  test("fromWire converts ms to seconds and fills SOL/USD", () => {
    expect(fromWire({ t: 1_791_093_030_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3, n: 2, solUsd: null }, 121)).toMatchObject({
      time: 1_791_093_030,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volumeSol: 3,
      solUsd: 121,
    });
  });
  test("historyStateOf reads either field name", () => {
    expect(historyStateOf({ history: "backfilling" })).toBe("backfilling");
    expect(historyStateOf({ historyState: "partial" })).toBe("partial");
    expect(historyStateOf({ history: "weird" })).toBe("unknown");
    expect(historyStateOf(null)).toBe("unknown");
  });
});
