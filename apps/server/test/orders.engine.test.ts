/**
 * The armed-orders engine end to end, offline: real Postgres (PGlite), the real core status machine and
 * trigger engine, a market on the real curve math, and a programmable chain. Nothing is sent anywhere:
 * live-mode tests record submissions, DRY_RUN tests simulate against the fake chain.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder } from "@solana/kit";
import {
  ADDRESS_LOOKUP_TABLE_PROGRAM_ID,
  type ArmedOrder,
  findAssociatedTokenAddress,
  type LiveMarketState,
  pickVariant,
} from "@zerofee/core";
import type { OrdersDelta } from "@zerofee/protocol";
import type { OrderEvent } from "../src/alerts/engine";
import { UserStore } from "../src/db/pg";
import { setLogLevel } from "../src/log";
import { loadOrdersConfig, type OrdersConfig } from "../src/orders/config";
import { OrderEngine } from "../src/orders/engine";
import { DryRunSubmitter, type Submitter } from "../src/orders/lanes";
import { ArmedOrdersRepo } from "../src/orders/repo";
import { addr, FakeCurve, synthTx } from "./helpers";
import { curveMarket, FakeChain, FakeHalt, FakeMarket, poolMarket, quoteOf, RecordingSubmitter } from "./orderFakes";
import { CREATOR, type SynthArgs, synthOrder } from "./orderFixtures";
import { pgliteDb, type TestDb } from "./pgHelpers";

setLogLevel("error");
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const AMOUNT = 10_000_000_000n;
const SOL = 1_000_000_000n;
const pct = (v: bigint, p: number) => (v * BigInt(Math.round(p * 100))) / 10_000n;

const M0 = curveMarket();
const Q0 = quoteOf("sell", AMOUNT, M0);
/** The price fell about 5.5%: below a 95% stop. */
const DROP = curveMarket({ vQuote: 37_800_000_000n });

interface Env {
  db: TestDb;
  store: UserStore;
  repo: ArmedOrdersRepo;
  engine: OrderEngine;
  chain: FakeChain;
  market: FakeMarket;
  submitter: Submitter;
  halt: FakeHalt;
  published: { userId: string; delta: OrdersDelta }[];
  notified: OrderEvent[];
  clock: { t: number };
  user(tag: string): Promise<string>;
  arm(userId: string, orders: ArmedOrder[], o?: { balances?: boolean }): Promise<void>;
  status(id: string): Promise<ArmedOrder>;
  close(): Promise<void>;
}

