/**
 * POST /api/orders/armed and the order endpoints through the real server (SIWS session, CSRF, PGlite),
 * with genuinely signed armed orders from @zerofee/core, a fake chain for nonce reads and the operator
 * lookup table pinned. DRY_RUN (the default) means nothing is ever sent; cancels are simulated.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Address, AddressesByLookupTableAddress, KeyPairSigner } from "@solana/kit";
import {
  type ArmedOrder,
  type ArmedOrderSpec,
  armedOrderToJson,
  armOcoPair,
  armOrder,
  jitoTipLevels,
  minOutGrid,
  pumpBuyTemplate,
  pumpSellTemplate,
  type TipLevel,
} from "@zerofee/core";
import type {
  ArmOrdersResponse,
  ArmRejection,
  CancelOrderResponse,
  NonceProbeResponse,
  NonceSlotsResponse,
  OrderDetailResponse,
  OrderLimits,
  OrdersListResponse,
  PanicResponse,
} from "@zerofee/protocol";
import { armedWallet, curveContext, nonceRefs, operatorTables, TIP_LEVELS } from "../../../packages/core/test/armedTestKit";
import { addr } from "./helpers";
import { FakeChain } from "./orderFakes";
import { Browser, startUserApp, type UserTestEnv } from "./userHelpers";

const AMOUNT = 1_234_567_890n;
let env: UserTestEnv;
let tables: AddressesByLookupTableAddress;
const chain = new FakeChain();

beforeAll(async () => {
  tables = await operatorTables();
  env = await startUserApp({
    env: { ORDERS_MAX_NOTIONAL_SOL: "0.07", ORDERS_MAX_OPEN_PER_USER: "3" },
    orders: { lookupTables: tables, chain, timers: false },
  });
}, 60_000);
afterAll(async () => {
  await env.close();
});

/** A signed-in user with a registered trading wallet. */
async function trader(): Promise<{ b: Browser; signer: KeyPairSigner }> {
  const b = new Browser(env);
  await b.signIn();
  const signer = await armedWallet();
  const r = await b.req("POST", "/api/trading-wallets", { publicKey: signer.address });
  expect(r.status).toBe(200);
  return { b, signer };
}

/** Registers every nonce of the orders on the fake chain at the value they were signed against. */
function onChain(...orders: ArmedOrder[]): void {
  for (const o of orders) for (const a of o.attempts) chain.setNonce(a.nonce.account, o.wallet, a.nonce.value);
}

async function stopLossSpec(signer: KeyPairSigner, over: Partial<ArmedOrderSpec> & { nonceFrom?: number } = {}): Promise<ArmedOrderSpec> {
  const curve = await curveContext(signer.address);
  const { nonceFrom, ...rest } = over;
  return {
    id: crypto.randomUUID(),
    kind: "stop-loss",
    wallet: signer.address,
    mint: curve.mint,
    amount: AMOUNT,
    fullExit: true,
    trigger: { type: "quote-at-most", threshold: 30_000_000n },
    templates: [await pumpSellTemplate(curve, { amount: AMOUNT, closeBaseAccount: true })],
    minOuts: minOutGrid(30_000_000n, [0, 300, 600, 900]),
    tipLevels: TIP_LEVELS,
    nonces: await nonceRefs(signer.address, 1, nonceFrom ?? 0),
    armingQuoteOut: 40_000_000n,
    lookupTables: tables,
    ...rest,
  };
}

async function stopLoss(signer: KeyPairSigner, over: Partial<ArmedOrderSpec> & { nonceFrom?: number } = {}): Promise<ArmedOrder> {
  const o = await armOrder(await stopLossSpec(signer, over), signer);
  onChain(o);
  return o;
}

const post = (b: Browser, body: string) => b.json<ArmOrdersResponse & ArmRejection>("POST", "/api/orders/armed", body);
const codes = (r: { body: ArmRejection }) => [...new Set(r.body.violations.map((v) => v.code))];
const tamper = (o: ArmedOrder, fn: (j: Record<string, unknown>) => void): string => {
  const j = JSON.parse(armedOrderToJson(o));
  fn(j);
  return JSON.stringify(j);
};

