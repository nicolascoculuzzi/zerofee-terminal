/**
 * Any mint by address over the protocol: GET /api/tokens/:mint resolves a coin the server never saw (200 with the
 * summary, "backfilling" history and its trade context), answers 400 / 404-with-a-reason, and a token:<mint>
 * subscription for an unknown coin gets a null snapshot, then the full summary as a delta once it is resolved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TokenNotFoundBody, TokenResponse } from "@zerofee/protocol";
import mainSnap from "../../../packages/core/test/fixtures/mainnet-accounts.json";
import metaSnap from "../../../packages/core/test/fixtures/metadata-accounts.json";
import raySnap from "../../../packages/core/test/fixtures/raydium-mainnet.json";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { setLogLevel } from "../src/log";
import { openDb } from "../src/storage/db";
import { RpcClient } from "../src/util/rpc";
import { mockFetch, waitFor } from "./helpers";
import { FakeHistoryReader } from "./historyHelpers";

type Acc = { owner: string; lamports: string; data: string };
const ACCOUNTS: Record<string, Acc> = {
  ...(mainSnap.accounts as Record<string, Acc>),
  ...(raySnap.accounts as Record<string, Acc>),
  ...(metaSnap.accounts as Record<string, Acc>),
};
const RPC_URL = "http://rpc.test";
const rpcMock = mockFetch((url, body) => {
  if (url.startsWith(RPC_URL) && body?.method === "getMultipleAccounts") {
    const addrs = (body.params?.[0] as string[]) ?? [];
    return [
      200,
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 400_000_000 },
          value: addrs.map((a) => (ACCOUNTS[a] ? { owner: ACCOUNTS[a].owner, lamports: 1, data: [ACCOUNTS[a].data, "base64"] } : null)),
        },
      },
    ];
  }
  return [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }];
});

// biome-ignore lint/suspicious/noExplicitAny: loose wire payloads
type Msg = { type: string; topic?: string; seq?: number; data?: any };

let app: App;
let base: string;

beforeAll(() => {
  setLogLevel("error");
  const cfg = loadConfig({
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    RPC_URL,
    LOG_LEVEL: "error",
    RATE_LIMIT_REST_RPS: "1000",
    RATE_LIMIT_REST_BURST: "1000",
    HISTORY_BACKGROUND: "false",
    HISTORY_VIEW_REFRESH_MS: "0",
    RESOLVE_JUPITER_PROBE: "false",
  });
  app = createApp(cfg, {
    source: null,
    db: openDb(":memory:"),
    rpc: new RpcClient({ url: RPC_URL, fetchFn: rpcMock.fn }),
    fetchFn: rpcMock.fn,
    solUsd: null,
    pollers: false,
    historyReader: new FakeHistoryReader(new Map()),
  });
  base = `http://127.0.0.1:${app.gateway.port}`;
});

afterAll(async () => {
  await app.stop();
});

describe("GET /api/tokens/:mint for coins the server never saw", () => {
  test("a migrated pump coin resolves from chain: summary, backfilling history, PumpSwap trade context", async () => {
    const res = await fetch(`${base}/api/tokens/3fr6BBobNvytZQPVLj8o5o7vToBZf7E5tc9zmJvSpump`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenResponse;
    expect(body.token).toMatchObject({ launchpad: "pump", migrated: true, pool: mainSnap.pool });
    expect(body.token.priceSol).toBeGreaterThan(0);
    expect(body.token.history?.state).toBe("backfilling");
    expect(body.tradeContext?.venue).toBe("pumpswap");
  });

  test("malformed: 400; no account: 404 not_a_token; a pool address: 404 with a redirect to its coin", async () => {
    expect((await fetch(`${base}/api/tokens/not-a-mint`)).status).toBe(400);
    expect((await fetch(`${base}/api/tokens/%E0%A4%A`)).status).toBe(400);
    const none = await fetch(`${base}/api/tokens/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`);
    expect(none.status).toBe(404);
    expect((await none.json()) as TokenNotFoundBody).toMatchObject({ code: "not_found", reason: "not_a_token" });
    const pool = await fetch(`${base}/api/tokens/${mainSnap.pool}`);
    expect((await pool.json()) as TokenNotFoundBody).toMatchObject({
      reason: "not_a_token",
      redirect: "3fr6BBobNvytZQPVLj8o5o7vToBZf7E5tc9zmJvSpump",
    });
    const bare = await fetch(`${base}/api/tokens/${metaSnap.legacyMint}`);
    expect((await bare.json()) as TokenNotFoundBody).toMatchObject({ reason: "no_venue" });
  });

  test("token:<mint> for an unknown coin: null snapshot, then the resolved summary and its trade context", async () => {
    const mint = mainSnap.curveMint;
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const msgs: Msg[] = [];
    ws.onmessage = (ev) => msgs.push(JSON.parse(String(ev.data)));
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    ws.send(JSON.stringify({ type: "subscribe", topic: `token:${mint}` }));
    ws.send(JSON.stringify({ type: "subscribe", topic: `tradectx:${mint}` }));
    const snap = await waitFor(() => msgs.find((m) => m.topic === `token:${mint}` && m.type === "snapshot"));
    expect(snap.data).toBeNull();
    const full = await waitFor(() =>
      msgs.find((m) => m.topic === `token:${mint}` && m.type === "delta" && m.data.mint === mint && m.data.launchpad),
    );
    expect(full.data.priceSol).toBeGreaterThan(0);
    expect(full.data.history?.state).toBe("backfilling");
    await waitFor(() => msgs.find((m) => m.topic === `tradectx:${mint}` && m.type === "delta" && m.data?.venue === "pump"));
    expect(app.resolve.pinned(mint)).toBe(true);
    ws.close();
  });
});
