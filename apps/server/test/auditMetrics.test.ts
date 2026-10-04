/**
 * Audit metrics added on top of the trade-based book: the bundle rule's size band and shared funder,
 * dev-sold-all, pro traders that actually paid a fee wallet, chain snapshots (largest accounts, DAS) and
 * insiders. Offline, synthetic events.
 */
import { describe, expect, test } from "bun:test";
import { sharedFunderMembers, sizeBandMembers } from "../src/market/holders";
import { type MarketConfig, MarketState } from "../src/market/state";
import { deserializeRecord, serializeRecord } from "../src/storage/codec";
import { addr, FakeCurve, FakeResolver, synthTx } from "./helpers";

const T0 = 1_791_048_900;
const FEE = addr("fee-wallet");
const FEE_ATA = addr("fee-usdc-account");

function market(o: Partial<MarketConfig> = {}, funders: Record<string, string> = {}) {
  const cfg: MarketConfig = {
    sniperSlots: 3,
    bundleMinBuyers: 4,
    bundleSizeBandBps: 1_000,
    proTraderWallets: [FEE],
    proTraderTokenAccounts: [FEE_ATA],
    ...o,
  };
  return new MarketState(cfg, {
    resolver: new FakeResolver(),
    solUsd: () => 120,
    now: () => 1_791_049_000_000,
    funderOf: (w) => funders[w] ?? null,
  });
}

function launch(m: MarketState, tag: string, slot = 1_000) {
  const mint = addr(`mint-${tag}`);
  const dev = addr(`dev-${tag}`);
  const c = new FakeCurve(mint, dev);
  m.applyTx(synthTx(slot, [c.create(T0)]));
  return { mint, dev, c };
}