const envs: Env[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

async function makeEnv(
  o: { dryRun?: boolean; cfg?: Partial<OrdersConfig>; interfaceVersion?: () => string; db?: TestDb; start?: boolean; halt?: FakeHalt } = {},
): Promise<Env> {
  const db = o.db ?? (await pgliteDb());
  const store = new UserStore(db.db);
  const repo = new ArmedOrdersRepo(db.db);
  const chain = new FakeChain();
  const market = new FakeMarket();
  const halt = o.halt ?? new FakeHalt();
  const submitter: Submitter = o.dryRun ? new DryRunSubmitter(chain) : new RecordingSubmitter(false);
  const published: Env["published"] = [];
  const notified: OrderEvent[] = [];
  const clock = { t: T0 };
  const engine = new OrderEngine({
    cfg: { ...loadOrdersConfig({}), statePersistMs: 0, ...o.cfg },
    repo,
    market,
    chain,
    submitter,
    publish: (userId, delta) => published.push({ userId, delta }),
    notify: (ev) => notified.push(ev),
    halt,
    lookupTables: {},
    now: () => clock.t,
    ...(o.interfaceVersion ? { interfaceVersion: o.interfaceVersion } : {}),
  });
  if (o.start !== false) await engine.start({ timers: false });
  const env: Env = {
    db,
    store,
    repo,
    engine,
    chain,
    market,
    submitter,
    halt,
    published,
    notified,
    clock,
    user: async (tag) => (await store.users.upsertOnLogin(addr(`engine-${tag}`), T0)).id,
    async arm(userId, orders, a = {}) {
      for (const order of orders) {
        for (const at of order.attempts) chain.setNonce(at.nonce.account, order.wallet, at.nonce.value);
        if (a.balances !== false) {
          chain.lamports.set(order.wallet, 10n * SOL);
          if (order.side === "sell") {
            const ata = await findAssociatedTokenAddress(order.wallet, order.mint, order.frozen.baseTokenProgram);
            chain.tokens.set(ata, { mint: order.mint, owner: order.wallet, amount: order.amount });
          }
        }
        if (!market.quotes.has(order.mint)) market.setCurve(order.mint, M0);
      }
      const stored = await repo.insertBatch(
        userId,
        orders.map((order) => ({ order, triggerState: {} })),
        { now: clock.t, maxActive: 100 },
      );
      engine.admit(stored);
      await engine.settle();
    },
    async status(id) {
      const s = await repo.get(id);
      if (!s) throw new Error(`no order ${id}`);
      return s.order;
    },
    async close() {
      await engine.stop();
      if (!o.db) await db.close();
    },
  };
  envs.push(env);
  return env;
}

/** A full-exit stop-loss at 95% of the current quote, grid at 94 / 92 / 90%. */
function stopLoss(a: SynthArgs = {}): ArmedOrder {
  return synthOrder({
    amount: AMOUNT,
    trigger: { type: "quote-at-most", threshold: pct(Q0, 95) },
    minOuts: [pct(Q0, 94), pct(Q0, 92), pct(Q0, 90)],
    armingQuoteOut: Q0,
    ...a,
  });
}

/** The variant the engine must choose at `market` (highest min-out 1% below the live quote, lowest tip). */
function expectedVariant(o: ArmedOrder, market: LiveMarketState, attempt = 0) {
  const v = pickVariant(o.attempts[attempt]?.variants ?? [], quoteOf(o.side, o.amount, market), { safetyMarginBps: 100 });
  if (!v) throw new Error("no variant clears");
  return v;
}

/** Signature of attempt `i`'s pre-signed cancel. */
function cancelSig(o: ArmedOrder, i = 0): string {
  const sig = o.attempts[i]?.nonce.cancel.signature;
  if (!sig) throw new Error(`no attempt ${i}`);
  return sig;
}

async function tick(env: Env, scope: "hot" | "all" = "hot"): Promise<void> {
  await env.engine.pollNonces(scope);
  await env.engine.settle();
}

async function sweep(env: Env): Promise<void> {
  await env.engine.sweep();
  await env.engine.settle();
}

const lastView = (env: Env, id: string) =>
  env.published
    .flatMap((p) => p.delta.upsert)
    .filter((v) => v.id === id)
    .at(-1);

// ---------------------------------------------------------------------------------------------

describe("trigger -> submit", () => {
  test("DRY_RUN: the trigger fires, the chosen variant is simulated, nothing is sent and nothing misses", async () => {
    const env = await makeEnv({ dryRun: true });
    const uid = await env.user("dry");
    const o = stopLoss();
    await env.arm(uid, [o]);
    await sweep(env);
    expect(env.chain.simulations).toEqual([]);
    expect(await env.engine.lookupTables()).toEqual({});

    env.market.setCurve(o.mint, DROP);
    await sweep(env);
    const v = expectedVariant(o, DROP);
    expect(v.minOut).toBe(pct(Q0, 92));
    expect(env.chain.simulations).toEqual([v.tx.wireBase64]);
    const s = await env.repo.get(o.id);
    expect(s?.dryRun).toBe(true);
    expect(s?.order).toMatchObject({ status: "submitted" });
    expect(s?.order.attempts[0]).toMatchObject({ status: "submitted", submittedVariantId: v.id, submittedAtSlot: 1_000n });
    const events = await env.repo.events(o.id);
    expect(events.map((e) => e.type)).toEqual(["armed", "submitted", "submitted", "simulated"]);
    expect(events[3]?.message).toContain("DRY_RUN: simulated");
    expect(lastView(env, o.id)).toMatchObject({ status: "submitted", dryRun: true });

    // A simulation never lands: no miss, no cancel.
    env.chain.slot += 500;
    env.clock.t += 600_000;
    await tick(env);
    expect((await env.status(o.id)).status).toBe("submitted");
    expect(env.chain.simulations).toHaveLength(1);
  });

  test("live: the variant goes only to the protected lane; the fill is resolved from the nonce and notified", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("live");
    const o = stopLoss();
    await env.arm(uid, [o]);
    env.market.setCurve(o.mint, DROP);
    // The ingest stream triggers the evaluation (a trade on the mint).
    const curve = new FakeCurve(o.mint, CREATOR);
    env.engine.onIngestTx(synthTx(500, [curve.buy(addr("someone"), 1_000_000n, 1_791_048_900)]));
    await env.engine.settle();
    const v = expectedVariant(o, DROP);
    expect(sub.variants).toEqual([v.tx.wireBase64]);
    expect(sub.cancels).toEqual([]);
    expect(lastView(env, o.id)?.attempts[0]).toMatchObject({ status: "submitted", submittedVariantId: v.id, submittedAtSlot: 1_000 });

    env.chain.land(v.tx.signature, { nonce: o.attempts[0]?.nonce.account as string });
    await tick(env);
    const done = await env.status(o.id);
    expect(done.status).toBe("filled");
    expect(done.attempts[0]).toMatchObject({ status: "landed-ok", consumedBy: v.tx.signature });
    expect(lastView(env, o.id)).toMatchObject({ status: "filled", signature: v.tx.signature, open: false });
    expect(env.notified).toEqual([
      expect.objectContaining({ event: "filled", kind: "stop-loss", status: "filled", signature: v.tx.signature }),
    ]);
    expect(env.engine.openCount).toBe(0);
    expect(env.engine.watches(o.mint)).toBe(false);
    expect((await env.repo.events(o.id)).map((e) => e.type)).toEqual(["armed", "submitted", "submitted", "sent", "nonce-consumed"]);
  });

  test("the tip level follows the live Jito tip floor", async () => {
    const env = await makeEnv();
    env.market.tipFloor = 15_000n; // level 0 tips 10,000, level 1 tips 20,000
    const uid = await env.user("tip");
    const o = stopLoss();
    await env.arm(uid, [o]);
    env.market.setCurve(o.mint, DROP);
    await sweep(env);
    expect((await env.status(o.id)).attempts[0]?.submittedVariantId).toMatch(/\/1$/);
  });
});

