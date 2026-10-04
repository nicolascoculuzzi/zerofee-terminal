#!/usr/bin/env bun
/**
 * Record and replay the RPC logs feed, so the server's hot path can be benchmarked on the same input every
 * time (the public RPC's throughput and throttling change by the minute; see NOTES.md).
 *
 *   bun apps/server/scripts/perf-feed.ts record feed.jsonl.gz --seconds 120
 *       Subscribes like RpcLogsSource (logsSubscribe mentions pump + PumpSwap at processed, slotSubscribe) on
 *       RPC_WS_URL (default: the public endpoint) and writes every message with its arrival offset.
 *   bun apps/server/scripts/perf-feed.ts serve feed.jsonl.gz [--port 8899] [--speed 1] [--loop]
 *       A fake RPC WebSocket that answers the same subscriptions and replays the recording at its original
 *       pace (or `--speed` times faster). `bun run perf --replay feed.jsonl.gz` starts it for you.
 *
 * Detection latency (block time -> receive) is meaningless on a replay; the server-side stages (queue, decode,
 * apply, publish waits), event-loop lag and work spans are what this is for.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export interface Recording {
  /** [offset ms, raw message] in arrival order. */
  messages: [number, string][];
  /** Subscription id the recording used per channel. */
  subs: { pump: number | null; pumpswap: number | null; slot: number | null };
}

export function loadRecording(path: string): Recording {
  const text = new TextDecoder().decode(gunzipSync(new Uint8Array(readFileSync(path))));
  const lines = text.split("\n");
  const head = JSON.parse(lines[0] as string) as { subs: Recording["subs"] };
  const messages: [number, string][] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i] as string;
    if (!l) continue;
    const tab = l.indexOf("\t");
    messages.push([Number(l.slice(0, tab)), l.slice(tab + 1)]);
  }
  return { messages, subs: head.subs };
}

async function record(path: string, seconds: number): Promise<void> {
  const url = process.env.RPC_WS_URL ?? (process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com").replace(/^http/, "ws");
  const ws = new WebSocket(url);
  const subs: Recording["subs"] = { pump: null, pumpswap: null, slot: null };
  const chunks: string[] = [];
  let t0 = 0;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      t0 = performance.now();
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP] }, { commitment: "processed" }] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "logsSubscribe", params: [{ mentions: [PUMP_AMM] }, { commitment: "processed" }] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1000, method: "slotSubscribe" }));
      setTimeout(() => {
        ws.close();
        resolve();
      }, seconds * 1000);
    };
    ws.onerror = () => reject(new Error(`websocket error on ${url}`));
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const m = JSON.parse(raw.length < 200 ? raw : "{}") as { id?: number; result?: number };
      if (m.id === 1) subs.pump = m.result ?? null;
      else if (m.id === 2) subs.pumpswap = m.result ?? null;
      else if (m.id === 1000) subs.slot = m.result ?? null;
      else {
        chunks.push(`${Math.round(performance.now() - t0)}\t${raw}`);
        bytes += raw.length;
      }
    };
  });
  const body = `${JSON.stringify({ subs, seconds, recordedAt: Date.now(), url: url.replace(/api-key=[^&]+/, "api-key=***") })}\n${chunks.join("\n")}\n`;
  await Bun.write(path, Bun.gzipSync(new TextEncoder().encode(body), { level: 6 }));
  console.log(`recorded ${chunks.length} messages, ${(bytes / 1e6).toFixed(1)} MB in ${seconds} s -> ${path}`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Later laps of a looped replay: shift slots and change signatures, so the server treats them as new
 * transactions instead of deduplicating them (the content is the same load, not real chain data).
 */
function relabel(raw: string, lap: number): string {
  return raw
    .replace(/"slot":(\d+)/g, (_, n: string) => `"slot":${Number(n) + lap * 1_000_000}`)
    .replace(/"signature":"([1-9A-HJ-NP-Za-km-z]+)"/, (_, sig: string) => `"signature":"${sig.slice(0, -2)}${B58[lap % 58]}${B58[Math.floor(lap / 58) % 58]}"`);
}

/** Starts a fake RPC WebSocket replaying `rec`; returns its URL and a stop function. */
export function serveRecording(rec: Recording, o: { port?: number; speed?: number; loop?: boolean } = {}): { url: string; stop(): void } {
  const speed = o.speed ?? 1;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      // HTTP JSON-RPC is not replayed: point RPC_URL at a real endpoint
      return new Response("replay server: WebSocket only", { status: 400 });
    },
    websocket: {
      message(ws, msg) {
        const m = JSON.parse(String(msg)) as { id: number; method: string; params?: [{ mentions?: string[] }] };
        let result = 0;
        if (m.method === "logsSubscribe") result = m.params?.[0]?.mentions?.[0] === PUMP ? (rec.subs.pump ?? 1) : (rec.subs.pumpswap ?? 2);
        else if (m.method === "slotSubscribe") result = rec.subs.slot ?? 3;
        else {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }));
          return;
        }
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        if (m.method !== "slotSubscribe") return;
        // start the replay once the client subscribed to everything (slotSubscribe comes last)
        let start = performance.now();
        let i = 0;
        let lap = 0;
        const pump = () => {
          const now = (performance.now() - start) * speed;
          while (i < rec.messages.length && (rec.messages[i] as [number, string])[0] <= now) {
            if (ws.readyState !== 1) return;
            const raw = (rec.messages[i] as [number, string])[1];
            ws.send(lap === 0 ? raw : relabel(raw, lap));
            i++;
          }
          if (i >= rec.messages.length) {
            if (!o.loop) return;
            i = 0;
            lap++;
            start = performance.now();
            timers.add(setTimeout(pump, 0));
            return;
          }
          const wait = Math.max(0, ((rec.messages[i] as [number, string])[0] - now) / speed);
          timers.add(setTimeout(pump, Math.min(wait, 50)));
        };
        pump();
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop() {
      for (const t of timers) clearTimeout(t);
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const [cmd, path, ...rest] = process.argv.slice(2);
  const flag = (name: string, def: number) => {
    const i = rest.indexOf(name);
    return i >= 0 ? Number(rest[i + 1]) : def;
  };
  if (cmd === "record" && path) await record(path, flag("--seconds", 120));
  else if (cmd === "serve" && path) {
    const rec = loadRecording(path);
    const s = serveRecording(rec, { port: flag("--port", 8899), speed: flag("--speed", 1), loop: rest.includes("--loop") });
    console.log(`replaying ${rec.messages.length} messages on ${s.url}`);
  } else {
    console.error("usage: perf-feed.ts record <file.jsonl.gz> [--seconds N] | serve <file.jsonl.gz> [--port N] [--speed X] [--loop]");
    process.exit(1);
  }
}