describe("intake: accepted", () => {
  test("a browser-armed stop-loss is accepted, stored, published and listed (signed bytes never come back)", async () => {
    const { b, signer } = await trader();
    const ws = await b.socket();
    ws.send({ type: "subscribe", topic: "orders" });
    await ws.next((m) => m.topic === "orders" && m.type === "snapshot");
    const o = await stopLoss(signer);
    const r = await post(b, armedOrderToJson(o));
    expect(r.status).toBe(201);
    expect(r.body.orders[0]).toMatchObject({
      id: o.id,
      status: "armed",
      kind: "stop-loss",
      wallet: signer.address,
      open: true,
      dryRun: false,
    });
    const delta = await ws.next((m) => m.topic === "orders" && m.type === "delta");
    expect(delta.data.upsert[0].id).toBe(o.id);

    const list = await b.json<OrdersListResponse>("GET", "/api/orders");
    expect(list.body.orders.map((x) => x.id)).toEqual([o.id]);
    const detail = await b.json<OrderDetailResponse>("GET", `/api/orders/${o.id}`);
    expect(detail.body.events.map((e) => e.type)).toEqual(["armed"]);
    const text = JSON.stringify([list.body, detail.body, delta.data]);
    for (const v of o.attempts[0]?.variants ?? []) expect(text).not.toContain(v.tx.wireBase64);
    expect(text).not.toContain(o.attempts[0]?.nonce.cancel.wireBase64 as string);

    const slots = await b.json<NonceSlotsResponse>("GET", "/api/orders/nonce-slots");
    expect(slots.body.slots).toEqual([
      expect.objectContaining({ nonceAccount: o.attempts[0]?.nonce.account, status: "in-use", orderId: o.id }),
    ]);
    const limits = await b.json<OrderLimits>("GET", "/api/orders/limits");
    expect(limits.body).toMatchObject({
      openOrders: 1,
      armedNotionalLamports: "40000000",
      maxOpenOrders: 3,
      dryRun: true,
      lookupTables: Object.keys(tables),
    });
    // Another user sees nothing of it.
    const stranger = new Browser(env);
    await stranger.signIn();
    expect((await stranger.json("GET", `/api/orders/${o.id}`)).status).toBe(404);
    expect((await stranger.json<OrdersListResponse>("GET", "/api/orders")).body.orders).toEqual([]);
    ws.ws.close();
  });

  test("an OCO pair arrives as one atomic batch", async () => {
    const { b, signer } = await trader();
    const [nonce] = await nonceRefs(signer.address, 1, 7);
    const base = await stopLossSpec(signer);
    const { nonces: _n, ...rest } = base;
    const [tp, sl] = await armOcoPair(
      {
        group: "g1",
        nonce: nonce as never,
        takeProfit: {
          ...rest,
          id: crypto.randomUUID(),
          kind: "take-profit",
          trigger: { type: "quote-at-least", threshold: 39_000_000n },
          minOuts: [38_000_000n],
        },
        stopLoss: { ...rest, id: crypto.randomUUID() },
      },
      signer,
    );
    onChain(tp, sl);
    const r = await post(b, `{"orders":[${armedOrderToJson(tp)},${armedOrderToJson(sl)}]}`);
    expect(r.status).toBe(201);
    expect(r.body.orders.map((o) => [o.kind, o.ocoGroup])).toEqual([
      ["take-profit", "g1"],
      ["stop-loss", "g1"],
    ]);
    // Exclusive (one nonce): the pair counts once against the notional cap.
    expect((await b.json<OrderLimits>("GET", "/api/orders/limits")).body.armedNotionalLamports).toBe("40000000");
  });
});