describe("nonce-consumed handling", () => {
  test("landed but failed: a single attempt is consumed (re-arm); a ladder moves on and a fill cancels the rest", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("ladder");

    const single = stopLoss();
    await env.arm(uid, [single]);
    env.market.setCurve(single.mint, DROP);
    await sweep(env);
    const sv = expectedVariant(single, DROP);
    env.chain.land(sv.tx.signature, {
      nonce: single.attempts[0]?.nonce.account as string,
      err: { InstructionError: [3, { Custom: 6003 }] },
    });
    await tick(env);
    expect((await env.status(single.id)).status).toBe("failed-consumed");
    expect(env.notified.at(-1)).toMatchObject({ event: "consumed", status: "failed-consumed" });

    const ladder = stopLoss({ mint: addr("ladder-mint"), attempts: 3 });
    env.market.setCurve(ladder.mint, M0);
    await env.arm(uid, [ladder]);
    env.market.setCurve(ladder.mint, DROP);
    await sweep(env);
    const a0 = expectedVariant(ladder, DROP, 0);
    expect(sub.variants.at(-1)).toBe(a0.tx.wireBase64);
    env.chain.land(a0.tx.signature, { nonce: ladder.attempts[0]?.nonce.account as string, err: { InstructionError: [3, "Custom"] } });
    await tick(env);
    let s = await env.status(ladder.id);
    expect(s.status).toBe("armed");
    expect(s.attempts.map((a) => a.status)).toEqual(["landed-failed", "live", "live"]);
    expect(env.notified.at(-1)).toMatchObject({ event: "ladder-continues" });

    await sweep(env); // the price is still below the stop: the next nonce fires
    const a1 = expectedVariant(ladder, DROP, 1);
    expect(sub.variants.at(-1)).toBe(a1.tx.wireBase64);
    env.chain.land(a1.tx.signature, { nonce: ladder.attempts[1]?.nonce.account as string });
    await tick(env);
    s = await env.status(ladder.id);
    expect(s.status).toBe("filled");
    expect(s.attempts.map((a) => a.status)).toEqual(["landed-failed", "landed-ok", "cancelling"]);
    expect(sub.cancels.map((c) => c.signature)).toEqual([cancelSig(ladder, 2)]);

    // The third nonce's cancel lands: nothing of the order is open any more.
    env.chain.land(cancelSig(ladder, 2), { nonce: ladder.attempts[2]?.nonce.account as string });
    await tick(env);
    expect((await env.status(ladder.id)).attempts[2]?.status).toBe("burned");
    expect(env.engine.openCount).toBe(0);
  });

  test("OCO: the partner's fill burns the shared nonce, cancels this order and fires its extra ladder nonce's cancel", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("oco");
    const tp = synthOrder({
      kind: "take-profit",
      amount: AMOUNT,
      trigger: { type: "quote-at-least", threshold: pct(Q0, 105) },
      minOuts: [pct(Q0, 104)],
      armingQuoteOut: Q0,
      nonceTags: ["oco"],
      ocoGroup: "pair",
    });
    const sl = stopLoss({ nonceTags: ["oco", "sl-extra"], attempts: 2, ocoGroup: "pair" });
    expect(sl.attempts[0]?.nonce).toEqual(tp.attempts[0]?.nonce as never);
    await env.arm(uid, [tp, sl]);
    env.market.setCurve(sl.mint, DROP);
    await sweep(env);
    const v = expectedVariant(sl, DROP);
    expect(sub.variants).toEqual([v.tx.wireBase64]); // the take-profit never fires on the busy nonce
    env.chain.land(v.tx.signature, { nonce: sl.attempts[0]?.nonce.account as string });
    await tick(env);
    expect((await env.status(sl.id)).status).toBe("filled");
    const tpNow = await env.status(tp.id);
    expect(tpNow).toMatchObject({ status: "cancelled", statusReason: `OCO sibling ${sl.id} filled` });
    expect(tpNow.attempts[0]).toMatchObject({ status: "burned", consumedBy: v.tx.signature });
    expect(sub.cancels.map((c) => c.signature)).toEqual([cancelSig(sl, 1)]);
    expect(env.notified.map((n) => [n.orderId, n.event]).sort()).toEqual(
      [
        [sl.id, "filled"],
        [tp.id, "cancelled"],
      ].sort(),
    );
  });

  test("a nonce advanced by someone else: our own landed variant still fills; a foreign transaction cancels; a vanished slot is stale", async () => {
    const env = await makeEnv();
    const uid = await env.user("foreign");
    // Our variant landed without the engine sending it (truth wins).
    const leaked = stopLoss();
    await env.arm(uid, [leaked]);
    const lv = leaked.attempts[0]?.variants[0];
    if (!lv) throw new Error("fixture");
    env.chain.land(lv.tx.signature, { nonce: leaked.attempts[0]?.nonce.account as string });
    await tick(env, "all");
    expect((await env.status(leaked.id)).status).toBe("filled");

    // Someone else's transaction advanced the nonce: three polls without our signature, then the history decides.
    const other = stopLoss({ mint: addr("foreign-mint") });
    await env.arm(uid, [other]);
    const account = other.attempts[0]?.nonce.account as string;
    env.chain.setNonce(account, other.wallet, "Fz4ExMMmt5dyMX1oDkz7wDBgCV9iyZ8Q2wcKsm2tPkU5");
    env.chain.history.set(account, [
      { signature: "ForeignSig1111111111111111111111111111111111111111111111111111111111111111111111111111", slot: 1_000, err: null },
    ]);
    await tick(env, "all");
    await tick(env, "all");
    expect((await env.status(other.id)).status).toBe("armed");
    await tick(env, "all");
    expect(await env.status(other.id)).toMatchObject({
      status: "cancelled",
      statusReason: expect.stringContaining("nonce consumed by another transaction"),
    });

    const gone = stopLoss({ mint: addr("gone-mint") });
    await env.arm(uid, [gone]);
    env.chain.nonces.set(gone.attempts[0]?.nonce.account as string, null);
    await tick(env, "all");
    const goneNow = await env.status(gone.id);
    expect(goneNow).toMatchObject({ status: "stale", statusReason: expect.stringContaining("nonce-missing") });
    expect(goneNow.attempts[0]?.status).toBe("burned"); // closed: nothing left to watch
    expect(env.engine.openCount).toBe(0);
    expect(env.notified.at(-1)).toMatchObject({ orderId: gone.id, event: "stale" });
  });
});

