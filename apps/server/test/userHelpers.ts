/**
 * Accounts-layer fixtures: the whole server in-process with a PGlite user database, a controllable
 * clock, mocked network, throwaway Ed25519 wallets (never funded, never leave the test) and a
 * minimal cookie-carrying client. PUBLIC_ORIGIN is https://zerofee.test, so the SIWS domain is
 * "zerofee.test" and allowed requests send `Origin: https://zerofee.test`.
 */
import { type Address, getAddressFromPublicKey } from "@solana/kit";
import { createSignInMessage, InMemoryNonceStore } from "@zerofee/auth";
import type { MeResponse, NonceResponse, SourceHealth } from "@zerofee/protocol";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { IngestSink, IngestTx, Source } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import type { OrderServiceOverrides } from "../src/orders";
import { openDb } from "../src/storage/db";
import { createUserLayer, type UserLayer, type UserLayerOverrides } from "../src/user";
import { RpcClient } from "../src/util/rpc";
import { mockFetch, waitFor } from "./helpers";
import { pgliteDb, type TestDb } from "./pgHelpers";

export const ORIGIN = "https://zerofee.test";
export const RPC_URL = "http://rpc.test";

export interface TestSigner {
  address: Address;
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** Throwaway, never-funded Ed25519 key with a non-extractable private half. */
export async function throwawaySigner(): Promise<TestSigner> {
  const kp = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
  return {
    address: await getAddressFromPublicKey(kp.publicKey),
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
    sign: async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new Uint8Array(m))),
  };
}

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export class Clock {
  constructor(public t = Date.now()) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** JSON-RPC mock: simulateTransaction succeeds, account reads return nothing. */
export const rpcMock = () =>
  mockFetch((url, body) => {
    if (url !== RPC_URL) return [404, {}];
    if (body?.method === "simulateTransaction") {
      return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 7 }, value: { err: null, logs: [], unitsConsumed: 1 } } }];
    }
    if (body?.method === "getMultipleAccounts") {
      const n = ((body.params?.[0] as string[]) ?? []).length;
      return [200, { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: new Array(n).fill(null) } }];
    }
    return [200, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not mocked" } }];
  });

export interface UserTestEnv {
  app: App;
  user: UserLayer;
  db: TestDb;
  clock: Clock;
  base: string;
  ws: string;
  close(): Promise<void>;
}

export interface StartOptions extends Omit<UserLayerOverrides, "db" | "now"> {
  env?: Record<string, string>;
  db?: TestDb;
  clock?: Clock;
  /** Ingest source (a fake one to drive market prices). */
  source?: Source | null;
  /** Armed-orders engine seams (fake chain, recording lanes, pinned lookup tables, no timers). */
  orders?: OrderServiceOverrides;
}

/** A fake ingest source: tests push transactions into the market with emit(). */
export class TestSource implements Source {
  readonly name = "test";
  sink: IngestSink | null = null;
  start(sink: IngestSink): void {
    this.sink = sink;
  }
  async stop(): Promise<void> {}
  emit(tx: IngestTx): void {
    this.sink?.tx(tx);
  }
  health(): SourceHealth {
    return { name: this.name, connected: true, reconnects: 0, messages: 0, lastMessageAt: null, slot: null, dropped: 0, notes: [] };
  }
}

export interface OutboundCall {
  url: string;
  host: string;
  headers: Record<string, string>;
  /** Parsed JSON body (Telegram, Discord) or null. */
  json: unknown;
  /** Raw body bytes (Web Push ciphertext). */
  bytes: Uint8Array | null;
}

/**
 * Mock for every outbound alert call: Telegram Bot API, Discord webhooks and push services. `respond`
 * picks the response per call (default: success). Nothing leaves the process.
 */
export function transportMock(respond?: (call: OutboundCall) => Response | undefined) {
  const calls: OutboundCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let bytes: Uint8Array | null = null;
    let json: unknown = null;
    if (init?.body instanceof Uint8Array) bytes = init.body;
    else if (typeof init?.body === "string") {
      try {
        json = JSON.parse(init.body);
      } catch {
        json = null;
      }
    }
    const call: OutboundCall = { url, host: new URL(url).host, headers, json, bytes };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    if (call.host === "api.telegram.org") {
      const method = url.slice(url.lastIndexOf("/") + 1);
      const result =
        method === "getMe" ? { id: 1, is_bot: true, username: "zerofee_test_bot" } : method === "getUpdates" ? [] : { message_id: 1 };
      return Response.json({ ok: true, result });
    }
    if (call.host === "discord.com") return new Response(null, { status: 204 });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  return { fn, calls, of: (host: string) => calls.filter((c) => c.host === host) };
}