describe("intake: refused", () => {
  test("authentication, CSRF, malformed bodies and someone else's wallet", async () => {
    const { b, signer } = await trader();
    const o = await stopLoss(signer);
    const json = armedOrderToJson(o);
    // No session: 401 (with our Origin); no Origin at all is refused first (CSRF).
    expect((await new Browser(env).req("POST", "/api/orders/armed", json)).status).toBe(401);
    expect((await fetch(`${env.base}/api/orders/armed`, { method: "POST", body: json })).status).toBe(403);
    const evil = new Browser(env, "https://evil.example");
    evil.cookie = b.cookie;
    expect((await evil.req("POST", "/api/orders/armed", json)).status).toBe(403);

    const bad = await post(b, "{not json");
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "bad_request", violations: [{ code: "malformed" }] });
    expect(
      (
        await post(
          b,
          tamper(o, (j) => (j.id = "not-a-uuid")),
        )
      ).body.error,
    ).toContain("lowercase UUID");

    const other = new Browser(env);
    await other.signIn(); // did not register this trading wallet
    const r = await post(other, json);
    expect(r.status).toBe(403);
    expect(codes(r)).toEqual(["wallet-not-yours"]);
  });

  test("forged or mismatched signed bytes", async () => {
    const { b, signer } = await trader();
    const o = await stopLoss(signer);
    const minOut = await post(
      b,
      tamper(o, (j) => {
        const v = (j.attempts as { variants: { minOut: { $bigint: string } }[] }[])[0]!.variants[0]!;
        v.minOut = { $bigint: "1" };
      }),
    );
    expect(minOut.status).toBe(400);
    expect(codes(minOut)).toContain("trade-mismatch");

    const amount = await post(
      b,
      tamper(o, (j) => (j.amount = { $bigint: (AMOUNT + 1n).toString() })),
    );
    expect(codes(amount)).toContain("trade-mismatch");

    const other = await stopLoss(signer, { nonceFrom: 3 });
    const swapped = await post(
      b,
      tamper(o, (j) => {
        (j.attempts as { nonce: { cancel: unknown } }[])[0]!.nonce.cancel = JSON.parse(armedOrderToJson(other)).attempts[0].nonce.cancel;
      }),
    );
    expect(swapped.status).toBe(400);
    expect(codes(swapped)).toEqual(expect.arrayContaining(["nonce-instruction", "lifetime-mismatch"]));
  });

  test("server rules: Jito tip, jitodontfront marker, operator lookup tables, reservation, the user's own per-trade cap", async () => {
    const { b, signer } = await trader();
    const heliusOnly: TipLevel[] = [{ level: 0, cuPriceMicroLamports: 100_000n, tips: [{ lane: "helius", lamports: 10_000n }] }];
    const noJito = await post(b, armedOrderToJson(await stopLoss(signer, { tipLevels: heliusOnly, minOuts: [30_000_000n] })));
    expect(noJito.status).toBe(400);
    // core puts the jitodontfront marker on the Jito tip, so a Helius-only variant lacks both.
    expect(codes(noJito)).toEqual(["jito-tip-missing", "dontfront-missing"]);

    const noMarker = await post(
      b,
      armedOrderToJson(await stopLoss(signer, { jitoDontFront: false, minOuts: [30_000_000n], tipLevels: TIP_LEVELS.slice(0, 1) })),
    );
    expect(codes(noMarker)).toEqual(["dontfront-missing"]);

    const foreignTable = addr("not-an-operator-table") as Address;
    const strangeTables = { [foreignTable]: Object.values(tables)[0] as Address[] };
    const unknownTable = await post(b, armedOrderToJson(await stopLoss(signer, { lookupTables: strangeTables })));
    expect(unknownTable.status).toBe(400);
    expect(codes(unknownTable)).toEqual(expect.arrayContaining(["lookup-table-unknown", "unresolved-account"]));

    const lowReserve = await post(
      b,
      tamper(await stopLoss(signer, { nonceFrom: 4 }), (j) => ((j.reservation as { lamports: unknown }).lamports = { $bigint: "1" })),
    );
    expect(codes(lowReserve)).toEqual(["reservation-too-low"]);

    // An armed buy above the user's maxTradeSol setting (0.01 SOL here).
    expect((await b.req("PATCH", "/api/settings", { maxTradeSol: 0.01 })).status).toBe(200);
    const curve = await curveContext(signer.address);
    const buy = await armOrder(
      {
        id: crypto.randomUUID(),
        kind: "limit-buy",
        wallet: signer.address,
        mint: curve.mint,
        amount: 50_000_000n,
        trigger: { type: "quote-at-least", threshold: 1_000_000_000n },
        templates: [await pumpBuyTemplate(curve, { spend: 50_000_000n })],
        minOuts: [1_000_000_000n, 990_000_000n],
        tipLevels: jitoTipLevels([{ tipLamports: 10_000n, cuPriceMicroLamports: 100_000n }]),
        nonces: await nonceRefs(signer.address, 1, 9),
        armingQuoteOut: 1_000_000_000n,
        lookupTables: tables,
        extraReserveLamports: 3_000_000n,
      },
      signer,
    );
    onChain(buy);
    const capped = await post(b, armedOrderToJson(buy));
    expect(capped.status).toBe(422);
    expect(capped.body.code).toBe("limit_exceeded");
    expect(codes(capped)).toEqual(["user-buy-cap"]);
  });

  test("the safety policy: grid depth and the armed notional cap (an OCO pair counts once)", async () => {
    const { b, signer } = await trader();
    const deep = await post(
      b,
      tamper(await stopLoss(signer), (j) => (j.armingQuoteOut = { $bigint: "80000000" })),
    );
    expect(deep.status).toBe(422);
    expect(codes(deep)).toEqual(["grid-too-deep"]);

    expect((await post(b, armedOrderToJson(await stopLoss(signer, { nonceFrom: 1 })))).status).toBe(201);
    const over = await post(b, armedOrderToJson(await stopLoss(signer, { nonceFrom: 2 })));
    expect(over.status).toBe(422);
    expect(codes(over)).toEqual(["notional-cap"]);
  });

  test("nonce problems: stale value, missing slot, shared outside an OCO group, a duplicate, another account's slot", async () => {
    const { b, signer } = await trader();
    const stale = await stopLoss(signer);
    chain.setNonce(stale.attempts[0]?.nonce.account as string, signer.address, "6xUWm5nEhyFfR2CdkrkSPbmgobHrjAjjKGMBxqTC4Zrz");
    const r1 = await post(b, armedOrderToJson(stale));
    expect(r1.status).toBe(409);
    expect(codes(r1)).toEqual(["nonce-stale"]);

    const missing = await stopLoss(signer, { nonceFrom: 1 });
    chain.nonces.set(missing.attempts[0]?.nonce.account as string, null);
    expect(codes(await post(b, armedOrderToJson(missing)))).toEqual(["nonce-missing"]);

    const ok = await stopLoss(signer, { nonceFrom: 2 });
    expect((await post(b, armedOrderToJson(ok))).status).toBe(201);
    const dup = await post(b, armedOrderToJson(ok));
    expect(dup.status).toBe(409);
    expect(codes(dup)).toContain("duplicate-order");

    // Same nonce generation, metadata claiming another OCO group: refused.
    const [nonce] = await nonceRefs(signer.address, 1, 5);
    const { nonces: _n, ...rest } = await stopLossSpec(signer);
    const [tp, sl] = await armOcoPair(
      {
        group: "g",
        nonce: nonce as never,
        takeProfit: {
          ...rest,
          id: crypto.randomUUID(),
          kind: "take-profit",
          trigger: { type: "quote-at-least", threshold: 39_000_000n },
          minOuts: [38_000_000n],
        },
        stopLoss: { ...rest, id: crypto.randomUUID() },
      },
      signer,
    );
    onChain(tp, sl);
    // (A fresh user so the notional cap does not interfere.)
    const t2 = new Browser(env);
    await t2.signIn();
    await t2.req("POST", "/api/trading-wallets", { publicKey: signer.address });
    expect((await post(t2, armedOrderToJson(tp))).status).toBe(201);
    const shared = await post(
      t2,
      tamper(sl, (j) => (j.ocoGroup = "another-group")),
    );
    expect(shared.status).toBe(409);
    expect(codes(shared)).toContain("nonce-shared");

    // Someone who registered the same trading wallet cannot arm on slots another account armed first.
    const thief = new Browser(env);
    await thief.signIn();
    await thief.req("POST", "/api/trading-wallets", { publicKey: signer.address });
    const reuse = await post(thief, armedOrderToJson(sl));
    expect(reuse.status).toBe(409);
    expect(codes(reuse)).toEqual(["nonce-slot-taken"]);
  });

  test("the per-user open-orders cap", async () => {
    const { signer } = await trader();
    const capped = await startUserApp({
      db: env.db,
      env: { ORDERS_MAX_OPEN_PER_USER: "1" },
      orders: { lookupTables: tables, chain, timers: false },
    });
    try {
      const c = new Browser(capped);
      await c.signIn();
      await c.req("POST", "/api/trading-wallets", { publicKey: signer.address });
      const first = await stopLoss(signer, { nonceFrom: 11 });
      const second = await stopLoss(signer, { nonceFrom: 12 });
      expect((await post(c, armedOrderToJson(first))).status).toBe(201);
      const r = await post(c, armedOrderToJson(second));
      expect(r.status).toBe(422);
      expect(codes(r)).toEqual(["open-orders-cap"]);
    } finally {
      await capped.close();
    }
  }, 60_000);
});