describe("misses", () => {
  test("an attempt that misses its window gets its cancel fired (and re-sent); the cancel burns the nonce", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("miss");
    const o = stopLoss();
    await env.arm(uid, [o]);
    env.market.setCurve(o.mint, DROP);
    await sweep(env);
    const v = expectedVariant(o, DROP);
    // Inside the window: re-sent to the protected lane after resendMs, no cancel.
    env.chain.slot = 1_004;
    env.clock.t += 1_000;
    await tick(env);
    expect(sub.variants).toEqual([v.tx.wireBase64, v.tx.wireBase64]);
    expect(sub.cancels).toEqual([]);
    // Past missSlots (8): submit-missed fires the cancel.
    env.chain.slot = 1_008;
    await tick(env);
    const cancel = o.attempts[0]?.nonce.cancel;
    expect(sub.cancels.map((c) => c.signature)).toEqual([cancelSig(o)]);
    let s = await env.status(o.id);
    expect(s.status).toBe("submitted");
    expect(s.attempts[0]?.status).toBe("cancelling");
    expect(env.notified.at(-1)).toMatchObject({ event: "missed" });
    // Re-sent until the nonce advances.
    env.clock.t += 2_000;
    await tick(env);
    expect(sub.cancels).toHaveLength(2);
    env.chain.land(cancel?.signature as string, { nonce: o.attempts[0]?.nonce.account as string });
    await tick(env);
    s = await env.status(o.id);
    expect(s).toMatchObject({ status: "failed-consumed" });
    expect(s.attempts[0]).toMatchObject({ status: "burned", consumedBy: cancel?.signature });
    expect(env.notified.at(-1)).toMatchObject({ event: "consumed" });
    expect((await env.repo.events(o.id)).map((e) => e.type)).toContain("submit-missed");
  });

  test("truth wins: the late variant lands after the cancel was fired", async () => {
    const env = await makeEnv();
    const uid = await env.user("late");
    const o = stopLoss();
    await env.arm(uid, [o]);
    env.market.setCurve(o.mint, DROP);
    await sweep(env);
    env.chain.slot = 1_020;
    await tick(env);
    const v = expectedVariant(o, DROP);
    env.chain.land(v.tx.signature, { nonce: o.attempts[0]?.nonce.account as string });
    await tick(env);
    expect((await env.status(o.id)).status).toBe("filled");
  });

  test("restart: the miss window survives the process (the submission was persisted before sending)", async () => {
    const db = await pgliteDb();
    try {
      const a = await makeEnv({ db });
      const uid = await a.user("restart");
      const o = stopLoss();
      await a.arm(uid, [o]);
      a.market.setCurve(o.mint, DROP);
      await sweep(a);
      expect((a.submitter as RecordingSubmitter).variants).toHaveLength(1);
      await a.engine.stop();

      const b = await makeEnv({ db });
      for (const at of o.attempts) b.chain.setNonce(at.nonce.account, o.wallet, at.nonce.value);
      expect(b.engine.openCount).toBe(1);
      b.chain.slot = 1_010;
      await tick(b);
      expect((b.submitter as RecordingSubmitter).cancels.map((c) => c.signature)).toEqual([cancelSig(o, 0)]);
    } finally {
      for (const e of envs.splice(0)) await e.close();
      await db.close();
    }
  });
});

