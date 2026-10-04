/**
 * Offline tests of the mainnet-fork discovery plumbing (packages/core/scripts/fork/accounts.ts): JSON-RPC
 * batches over the read-only allowlist, rate-limit handling, slot spreading and the transaction scan (v1
 * transactions included). No network: fetch and the RPC client are fakes.
 */
import { describe, expect, test } from "bun:test";
import { address } from "@solana/kit";
import {
  type BatchCall,
  type BatchItem,
  createReadOnlyBatch,
  describeStats,
  fetchedCount,
  isTransientRpcError,
  newDiscoveryStats,
  type ReadOnlyBatch,
  type ReadOnlyRpc,
  scanProgram,
  spreadAcrossSlots,
} from "../scripts/fork/accounts";

const URL_ = "http://discovery.test/rpc";
const PROGRAM = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

function fakeFetch(handler: (body: unknown, n: number) => Response): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return handler(body, bodies.length);
  }) as typeof fetch;
  return { fetch: f, bodies };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

describe("read-only JSON-RPC batches", () => {
  test("several calls in one POST, answers matched by id whatever their order", async () => {
    const { fetch, bodies } = fakeFetch((body) =>
      json(
        (body as { id: number; params: unknown[] }[])
          .map((c) => ({ jsonrpc: "2.0", id: c.id, result: `tx-${String(c.params[0])}` }))
          .reverse(),
      ),
    );
    const batch = createReadOnlyBatch(URL_, fetch);
    const calls: BatchCall[] = ["a", "b", "c"].map((s) => ({ method: "getTransaction", params: [s] }));
    expect(await batch<string>(calls)).toEqual([
      { ok: true, value: "tx-a" },
      { ok: true, value: "tx-b" },
      { ok: true, value: "tx-c" },
    ]);
    expect(bodies).toHaveLength(1);
    expect(Array.isArray(bodies[0])).toBe(true);
  });

  test("per-call errors: rate limits are transient, version / not-found errors are not", async () => {
    const { fetch } = fakeFetch(() =>
      json([
        { jsonrpc: "2.0", id: 0, error: { code: 429, message: "Too many requests for a specific RPC call" } },
        { jsonrpc: "2.0", id: 1, error: { code: -32015, message: "Transaction version (2) is not supported by the requesting client" } },
        { jsonrpc: "2.0", id: 2, result: null },
      ]),
    );
    const items = await createReadOnlyBatch(
      URL_,
      fetch,
    )<unknown>([
      { method: "getTransaction", params: ["a"] },
      { method: "getTransaction", params: ["b"] },
      { method: "getTransaction", params: ["c"] },
    ]);
    expect(items.map((i) => (i.ok ? "ok" : i.transient ? "transient" : "failed"))).toEqual(["transient", "failed", "ok"]);
    expect(isTransientRpcError({ code: -32005, message: "Node is behind by 42 slots" })).toBe(true);
    expect(isTransientRpcError({ code: -32602, message: "Invalid param" })).toBe(false);
  });

  test("HTTP 429 is retried after Retry-After; an endpoint without batches gets one call per request", async () => {
    const { fetch, bodies } = fakeFetch((body, n) => {
      if (n === 1) return json({ error: "rate limited" }, 429, { "retry-after": "0.01" });
      if (Array.isArray(body)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are disabled" } });
      const c = body as { id: number; params: unknown[] };
      return json({ jsonrpc: "2.0", id: c.id, result: c.params[0] });
    });
    const batch = createReadOnlyBatch(URL_, fetch);
    const calls = [
      { method: "getTransaction", params: ["x"] },
      { method: "getTransaction", params: ["y"] },
    ];
    expect(await batch<string>(calls)).toEqual([
      { ok: true, value: "x" },
      { ok: true, value: "y" },
    ]);
    expect(bodies.map((b) => (Array.isArray(b) ? "batch" : "single"))).toEqual(["batch", "batch", "single", "single"]);
    // Batching stays off for this endpoint.
    expect(await batch<string>(calls)).toHaveLength(2);
    expect(bodies.slice(4).every((b) => !Array.isArray(b))).toBe(true);
  });

  test("anything but a read is refused before it is sent", async () => {
    const { fetch, bodies } = fakeFetch(() => json([]));
    const batch = createReadOnlyBatch(URL_, fetch);
    await expect(batch([{ method: "sendTransaction", params: ["AAAA"] }])).rejects.toThrow("read-only");
    await expect(batch([{ method: "requestAirdrop", params: [] }])).rejects.toThrow("read-only");
    expect(bodies).toHaveLength(0);
  });
});

describe("transaction scan", () => {
  test("spreadAcrossSlots: newest slot first, round-robin, at most perSlot per slot", () => {
    const refs = [
      { s: "a1", slot: 9n },
      { s: "a2", slot: 9n },
      { s: "a3", slot: 9n },
      { s: "b1", slot: 8n },
      { s: "c1", slot: 7n },
      { s: "c2", slot: 7n },
    ];
    expect(spreadAcrossSlots(refs, 2).map((r) => r.s)).toEqual(["a1", "b1", "c1", "a2", "c2"]);
    expect(spreadAcrossSlots(refs, 1).map((r) => r.s)).toEqual(["a1", "b1", "c1"]);
  });

  /** Fake RPC: pages of signatures (newest first), `before` honored. */
  function fakeRpc(sigs: { signature: string; slot: bigint; err?: unknown }[]): { rpc: ReadOnlyRpc; pages: number } {
    const state = { pages: 0 };
    const rpc = {
      getSignaturesForAddress: (_p: unknown, o: { limit: number; before?: string }) => ({
        send: async () => {
          state.pages++;
          const start = o.before ? sigs.findIndex((x) => x.signature === o.before) + 1 : 0;
          return sigs.slice(start, start + o.limit).map((x) => ({ ...x, err: x.err ?? null }));
        },
      }),
    } as unknown as ReadOnlyRpc;
    return {
      rpc,
      get pages() {
        return state.pages;
      },
    };
  }

  const budget = { maxTxs: 10, pages: 3, pageSize: 4, batchSize: 3, perSlot: 2, deadline: Date.now() + 60_000 };

  test("asks for v1, decodes v0 / v1 / legacy, skips failed transactions, retries a throttled one once, stops when told", async () => {
    const sigs = Array.from({ length: 8 }, (_v, i) => ({
      signature: `s${i}`,
      slot: 100n - BigInt(i),
      err: i === 2 ? { x: 1 } : undefined,
    }));
    const f = fakeRpc(sigs);
    const asked: unknown[] = [];
    const throttledOnce = new Set<string>();
    const batch: ReadOnlyBatch = async <T>(calls: readonly BatchCall[]) => {
      asked.push(...calls.map((c) => c.params[1]));
      return calls.map((c) => {
        const sig = String(c.params[0]);
        if (sig === "s1" && !throttledOnce.has(sig)) {
          throttledOnce.add(sig);
          return { ok: false, transient: true, message: "429" };
        }
        if (sig === "s4") return { ok: false, transient: false, message: "version 2" };
        const version = sig === "s3" ? 1 : sig === "s5" ? "legacy" : 0;
        return { ok: true, value: { version, meta: { err: sig === "s6" ? { e: 1 } : null, logMessages: [`log ${sig}`] } } as T };
      }) as BatchItem<T>[];
    };
    const stats = newDiscoveryStats();
    const decoded: string[] = [];
    const stopped = await scanProgram(f.rpc, batch, PROGRAM, budget, new Set(), stats, async () => {
      decoded.push("x");
      return false;
    });
    expect(stopped).toBe(false);
    expect(asked.every((o) => (o as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion === 1)).toBe(true);
    // s2 failed on chain (skipped before fetching), s4 unreadable, s6 failed: s0 s1 s3 s5 s7 decoded.
    expect(fetchedCount(stats)).toBe(5);
    expect(stats.fetched).toEqual({ "0": 3, "1": 1, legacy: 1 });
    expect(stats).toMatchObject({ signatures: 7, throttled: 1, failed: 1 });
    expect(stats.slots.size).toBe(7);
    expect(describeStats(stats)).toBe("5 transactions (3 v0, 1 v1, 1 legacy) from 7 signatures across 7 slots, 1 throttled, 1 unreadable");

    // Seen signatures are not fetched again; a positive answer stops the scan.
    const again = newDiscoveryStats();
    const seen = new Set(["s0", "s1"]);
    let calls = 0;
    expect(
      await scanProgram(f.rpc, batch, PROGRAM, budget, seen, again, async () => {
        calls++;
        return calls === 2;
      }),
    ).toBe(true);
    expect(fetchedCount(again)).toBe(2);
  });

  test("an endpoint that keeps refusing ends the scan (the caller backs off) instead of throwing", async () => {
    const f = fakeRpc([{ signature: "a", slot: 1n }]);
    const stats = newDiscoveryStats();
    const refusing: ReadOnlyBatch = async () => {
      throw new Error("HTTP 429 8 times");
    };
    expect(await scanProgram(f.rpc, refusing, PROGRAM, budget, new Set(), stats, async () => true)).toBe(false);
    expect(stats.throttled).toBe(1);
  });

  test("the deadline stops the scan before any fetch", async () => {
    const f = fakeRpc([{ signature: "a", slot: 1n }]);
    const stats = newDiscoveryStats();
    let fetched = 0;
    const batch: ReadOnlyBatch = async () => {
      fetched++;
      return [];
    };
    await scanProgram(f.rpc, batch, PROGRAM, { ...budget, deadline: Date.now() - 1 }, new Set(), stats, async () => true);
    expect(fetched).toBe(0);
    expect(f.pages).toBe(0);
  });
});