export async function startUserApp(o: StartOptions = {}): Promise<UserTestEnv> {
  setLogLevel("error");
  const clock = o.clock ?? new Clock();
  const db = o.db ?? (await pgliteDb());
  const cfg = loadConfig({
    SERVER_PORT: "0",
    DB_PATH: ":memory:",
    RPC_URL,
    LOG_LEVEL: "error",
    PUBLIC_ORIGIN: ORIGIN,
    RATE_LIMIT_REST_RPS: "1000",
    RATE_LIMIT_REST_BURST: "1000",
    RATE_LIMIT_AUTH_PER_MIN: "6000",
    RATE_LIMIT_USER_RPS: "1000",
    RATE_LIMIT_USER_BURST: "1000",
    ...o.env,
  });
  const rpc = rpcMock();
  const user = await createUserLayer(cfg, {
    ...o,
    db: db.db,
    now: clock.now,
    nonceStore: o.nonceStore ?? new InMemoryNonceStore({ now: clock.now }),
    fetchFn: o.fetchFn ?? rpc.fn,
    telegramPolling: o.telegramPolling ?? false,
  });
  const app = createApp(cfg, {
    source: o.source ?? null,
    db: openDb(":memory:"),
    rpc: new RpcClient({ url: RPC_URL, fetchFn: rpc.fn }),
    fetchFn: rpc.fn,
    solUsd: null,
    pollers: false,
    user,
    orders: o.orders,
  });
  await app.orders?.ready;
  const base = `http://127.0.0.1:${app.gateway.port}`;
  return {
    app,
    user,
    db,
    clock,
    base,
    ws: `${base.replace("http", "ws")}/ws`,
    async close() {
      await app.stop();
      if (!o.db) await db.close();
    },
  };
}

/** A browser-ish client: remembers the session cookie and sends our Origin on every request. */
export class Browser {
  cookie: string | null = null;

  constructor(
    readonly env: UserTestEnv,
    readonly origin: string | null = ORIGIN,
  ) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.origin ? { origin: this.origin } : {}),
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    };
  }

  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const r = await fetch(`${this.env.base}${path}`, {
      method,
      headers: this.headers(extra),
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const set = r.headers.get("set-cookie");
    if (set) {
      const [pair] = set.split(";");
      this.cookie = pair?.endsWith("=") ? null : (pair ?? null);
    }
    return r;
  }

  async json<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const r = await this.req(method, path, body);
    return { status: r.status, body: (await r.json()) as T };
  }

  /** Full SIWS round trip with `signer` (a fresh throwaway key by default). */
  async signIn(signer?: TestSigner): Promise<{ signer: TestSigner; me: MeResponse }> {
    const s = signer ?? (await throwawaySigner());
    const nonce = (await (await fetch(`${this.env.base}/api/auth/nonce`)).json()) as NonceResponse;
    const signedMessage = createSignInMessage({ ...nonce.input, address: s.address });
    const r = await this.json<MeResponse>("POST", "/api/auth/signin", {
      account: { address: s.address, publicKey: b64(s.publicKey) },
      signedMessage: b64(signedMessage),
      signature: b64(await s.sign(signedMessage)),
    });
    if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${JSON.stringify(r.body)}`);
    return { signer: s, me: r.body };
  }

  /** Opens /ws with this browser's cookie and Origin. */
  async socket(): Promise<WsClient> {
    return WsClient.connect(this.env.ws, {
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(this.origin ? { origin: this.origin } : {}),
    });
  }
}

export interface WsMsg {
  type: string;
  topic?: string;
  seq?: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests inspect payloads loosely
  data?: any;
  code?: string;
  message?: string;
}

export class WsClient {
  readonly msgs: WsMsg[] = [];
  closed: { code: number; reason: string } | null = null;

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (ev) => this.msgs.push(JSON.parse(String(ev.data)));
    ws.onclose = (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
    };
  }

  static async connect(url: string, headers: Record<string, string> = {}): Promise<WsClient> {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("ws connect failed"));
    });
    return new WsClient(ws);
  }

  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }

  async next(pred: (m: WsMsg) => boolean, timeoutMs = 3_000): Promise<WsMsg> {
    return waitFor(() => this.msgs.find(pred), timeoutMs);
  }

  async waitClosed(timeoutMs = 3_000): Promise<{ code: number; reason: string }> {
    return waitFor(() => this.closed, timeoutMs);
  }
}
