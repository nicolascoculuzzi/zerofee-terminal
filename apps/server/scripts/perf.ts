#!/usr/bin/env bun
/**
 * End-to-end latency benchmark: starts the real server (DRY_RUN, public RPC unless RPC_URL / RPC_WS_URL say
 * otherwise) in a child process, connects WebSocket clients the way the web app does (chain + the three
 * Pulse columns + the trade tape of an active token), runs for N minutes and prints where the time goes:
 *
 *   block time -> RPC notification -> queue -> decode -> MarketState -> gateway publish -> client receive
 *
 * plus the server's event-loop lag, its busiest synchronous work, startup (listen, restore, first data) and
 * what each client received. Server-side numbers come from GET /api/perf (src/perf.ts).
 *
 *   bun run perf                                   3 min, fresh database
 *   bun run perf --minutes 5 --save-db /tmp/m.db   keep the database the run built
 *   bun run perf --db /tmp/m.db                    start from a copy of it (startup restore of its tokens)
 *   bun run perf --clients 5 --json out.json --profile
 *
 * Flags: --minutes N (3), --clients N (1), --db PATH (copied, never modified), --save-db PATH, --port N,
 * --json PATH, --profile (Bun --cpu-prof-md into the run's temp dir), --quiet (no server log tail),
 * --fresh-pglite (initialise a new PGlite user database instead of reusing $TMPDIR/zf-perf-pglite),
 * --replay FILE [--speed X]: feed the server a recording (scripts/perf-feed.ts record) instead of the live RPC
 * stream, looped, X times faster: the same input every run, to compare server builds (detection latency is
 * meaningless there; read the queue / publish stages, loop lag and spans). --entry PATH runs another
 * server entry point (e.g. an older checkout's main.ts) for A/B comparisons.
 * Extra server settings pass through the environment (e.g. ENRICH_ENABLED=false bun run perf).
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PerfResponse, PerfStat } from "@zerofee/protocol";

interface Args {
  minutes: number;
  clients: number;
  db: string | null;
  saveDb: string | null;
  port: number;
  json: string | null;
  profile: boolean;
  quiet: boolean;
  freshPglite: boolean;
  replay: string | null;
  speed: number;
  entry: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { minutes: 3, clients: 1, db: null, saveDb: null, port: 0, json: null, profile: false, quiet: false, freshPglite: false, replay: null, speed: 1, entry: "apps/server/src/main.ts" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--minutes") a.minutes = Number(v());
    else if (k === "--clients") a.clients = Math.max(0, Math.floor(Number(v())));
    else if (k === "--db") a.db = resolve(v());
    else if (k === "--save-db") a.saveDb = resolve(v());
    else if (k === "--port") a.port = Number(v());
    else if (k === "--json") a.json = resolve(v());
    else if (k === "--profile") a.profile = true;
    else if (k === "--quiet") a.quiet = true;
    else if (k === "--fresh-pglite") a.freshPglite = true;
    else if (k === "--replay") a.replay = resolve(v());
    else if (k === "--speed") a.speed = Number(v());
    else if (k === "--entry") a.entry = resolve(v());
    else throw new Error(`unknown flag ${k}`);
  }
  if (!(a.minutes > 0)) throw new Error("--minutes must be > 0");
  return a;
}

/** Nearest-rank percentiles over raw samples. */
class Samples {
  readonly v: number[] = [];
  add(x: number): void {
    if (Number.isFinite(x)) this.v.push(x);
  }
  stat(): PerfStat {
    const s = [...this.v].sort((a, b) => a - b);
    const q = (p: number) => (s.length ? (s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number) : null);
    return { count: s.length, p50: q(50), p90: q(90), p99: q(99), max: s.length ? (s[s.length - 1] as number) : null };
  }
}

