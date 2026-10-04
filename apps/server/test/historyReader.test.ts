/** RpcHistoryReader on a (mocked) endpoint: pipelined getTransaction within the rate, AIMD and Retry-After on 429. */
import { describe, expect, test } from "bun:test";
import { RpcHistoryReader } from "../src/history/reader";
import { RpcClient } from "../src/util/rpc";

function endpoint(o: { latencyMs: number; limitEvery?: number; retryAfter?: string }) {
  let inFlight = 0;
  let maxInFlight = 0;
  let n = 0;
  const times: number[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    n++;
    times.push(Date.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Bun.sleep(o.latencyMs);
    inFlight--;
    if (o.limitEvery && n % o.limitEvery === 0) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: 429, message: "Too many requests for a specific RPC call" } }),
        {
          status: 429,
          headers: { "retry-after": o.retryAfter ?? "1", "x-ratelimit-method-limit": "10", "x-ratelimit-method-remaining": "0" },
        },
      );
    }
    const one = (b: { id: number; params: unknown[] }) => ({ jsonrpc: "2.0", id: b.id, result: { slot: 1, signature: b.params[0] } });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), {
      status: 200,
      headers: { "x-ratelimit-method-limit": "10", "x-ratelimit-method-remaining": "7" },
    });
  }) as typeof fetch;
  return { fetchFn, stats: () => ({ maxInFlight, calls: n, times }) };
}

const sigs = (k: number) => Array.from({ length: k }, (_v, i) => `sig${i}`);

describe("history reader throughput", () => {
  test("sequential before: one getTransaction in flight; pipelined: `concurrency` in flight within the rate", async () => {
    const seq = endpoint({ latencyMs: 80 });
    const r1 = new RpcHistoryReader({ rpc: new RpcClient({ url: "http://h", fetchFn: seq.fetchFn, maxConcurrent: 8 }), perSec: 50 });
    let t0 = Date.now();
    const a = await r1.transactions(sigs(6));
    const sequentialMs = Date.now() - t0;
    expect(a.map((x) => (x as unknown as { signature: string }).signature)).toEqual(sigs(6));
    expect(seq.stats().maxInFlight).toBe(1);

    const pipe = endpoint({ latencyMs: 80 });
    const rpc = new RpcClient({ url: "http://h", fetchFn: pipe.fetchFn, maxConcurrent: 8 });
    const r2 = new RpcHistoryReader({ rpc, perSec: 50, concurrency: 3 });
    t0 = Date.now();
    const b = await r2.transactions(sigs(6));
    const pipelinedMs = Date.now() - t0;
    expect(b.map((x) => (x as unknown as { signature: string }).signature)).toEqual(sigs(6)); // input order kept
    expect(pipe.stats().maxInFlight).toBe(3);
    expect(pipelinedMs).toBeLessThan(sequentialMs * 0.7);
    expect(rpc.stats.methodLimit).toBe(10);
    expect(rpc.stats.methodRemaining).toBe(7);
  });

  test("the pacer still caps the call rate when pipelined", async () => {
    const e = endpoint({ latencyMs: 5 });
    const r = new RpcHistoryReader({
      rpc: new RpcClient({ url: "http://h", fetchFn: e.fetchFn, maxConcurrent: 8 }),
      perSec: 10,
      concurrency: 4,
    });
    const t0 = Date.now();
    await r.transactions(sigs(6));
    // 1 token up front, then 10/s: >= ~500 ms for 6 calls
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
  });

  test("a 429 halves the rate and holds every call for the endpoint's Retry-After; success wins it back", async () => {
    const e = endpoint({ latencyMs: 2, limitEvery: 3, retryAfter: "1" });
    const rpc = new RpcClient({ url: "http://h", fetchFn: e.fetchFn, maxConcurrent: 4, cooldownMs: 100 });
    const r = new RpcHistoryReader({ rpc, perSec: 20, concurrency: 2 });
    const t0 = Date.now();
    const out = await r.transactions(sigs(4));
    expect(out).toHaveLength(4);
    expect(r.stats.rateLimited).toBeGreaterThanOrEqual(1);
    // Retry-After: 1 s beats the 100 ms configured cooldown
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    const times = e.stats().times;
    const limited = 2; // the 3rd call answered 429 (index 2)
    expect((times[limited + 1] as number) - (times[limited] as number)).toBeGreaterThanOrEqual(900);
    expect(r.stats.rate).toBeLessThanOrEqual(20);
    expect(r.stats.rate).toBeGreaterThan(5);
  });
});
