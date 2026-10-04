#!/usr/bin/env bun
/**
 * Live check of the wallet tracker and copy-trade detection against a running server:
 *   1. signs in with a throwaway, never-funded wallet (SIWS);
 *   2. watches the public trade tapes of the busiest Pulse tokens and picks the most active traders;
 *   3. tracks them (POST /api/tracked-wallets) and copies the busiest one (POST /api/copy/tasks);
 *   4. listens on the signed-in `tracked` and `copy` topics for DURATION_SEC and reports what arrived.
 * Copy signals are only messages: nothing builds, signs or sends a transaction, and they expire.
 * The task and the tracked wallets are deleted at the end.
 *
 *   SERVER_URL=http://127.0.0.1:8787 DURATION_SEC=180 bun run --cwd apps/server tracker-live
 */
import { getAddressFromPublicKey } from "@solana/kit";
import { createSignInMessage } from "@zerofee/auth";
import type { CopySignal, CopyTask, NonceResponse, TokenSummary, Trade, TrackedTradeRow } from "@zerofee/protocol";

const SERVER = (process.env.SERVER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = process.env.ORIGIN ?? new URL(SERVER).origin;
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? 25);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 180);
const WALLETS = Number(process.env.WALLETS ?? 3);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

interface Msg {
  type: string;
  topic?: string;
  code?: string;
  // biome-ignore lint/suspicious/noExplicitAny: loose wire payloads
  data?: any;
}

function socket(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; on: (fn: (m: Msg) => void) => void }> {
  const ws = new WebSocket(`${SERVER.replace(/^http/, "ws")}/ws`, { headers } as unknown as string[]);
  const handlers: ((m: Msg) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Msg;
    for (const h of handlers) h(m);
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ ws, on: (fn) => handlers.push(fn) });
    ws.onerror = () => reject(new Error("websocket failed"));
  });
}

async function signIn(): Promise<{ cookie: string; wallet: string }> {
  const kp = (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
  const address = await getAddressFromPublicKey(kp.publicKey);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const nonce = (await (await fetch(`${SERVER}/api/auth/nonce`)).json()) as NonceResponse;
  const message = createSignInMessage({ ...nonce.input, address });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new Uint8Array(message)));
  const r = await fetch(`${SERVER}/api/auth/signin`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ account: { address, publicKey: b64(publicKey) }, signedMessage: b64(message), signature: b64(signature) }),
  });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  return { cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "", wallet: address };
}

/** Busiest traders on the busiest Pulse tokens' public tapes over SAMPLE_SEC. */
async function pickTraders(): Promise<{ address: string; trades: number }[]> {
  const { ws, on } = await socket();
  const counts = new Map<string, number>();
  const add = (trades: Trade[]) => {
    for (const t of trades) counts.set(t.trader, (counts.get(t.trader) ?? 0) + 1);
  };
  const tokens: TokenSummary[] = [];
  on((m) => {
    if (m.type === "snapshot" && m.topic?.startsWith("pulse:")) tokens.push(...(m.data.tokens as TokenSummary[]));
    if (m.topic?.startsWith("trades:")) add((m.data?.trades as Trade[]) ?? []);
  });
  for (const c of ["new", "final", "migrated"]) ws.send(JSON.stringify({ type: "subscribe", topic: `pulse:${c}` }));
  await Bun.sleep(2_000);
  const busiest = [...new Map(tokens.map((t) => [t.mint, t])).values()].sort((a, b) => b.volume5m - a.volume5m).slice(0, 12);
  for (const t of busiest) ws.send(JSON.stringify({ type: "subscribe", topic: `trades:${t.mint}` }));
  console.log(`sampling the tapes of ${busiest.length} busy tokens for ${SAMPLE_SEC}s ...`);
  await Bun.sleep(SAMPLE_SEC * 1_000);
  ws.close();
  return [...counts.entries()].map(([address, trades]) => ({ address, trades })).sort((a, b) => b.trades - a.trades);
}

