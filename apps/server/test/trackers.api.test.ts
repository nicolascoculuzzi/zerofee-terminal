/**
 * Wallet tracker and copy trading through the real server (in-process, PGlite, fake ingest source):
 * the copy REST needs a session and an allowed Origin on every mutation, validates strictly and only
 * shows a user their own tasks and signals; the `tracked`, `tracked:<mint>` and `copy` topics need a
 * signed-in socket and are scoped to it; and a leader trade fed through the ingest source comes out
 * as a tracked row and a copy signal on the owner's socket, whose reported fill updates the position.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { COPY_LIMITS, type CopySignal, type CopyTask, DEFAULT_COPY_CONFIG } from "@zerofee/protocol";
import { addr, FakeCurve, synthTx, waitFor } from "./helpers";
import { sig } from "./trackerHelpers";
import { Browser, startUserApp, TestSource, type UserTestEnv, WsClient } from "./userHelpers";

let env: UserTestEnv;
const source = new TestSource();

beforeAll(async () => {
  env = await startUserApp({ source, env: { TRACKER_FLUSH_MS: "20" } });
}, 60_000);
afterAll(async () => {
  await env.close();
});

let k = 0;

describe("copy REST: authentication and CSRF", () => {
  test("every route needs a session; every mutation needs an allowed Origin", async () => {
    const anon = new Browser(env);
    const id = crypto.randomUUID();
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/copy/tasks"],
      ["POST", "/api/copy/tasks", { leader: addr("x") }],
      ["GET", `/api/copy/tasks/${id}`],
      ["PATCH", `/api/copy/tasks/${id}`, { label: "x" }],
      ["DELETE", `/api/copy/tasks/${id}`],
      ["POST", `/api/copy/tasks/${id}/pause`],
      ["POST", `/api/copy/tasks/${id}/resume`],
      ["GET", "/api/copy/positions"],
      ["GET", "/api/copy/signals"],
      ["POST", `/api/copy/signals/${id}/result`, { status: "failed" }],
      ["GET", "/api/tracked-trades"],
    ];
    for (const [method, path, body] of routes)
      expect([method, path, (await anon.req(method, path, body)).status]).toEqual([method, path, 401]);

    const signedIn = new Browser(env);
    await signedIn.signIn();
    const noOrigin = new Browser(env, null);
    noOrigin.cookie = signedIn.cookie;
    const evil = new Browser(env, "https://evil.example");
    evil.cookie = signedIn.cookie;
    for (const [method, path, body] of routes.filter(([m]) => m !== "GET")) {
      for (const b of [noOrigin, evil]) {
        const r = await b.req(method, path, body);
        expect([method, path, r.status, ((await r.json()) as { code: string }).code]).toEqual([method, path, 403, "forbidden"]);
      }
    }
    // Reads work without Origin (browsers do not send it on same-origin GETs).
    expect((await noOrigin.req("GET", "/api/copy/tasks")).status).toBe(200);
  });
});

describe("copy tasks: CRUD, validation, ownership", () => {
  test("create with defaults merged, update nested fields, pause / resume, delete; strict validation", async () => {
    const b = new Browser(env);
    const { me } = await b.signIn();
    const leader = addr(`api-leader-${++k}`);
    const bad: [unknown, number, string][] = [
      [{ leader: "not-an-address" }, 400, "leader"],
      [{ leader: me.wallet }, 400, "own wallets"],
      [{ leader, config: { nope: 1 } }, 400, "unknown field"],
      [{ leader, config: { sizing: { mode: "ratio" } } }, 400, "pct is required"],
      [{ leader, config: { sizing: { mode: "fixed", pct: 5 } } }, 400, "only applies to mode ratio"],
      [{ leader, config: { mc: { min: 10, max: 5 } } }, 400, "cannot exceed"],
      [{ leader, config: { stopLossPct: 100 } }, 400, "stopLossPct"],
      [{ leader, config: { blacklist: { mints: ["x"] } } }, 400, "blacklist.mints[0]"],
      [{ leader, status: "running" }, 400, "status"],
    ];
    for (const [body, status, msg] of bad) {
      const r = await b.json<{ error: string }>("POST", "/api/copy/tasks", body);
      expect([r.status, r.body.error.includes(msg)]).toEqual([status, true]);
    }
    const created = await b.json<CopyTask>("POST", "/api/copy/tasks", {
      leader,
      label: "🐋 KOL",
      config: { sizing: { mode: "ratio", pct: 10 }, maxPerBuySol: 0.5, mc: { min: 5_000 }, takeProfitPct: 100, copySells: false },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      leader,
      label: "🐋 KOL",
      status: "active",
      pausedReason: null,
      config: {
        ...DEFAULT_COPY_CONFIG,
        sizing: { mode: "ratio", pct: 10 },
        maxPerBuySol: 0.5,
        mc: { min: 5_000, max: null, currency: "usd" },
        takeProfitPct: 100,
        copySells: false,
      },
      stats: { buySignals: 0, skipped: 0, spentSol: 0, openPositions: 0, unrealizedPnlSol: 0 },
    });
    const id = created.body.id;
    expect((await b.json("POST", "/api/copy/tasks", { leader })).status).toBe(409);
    expect((await b.json<CopyTask[]>("GET", "/api/copy/tasks")).body.map((t) => t.id)).toEqual([id]);
    const patched = await b.json<CopyTask>("PATCH", `/api/copy/tasks/${id}`, { config: { mc: { max: 90_000 }, sizing: { pct: 25 } } });
    expect(patched.body.config).toMatchObject({
      mc: { min: 5_000, max: 90_000, currency: "usd" },
      sizing: { mode: "ratio", pct: 25 },
      copySells: false,
    });
    expect((await b.json<CopyTask>("POST", `/api/copy/tasks/${id}/pause`)).body).toMatchObject({ status: "paused", pausedReason: "user" });
    expect((await b.json<CopyTask>("POST", `/api/copy/tasks/${id}/resume`)).body).toMatchObject({ status: "active", pausedReason: null });

    // Someone else sees nothing and can change nothing.
    const other = new Browser(env);
    await other.signIn();
    for (const [m, p] of [
      ["GET", `/api/copy/tasks/${id}`],
      ["PATCH", `/api/copy/tasks/${id}`],
      ["POST", `/api/copy/tasks/${id}/pause`],
      ["DELETE", `/api/copy/tasks/${id}`],
    ] as const) {
      expect((await other.json(m, p, m === "PATCH" ? { label: "mine" } : undefined)).status).toBe(404);
    }
    expect((await other.json<CopyTask[]>("GET", "/api/copy/tasks")).body).toEqual([]);
    expect((await other.json("GET", `/api/copy/signals?task=${id}`)).status).toBe(404);
    expect((await b.json("GET", "/api/copy/tasks/not-a-uuid")).status).toBe(400);
    expect((await b.json("DELETE", `/api/copy/tasks/${id}`)).status).toBe(200);
    expect((await b.json("GET", `/api/copy/tasks/${id}`)).status).toBe(404);
  });

  test(`at most ${COPY_LIMITS.tasksPerUser} tasks per user`, async () => {
    const b = new Browser(env);
    await b.signIn();
    for (let i = 0; i < COPY_LIMITS.tasksPerUser; i++) {
      expect((await b.json("POST", "/api/copy/tasks", { leader: addr(`cap-${k}-${i}`) })).status).toBe(200);
    }
    const r = await b.json<{ code: string }>("POST", "/api/copy/tasks", { leader: addr(`cap-${k}-over`) });
    expect([r.status, r.body.code]).toEqual([422, "limit_exceeded"]);
  });
});

describe("topics and the end-to-end path", () => {
  test("anonymous sockets get unauthorized on tracked, tracked:<mint> and copy", async () => {
    const c = await WsClient.connect(env.ws);
    const mint = addr("anon-mint");
    for (const topic of ["tracked", `tracked:${mint}`, "copy"]) c.send({ type: "subscribe", topic });
    const errs = await Promise.all(
      ["tracked", `tracked:${mint}`, "copy"].map((topic) => c.next((m) => m.type === "error" && m.topic === topic)),
    );
    expect(errs.map((e) => e.code)).toEqual(["unauthorized", "unauthorized", "unauthorized"]);
    c.send({ type: "subscribe", topic: "tracked:not-a-mint" });
    expect((await c.next((m) => m.type === "error" && m.topic === "tracked:not-a-mint")).code).toBe("unknown_topic");
    c.ws.close();
  });

  test("a leader trade from the feed becomes a tracked row and a copy signal for its owner only; the reported fill opens a position", async () => {
    const alice = new Browser(env);
    const bob = new Browser(env);
    const { me } = await alice.signIn();
    await bob.signIn();
    const aliceId = (await env.user.store.users.byWallet(me.wallet))?.id as string;
    const whale = addr(`api-whale-${++k}`);
    expect((await alice.json("POST", "/api/tracked-wallets", { address: whale, label: "🐳 Whale", emoji: "🐳" })).status).toBe(200);
    const task = await alice.json<CopyTask>("POST", "/api/copy/tasks", { leader: whale, config: { sizing: { mode: "fixed", sol: 0.1 } } });
    expect(task.status).toBe(200);
    await waitFor(() => env.user.trackers.index.tracks(aliceId, whale)); // the tracked-wallet reload is asynchronous

    const curve = new FakeCurve(addr(`api-mint-${k}`), addr(`api-dev-${k}`));
    const a = await alice.socket();
    const b = await bob.socket();
    for (const c of [a, b]) {
      c.send({ type: "subscribe", topic: "tracked" });
      c.send({ type: "subscribe", topic: "copy" });
      c.send({ type: "subscribe", topic: `tracked:${curve.mint}` });
    }
    const snapCopy = await a.next((m) => m.type === "snapshot" && m.topic === "copy");
    expect(snapCopy.data.tasks.map((t: CopyTask) => t.id)).toEqual([task.body.id]);
    expect((await a.next((m) => m.type === "snapshot" && m.topic === "tracked")).data).toEqual({ rows: [] });
    await a.next((m) => m.type === "snapshot" && m.topic === `tracked:${curve.mint}`);
    await b.next((m) => m.type === "snapshot" && m.topic === `tracked:${curve.mint}`);

    const ts = Math.floor(Date.now() / 1000);
    source.emit(synthTx(5_000, [curve.create(ts - 60, { symbol: "APIT" })]));
    const buyTx = synthTx(5_001, [curve.buy(whale, 500_000_000n, ts)]);
    source.emit(buyTx);

    const row = await a.next((m) => m.type === "delta" && m.topic === "tracked" && m.data.rows[0]?.signature === buyTx.signature);
    expect(row.data.rows[0]).toMatchObject({
      wallet: whale,
      kind: "buy",
      label: "🐳 Whale",
      tag: "Whale",
      symbol: "APIT",
      signature: buyTx.signature,
      slot: 5_001,
      firstBuy: true,
    });
    const marker = await a.next((m) => m.type === "delta" && m.topic === `tracked:${curve.mint}`);
    expect(marker.data.rows[0].signature).toBe(buyTx.signature);
    const sigMsg = await a.next((m) => m.type === "delta" && m.topic === "copy" && m.data.signals?.length > 0);
    const signal: CopySignal = sigMsg.data.signals[0];
    expect(signal).toMatchObject({
      side: "buy",
      status: "pending",
      mint: curve.mint,
      leader: whale,
      sizeSol: 0.1,
      leaderSignature: buyTx.signature,
      delivered: true,
    });
    await Bun.sleep(100);
    expect(b.msgs.filter((m) => m.type === "delta")).toEqual([]);

    // The browser executed it and reports the fill.
    const report = { status: "executed", signature: sig("api-fill"), solAmount: 0.1, tokenAmount: "3000000000000" };
    const noOrigin = new Browser(env, null);
    noOrigin.cookie = alice.cookie;
    expect((await noOrigin.json("POST", `/api/copy/signals/${signal.id}/result`, report)).status).toBe(403);
    expect((await bob.json("POST", `/api/copy/signals/${signal.id}/result`, report)).status).toBe(404);
    expect((await alice.json("POST", `/api/copy/signals/${signal.id}/result`, { status: "executed", signature: "x" })).status).toBe(400);
    const done = await alice.json<CopySignal>("POST", `/api/copy/signals/${signal.id}/result`, report);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: signal.id, status: "executed", filledSol: 0.1, filledTokens: "3000000000000", confirmed: false });
    expect((await alice.json("POST", `/api/copy/signals/${signal.id}/result`, report)).status).toBe(409);
    const executed = await a.next((m) => m.type === "delta" && m.topic === "copy" && m.data.signals?.[0]?.status === "executed");
    expect(executed.data.positions[0]).toMatchObject({ mint: curve.mint, tokens: "3000000000000", costSol: 0.1, buys: 1 });

    const positions = await alice.json<{ mint: string }[]>("GET", "/api/copy/positions");
    expect(positions.body.map((p) => p.mint)).toEqual([curve.mint]);
    const signals = await alice.json<CopySignal[]>("GET", `/api/copy/signals?task=${task.body.id}`);
    expect(signals.body.map((s) => [s.id, s.status])).toEqual([[signal.id, "executed"]]);
    const rows = await alice.json<{ signature: string }[]>("GET", `/api/tracked-trades?mint=${curve.mint}`);
    expect(rows.body.map((r) => r.signature)).toEqual([buyTx.signature]);
    expect((await bob.json<unknown[]>("GET", `/api/tracked-trades?mint=${curve.mint}`)).body).toEqual([]);

    // The leader sells half: a proportional copy sell arrives (holder book: the token's history is known).
    const held = env.app.market.tokens.get(curve.mint)?.holders?.balanceOf(whale) ?? 0n;
    source.emit(synthTx(5_002, [curve.sell(whale, held / 2n, ts + 1)]));
    const sell = await a.next((m) => m.type === "delta" && m.topic === "copy" && m.data.signals?.[0]?.side === "sell");
    expect(sell.data.signals[0]).toMatchObject({
      trigger: "leader_sell",
      sellFraction: 0.5,
      sellTokenAmount: "1500000000000",
      fractionSource: "holders",
    });

    // A dead slot retracts the row on both topics.
    const deadTx = synthTx(5_003, [curve.buy(whale, 10_000_000n, ts + 2)]);
    source.emit(deadTx);
    // (the sell's row may share the frame: rows are batched per flush)
    await a.next(
      (m) =>
        m.type === "delta" && m.topic === "tracked" && m.data.rows.some((r: { signature: string }) => r.signature === deadTx.signature),
    );
    source.sink?.slot?.(5_003, "dead");
    const corr = await a.next((m) => m.type === "correction" && m.topic === "tracked");
    expect(corr.data).toEqual({ remove: [`${deadTx.signature}:0:${whale}`] });
    a.ws.close();
    b.ws.close();
  });

  test("a copy socket opened later gets pending signals in its snapshot", async () => {
    const alice = new Browser(env);
    await alice.signIn();
    const leader = addr(`api-late-${++k}`);
    expect((await alice.json("POST", "/api/copy/tasks", { leader })).status).toBe(200); // indexed before the response
    const curve = new FakeCurve(addr(`api-late-mint-${k}`), addr(`api-late-dev-${k}`));
    const ts = Math.floor(Date.now() / 1000);
    source.emit(synthTx(6_000, [curve.create(ts - 60)]));
    source.emit(synthTx(6_001, [curve.buy(leader, 200_000_000n, ts)]));
    const c = await alice.socket();
    c.send({ type: "subscribe", topic: "copy" });
    const snap = await c.next((m) => m.type === "snapshot" && m.topic === "copy");
    expect(snap.data.signals[0]).toMatchObject({ status: "pending", mint: curve.mint, delivered: false });
    expect(snap.data.tasks[0].stats.buySignals).toBe(1);
    c.ws.close();
  });
});
