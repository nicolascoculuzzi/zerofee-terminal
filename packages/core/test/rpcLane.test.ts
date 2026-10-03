/** RpcLane tests with a mocked fetch - nothing here touches the network. */
import { describe, expect, test } from "bun:test";
import { RpcLane, rpcLaneName, SendDisabledError, SubmitRouter } from "../src";

interface Captured {
  url: string;
  body: { method: string; params: unknown[] };
  headers: Record<string, string>;
}

function mockFetch(respond: (c: Captured) => { status?: number; body: unknown }) {
  const calls: Captured[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(c);
    const r = respond(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const KEYED_URL = "https://mainnet.helius-rpc.com/?api-key=SECRET-KEY";

describe("RpcLane", () => {
  test("name carries only the host, never the path or query (API keys)", () => {
    expect(rpcLaneName("http://127.0.0.1:18899")).toBe("rpc-127.0.0.1:18899");
    expect(new RpcLane({ url: KEYED_URL }).name).toBe("rpc-mainnet.helius-rpc.com");
    expect(new RpcLane({ url: "https://rpc.example.com/v2/SECRET-KEY" }).name).toBe("rpc-rpc.example.com");
    expect(new RpcLane({ url: KEYED_URL, name: "my-rpc" }).name).toBe("my-rpc");
  });

  test("rejects non-http URLs at construction", () => {
    expect(() => new RpcLane({ url: "ws://127.0.0.1:18900" })).toThrow("http(s)");
    expect(() => new RpcLane({ url: "not a url" })).toThrow();
  });

  test("sendTransaction body: base64, skipPreflight true, maxRetries 0 by default", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "SIG" } }));
    const ack = await new RpcLane({ url: "http://127.0.0.1:18899", fetchFn: fn }).sendTransaction("AAAA");
    expect(ack).toMatchObject({ ok: true, signature: "SIG", lane: "rpc-127.0.0.1:18899", httpStatus: 200 });
    expect(calls[0]?.url).toBe("http://127.0.0.1:18899");
    expect(calls[0]?.body.method).toBe("sendTransaction");
    expect(calls[0]?.body.params).toEqual(["AAAA", { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  });

  test("optional preflight and custom headers", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "SIG" } }));
    await new RpcLane({
      url: "https://rpc.example.com",
      skipPreflight: false,
      maxRetries: 2,
      headers: { authorization: "Bearer t" },
      fetchFn: fn,
    }).sendTransaction("AAAA");
    expect(calls[0]?.body.params).toEqual([
      "AAAA",
      { encoding: "base64", skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" },
    ]);
    expect(calls[0]?.headers.authorization).toBe("Bearer t");
  });

  test("JSON-RPC and HTTP errors are reported, never thrown", async () => {
    const rpcErr = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Blockhash not found" } } }));
    const a = await new RpcLane({ url: "http://127.0.0.1:18899", fetchFn: rpcErr.fn }).sendTransaction("AAAA");
    expect(a.ok).toBe(false);
    expect(a.error).toBe("-32002: Blockhash not found");

    const http = mockFetch(() => ({ status: 503, body: {} }));
    const b = await new RpcLane({ url: "http://127.0.0.1:18899", fetchFn: http.fn }).sendTransaction("AAAA");
    expect(b).toMatchObject({ ok: false, httpStatus: 503 });
  });

  test("network failures are reported without leaking the keyed URL", async () => {
    const fn = (async (input: string | URL | Request) => {
      throw new Error(`Unable to connect to ${String(input)}`);
    }) as unknown as typeof fetch;
    const ack = await new RpcLane({ url: KEYED_URL, fetchFn: fn }).sendTransaction("AAAA");
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("rpc-mainnet.helius-rpc.com");
    expect(ack.error).not.toContain("SECRET-KEY");
  });

  test("works behind SubmitRouter, which still refuses to send unless dryRun is false", async () => {
    const { fn, calls } = mockFetch(() => ({ body: { jsonrpc: "2.0", id: 1, result: "SIG" } }));
    const lanes = [new RpcLane({ url: "http://127.0.0.1:18899", fetchFn: fn })];
    expect(() => new SubmitRouter({ lanes, dryRun: true }).send("AAAA")).toThrow(SendDisabledError);
    expect(calls.length).toBe(0);
    const { first, all } = new SubmitRouter({ lanes, dryRun: false }).send("BYTES");
    expect((await first)?.lane).toBe("rpc-127.0.0.1:18899");
    expect((await all).map((x) => x.ok)).toEqual([true]);
    expect(calls[0]?.body.params[0]).toBe("BYTES");
  });
});