describe("kill switches and user cancels", () => {
  test("Panic cancels one user's orders; the admin halt fires every remaining cancel and stops submissions", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const alice = await env.user("alice");
    const bob = await env.user("bob");
    const a1 = stopLoss();
    const a2 = stopLoss({ mint: addr("alice-2") });
    const b1 = stopLoss({ mint: addr("bob-1"), wallet: addr("bob-wallet") });
    await env.arm(alice, [a1, a2]);
    await env.arm(bob, [b1]);

    const panic = await env.engine.panic(alice);
    await env.engine.settle();
    expect(panic.cancelled).toBe(2);
    expect(panic.orders.map((o) => o.status)).toEqual(["cancelled", "cancelled"]);
    expect(sub.cancels.map((c) => c.signature).sort()).toEqual([a1, a2].map((o) => cancelSig(o)).sort());
    expect((await env.status(b1.id)).status).toBe("armed");
    expect((await env.status(a1.id)).statusReason).toBe("panic");

    env.halt.set(true, "incident");
    await env.engine.settle();
    expect(await env.status(b1.id)).toMatchObject({ status: "cancelled", statusReason: "admin halt: incident" });
    expect(sub.cancels.map((c) => c.signature)).toContain(cancelSig(b1, 0));
    // Nothing is submitted while halted, even when a trigger condition holds.
    const late = stopLoss({ mint: addr("after-halt") });
    await env.arm(bob, [late]);
    env.market.setCurve(late.mint, DROP);
    await sweep(env);
    expect(sub.variants).toEqual([]);
  });

  test("an engine starting halted fires the stored cancels", async () => {
    const halt = new FakeHalt();
    const env = await makeEnv({ start: false, halt });
    const uid = await env.user("start-halted");
    const o = stopLoss();
    await env.repo.insertBatch(uid, [{ order: o, triggerState: {} }], { now: T0, maxActive: 5 });
    halt.set(true, null);
    await env.engine.start({ timers: false });
    await env.engine.settle();
    expect((env.submitter as RecordingSubmitter).cancels.map((c) => c.signature)).toEqual([cancelSig(o, 0)]);
    expect((await env.status(o.id)).status).toBe("cancelled");
  });

  test("cancelling one leg of an OCO pair cancels its partner; the shared cancel is sent once", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("oco-cancel");
    const tp = synthOrder({
      kind: "take-profit",
      amount: AMOUNT,
      trigger: { type: "quote-at-least", threshold: pct(Q0, 110) },
      minOuts: [pct(Q0, 108)],
      armingQuoteOut: Q0,
      nonceTags: ["pair2"],
      ocoGroup: "g2",
    });
    const sl = stopLoss({ nonceTags: ["pair2", "pair2-extra"], attempts: 2, ocoGroup: "g2" });
    await env.arm(uid, [tp, sl]);
    expect(await env.engine.cancel(await env.user("stranger"), tp.id)).toBeNull();
    const views = await env.engine.cancel(uid, tp.id);
    await env.engine.settle();
    expect(views?.map((v) => [v.id, v.status])).toEqual([
      [tp.id, "cancelled"],
      [sl.id, "cancelled"],
    ]);
    expect((await env.status(sl.id)).statusReason).toBe(`cancelled with its OCO partner ${tp.id}`);
    expect(sub.cancels.map((c) => c.signature).sort()).toEqual([cancelSig(sl, 0), cancelSig(sl, 1)].sort());
  });

  test("the database being down never stops the halt's cancels", async () => {
    const env = await makeEnv();
    const uid = await env.user("db-down");
    const o = stopLoss();
    await env.arm(uid, [o]);
    env.repo.saveState = async () => {
      throw new Error("database unavailable");
    };
    env.halt.set(true, "db outage drill");
    await env.engine.settle();
    expect((env.submitter as RecordingSubmitter).cancels.map((c) => c.signature)).toEqual([cancelSig(o, 0)]);
  });
});