describe("nonce probe", () => {
  test("a wallet's derived slots as they stand on chain, held slots named; other wallets and bad input refused", async () => {
    const { b, signer } = await trader();
    const [slot0, slot1, slot2] = await nonceRefs(signer.address, 3);
    if (!slot0 || !slot1 || !slot2) throw new Error("no slots");
    chain.setNonce(slot0.account, signer.address, slot0.value);
    chain.setNonce(slot2.account, addr("someone-else"), slot2.value);
    // An open order holds slot 0 once armed.
    const held = await stopLoss(signer);
    expect((await post(b, armedOrderToJson(held))).status).toBe(201);
    const heldAccount = held.attempts[0]?.nonce.account;

    const r = await b.json<NonceProbeResponse>("GET", `/api/orders/nonce-probe?wallet=${signer.address}&count=3`);
    expect(r.status).toBe(200);
    expect(r.body.wallet).toBe(signer.address);
    expect(r.body.slots.map((s) => s.nonceAccount)).toEqual([slot0.account, slot1.account, slot2.account]);
    expect(r.body.slots[0]).toMatchObject({ index: 0, state: "ready", orderId: heldAccount === slot0.account ? held.id : null });
    expect(r.body.slots[0]?.nonceValue).not.toBeNull();
    expect(r.body.slots[1]).toMatchObject({ index: 1, state: "absent", nonceValue: null, lamports: null, orderId: null });
    expect(r.body.slots[2]).toMatchObject({ index: 2, state: "foreign" });

    const stranger = await armedWallet();
    expect((await b.req("GET", `/api/orders/nonce-probe?wallet=${stranger.address}&count=2`)).status).toBe(403);
    expect((await b.req("GET", `/api/orders/nonce-probe?wallet=${signer.address}&count=33`)).status).toBe(400);
    expect((await b.req("GET", `/api/orders/nonce-probe?wallet=nope&count=2`)).status).toBe(400);
    expect((await new Browser(env).req("GET", `/api/orders/nonce-probe?wallet=${signer.address}&count=2`)).status).toBe(401);
  });
});

