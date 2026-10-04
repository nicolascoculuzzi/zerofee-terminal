/**
 * Armed-orders persistence (migration v2 + orders/repo.ts), through PGlite and through Bun.sql over the
 * Postgres wire protocol: batch intake with the open-orders cap and nonce-slot ownership, exact bigint
 * round-trips, optimistic state saves with the event history, slot release, views without signed bytes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyArmedOrderEvent } from "@zerofee/core";
import { isUniqueViolation, LimitExceededError, UserStore } from "../src/db/pg";
import { setLogLevel } from "../src/log";
import { ArmedOrdersRepo, NonceSlotTakenError, StaleOrderVersionError } from "../src/orders/repo";
import { addr } from "./helpers";
import { nonceValueOf, synthOrder, variantOf } from "./orderFixtures";
import { DRIVERS, type TestDb } from "./pgHelpers";

setLogLevel("error");
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

describe.each(DRIVERS)("armed orders repository ($name)", ({ open }) => {
  let t: TestDb;
  let store: UserStore;
  let repo: ArmedOrdersRepo;
  const user = async (tag: string) => (await store.users.upsertOnLogin(addr(`orders-repo-${tag}`), T0)).id;

  beforeAll(async () => {
    t = await open();
    store = new UserStore(t.db);
    repo = new ArmedOrdersRepo(t.db);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  test("a batch is stored atomically: exact bigints, claimed slots, an armed event each, views without signed bytes", async () => {
    const uid = await user("a");
    const tp = synthOrder({
      kind: "take-profit",
      trigger: { type: "quote-at-least", threshold: 2_000n },
      nonceTags: ["shared"],
      ocoGroup: "g1",
    });
    const sl = synthOrder({ nonceTags: ["shared", "sl-extra"], attempts: 2, ocoGroup: "g1", amount: 123_456_789_012_345_678n });
    const stored = await repo.insertBatch(
      uid,
      [
        { order: tp, triggerState: {} },
        { order: sl, triggerState: { highWater: 98_765_432_109_876_543n } },
      ],
      { now: T0, maxActive: 10 },
    );
    expect(stored.map((s) => s.version)).toEqual([0, 0]);
    const back = await repo.get(sl.id);
    // Exact values (jsonb reorders keys, which the codec does not care about).
    expect(back?.order).toEqual(sl);
    expect(typeof back?.order.amount).toBe("bigint");
    expect(back?.triggerState.highWater).toBe(98_765_432_109_876_543n);
    expect(back).toMatchObject({ userId: uid, dryRun: false, createdAt: T0, updatedAt: T0 });

    const views = await repo.listViews(uid, { scope: "open", limit: 10 });
    expect(views.map((v) => v.id).sort()).toEqual([tp.id, sl.id].sort());
    const slView = views.find((v) => v.id === sl.id);
    expect(slView).toMatchObject({ kind: "stop-loss", status: "armed", amount: "123456789012345678", open: true, ocoGroup: "g1" });
    expect(slView?.attempts.map((a) => a.variants)).toEqual([6, 6]);
    // No signed bytes in views.
    for (const a of [...tp.attempts, ...sl.attempts]) {
      expect(JSON.stringify(views)).not.toContain(a.nonce.cancel.wireBase64);
      for (const v of a.variants) expect(JSON.stringify(views)).not.toContain(v.tx.wireBase64);
    }

    const slots = await repo.slots(uid);
    expect(slots.map((s) => s.status)).toEqual(["in-use", "in-use"]);
    expect(slots.find((s) => s.nonceAccount === sl.attempts[1]?.nonce.account)?.nonceValue).toBe(sl.attempts[1]?.nonce.value as string);
    expect((await repo.events(sl.id)).map((e) => [e.type, e.status])).toEqual([["armed", "armed"]]);
    expect(await repo.countActive(uid)).toBe(2);
    expect((await repo.loadOpen()).map((s) => s.order.id)).toEqual(expect.arrayContaining([tp.id, sl.id]));
  });

  test("the open-orders cap and another account's nonce slot refuse the whole batch", async () => {
    const uid = await user("b");
    const first = synthOrder();
    await repo.insertBatch(uid, [{ order: first, triggerState: {} }], { now: T0, maxActive: 2 });
    await expect(
      repo.insertBatch(
        uid,
        [
          { order: synthOrder(), triggerState: {} },
          { order: synthOrder(), triggerState: {} },
        ],
        { now: T0, maxActive: 2 },
      ),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(await repo.countActive(uid)).toBe(1); // rolled back

    const other = await user("b-other");
    const steal = synthOrder({ nonceTags: [`${first.id}-n0`] });
    const firstNonce = first.attempts[0]?.nonce.account as string;
    expect(await repo.slotsOwnedByOthers(other, [firstNonce])).toEqual([firstNonce]);
    await expect(repo.insertBatch(other, [{ order: steal, triggerState: {} }], { now: T0, maxActive: 5 })).rejects.toBeInstanceOf(
      NonceSlotTakenError,
    );
    expect(await repo.get(steal.id)).toBeNull();
    // The same id twice is a unique violation (409 at the API).
    const dup = await repo.insertBatch(uid, [{ order: synthOrder(), triggerState: {} }], { now: T0, maxActive: 5 });
    const err = await repo
      .insertBatch(uid, [{ order: dup[0]?.order as never, triggerState: {} }], { now: T0, maxActive: 5 })
      .catch((e) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  test("state saves are optimistic, append the history and free the slots of closed attempts", async () => {
    const uid = await user("c");
    const o = synthOrder({ attempts: 2 });
    const [s] = await repo.insertBatch(uid, [{ order: o, triggerState: {} }], { now: T0, maxActive: 5 });
    if (!s) throw new Error("fixture");
    const v = variantOf(o, 0, 1);
    const sub = applyArmedOrderEvent(o, { type: "submitted", attempt: 0, variantId: v.id, slot: 77n }).order;
    const v1 = await repo.saveState(
      { ...s, order: sub },
      [{ type: "submitted", message: "submitted", detail: { minOut: v.minOut } }],
      T0 + 1_000,
    );
    expect(v1).toBe(1);
    await expect(repo.saveState({ ...s, order: sub }, [], T0 + 2_000)).rejects.toBeInstanceOf(StaleOrderVersionError);

    const filled = applyArmedOrderEvent(sub, {
      type: "nonce-consumed",
      nonce: o.attempts[0]?.nonce.account as never,
      nonceValue: o.attempts[0]?.nonce.value as string,
      signature: v.tx.signature,
      success: true,
    }).order;
    expect(filled.status).toBe("filled");
    const v2 = await repo.saveState({ ...s, order: filled, version: v1 }, [{ type: "nonce-consumed", message: "filled" }], T0 + 3_000);
    expect(v2).toBe(2);
    const view = await repo.view(uid, o.id);
    expect(view).toMatchObject({ status: "filled", signature: v.tx.signature, open: true, updatedAt: T0 + 3_000 });
    expect(view?.attempts.map((a) => a.status)).toEqual(["landed-ok", "cancelling"]);
    expect((await repo.events(o.id)).map((e) => e.type)).toEqual(["armed", "submitted", "nonce-consumed"]);
    expect((await repo.events(o.id))[1]?.detail).toEqual({ minOut: v.minOut.toString() }); // bigints as strings
    const slots = await repo.slots(uid);
    expect(slots.find((x) => x.nonceAccount === o.attempts[0]?.nonce.account)?.status).toBe("free");
    expect(slots.find((x) => x.nonceAccount === o.attempts[1]?.nonce.account)?.status).toBe("in-use");

    // The ladder's second nonce burns: nothing is open any more.
    const done = applyArmedOrderEvent(filled, {
      type: "nonce-consumed",
      nonce: o.attempts[1]?.nonce.account as never,
      nonceValue: o.attempts[1]?.nonce.value as string,
      signature: o.attempts[1]?.nonce.cancel.signature as string,
      success: true,
    }).order;
    await repo.saveState({ ...s, order: done, version: v2 }, [], T0 + 4_000);
    expect((await repo.view(uid, o.id))?.open).toBe(false);
    expect((await repo.loadOpen()).some((x) => x.order.id === o.id)).toBe(false);
    expect((await repo.slots(uid)).every((x) => x.status === "free")).toBe(true);
    // Closed orders still list with scope=all, and with scope=open only inside the recent window.
    expect((await repo.listViews(uid, { scope: "all", limit: 10 })).map((x) => x.id)).toContain(o.id);
    expect((await repo.listViews(uid, { scope: "open", limit: 10 })).map((x) => x.id)).not.toContain(o.id);
    expect((await repo.listViews(uid, { scope: "open", limit: 10, sinceMs: T0 })).map((x) => x.id)).toContain(o.id);
  });

  test("a slot re-armed by a newer order of the same user stays in use when the older order closes", async () => {
    const uid = await user("d");
    const old = synthOrder({ nonceTags: ["reused"], valueTags: ["gen1"] });
    const [s] = await repo.insertBatch(uid, [{ order: old, triggerState: {} }], { now: T0, maxActive: 5 });
    if (!s) throw new Error("fixture");
    const fresh = synthOrder({ nonceTags: ["reused"], valueTags: ["gen2"] });
    await repo.insertBatch(uid, [{ order: fresh, triggerState: {} }], { now: T0, maxActive: 5 });
    const burned = applyArmedOrderEvent(old, {
      type: "nonce-consumed",
      nonce: old.attempts[0]?.nonce.account as never,
      nonceValue: nonceValueOf("gen1"),
      signature: old.attempts[0]?.nonce.cancel.signature as string,
      success: true,
    }).order;
    await repo.saveState({ ...s, order: burned }, [], T0 + 1);
    const slot = (await repo.slots(uid)).find((x) => x.nonceAccount === old.attempts[0]?.nonce.account);
    expect(slot).toMatchObject({ status: "in-use", orderId: fresh.id, nonceValue: nonceValueOf("gen2") });
  });

  test("trigger state saves rewrite the view; slot observations record values and closures", async () => {
    const uid = await user("e");
    const o = synthOrder({ kind: "trailing-stop", trigger: { type: "trailing", trailBps: 1_000 } });
    const [s] = await repo.insertBatch(uid, [{ order: o, triggerState: {} }], { now: T0, maxActive: 5 });
    if (!s) throw new Error("fixture");
    await repo.saveTriggerState({ ...s, triggerState: { highWater: 5_555n } });
    expect((await repo.view(uid, o.id))?.highWater).toBe("5555");
    expect((await repo.get(o.id))?.triggerState).toEqual({ highWater: 5_555n });
    const account = o.attempts[0]?.nonce.account as string;
    await repo.observeSlot(account, { value: "NewValue111111111111111111111111111111111", missing: false, now: T0 + 1 });
    expect((await repo.slots(uid))[0]).toMatchObject({ nonceValue: "NewValue111111111111111111111111111111111", status: "in-use" });
    await repo.observeSlot(account, { value: null, missing: true, now: T0 + 2 });
    expect((await repo.slots(uid))[0]).toMatchObject({ nonceValue: "NewValue111111111111111111111111111111111", status: "missing" });
    // Other users never see the order.
    expect(await repo.view(await user("e-other"), o.id)).toBeNull();
  });
});
