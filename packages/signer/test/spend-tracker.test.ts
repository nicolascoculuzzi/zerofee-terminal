import { describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import { randomBytes } from "../src/bytes";
import { type DailySpendCaps, type SpendState, SpendTracker } from "../src/firewall/spend-tracker";
import type { TransactionSummary } from "../src/firewall/types";
import { MemoryStore } from "../src/store";
import { LAMPORTS_PER_SOL, MAINNET, randomAddress } from "./helpers/fixtures";

const SOL = LAMPORTS_PER_SOL;
const DAY = 24 * 60 * 60 * 1000;

function summary(p: {
  buy?: bigint;
  tip?: bigint;
  fee?: bigint;
  network?: bigint;
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
    networkFeeLamports: p.network ?? 0n,
    tipLamports: p.tip ?? 0n,
    maxBuyLamports: p.buy ?? 0n,
    maxBuyQuote: p.quote ?? {},
    maxSolOutLamports: (p.buy ?? 0n) + (p.tip ?? 0n) + (p.fee ?? 0n) + (p.network ?? 0n),
    ...(p.nonce ? { durableNonce: { nonceAccount: p.nonce.account, nonceValue: p.nonce.value } } : {}),
  };
}

/** Fee budget defaults to a generous 100 SOL so tests that are not about fees ignore it. */
function tracker(caps: Omit<DailySpendCaps, "feeLamports"> & { feeLamports?: bigint }, clock = { now: Date.UTC(2026, 9, 3, 10) }) {
  const storage = new MemoryStore<SpendState>();
  const full: DailySpendCaps = { feeLamports: 100n * SOL, ...caps };
  return { t: new SpendTracker({ storage, caps: full, now: () => clock.now }), storage, clock };
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

  test("durable-nonce variants are each counted (exclusivity cannot be proven offline)", async () => {
    // A tx that starts with AdvanceNonceAccount but carries a recent blockhash executes as a normal
    // transaction, so "variants" sharing a nonce account and lifetime token can all land in
    // successive slots. Grouping them would let a compromised caller multiply the daily cap.
    const { t } = tracker({ buyLamports: SOL });
    const nonce = { account: randomAddress(), value: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" };
    expect((await t.reserve(summary({ buy: (SOL * 4n) / 10n, nonce }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ buy: (SOL * 4n) / 10n, nonce }), msg())).ok).toBe(true);
    const third = await t.reserve(summary({ buy: (SOL * 4n) / 10n, nonce }), msg());
    expect(third.ok).toBe(false);
    expect((await t.totals()).buyLamports).toBe((SOL * 8n) / 10n);
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

  test("mandatory fee budget counts tips, priority fees and the base fee, sells included", async () => {
    const { t } = tracker({ buyLamports: SOL, feeLamports: 20_000n });
    expect((await t.reserve(summary({ tip: 6_000n, network: 5_000n }), msg())).ok).toBe(true);
    const over = await t.reserve(summary({ fee: 5_000n, network: 5_000n }), msg());
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.violations.join()).toContain("daily fee budget");
    expect((await t.totals()).feeLamports).toBe(11_000n);
    expect(() => new SpendTracker({ storage: new MemoryStore(), caps: { buyLamports: SOL } as DailySpendCaps })).toThrow(/feeLamports/);
  });

  test("wiping or rewriting stored totals cannot reset today's cap while the tracker lives", async () => {
    const { t, storage } = tracker({ buyLamports: SOL });
    expect((await t.reserve(summary({ buy: (SOL * 6n) / 10n }), msg())).ok).toBe(true);
    storage.tamper((v) => ({ ...v, entries: [] })); // same-origin script deletes the record's contents
    expect((await t.totals()).buyLamports).toBe((SOL * 6n) / 10n);
    expect((await t.reserve(summary({ buy: (SOL * 6n) / 10n }), msg())).ok).toBe(false);
    // The next successful reservation writes the merged history back to storage.
    expect((await t.reserve(summary({ buy: (SOL * 3n) / 10n }), msg())).ok).toBe(true);
    expect((await storage.load())!.value.entries.length).toBe(2);
  });

  test("non-SOL quote mints need their own daily cap", async () => {
    const { t } = tracker({ buyLamports: SOL, buyQuote: { [MAINNET.usdc]: 1_000n } });
    expect((await t.reserve(summary({ quote: { [MAINNET.usdc]: 600n } }), msg())).ok).toBe(true);
    expect((await t.reserve(summary({ quote: { [MAINNET.usdc]: 600n } }), msg())).ok).toBe(false);
    const unknown = await t.reserve(summary({ quote: { [randomAddress()]: 1n } }), msg());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.violations.join()).toContain("no daily cap is configured");
  });

  test("compaction bounds storage without losing totals", async () => {
    const { t, storage } = tracker({ buyLamports: 10_000n * SOL });
    const repeated = msg();
    await t.reserve(summary({ buy: 7n }), repeated);
    for (let i = 0; i < 1005; i++) await t.reserve(summary({ buy: 1n, tip: 1n }), msg());
    const state = (await storage.load())!.value;
    expect(state.entries.length).toBe(206); // folded at 1,001 entries down to aggregate + 200, then 5 more
    expect(state.entries[0]!.group).toMatch(/^aggregate:/);
    const totals = await t.totals();
    expect(totals.buyLamports).toBe(1005n + 7n);
    expect(totals.feeLamports).toBe(1005n);
    // A message folded into the aggregate counts again if re-signed: conservative.
    await t.reserve(summary({ buy: 7n }), repeated);
    expect((await t.totals()).buyLamports).toBe(1005n + 14n);
  });

  test("concurrent reservations cannot both squeeze under the cap", async () => {
    const { t } = tracker({ buyLamports: SOL });
    const results = await Promise.all(Array.from({ length: 5 }, () => t.reserve(summary({ buy: (SOL * 3n) / 10n }), msg())));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect((await t.totals()).buyLamports).toBe((SOL * 9n) / 10n);
  });
});