describe("operator lookup tables", () => {
  test("read at finalized commitment (lookups resolve against the root bank) and retried until every table exists", async () => {
    const table = addr("op-table") as Address;
    const env = await makeEnv({ cfg: { lookupTables: [table] }, start: false });
    // makeEnv pins tables for the other tests; this engine must read them from chain.
    const engine = new OrderEngine({
      cfg: { ...loadOrdersConfig({}), lookupTables: [table] },
      repo: env.repo,
      market: env.market,
      chain: env.chain,
      submitter: env.submitter,
      publish: () => {},
      notify: () => {},
      now: () => env.clock.t,
    });
    await engine.start({ timers: false });
    expect(engine.lookupTables()).toEqual({});
    expect(env.chain.calls.find((c) => c.method === "accounts")?.commitment).toBe("finalized");
    const entries = [addr("e1"), addr("e2")] as Address[];
    const data = new Uint8Array(56 + 32 * entries.length);
    const view = new DataView(data.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, (1n << 64n) - 1n, true);
    entries.forEach((e, i) => data.set(getAddressEncoder().encode(e), 56 + 32 * i));
    env.chain.raw.set(table, { address: table, owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data });
    await engine.sweep(); // within the retry delay: no read yet
    await engine.settle();
    expect(engine.lookupTables()).toEqual({});
    env.clock.t += 5_000;
    await engine.sweep();
    await engine.settle();
    expect(engine.lookupTables()).toEqual({ [table]: entries });
    await engine.stop();
  });
});

