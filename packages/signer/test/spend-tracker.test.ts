import { describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import { randomBytes } from "../src/bytes";
import { type SpendState, SpendTracker } from "../src/firewall/spend-tracker";
import type { TransactionSummary } from "../src/firewall/types";
import { MemoryStore } from "../src/store";
import { LAMPORTS_PER_SOL, MAINNET, randomAddress } from "./helpers/fixtures";

const SOL = LAMPORTS_PER_SOL;
const DAY = 24 * 60 * 60 * 1000;

function summary(p: {
  buy?: bigint;
  tip?: bigint;
  fee?: bigint;
  quote?: Record<string, bigint>;
  nonce?: { account: Address; value: string };
}): TransactionSummary {
  return {
    text: "",
    lines: [],
    actions: [],
    version: 0,
    feePayer: randomAddress(),
    priorityFeeLamports: p.fee ?? 0n,
    tipLamports: p.tip ?? 0n,
    maxBuyLamports: p.buy ?? 0n,
    maxBuyQuote: p.quote ?? {},
    maxSolOutLamports: (p.buy ?? 0n) + (p.tip ?? 0n) + (p.fee ?? 0n),
    ...(p.nonce ? { durableNonce: { nonceAccount: p.nonce.account, nonceValue: p.nonce.value } } : {}),
  };
}

function tracker(caps: ConstructorParameters<typeof SpendTracker>[0]["caps"], clock = { now: Date.UTC(2026, 9, 3, 10) }) {
  const storage = new MemoryStore<SpendState>();
  return { t: new SpendTracker({ storage, caps, now: () => clock.now }), storage, clock };
}

const msg = () => randomBytes(64);

describe("SpendTracker", () => {
  test("accumulates per UTC day and refuses over the daily cap", async () => {
    const { t } = tracker({ buyLamports: SOL });
    expect((await t.reserve(summary({ buy: SOL / 2n }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ buy: (SOL * 4n) / 10n }), msg())).ok).toBe(true);
    const over = await t.reserve(summary({ buy: (SOL * 2n) / 10n }), msg());
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations.join()).toContain("daily buy cap: 0.9 SOL committed today");
    expect((await t.totals()).buyLamports).toBe((SOL * 9n) / 10n);
  });

  test("resets at the UTC day boundary", async () => {
    const { t, clock } = tracker({ buyLamports: SOL }, { now: Date.UTC(2026, 9, 3, 23, 59) });
    expect((await t.reserve(summary({ buy: SOL }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ buy: 1n }), msg())).ok).toBe(false);
    clock.now += 2 * 60_000; // 00:01 UTC next day
    expect((await t.reserve(summary({ buy: SOL }), msg())).ok).toBe(true);
    expect((await t.totals()).day).toBe("2026-10-04");
    clock.now += DAY;
    expect((await t.totals()).buyLamports).toBe(0n);
  });

  test("a min-out grid on one nonce counts once, at its largest variant", async () => {
    const { t } = tracker({ buyLamports: SOL });
    const nonce = { account: randomAddress(), value: "nonce-value-1" };
    for (let i = 0; i < 12; i++) {
      const r = await t.reserve(summary({ buy: SOL / 2n - BigInt(i), tip: 1_000n * BigInt(i), nonce }), msg());
      expect(r.ok).toBe(true);
    }
    const totals = await t.totals();
    expect(totals.buyLamports).toBe(SOL / 2n);
    expect(totals.feeLamports).toBe(11_000n);
    // A different nonce value (or account) is a separate order.
    expect((await t.reserve(summary({ buy: SOL / 2n, nonce: { ...nonce, value: "nonce-value-2" } }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ buy: 1n, nonce: { account: randomAddress(), value: "x" } }), msg())).ok).toBe(false);
  });

  test("re-signing the identical message counts once", async () => {
    const { t } = tracker({ buyLamports: SOL });
    const same = msg();
    for (let i = 0; i < 5; i++) expect((await t.reserve(summary({ buy: (SOL * 6n) / 10n }), same)).ok).toBe(true);
    expect((await t.totals()).buyLamports).toBe((SOL * 6n) / 10n);
  });

  test("sells are never blocked by the buy cap", async () => {
    const { t } = tracker({ buyLamports: SOL });
    expect((await t.reserve(summary({ buy: SOL }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ buy: 0n, fee: 5_000n }), msg())).ok).toBe(true);
  });

  test("optional tip + priority fee budget", async () => {
    const { t } = tracker({ buyLamports: SOL, feeLamports: 10_000n });
    expect((await t.reserve(summary({ tip: 6_000n }), msg())).ok).toBe(true);
    const over = await t.reserve(summary({ fee: 5_000n }), msg());
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations.join()).toContain("daily tip and priority fee cap");
  });

  test("non-SOL quote mints need their own daily cap", async () => {
    const { t } = tracker({ buyLamports: SOL, buyQuote: { [MAINNET.usdc]: 1_000n } });
    expect((await t.reserve(summary({ quote: { [MAINNET.usdc]: 600n } }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ quote: { [MAINNET.usdc]: 600n } }), msg())).ok).toBe(false);
    const unknown = await t.reserve(summary({ quote: { [randomAddress()]: 1n } }), msg());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.violations.join()).toContain("no daily cap is configured");
  });

  test("compaction keeps totals and nonce groups", async () => {
    const { t, storage } = tracker({ buyLamports: 10_000n * SOL });
    const nonce = { account: randomAddress(), value: "v" };
    await t.reserve(summary({ buy: 7n, nonce }), msg());
    for (let i = 0; i < 1005; i++) await t.reserve(summary({ buy: 1n, tip: 1n }), msg());
    await t.reserve(summary({ buy: 5n, nonce }), msg());
    const state = (await storage.load())!.value;
    expect(state.entries.length).toBeLessThan(10);
    const totals = await t.totals();
    expect(totals.buyLamports).toBe(1005n + 7n);
    expect(totals.feeLamports).toBe(1005n);
  });

  test("concurrent reservations cannot both squeeze under the cap", async () => {
    const { t } = tracker({ buyLamports: SOL });
    const results = await Promise.all(Array.from({ length: 5 }, () => t.reserve(summary({ buy: (SOL * 3n) / 10n }), msg())));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await t.totals()).buyLamports).toBe((SOL * 9n) / 10n);
  });
});