async function main(): Promise<void> {
  const health = await fetch(`${SERVER}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`server not reachable at ${SERVER}`);
  const { cookie, wallet } = await signIn();
  console.log(`signed in as throwaway ${short(wallet)} (never funded)`);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(`${SERVER}${path}`, {
      method,
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as T };
  };

  const traders = (await pickTraders()).slice(0, WALLETS);
  if (!traders.length) throw new Error("no trades seen on the sampled tapes");
  for (const [i, t] of traders.entries()) {
    const r = await api("POST", "/api/tracked-wallets", { address: t.address, label: `🤖 live ${i + 1}`, emoji: "🤖", alerts: { buy: true, sell: true } });
    console.log(`tracking ${t.address} (${t.trades} trades in the sample): HTTP ${r.status}`);
  }
  const leader = traders[0]?.address as string;
  const task = await api<CopyTask>("POST", "/api/copy/tasks", {
    leader,
    label: "live check",
    config: { sizing: { mode: "fixed", sol: 0.01 }, ageSec: { min: null }, maxBuysPerToken: 100, dailyBuyLimit: 10_000, dailySpendLimitSol: 1_000, totalSpendLimitSol: 1_000 },
  });
  console.log(`copy task on ${short(leader)}: HTTP ${task.status}`);

  const rows: (TrackedTradeRow & { arrivedAt: number })[] = [];
  const signals = new Map<string, CopySignal & { arrivedAt: number }>();
  const { ws, on } = await socket({ cookie, origin: ORIGIN });
  on((m) => {
    const now = Date.now();
    if (m.type === "error") console.log(`error on ${m.topic}: ${m.code}`);
    if (m.topic === "tracked" && m.type === "delta") {
      for (const r of m.data.rows as TrackedTradeRow[]) {
        rows.push({ ...r, arrivedAt: now });
        console.log(
          `tracked  ${r.tag.padEnd(9)} ${r.kind.padEnd(4)} ${r.amountSol.toFixed(4).padStart(9)} SOL  ${(r.symbol || short(r.mint)).padEnd(10)} ` +
            `MC ${r.mcSol.toFixed(1)} SOL  slot ${r.slot}  ${short(r.signature)}  first=${r.firstBuy}  ` +
            `detect ${r.receivedAt - r.blockTime} ms, server->client ${now - r.receivedAt} ms`,
        );
      }
    }
    if (m.topic === "copy" && m.type === "delta") {
      for (const s of (m.data.signals ?? []) as CopySignal[]) {
        if (!signals.has(s.id) || signals.get(s.id)?.status !== s.status) {
          console.log(
            `copy     ${s.side.padEnd(4)} ${s.status.padEnd(8)} ${s.reason ?? ""} ${s.symbol || short(s.mint)} size ${s.sizeSol ?? "-"} ` +
              `sell ${s.sellFraction ?? "-"} leader ${s.leaderSol.toFixed(4)} SOL`,
          );
        }
        signals.set(s.id, { ...s, arrivedAt: signals.get(s.id)?.arrivedAt ?? now });
      }
    }
  });
  ws.send(JSON.stringify({ type: "subscribe", topic: "tracked" }));
  ws.send(JSON.stringify({ type: "subscribe", topic: "copy" }));
  console.log(`listening for ${DURATION_SEC}s ...`);
  await Bun.sleep(DURATION_SEC * 1_000);
  ws.close();

  const perWallet = new Map<string, number>();
  for (const r of rows) perWallet.set(r.wallet, (perWallet.get(r.wallet) ?? 0) + 1);
  const detect = rows.map((r) => r.receivedAt - r.blockTime);
  const deliver = rows.map((r) => r.arrivedAt - r.receivedAt);
  const byStatus = new Map<string, number>();
  const reasons = new Map<string, number>();
  for (const s of signals.values()) {
    byStatus.set(`${s.side}:${s.status}`, (byStatus.get(`${s.side}:${s.status}`) ?? 0) + 1);
    if (s.status === "skipped" && s.reason) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  }
  const final = await api<CopyTask>("GET", `/api/copy/tasks/${task.body.id}`);
  console.log("\n--- summary ---");
  console.log(`tracked rows: ${rows.length} (${[...perWallet.entries()].map(([w, k]) => `${short(w)}: ${k}`).join(", ") || "none"})`);
  console.log(
    `detection (receive - block time, 1 s clock): p50 ${pct(detect, 50)} ms, p90 ${pct(detect, 90)} ms; ` +
      `server receive -> client: p50 ${pct(deliver, 50)} ms, p90 ${pct(deliver, 90)} ms, max ${pct(deliver, 100)} ms`,
  );
  console.log(`copy signals: ${[...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`copy skip reasons (logged): ${[...reasons.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`task stats: ${JSON.stringify(final.body.stats)}`);

  await api("DELETE", `/api/copy/tasks/${task.body.id}`);
  for (const t of traders) await api("DELETE", `/api/tracked-wallets/${t.address}`);
  await api("POST", "/api/auth/signout", {});
  if (!rows.length) {
    console.log("FAIL: no tracked rows arrived");
    process.exit(1);
  }
  console.log("ok: matches arrived on the tracked topic");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