describe("cancel, Panic and the kill switch", () => {
  test("cancel fires the pre-signed cancel (simulated under DRY_RUN); a closed order answers 409", async () => {
    const { b, signer } = await trader();
    const o = await stopLoss(signer);
    expect((await post(b, armedOrderToJson(o))).status).toBe(201);
    const ws = await b.socket();
    ws.send({ type: "subscribe", topic: "orders" });
    const snap = await ws.next((m) => m.topic === "orders" && m.type === "snapshot");
    expect(snap.data.orders.map((x: { id: string }) => x.id)).toContain(o.id);

    const before = chain.simulations.length;
    const r = await b.json<CancelOrderResponse>("POST", `/api/orders/${o.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.orders).toEqual([expect.objectContaining({ id: o.id, status: "cancelled", statusReason: "cancelled by the user" })]);
    await env.app.orders?.engine.settle();
    expect(chain.simulations.slice(before)).toEqual([o.attempts[0]?.nonce.cancel.wireBase64 as string]);
    const delta = await ws.next((m) => m.topic === "orders" && m.type === "delta" && m.data.upsert[0]?.status === "cancelled");
    expect(delta.data.upsert[0].attempts[0].status).toBe("cancelling");

    // The cancel lands: the order closes; cancelling again has nothing to fire.
    chain.land(o.attempts[0]?.nonce.cancel.signature as string, { nonce: o.attempts[0]?.nonce.account as string });
    await env.app.orders?.engine.pollNonces("hot");
    await env.app.orders?.engine.settle();
    expect((await b.json("POST", `/api/orders/${o.id}/cancel`)).status).toBe(409);
    expect((await b.json("POST", `/api/orders/${crypto.randomUUID()}/cancel`)).status).toBe(404);
    expect((await b.json("POST", "/api/orders/not-an-id/cancel")).status).toBe(400);
    ws.ws.close();
  });

  test("Panic cancels every open order of the user", async () => {
    const { b, signer } = await trader();
    await post(b, armedOrderToJson(await stopLoss(signer)));
    const r = await b.json<PanicResponse>("POST", "/api/orders/panic");
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(1);
    expect(r.body.orders.map((o) => o.status)).toEqual(["cancelled"]);
  });

  test("while halted, intake answers 503 and open orders have been cancelled", async () => {
    const { b, signer } = await trader();
    const o = await stopLoss(signer);
    expect((await post(b, armedOrderToJson(o))).status).toBe(201);
    await env.user.halt.halt("drill", { actor: "test", ip: null, userAgentHash: null });
    try {
      await env.app.orders?.engine.settle();
      const view = (await b.json<OrderDetailResponse>("GET", `/api/orders/${o.id}`)).body.order;
      expect(view).toMatchObject({ status: "cancelled", statusReason: "admin halt: drill" });
      const r = await post(b, armedOrderToJson(await stopLoss(signer, { nonceFrom: 1 })));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe("halted");
    } finally {
      await env.user.halt.resume({ actor: "test", ip: null, userAgentHash: null });
    }
  });
});