describe("staleness and balance checks", () => {
  test("a creator change or a migration strands the order: it goes stale, its cancel fires, the user is told to re-arm", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("stale");
    const creator = stopLoss();
    const migrated = stopLoss({ mint: addr("migrated-mint") });
    await env.arm(uid, [creator, migrated]);
    env.market.facts.set(creator.mint, { curve: { creator: addr("new-creator") as Address, complete: false } });
    env.market.facts.set(migrated.mint, { curve: { creator: CREATOR, complete: true }, pool: null });
    await env.engine.checkStaleness();
    await env.engine.settle();
    expect(await env.status(creator.id)).toMatchObject({ status: "stale", statusReason: expect.stringContaining("creator-changed") });
    expect(await env.status(migrated.id)).toMatchObject({ status: "stale", statusReason: expect.stringContaining("migrated") });
    expect(sub.cancels).toHaveLength(2);
    expect(env.notified.filter((n) => n.event === "stale")).toHaveLength(2);
  });

  test("a pump interface change only flags the order (once)", async () => {
    const env = await makeEnv({ interfaceVersion: () => "pump:000000000000|pump_amm:000000000000|pump_fees:000000000000" });
    const uid = await env.user("flag");
    const o = stopLoss();
    await env.arm(uid, [o]);
    await env.engine.checkStaleness();
    await env.engine.settle();
    const s = await env.status(o.id);
    expect(s).toMatchObject({ status: "armed", flags: ["interface-upgrade"] });
    expect(env.notified.filter((n) => n.event === "flagged")).toHaveLength(1);
    expect((env.submitter as RecordingSubmitter).cancels).toEqual([]);
  });

  test("before submitting: a full exit whose balance changed goes stale; a buy without its SOL is held; a failed read submits anyway", async () => {
    const env = await makeEnv();
    const sub = env.submitter as RecordingSubmitter;
    const uid = await env.user("balance");
    const o = stopLoss();
    await env.arm(uid, [o]);
    const ata = await findAssociatedTokenAddress(o.wallet, o.mint, o.frozen.baseTokenProgram);
    env.chain.tokens.set(ata, { mint: o.mint, owner: o.wallet, amount: o.amount - 1n });
    env.market.setCurve(o.mint, DROP);
    await sweep(env);
    expect(sub.variants).toEqual([]);
    expect(await env.status(o.id)).toMatchObject({ status: "stale", statusReason: expect.stringContaining("balance-changed") });

    // Limit buy: tokens out for 0.5 SOL at least 102% of now (fires after a price drop).
    const spend = SOL / 2n;
    const out0 = quoteOf("buy", spend, M0);
    const buyer = addr("poor-wallet");
    const buy = synthOrder({
      side: "buy",
      kind: "limit-buy",
      mint: addr("buy-mint"),
      wallet: buyer,
      amount: spend,
      trigger: { type: "quote-at-least", threshold: pct(out0, 102) },
      minOuts: [pct(out0, 100)],
      tipLevels: [0],
      armingQuoteOut: out0,
      reservationLamports: spend + 100_000n,
    });
    await env.arm(uid, [buy], { balances: false });
    env.chain.lamports.set(buyer, SOL / 10n);
    env.market.setCurve(buy.mint, DROP);
    await sweep(env);
    expect(sub.variants).toEqual([]);
    expect((await env.status(buy.id)).status).toBe("armed");
    expect(env.notified.at(-1)).toMatchObject({ orderId: buy.id, event: "held", detail: expect.stringContaining("lamports") });
    expect((await env.repo.events(buy.id)).map((e) => e.type)).toContain("held");

    env.chain.failAccounts = true; // the read fails: best effort, the order still fires
    await sweep(env);
    expect(sub.variants).toEqual([expectedVariant(buy, DROP).tx.wireBase64]);
  });
});