interface ClientStats {
  connectMs: number | null;
  firstSnapshotMs: Record<string, number>;
  snapshotBytes: Record<string, number>;
  bytes: number;
  messages: number;
  gaps: number;
  publishToReceive: Samples;
  tradeE2E: Samples;
  tradeServerToClient: Samples;
  launchE2E: Samples;
  pulseRate: Map<string, number>;
  tradesReceived: number;
  firstTradeMs: number | null;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port as number;
  s.stop(true);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runClient(wsUrl: string, t0: number, stopAt: number): { stats: ClientStats; done: Promise<void> } {
  const stats: ClientStats = {
    connectMs: null,
    firstSnapshotMs: {},
    snapshotBytes: {},
    bytes: 0,
    messages: 0,
    gaps: 0,
    publishToReceive: new Samples(),
    tradeE2E: new Samples(),
    tradeServerToClient: new Samples(),
    launchE2E: new Samples(),
    pulseRate: new Map(),
    tradesReceived: 0,
    firstTradeMs: null,
  };
  const seqs = new Map<string, number>();
  const knownNew = new Set<string>();
  let focus: string | null = null;
  let focusTradeAt = 0;
  let finalTop: string[] = [];
  const done = new Promise<void>((resolveDone) => {
    const opened = performance.now();
    const ws = new WebSocket(wsUrl);
    const send = (type: "subscribe" | "unsubscribe", topic: string) => ws.send(JSON.stringify({ type, topic }));
    const refocus = () => {
      const next = finalTop.find((m) => m !== focus) ?? null;
      if (!next) return;
      if (focus) {
        send("unsubscribe", `trades:${focus}`);
        send("unsubscribe", `token:${focus}`);
      }
      focus = next;
      focusTradeAt = Date.now();
      send("subscribe", `trades:${focus}`);
      send("subscribe", `token:${focus}`);
    };
    const timer = setInterval(() => {
      // follow activity: move to another Final Stretch token when the focused one went quiet
      if (Date.now() - focusTradeAt > 20_000) refocus();
      if (Date.now() >= stopAt) {
        clearInterval(timer);
        ws.close();
      }
    }, 1_000);
    ws.onopen = () => {
      stats.connectMs = performance.now() - opened;
      for (const t of ["chain", "pulse:new", "pulse:final", "pulse:migrated"]) send("subscribe", t);
    };
    ws.onmessage = (ev) => {
      const now = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      stats.bytes += raw.length;
      stats.messages++;
      const m = JSON.parse(raw) as { type: string; topic: string; seq: number; ts?: number; data: unknown };
      if (m.type === "error") return;
      if (m.type === "snapshot") {
        if (stats.firstSnapshotMs[m.topic] === undefined) {
          stats.firstSnapshotMs[m.topic] = performance.now() - opened;
          stats.snapshotBytes[m.topic] = raw.length;
        }
        seqs.set(m.topic, m.seq);
        if (m.topic === "pulse:new") for (const t of (m.data as { tokens: { mint: string }[] }).tokens) knownNew.add(t.mint);
        if (m.topic === "pulse:final") {
          finalTop = (m.data as { tokens: { mint: string }[] }).tokens.slice(0, 10).map((t) => t.mint);
          if (!focus) refocus();
        }
        return;
      }
      const last = seqs.get(m.topic);
      if (last !== undefined && m.seq !== last + 1) stats.gaps++;
      seqs.set(m.topic, m.seq);
      if (m.ts !== undefined) stats.publishToReceive.add(now - m.ts);
      if (m.topic.startsWith("pulse:")) {
        stats.pulseRate.set(m.topic, (stats.pulseRate.get(m.topic) ?? 0) + 1);
        const d = m.data as { upsert: { mint: string; createdAt?: number | null }[] };
        if (m.topic === "pulse:new") {
          for (const u of d.upsert) {
            if (knownNew.has(u.mint)) continue;
            knownNew.add(u.mint);
            if (typeof u.createdAt === "number" && now - u.createdAt < 120_000) stats.launchE2E.add(now - u.createdAt);
          }
        }
        if (m.topic === "pulse:final") for (const u of d.upsert) if (!finalTop.includes(u.mint)) finalTop.push(u.mint);
      } else if (m.topic.startsWith("trades:") && m.type === "delta") {
        const trades = (m.data as { trades: { blockTime: number; receivedAt: number }[] }).trades;
        focusTradeAt = now;
        if (stats.firstTradeMs === null) stats.firstTradeMs = performance.now() - t0;
        for (const t of trades) {
          stats.tradesReceived++;
          stats.tradeE2E.add(now - t.blockTime);
          stats.tradeServerToClient.add(now - t.receivedAt);
        }
      }
    };
    ws.onclose = () => {
      clearInterval(timer);
      resolveDone();
    };
    ws.onerror = () => {};
  });
  return { stats, done };
}

const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? "-" : v.toFixed(d));

