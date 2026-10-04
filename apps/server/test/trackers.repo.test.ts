/**
 * Copy-trading persistence (copy_tasks, copy_signals), run through PGlite and through Bun.sql over the
 * Postgres wire protocol so the SQL is known to behave the same on both drivers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CopySignal, DEFAULT_COPY_CONFIG } from "@zerofee/protocol";
import { isUniqueViolation, LimitExceededError } from "../src/db/pg";
import { UsersRepo } from "../src/db/pg/users";
import { setLogLevel } from "../src/log";
import { CopyRepo, emptyStats } from "../src/trackers/copyRepo";
import { addr } from "./helpers";
import { DRIVERS, type TestDb } from "./pgHelpers";
import { sig } from "./trackerHelpers";

setLogLevel("error");
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);

function signal(taskId: string, o: Partial<CopySignal> = {}): CopySignal {
  return {
    id: crypto.randomUUID(),
    taskId,
    side: "buy",
    status: "pending",
    reason: null,
    mint: addr("repo-mint"),
    symbol: "RPO",
    venue: "pump",
    leader: addr("repo-leader"),
    leaderSignature: sig("leader"),
    leaderSlot: 123,
    leaderSol: 1,
    leaderTokenAmount: "30000000000000",
    leaderPriceSol: 1 / 30_000_000,
    priceSol: 1 / 30_000_000,
    mcSol: 33,
    mcUsd: 5_000,
    sizeSol: 0.05,
    maxPriceSol: 1.1 / 30_000_000,
    slippageBps: 1_500,
    preset: 1,
    takeProfitPct: null,
    stopLossPct: null,
    trigger: null,
    sellFraction: null,
    sellTokenAmount: null,
    fractionSource: null,
    delivered: true,
    createdAt: T0,
    expiresAt: T0 + 15_000,
    resolvedAt: null,
    signature: null,
    filledSol: null,
    filledTokens: null,
    confirmed: false,
    ...o,
  };
}

describe.each(DRIVERS)("$name", ({ open }) => {
  let t: TestDb;
  let repo: CopyRepo;
  let users: UsersRepo;
  let k = 0;
  const newUser = async () => (await users.upsertOnLogin(addr(`repo-user-${++k}`), T0)).id;
  const task = (userId: string, leader = addr(`repo-leader-${++k}`), max = 20) =>
    repo.createTask(userId, { leader, label: "kol", status: "active", config: DEFAULT_COPY_CONFIG }, T0, max);

  beforeAll(async () => {
    t = await open();
    repo = new CopyRepo(t.db);
    users = new UsersRepo(t.db);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  test("tasks: create, read, update, delete; config and state round-trip; one task per leader", async () => {
    const u = await newUser();
    const leader = addr("repo-leader-x");
    const created = await task(u, leader);
    expect(created).toMatchObject({
      userId: u,
      leader,
      label: "kol",
      status: "active",
      pausedReason: null,
      config: DEFAULT_COPY_CONFIG,
      state: { positions: [] },
      stats: emptyStats(),
      createdAt: T0,
      updatedAt: T0,
    });
    expect(await repo.getTask(u, created.id)).toEqual(created);
    expect(await repo.getTask(await newUser(), created.id)).toBeNull(); // someone else's
    const config = { ...DEFAULT_COPY_CONFIG, maxDriftPct: 3, blacklist: { mints: [addr("bl")], devs: [] } };
    const upd = await repo.updateTask(u, created.id, { label: "renamed", config, status: "paused", pausedReason: "user" }, T0 + 5);
    expect(upd).toMatchObject({ label: "renamed", config, status: "paused", pausedReason: "user", updatedAt: T0 + 5 });
    const state = {
      positions: [
        {
          mint: addr("p"),
          symbol: "P",
          tokens: "1500000000000",
          costSol: 0.05,
          buys: 1,
          openedAt: T0,
          realizedPnlSol: 0,
          leaderTokens: null,
        },
      ],
    };
    await repo.saveState(created.id, state);
    await repo.saveStats(created.id, { ...emptyStats(), executed: 3, skippedByReason: { price_drift: 2 }, skipped: 2 });
    expect(await repo.getTask(u, created.id)).toMatchObject({
      state,
      stats: { executed: 3, skipped: 2, skippedByReason: { price_drift: 2 } },
    });
    expect(isUniqueViolation(await task(u, leader).catch((e) => e))).toBe(true);
    expect((await repo.listTasks(u)).map((x) => x.id)).toEqual([created.id]);
    expect((await repo.listTasks()).some((x) => x.id === created.id)).toBe(true);
    expect(await repo.deleteTask(u, created.id)).toBe(true);
    expect(await repo.deleteTask(u, created.id)).toBe(false);
  });

  test("the per-user task cap rolls the insert back", async () => {
    const u = await newUser();
    await task(u, undefined, 2);
    await task(u, undefined, 2);
    await expect(task(u, undefined, 2)).rejects.toBeInstanceOf(LimitExceededError);
    expect(await repo.listTasks(u)).toHaveLength(2);
  });

  test("signals: insert, update, owner-scoped reads newest first; one actionable signal per leader event", async () => {
    const u = await newUser();
    const tk = await task(u);
    const a = signal(tk.id, { createdAt: T0 });
    const b = signal(tk.id, { createdAt: T0 + 1, side: "sell", sizeSol: null, sellFraction: 0.5, sellTokenAmount: "1" });
    await repo.insertSignal(u, a, a.leaderSignature);
    await repo.insertSignal(u, b, b.leaderSignature);
    expect((await repo.listSignals(u, { limit: 10 })).map((s) => s.id)).toEqual([b.id, a.id]);
    expect(await repo.listSignals(await newUser(), { limit: 10 })).toEqual([]);
    expect(await repo.getSignal(await newUser(), a.id)).toBeNull();
    const done = {
      ...a,
      status: "executed" as const,
      signature: sig("f"),
      filledSol: 0.049,
      filledTokens: "1480000000000",
      confirmed: true,
      resolvedAt: T0 + 9,
    };
    await repo.updateSignal(done);
    expect(await repo.getSignal(u, a.id)).toEqual(done);
    // The same leader event again for this task: refused while the first is actionable...
    const dup = await repo.insertSignal(u, signal(tk.id, { leaderSignature: a.leaderSignature }), a.leaderSignature).catch((e) => e);
    expect(isUniqueViolation(dup)).toBe(true);
    // ...but a revoked one (dead slot) does not block the fork's replay, and skips never conflict.
    const c = signal(tk.id);
    await repo.insertSignal(u, c, c.leaderSignature);
    await repo.updateSignal({ ...c, status: "revoked", reason: "leader_trade_rolled_back", resolvedAt: T0 });
    await repo.insertSignal(u, signal(tk.id, { leaderSignature: c.leaderSignature }), c.leaderSignature);
    const s1 = signal(tk.id, { status: "skipped", reason: "price_drift" });
    await repo.insertSignal(u, s1, s1.leaderSignature);
    await repo.insertSignal(
      u,
      signal(tk.id, { status: "skipped", reason: "price_drift", leaderSignature: s1.leaderSignature }),
      s1.leaderSignature,
    );
    expect((await repo.listSignals(u, { taskId: tk.id, limit: 2 })).length).toBe(2);
  });

  test("spend aggregates, start-up expiry of pending signals, skip-log retention, cascades", async () => {
    const u = await newUser();
    const tk = await task(u);
    const day = Date.UTC(2026, 9, 3);
    const rows: [Partial<CopySignal>, number][] = [
      [{ status: "executed", filledSol: 0.04, createdAt: day - 3_600_000 }, 0], // yesterday
      [{ status: "executed", filledSol: 0.05, createdAt: day + 1_000 }, 0],
      [{ status: "pending", sizeSol: 0.02, createdAt: day + 2_000 }, 0],
      [{ status: "failed", sizeSol: 0.5, createdAt: day + 3_000 }, 0],
      [{ status: "skipped", reason: "price_drift", sizeSol: null, createdAt: day + 4_000 }, 0],
    ];
    for (const [o] of rows) {
      const s = signal(tk.id, o);
      await repo.insertSignal(u, s, s.leaderSignature);
    }
    const spend = (await repo.spend(day)).get(tk.id);
    expect(spend?.buysToday).toBe(2);
    expect(spend?.spentSol).toBeCloseTo(0.11, 9);
    expect(spend?.spentTodaySol).toBeCloseTo(0.07, 9);
    expect(await repo.expirePending(day + 10_000)).toBeGreaterThanOrEqual(1);
    const expired = (await repo.listSignals(u, { limit: 10 })).find((s) => s.sizeSol === 0.02);
    expect(expired).toMatchObject({ status: "expired", resolvedAt: day + 10_000 });
    expect(await repo.purgeSkipped(day + 5_000)).toBeGreaterThanOrEqual(1);
    expect((await repo.listSignals(u, { limit: 10 })).some((s) => s.status === "skipped")).toBe(false);
    expect(await repo.deleteTask(u, tk.id)).toBe(true);
    expect(await repo.listSignals(u, { limit: 10 })).toEqual([]); // signals cascade with the task
  });
});
