import { describe, expect, test } from "bun:test";
import type { TokenSummary } from "../protocol";
import {
  activeFilterCount,
  compileBlacklists,
  compileFilter,
  emptyFilter,
  exportFilters,
  isBlacklisted,
  matchesFilter,
  parseFilterImport,
} from "./filters";

const NOW = 1_800_000_000_000;

function token(patch: Partial<TokenSummary> = {}): TokenSummary {
  return {
    mint: "Mint1111111111111111111111111111111111pump",
    name: "Based Frog",
    symbol: "BFROG",
    imageUri: null,
    launchpad: "pump",
    quote: "SOL",
    venue: "pump_curve",
    column: "new",
    createdAt: NOW - 5 * 60_000,
    creator: "Dev11111111111111111111111111111111111111",
    fundingWallet: "Fund1111111111111111111111111111111111111",
    socials: { x: "bfrog_sol" },
    supply: 1_000_000_000,
    decimals: 6,
    priceSol: 4e-8,
    priceUsd: 4.78e-6,
    marketCapSol: 40,
    marketCapUsd: 4_780,
    liquidityUsd: 1_912,
    volumeUsd: 6_340,
    txns: 57,
    buys: 41,
    sells: 16,
    holders: 33,
    proTraders: 2,
    bondingProgress: 0.18,
    migratedAt: null,
    risk: { top10Pct: 27.4, devPct: 3.1, devSold: false, snipersPct: 6.2, insidersPct: 0, bundlersPct: 12.8 },
    dexPaid: false,
    lpBurnedPct: null,
    token2022: null,
    feesPaidSol: 0.41,
    netBuyUsd: 0,
    dexPaidAt: null,
    lastTradeAt: NOW - 3_000,
    change5mPct: 18.2,
    ...patch,
  };
}

describe("pulse filters", () => {
  test("unknown is not zero: a null metric fails any min or max set on it, and passes when none is set", () => {
    const unknown = token({
      marketCapUsd: null,
      marketCapSol: null,
      liquidityUsd: null,
      volumeUsd: null,
      holders: null,
      risk: { top10Pct: null, devPct: null, devSold: false, snipersPct: null, insidersPct: null, bundlersPct: null },
    });
    expect(matchesFilter(unknown, compileFilter(emptyFilter()), NOW)).toBe(true);
    const cases: [string, (f: ReturnType<typeof emptyFilter>) => void][] = [
      ["max MC", (f) => (f.metrics.marketCap.max = 50_000)],
      ["min MC", (f) => (f.metrics.marketCap.min = 1)],
      ["min liquidity", (f) => (f.metrics.liquidity.min = 1)],
      ["max volume", (f) => (f.metrics.volume.max = 1e12)],
      ["max top 10", (f) => (f.audit.top10.max = 100)],
      ["min holders", (f) => (f.audit.holders.min = 0)],
      ["max insiders", (f) => (f.audit.insiders.max = 50)],
    ];
    for (const [label, set] of cases) {
      const f = emptyFilter();
      set(f);
      expect([label, matchesFilter(unknown, compileFilter(f), NOW)]).toEqual([label, false]);
      expect([label, matchesFilter(token(), compileFilter(f), NOW)]).toEqual([label, true]);
    }
  });

  test("an unobserved creation time passes a minimum age and fails a maximum", () => {
    const old = token({ createdAt: Number.NaN });
    const min = emptyFilter();
    min.audit.ageMin.min = 10;
    const max = emptyFilter();
    max.audit.ageMin.max = 10;
    expect(matchesFilter(old, compileFilter(min), NOW)).toBe(true);
    expect(matchesFilter(old, compileFilter(max), NOW)).toBe(false);
  });

  test("the empty filter matches everything and counts zero conditions", () => {
    const f = emptyFilter();
    expect(activeFilterCount(f)).toBe(0);
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(true);
  });

  test("protocols, ranges and keywords", () => {
    const f = emptyFilter();
    f.protocols = ["bonk"];
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(false);
    f.protocols = ["pump"];
    f.audit.top10 = { min: null, max: 25 };
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(false);
    f.audit.top10 = { min: null, max: 30 };
    f.audit.ageMin = { min: 1, max: 10 };
    f.include = "frog, cat";
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(true);
    f.exclude = "based";
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(false);
    expect(activeFilterCount(f)).toBe(5);
  });

  test("socials", () => {
    const f = emptyFilter();
    f.socials.telegram = true;
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(false);
    f.socials.telegram = false;
    f.socials.atLeastOne = true;
    expect(matchesFilter(token(), compileFilter(f), NOW)).toBe(true);
  });

  test("export/import round-trips presets and drops junk", () => {
    const f = emptyFilter();
    f.metrics.marketCap = { min: 5_000, max: null };
    const parsed = parseFilterImport(exportFilters({ new: [f, emptyFilter(), emptyFilter()] }));
    expect(parsed.kind).toBe("columns");
    if (parsed.kind === "columns") expect(parsed.columns.new?.[0]?.metrics.marketCap.min).toBe(5_000);
    const single = parseFilterImport('{"protocols":["pump","nope"],"audit":{"dev":{"max":"x"}}}');
    expect(single.kind).toBe("single");
    if (single.kind === "single") {
      expect(single.filter.protocols).toEqual(["pump"]);
      expect(single.filter.audit.dev.max).toBeNull();
    }
    expect(() => parseFilterImport("not json")).toThrow();
  });
});

describe("blacklists", () => {
  test("token, dev, funding wallet and X handle", () => {
    const t = token();
    const entry = (value: string) => ({ value, note: "", addedAt: 0 });
    expect(isBlacklisted(t, compileBlacklists({ tokens: [], devs: [], fundingWallets: [], xHandles: [] }))).toBe(false);
    expect(isBlacklisted(t, compileBlacklists({ tokens: [], devs: [entry(t.creator)], fundingWallets: [], xHandles: [] }))).toBe(true);
    expect(
      isBlacklisted(t, compileBlacklists({ tokens: [], devs: [], fundingWallets: [entry(t.fundingWallet ?? "")], xHandles: [] })),
    ).toBe(true);
    expect(
      isBlacklisted(t, compileBlacklists({ tokens: [], devs: [], fundingWallets: [], xHandles: [entry("https://x.com/BFROG_SOL")] })),
    ).toBe(true);
  });
});