describe("market events and trigger state", () => {
  test("a dev sell seen on the stream fires a dev-sell exit; the sticky flag is persisted", async () => {
    const env = await makeEnv();
    const uid = await env.user("dev-sell");
    const o = synthOrder({
      kind: "dev-sell-exit",
      amount: AMOUNT,
      trigger: { type: "dev-sell", creator: CREATOR, minTokenAmount: 1_000n },
      minOuts: [pct(Q0, 97), pct(Q0, 95)],
      armingQuoteOut: Q0,
    });
    await env.arm(uid, [o]);
    const curve = new FakeCurve(o.mint, CREATOR);
    env.engine.onIngestTx(synthTx(600, [curve.buy(addr("not-the-dev"), 5_000_000n, 1_791_048_900)]));
    await env.engine.settle();
    expect((env.submitter as RecordingSubmitter).variants).toEqual([]);
    env.engine.onIngestTx(synthTx(601, [curve.sell(CREATOR, 5_000_000_000n, 1_791_048_901)]));
    await env.engine.settle();
    expect((env.submitter as RecordingSubmitter).variants).toEqual([expectedVariant(o, M0).tx.wireBase64]);
    expect((await env.repo.get(o.id))?.triggerState.devSold).toBe(true);
  });

  test("a migration snipe waits for the migration event and the live pool", async () => {
    const env = await makeEnv();
    const uid = await env.user("snipe");
    const spend = SOL / 10n;
    const pool = poolMarket();
    const out = quoteOf("buy", spend, pool);
    const o = synthOrder({
      side: "buy",
      kind: "migration-snipe",
      venues: ["pumpswap"],
      amount: spend,
      trigger: { type: "migration" },
      minOuts: [pct(out, 95)],
      tipLevels: [0],
      armingQuoteOut: out,
      reservationLamports: spend + 100_000n,
    });
    await env.arm(uid, [o]); // the coin still trades on its curve
    await sweep(env);
    expect((env.submitter as RecordingSubmitter).variants).toEqual([]);
    env.market.quotes.set(o.mint, { venue: "pumpswap", market: pool });
    env.engine.onIngestTx(
      synthTx(700, [
        {
          kind: "pumpMigrate",
          user: addr("migrator") as Address,
          mint: o.mint,
          mintAmount: 200_000_000_000_000n,
          solAmount: 85_000_000_000n,
          poolMigrationFee: 0n,
          bondingCurve: addr("bc") as Address,
          timestamp: 1_791_048_999n,
          pool: addr("pool") as Address,
          quoteMint: addr("q") as Address,
        },
      ]),
    );
    await env.engine.settle();
    expect((env.submitter as RecordingSubmitter).variants).toEqual([o.attempts[0]?.variants[0]?.tx.wireBase64 as string]);
  });

  test("a trailing stop follows the price up, persists its high-water mark and fires on the pullback", async () => {
    const env = await makeEnv();
    const uid = await env.user("trail");
    const up = curveMarket({ vQuote: 44_000_000_000n });
    const qUp = quoteOf("sell", AMOUNT, up);
    const o = synthOrder({
      kind: "trailing-stop",
      amount: AMOUNT,
      trigger: { type: "trailing", trailBps: 500 },
      minOuts: [pct(qUp, 94), pct(qUp, 90), pct(qUp, 85)],
      armingQuoteOut: qUp,
    });
    await env.arm(uid, [o]);
    env.market.setCurve(o.mint, up);
    await sweep(env);
    expect((await env.repo.get(o.id))?.triggerState.highWater).toBe(qUp);
    expect(lastView(env, o.id)?.highWater).toBe(qUp.toString());
    expect((env.submitter as RecordingSubmitter).variants).toEqual([]);
    const pullback = curveMarket({ vQuote: 41_000_000_000n }); // about 7% below the high
    env.market.setCurve(o.mint, pullback);
    await sweep(env);
    expect((env.submitter as RecordingSubmitter).variants).toEqual([expectedVariant(o, pullback).tx.wireBase64]);
  });
});