describe("bundle rule: N+ buyers in one slot need a tight size band or a shared funder", () => {
  test("size band helper", () => {
    const buys = new Map<string, bigint>([
      ["a", 100n],
      ["b", 104n],
      ["c", 109n],
      ["d", 110n],
      ["e", 500n],
    ]);
    expect([...sizeBandMembers(buys, 4, 1_000)].sort()).toEqual(["a", "b", "c", "d"]); // 110 <= 100 x 1.10
    expect(sizeBandMembers(buys, 4, 500).size).toBe(0); // 5 %: at most 3 in a band
    expect([...sharedFunderMembers(["a", "b", "c", "d", "e"], 4, (w) => (w === "e" ? "Y" : "X"))].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("4 buyers in a slot with scattered sizes are not bundlers; equal sizes are", () => {
    const m = market();
    const { mint, c } = launch(m, "band");
    const sizes = [100_000_000n, 450_000_000n, 1_300_000_000n, 3_000_000_000n];
    sizes.forEach((s, i) => {
      m.applyTx(synthTx(1_020, [c.buy(addr(`scatter-${i}`), s, T0 + 8)]));
    });
    expect(m.tokens.get(mint)?.holders?.bundlers.size).toBe(0);
    for (const w of ["E", "F", "G", "H"]) m.applyTx(synthTx(1_030, [c.buy(addr(w), 250_000_000n, T0 + 12)]));
    m.applyTx(synthTx(1_030, [c.buy(addr("outlier"), 2_000_000_000n, T0 + 12)]));
    expect([...(m.tokens.get(mint)?.holders?.bundlers ?? [])].sort()).toEqual(["E", "F", "G", "H"].map(addr).sort());
  });

  test("a shared funder flags scattered sizes, and funder data arriving later re-runs the rule", () => {
    const funders: Record<string, string> = {};
    const m = market({}, funders);
    const { mint, c } = launch(m, "funder");
    const ws = ["p", "q", "r", "s"].map(addr);
    ws.forEach((w, i) => {
      m.applyTx(synthTx(1_040, [c.buy(w, BigInt(i + 1) * 700_000_000n, T0 + 16)]));
    });
    const book = m.tokens.get(mint)?.holders;
    expect(book?.bundlers.size).toBe(0);
    expect(book?.crowdedCandidates().sort()).toEqual([...ws].sort());
    for (const w of ws) funders[w] = addr("common-funder");
    expect(m.recheckBundles(mint)).toBe(4);
    expect([...(book?.bundlers ?? [])].sort()).toEqual([...ws].sort());
  });
});

describe("dev sold all", () => {
  test("true once the dev held and dropped to zero; false while holding or if the dev never bought", () => {
    const m = market();
    const { mint, dev, c } = launch(m, "devsell");
    expect(m.summary(mint)?.devSoldAll).toBe(false);
    m.applyTx(synthTx(1_001, [c.buy(dev, 2_000_000_000n, T0 + 1)]));
    expect(m.summary(mint)?.devSoldAll).toBe(false);
    const bal = m.tokens.get(mint)?.holders?.balanceOf(dev) ?? 0n;
    m.applyTx(synthTx(1_002, [c.sell(dev, bal, T0 + 2)]));
    expect(m.summary(mint)?.devSoldAll).toBe(true);
  });
});

describe("pro traders: the swap must pay a known fee wallet", () => {
  test("credited fee wallet, fee token account, uncredited wallet, the fee wallet trading itself", () => {
    const m = market();
    const { mint, c } = launch(m, "pro");
    const keys = [addr("payer"), FEE, addr("other")];
    // lamports indexed like accountKeys: the fee wallet goes from 10 to 11 SOL-lamports
    m.applyTx(
      synthTx(1_010, [c.buy(addr("paid"), 1_000_000n, T0)], {
        accountKeys: keys,
        lamports: { pre: ["5", "10", "1"], post: ["4", "11", "1"] },
      }),
    );
    m.applyTx(
      synthTx(1_011, [c.buy(addr("unpaid"), 1_000_000n, T0)], {
        accountKeys: keys,
        lamports: { pre: ["5", "10", "1"], post: ["4", "10", "1"] },
      }),
    );
    m.applyTx(
      synthTx(1_012, [c.buy(addr("usdc-fee"), 1_000_000n, T0)], {
        accountKeys: [addr("payer"), FEE_ATA],
        lamports: { pre: ["5", "2"], post: ["4", "2"] },
      }),
    );
    m.applyTx(synthTx(1_013, [c.buy(FEE, 1_000_000n, T0)], { accountKeys: [FEE], lamports: { pre: ["10"], post: ["9"] } }));
    m.applyTx(synthTx(1_014, [c.buy(addr("no-balances"), 1_000_000n, T0)], { accountKeys: keys }));
    const pros = m.tokens.get(mint)?.proTraders;
    expect([...(pros ?? [])].sort()).toEqual([addr("paid"), addr("usdc-fee"), addr("no-balances")].sort());
    expect(m.summary(mint)?.proTraders).toBe(3);
    expect(m.recentTrades(mint, 10).find((t) => t.trader === addr("paid"))?.tags).toContain("pro");
  });

  test("the pro-trader set survives a restart (codec)", () => {
    const m = market();
    const { mint, c } = launch(m, "pro-codec");
    m.applyTx(synthTx(1_010, [c.buy(addr("paid"), 1_000_000n, T0)], { accountKeys: [FEE], lamports: { pre: ["1"], post: ["2"] } }));
    const rec = m.tokens.get(mint);
    if (!rec) throw new Error("no record");
    const back = deserializeRecord(serializeRecord(rec), 0).rec;
    expect([...(back.proTraders ?? [])]).toEqual([addr("paid")]);
  });
});

describe("chain snapshots reconcile the trade-based book", () => {
  function scenario() {
    const m = market();
    const { mint, dev, c } = launch(m, "snap", 2_000);
    m.applyTx(synthTx(2_001, [c.buy(dev, 1_000_000_000n, T0 + 1)]));
    m.applyTx(synthTx(2_002, [c.buy(addr("A"), 3_000_000_000n, T0 + 2)])); // A later moves everything to B (unseen)
    m.applyTx(synthTx(2_003, [c.buy(addr("small"), 10_000_000n, T0 + 3)]));
    return { m, mint, dev, c, book: m.tokens.get(mint)?.holders };
  }

  test("largest accounts: transfer recipients appear, stale big balances drop to 0, top 10 and source update", () => {
    const { m, mint, dev, book } = scenario();
    const aBal = book?.balanceOf(addr("A")) ?? 0n;
    const devBal = book?.balanceOf(dev) ?? 0n;
    expect(m.summary(mint)?.holdersSource).toBe("trades");
    const before = m.summary(mint);
    const curve = addr(`curve:${mint}`);
    m.applyHolderSnapshot(
      mint,
      [
        { owner: curve, amount: 900_000_000_000_000n, slot: 2_010 }, // excluded: the bonding curve
        { owner: addr("B"), amount: aBal, slot: 2_010 },
        { owner: dev, amount: devBal, slot: 2_010 },
      ],
      // the 20th-largest account held 1M tokens: A's 3-SOL bag (~100M tokens) cannot be unlisted
      { source: "rpc", at: 1_791_049_000_123, full: false, floor: 1_000_000_000_000n, slot: 2_010 },
    );
    const s = m.summary(mint);
    expect(book?.balanceOf(addr("A"))).toBe(0n);
    expect(book?.balanceOf(addr("B"))).toBe(aBal);
    expect(book?.balanceOf(addr("small"))).toBeGreaterThan(0n); // ~350k tokens, below the floor: unknown, kept
    expect(s).toMatchObject({ holdersSource: "rpc", holdersCheckedAt: 1_791_049_000_123, holders: before?.holders });
    expect(s?.top10Pct).toBeCloseTo(before?.top10Pct ?? 0, 6); // A's tokens counted once, now under B
  });

  test("trades after the snapshot slot are re-applied; complete snapshots zero everyone missing", () => {
    const { m, mint, dev, c, book } = scenario();
    m.applyTx(synthTx(2_020, [c.buy(addr("late"), 500_000_000n, T0 + 20)])); // after the snapshot below
    const late = book?.balanceOf(addr("late")) ?? 0n;
    m.applyHolderSnapshot(
      mint,
      [
        { owner: dev, amount: 7n, slot: 2_015 },
        { owner: addr("B"), amount: 11n, slot: 2_015 },
      ],
      { source: "das", at: 5, full: true, slot: 2_015 },
    );
    expect([book?.balanceOf(dev), book?.balanceOf(addr("B")), book?.balanceOf(addr("late"))]).toEqual([7n, 11n, late]);
    expect([book?.balanceOf(addr("A")), book?.balanceOf(addr("small"))]).toEqual([0n, 0n]);
    expect(m.summary(mint)).toMatchObject({ holders: 3, holdersSource: "das", holdersCheckedAt: 5 });
  });

  test("tokens whose history we did not observe have no book to reconcile", () => {
    const m = market();
    expect(m.applyHolderSnapshot(addr("unknown"), [], { source: "rpc", at: 1, full: true, slot: 1 })).toBe(false);
  });
});

describe("insiders", () => {
  test("null unless enabled and analysed; then transfer recipients plus creator-funded wallets", () => {
    const off = market();
    const a = launch(off, "ins-off");
    off.setFundedInsiders(a.mint, [], 1);
    expect(off.summary(a.mint)?.insidersPct).toBeNull(); // no HELIUS_API_KEY: never computed

    const m = market({ insiders: true });
    const { mint, dev, c } = launch(m, "ins");
    m.applyTx(synthTx(1_001, [c.buy(dev, 1_000_000_000n, T0 + 1)]));
    m.applyTx(synthTx(1_002, [c.buy(addr("funded"), 2_000_000_000n, T0 + 2)]));
    m.applyTx(synthTx(1_003, [c.buy(addr("normal"), 2_000_000_000n, T0 + 3)]));
    expect(m.summary(mint)?.insidersPct).toBeNull(); // not analysed yet
    // a snapshot reveals a holder that never bought (received tokens by transfer)
    const book = m.tokens.get(mint)?.holders;
    m.applyHolderSnapshot(
      mint,
      [
        { owner: addr("gifted"), amount: 10_000_000_000_000n, slot: 1_010 },
        { owner: dev, amount: book?.balanceOf(dev) ?? 0n, slot: 1_010 },
        { owner: addr("funded"), amount: book?.balanceOf(addr("funded")) ?? 0n, slot: 1_010 },
        { owner: addr("normal"), amount: book?.balanceOf(addr("normal")) ?? 0n, slot: 1_010 },
      ],
      { source: "rpc", at: 1, full: true, slot: 1_010 },
    );
    m.setFundedInsiders(mint, [addr("funded"), dev], 2); // the dev itself is never counted as an insider
    const expected =
      Number(((10_000_000_000_000n + (book?.balanceOf(addr("funded")) ?? 0n)) * 1_000_000n) / 1_000_000_000_000_000n) / 10_000;
    expect(m.summary(mint)?.insidersPct).toBeCloseTo(expected, 6);
    expect(book?.transferRecipients()).toEqual([addr("gifted")]);
  });
});
