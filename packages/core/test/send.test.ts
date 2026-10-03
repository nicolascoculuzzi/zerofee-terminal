/** Lane / router tests with a mocked fetch - nothing here touches the network. */
import { describe, expect, test } from "bun:test";
import {
  decodeEventsFromLogs,
  fetchJitoTipAccounts,
  HeliusSenderLane,
  heliusSenderUrl,
  JITO_TIP_ACCOUNTS_FALLBACK,
  JitoLane,
  LatencyTracker,
  lanesForPlan,
  SendDisabledError,
  SubmitRouter,
} from "../src";

interface Captured {
  url: string;
  body: { method: string; params: unknown[] };
  headers: Record<string, string>;
}

function mockFetch(respond: (c: Captured) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(c);
    const r = respond(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

describe("Helius Sender lane", () => {
  test("URLs: SWQoS-only default flag, Max without it, mev-protect, regional HTTP vs global HTTPS", () => {
    expect(heliusSenderUrl({ region: "fra", mode: "swqos" })).toBe("http://fra-sender.helius-rpc.com/fast?swqos_only=true");
    expect(heliusSenderUrl({ region: "fra", mode: "max" })).toBe("http://fra-sender.helius-rpc.com/fast");
    expect(heliusSenderUrl({ region: "global", mode: "swqos", mevProtect: true })).toBe(
      "https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true",
    );
  });

  test("sendTransaction body: base64, skipPreflight true, maxRetries 0", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "SIG" } }));
    const ack = await new HeliusSenderLane({ region: "ams", mode: "swqos", fetchFn: fn }).sendTransaction("AAAA");
    expect(ack).toMatchObject({ ok: true, signature: "SIG", lane: "helius-swqos-ams" });
    expect(calls[0]?.body.method).toBe("sendTransaction");
    expect(calls[0]?.body.params).toEqual(["AAAA", { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  });

  test("errors are reported, never thrown", async () => {
    const { fn } = mockFetch(() => ({ status: 400, body: { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "missing tip" } } }));
    const ack = await new HeliusSenderLane({ region: "fra", mode: "max", fetchFn: fn }).sendTransaction("AAAA");
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("missing tip");
  });
});

describe("Jito lane", () => {
  test("bundleOnly sendTransaction returns the bundle id header; uuid sent as x-jito-auth", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "SIG" }, headers: { "x-bundle-id": "BUNDLE" } }));
    const ack = await new JitoLane({ region: "frankfurt", bundleOnly: true, uuid: "u-1", fetchFn: fn }).sendTransaction("AAAA");
    expect(calls[0]?.url).toBe("https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions?bundleOnly=true");
    expect(calls[0]?.headers["x-jito-auth"]).toBe("u-1");
    expect(calls[0]?.body.params).toEqual(["AAAA", { encoding: "base64" }]);
    expect(ack).toMatchObject({ ok: true, bundleId: "BUNDLE" });
  });

  test("getTipAccounts: live list, or documented fallback on failure", async () => {
    const live = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"] } }));
    expect(await fetchJitoTipAccounts("global", { fetchFn: live.fn })).toMatchObject({
      live: true,
      accounts: ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"],
    });
    const down = mockFetch(() => ({ status: 429, body: { error: { code: 429, message: "rate limited" } } }));
    const r = await fetchJitoTipAccounts("global", { fetchFn: down.fn });
    expect(r.live).toBe(false);
    expect(r.accounts).toEqual([...JITO_TIP_ACCOUNTS_FALLBACK]);
  });
});

