/**
 * The token page's not-found -> resolve flow: a coin the live set doesn't hold is asked from the server
 * (GET /api/tokens/:mint), retried while the answer isn't definitive, and only a 404 with a reason (or a 400)
 * ends in a "missing" state; the socket then delivers the resolved coin (null snapshot, then a full summary).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { setApiFetch } from "../services/live/api";
import { MINT, wireChain, wireToken } from "../services/live/fixtures";
import { LiveDataSource } from "../services/live/LiveDataSource";
import { ManualClock, socketFactory } from "../services/live/testkit";
import { useToken } from "./token";
import { askServer, type ResolveAnswer, resolveLoop } from "./tokenResolve";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => setApiFetch(null));

describe("askServer", () => {
  test("200 -> found; 404 with a reason -> missing (final); 400 -> invalid; 429 / 503 / network -> retry", async () => {
    const answers: Record<string, Response | Error> = {
      found: json(200, { token: wireToken(), tradeContext: null }),
      wallet: json(404, { error: "no account", code: "not_found", reason: "not_a_token" }),
      pool: json(404, { error: "pool", code: "not_found", reason: "not_a_token", redirect: MINT }),
      bare: json(404, { error: "x", code: "not_found", reason: "no_venue" }),
      old: json(404, { error: "unknown token", code: "not_found" }),
      bad: json(400, { error: "invalid mint", code: "bad_request" }),
      busy: json(503, { error: "busy", code: "unavailable", retryAfterSec: 4 }),
      limited: json(429, { error: "slow down", code: "rate_limited" }),
      down: new TypeError("fetch failed"),
    };
    setApiFetch(async (url) => {
      const a = answers[url.split("/").pop() as string] as Response | Error;
      if (a instanceof Error) throw a;
      return a.clone();
    });
    expect((await askServer("found", 0)).kind).toBe("found");
    expect(await askServer("wallet", 0)).toEqual({ kind: "missing", reason: "not_a_token", redirect: null });
    expect(await askServer("pool", 0)).toEqual({ kind: "missing", reason: "not_a_token", redirect: MINT });
    expect(await askServer("bare", 0)).toEqual({ kind: "missing", reason: "no_venue", redirect: null });
    expect(await askServer("old", 0)).toEqual({ kind: "missing", reason: "not_found", redirect: null });
    expect(await askServer("bad", 0)).toEqual({ kind: "missing", reason: "invalid", redirect: null });
    expect(await askServer("busy", 0)).toEqual({ kind: "retry", afterMs: 4_000 });
    expect(await askServer("limited", 2)).toEqual({ kind: "retry", afterMs: 5_000 });
    expect((await askServer("down", 0)).kind).toBe("retry");
  });
});

describe("resolveLoop", () => {
  test("retries until a definitive answer, then reports it once", async () => {
    const script: ResolveAnswer[] = [
      { kind: "retry", afterMs: 10 },
      { kind: "retry", afterMs: 20 },
      { kind: "missing", reason: "no_venue", redirect: null },
    ];
    const slept: number[] = [];
    const done: ResolveAnswer[] = [];
    await resolveLoop(MINT, {
      ask: async () => script.shift() as ResolveAnswer,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onDone: (a) => done.push(a),
      signal: new AbortController().signal,
    });
    expect(slept).toEqual([10, 20]);
    expect(done).toEqual([{ kind: "missing", reason: "no_venue", redirect: null }]);
  });

  test("stops without an answer when the page goes away", async () => {
    const stop = new AbortController();
    const done: ResolveAnswer[] = [];
    let asks = 0;
    await resolveLoop(MINT, {
      ask: async () => {
        asks++;
        if (asks === 2) stop.abort();
        return { kind: "retry", afterMs: 1 };
      },
      sleep: async () => {},
      onDone: (a) => done.push(a),
      signal: stop.signal,
    });
    expect(asks).toBe(2);
    expect(done).toEqual([]);
  });
});

describe("token state", () => {
  test("loading -> resolving -> missing(reason) only; a detail ends the wait", () => {
    const s = useToken.getState();
    s.reset(MINT);
    expect(useToken.getState().status).toBe("loading");
    useToken.getState().setResolving();
    expect(useToken.getState().status).toBe("resolving");
    useToken.getState().setMissing("not_a_token", MINT);
    expect(useToken.getState()).toMatchObject({ status: "missing", missingReason: "not_a_token", redirect: MINT });
    useToken.getState().reset(MINT);
    expect(useToken.getState()).toMatchObject({ status: "loading", missingReason: null, redirect: null });
    useToken.getState().reset(null);
  });

  test("the socket delivers a coin resolved after its subscription: null snapshot, then a full summary", () => {
    setApiFetch(async () => json(404, { error: "x", code: "not_found" }));
    const f = socketFactory();
    const ds = new LiveDataSource({
      socket: { url: "ws://gw.test/ws", createSocket: f.create, clock: new ManualClock(), random: () => 1 },
      healthPollMs: 0,
    });
    try {
      const s = f.last();
      s.open();
      s.snapshot("chain", 1, wireChain());
      const got: { type: string; data: unknown }[] = [];
      const off = ds.subscribe(`token:${MINT}`, (m) => got.push(m));
      s.snapshot(`token:${MINT}`, 1, null);
      s.snapshot(`tradectx:${MINT}`, 1, null);
      expect(got).toHaveLength(0); // nothing to show yet: the page keeps its skeleton
      s.delta(`token:${MINT}`, 2, wireToken({ history: { state: "backfilling" } as never }));
      expect(got[0]?.type).toBe("snapshot");
      expect(got[0]?.data).toMatchObject({ summary: { mint: MINT, historyState: "backfilling" } });
      off();
    } finally {
      ds.close();
    }
  });
});