function row(name: string, s: PerfStat | undefined, note = "", d = 0): string {
  if (!s) return `  ${name.padEnd(26)} ${"-".padStart(8)}${"".padStart(36)}  ${note}`;
  return `  ${name.padEnd(26)} ${String(s.count).padStart(8)} ${fmt(s.p50, d).padStart(8)} ${fmt(s.p90, d).padStart(8)} ${fmt(s.p99, d).padStart(8)} ${fmt(s.max, d).padStart(9)}  ${note}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repo = resolve(import.meta.dir, "../../..");
  const dir = mkdtempSync(join(tmpdir(), "zf-perf-"));
  const dbPath = join(dir, "market.db");
  if (args.db) {
    if (!existsSync(args.db)) throw new Error(`--db ${args.db} does not exist`);
    for (const ext of ["", "-wal", "-shm"]) if (existsSync(args.db + ext)) copyFileSync(args.db + ext, dbPath + ext);
  }
  const port = args.port || (await freePort());
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DRY_RUN: "true",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    DB_PATH: dbPath,
    // a persistent PGlite dir (as in development): a fresh one adds ~4 s of initdb to every start
    PGLITE_DIR: args.freshPglite ? join(dir, "pglite") : join(tmpdir(), "zf-perf-pglite"),
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  };
  let replay: { url: string; stop(): void } | null = null;
  if (args.replay) {
    const { loadRecording, serveRecording } = await import("./perf-feed");
    const rec = loadRecording(args.replay);
    replay = serveRecording(rec, { speed: args.speed, loop: true });
    env.RPC_WS_URL = replay.url;
    console.log(`perf: replaying ${rec.messages.length} recorded messages at ${args.speed}x from ${replay.url}`);
  }
  const bunArgs = args.profile ? ["--cpu-prof", "--cpu-prof-md", `--cpu-prof-dir=${dir}`] : [];
  console.log(`perf: ${args.minutes} min, ${args.clients} client(s), db ${args.db ? `copy of ${args.db}` : "fresh"}, temp ${dir}`);
  console.log(`perf: RPC ${env.RPC_URL ?? "default public"} / WS ${env.RPC_WS_URL ?? "(derived)"}, source ${env.INGEST_SOURCE ?? "rpc"}`);
  const t0 = performance.now();
  const child = Bun.spawn(["bun", ...bunArgs, args.entry], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const logLines: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        logLines.push(line);
        if (!args.quiet && /restored|listening|warn|error|perf:/i.test(line)) console.log(`  [server] ${line.slice(0, 220)}`);
        i = buf.indexOf("\n");
      }
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);

  const base = `http://127.0.0.1:${port}`;
  let listenMs: number | null = null;
  for (let i = 0; i < 600 && listenMs === null; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) listenMs = performance.now() - t0;
    } catch {
      await sleep(50);
    }
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}):\n${logLines.slice(-30).join("\n")}`);
  }
  if (listenMs === null) throw new Error("server did not start listening within 30 s");
  console.log(`perf: listening after ${listenMs.toFixed(0)} ms`);

  const stopAt = Date.now() + args.minutes * 60_000;
  const clients = Array.from({ length: args.clients }, () => runClient(`ws://127.0.0.1:${port}/ws`, t0, stopAt));
  // minute markers
  const ticker = setInterval(async () => {
    try {
      const p = (await (await fetch(`${base}/api/perf`)).json()) as PerfResponse;
      const t = p.stages["detect.trade"];
      console.log(
        `perf: t+${p.uptimeSec}s trade detect p50/p90 ${fmt(t?.p50)}/${fmt(t?.p90)} ms, loop lag p99/max ${fmt(p.loop.p99)}/${fmt(p.loop.max)} ms`,
      );
    } catch {}
  }, 30_000);
  await sleep(args.minutes * 60_000);
  clearInterval(ticker);
  const perfRes = (await (await fetch(`${base}/api/perf`)).json()) as PerfResponse;
  const health = (await (await fetch(`${base}/api/health`)).json()) as { ingest: Record<string, unknown>; sources: { notes: string[] }[] };
  await Promise.all(clients.map((c) => c.done));
  child.kill("SIGINT");
  await Promise.race([child.exited, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
  replay?.stop();

  const restoreLine = logLines.find((l) => l.includes("restored ")) ?? "";
  const s = perfRes.stages;
  console.log("\n=== latency breakdown (ms) ===");
  console.log(
    `  ${"stage".padEnd(26)} ${"n".padStart(8)} ${"p50".padStart(8)} ${"p90".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(9)}`,
  );
  console.log(row("detect.launch", s["detect.launch"], "block time -> socket receive (1 s floor)"));
  console.log(row("detect.trade", s["detect.trade"], "block time -> socket receive (1 s floor)"));
  console.log(row("rpc.afterSlot", s["rpc.afterSlot"], "slotNotification -> logs notification"));
  console.log(row("rpc.streamBehindSlots", s["rpc.streamBehindSlots"], "SLOTS: HTTP confirmed - streamed tip (>0 = stream backlog)"));
  console.log(row("ingest.queue", s["ingest.queue"], "receive -> decode start", 1));
  console.log(row("ingest.decode", s["ingest.decode"], "per tx", 3));
  console.log(row("gateway.pulseWait", s["gateway.pulseWait"], "state change -> Pulse publish"));
  console.log(row("gateway.tapeWait", s["gateway.tapeWait"], "receive -> tape publish"));
  console.log(row("e2e.launchPublish", s["e2e.launchPublish"], "block time -> Pulse publish"));
  console.log(row("e2e.tradePublish", s["e2e.tradePublish"], "block time -> tape publish"));
  const merged = { pub: new Samples(), te2e: new Samples(), ts2c: new Samples(), le2e: new Samples() };
  for (const c of clients) {
    merged.pub.v.push(...c.stats.publishToReceive.v);
    merged.te2e.v.push(...c.stats.tradeE2E.v);
    merged.ts2c.v.push(...c.stats.tradeServerToClient.v);
    merged.le2e.v.push(...c.stats.launchE2E.v);
  }
  console.log(row("client.publishToReceive", merged.pub.stat(), "gateway publish -> client receive"));
  console.log(row("client.tradeServerToClient", merged.ts2c.stat(), "server receive -> client receive (trades)"));
  console.log(row("client.launchE2E", merged.le2e.stat(), "block time -> client receive (launches)"));
  console.log(row("client.tradeE2E", merged.te2e.stat(), "block time -> client receive (trades)"));

  const l = perfRes.loop;
  console.log("\n=== event loop ===");
  console.log(
    `  lag p50 ${fmt(l.p50, 1)} / p90 ${fmt(l.p90, 1)} / p99 ${fmt(l.p99, 1)} / max ${fmt(l.max, 1)} ms; stalls >50 ms ${l.stallsOver50ms}, >100 ms ${l.stallsOver100ms}, >500 ms ${l.stallsOver500ms}`,
  );
  console.log("\n=== busiest synchronous work ===");
  console.log(
    `  ${"span".padEnd(30)} ${"n".padStart(8)} ${"ms/s".padStart(7)} ${"p50".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(8)}`,
  );
  for (const [k, v] of Object.entries(perfRes.spans).slice(0, 16)) {
    console.log(
      `  ${k.padEnd(30)} ${String(v.count).padStart(8)} ${v.perSecMs.toFixed(2).padStart(7)} ${fmt(v.p50, 2).padStart(7)} ${fmt(v.p99, 2).padStart(7)} ${fmt(v.max, 1).padStart(8)}`,
    );
  }
  console.log("\n=== startup / clients ===");
  console.log(`  listen ${listenMs.toFixed(0)} ms after spawn; ${restoreLine.replace(/^.*restored/, "restored") || "no restore line"}`);
  for (const [i, c] of clients.entries()) {
    const st = c.stats;
    const snaps = Object.entries(st.firstSnapshotMs)
      .map(([k, v]) => `${k} ${v.toFixed(0)} ms/${((st.snapshotBytes[k] ?? 0) / 1024).toFixed(0)} KB`)
      .join(", ");
    console.log(
      `  client ${i}: connect ${fmt(st.connectMs)} ms; first snapshots: ${snaps}; ${st.messages} msgs, ${(st.bytes / 1e6).toFixed(1)} MB, ${st.gaps} gaps, ` +
        `${st.tradesReceived} trades (first ${fmt(st.firstTradeMs)} ms after spawn); pulse deltas/s ${[...st.pulseRate].map(([k, n]) => `${k.slice(6)} ${(n / (args.minutes * 60)).toFixed(1)}`).join(" ")}`,
    );
  }
  const notes = health.sources?.[0]?.notes ?? [];
  console.log(
    `  ingest: ${JSON.stringify({ trades: health.ingest.trades, launches: health.ingest.launches, tps: health.ingest.tradesPerSec1m })}`,
  );
  for (const n of notes.filter((x) => /queue|slot lag|notifications|rpc:|received/.test(x))) console.log(`  source: ${n}`);
  if (args.profile) {
    const prof = readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".cpuprofile"));
    console.log(`  cpu profile: ${prof.map((f) => join(dir, f)).join(", ") || "(none written)"}`);
  }
  if (args.json) {
    const out = {
      args,
      listenMs,
      restoreLine,
      perf: perfRes,
      clients: clients.map((c) => ({
        ...c.stats,
        publishToReceive: c.stats.publishToReceive.stat(),
        tradeE2E: c.stats.tradeE2E.stat(),
        tradeServerToClient: c.stats.tradeServerToClient.stat(),
        launchE2E: c.stats.launchE2E.stat(),
        pulseRate: Object.fromEntries(c.stats.pulseRate),
      })),
    };
    await Bun.write(args.json, JSON.stringify(out, null, 2));
    console.log(`  wrote ${args.json}`);
  }
  if (args.saveDb) {
    for (const ext of ["", "-wal", "-shm"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, args.saveDb + ext);
    console.log(`  saved database to ${args.saveDb}`);
  }
  if (!args.profile) rmSync(dir, { recursive: true, force: true });
}

await main().catch((e) => {
  console.error(`perf failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