describe("router", () => {
  const plan = { heliusMode: "swqos" as const, sendToJito: true, jitoBundleOnly: false };

  test("lanes follow the fee plan", () => {
    expect(lanesForPlan(plan, { heliusRegion: "fra", jitoRegion: "frankfurt" }).map((l) => l.name)).toEqual([
      "helius-swqos-fra",
      "jito-frankfurt",
    ]);
    expect(
      lanesForPlan({ heliusMode: null, sendToJito: true, jitoBundleOnly: true }, { heliusRegion: "fra", jitoRegion: "amsterdam" }).map(
        (l) => l.name,
      ),
    ).toEqual(["jito-bundleOnly-amsterdam"]);
    expect(
      lanesForPlan({ heliusMode: "max", sendToJito: false, jitoBundleOnly: false }, { heliusRegion: "tyo", jitoRegion: "tokyo" }).map(
        (l) => l.name,
      ),
    ).toEqual(["helius-max-tyo"]);
  });

  test("refuses to send unless dryRun is explicitly false", () => {
    const { fn, calls } = mockFetch(() => ({ body: { result: "SIG" } }));
    const lanes = lanesForPlan(plan, { heliusRegion: "fra", jitoRegion: "frankfurt", fetchFn: fn });
    expect(() => new SubmitRouter({ lanes, dryRun: true }).send("AAAA")).toThrow(SendDisabledError);
    expect(() => new SubmitRouter({ lanes, dryRun: undefined as unknown as boolean }).send("AAAA")).toThrow(SendDisabledError);
    expect(calls.length).toBe(0);
  });

  test("fans out identical bytes; first = first successful ack; all = every ack", async () => {
    const { fn, calls } = mockFetch((c) =>
      c.url.includes("helius") ? { status: 500, body: { error: { code: 500, message: "down" } } } : { body: { result: "SIG" } },
    );
    const router = new SubmitRouter({
      lanes: lanesForPlan(plan, { heliusRegion: "fra", jitoRegion: "frankfurt", fetchFn: fn }),
      dryRun: false,
    });
    const { first, all } = router.send("BYTES");
    expect((await first)?.lane).toBe("jito-frankfurt");
    expect((await all).map((a) => a.ok)).toEqual([false, true]);
    expect(calls.every((c) => c.body.params[0] === "BYTES")).toBe(true);
  });
});

describe("latency + events", () => {
  test("tracker records stages, lanes and slot delta", () => {
    const t = new LatencyTracker({ side: "buy", venue: "pump", mint: "M", dryRun: false });
    t.mark("built");
    t.mark("signed");
    t.record.slotAtSend = 100n;
    t.laneAck({ lane: "jito-frankfurt", ok: true, sentAt: performance.now(), ackAt: performance.now() + 5 });
    t.landed(101n);
    expect(Object.keys(t.record.stages)).toEqual(["built", "signed", "landed"]);
    expect(t.record.slotDelta).toBe(1n);
    expect(t.format()).toContain("lane jito-frankfurt: ok");
  });

  test("decodes the TradeEvent emitted by a mainnet sell_v2 simulation", () => {
    const logs = [
      "Program log: Instruction: SellV2",
      "Program data: vdt/007mYe5ykofCEQsmuaYNzEfMZ7Xexfp7Gwm0430/g+wYIix2X83xlgMAAAAAlRkudsEAAAAA+fv3JUs2EGzQxFjZLmjyCFlseEfATUQ8V8v7KbQQw6/nNMFqAAAAAMwoPz0LAAAAQQU9n31eAgDMfBtBBAAAAEFtKlPsXwEAg4R0KS5nWpS0NuywqZiJQjKKg93GIzgClhJnxc1hF8tfAAAAAAAAAOC6CAAAAAAAcbVonkTgp6i5lC0AedHMS9b29E1ReAQkqo7bQo1l204eAAAAAAAAAMDBAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAHNlbGwAAAAAAAAAAAAAAAAAAAAAAIgTAAAAAAAAcF0EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADN8ZYDAAAAAMwoPz0LAAAAzHwbQQQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ];
    const [ev] = decodeEventsFromLogs(logs);
    expect(ev).toMatchObject({
      kind: "pumpTrade",
      isBuy: false,
      tokenAmount: 830_911_420_821n,
      quoteAmount: 60_223_949n,
      fee: 572_128n,
      creatorFee: 180_672n,
      mint: "8iF53SDsUDd3WpcJ1XQcwFxHD36t2RVEBescHU56pump",
    });
  });
});
