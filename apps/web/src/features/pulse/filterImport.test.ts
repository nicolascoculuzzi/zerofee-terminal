import { describe, expect, test } from "bun:test";
import { emptyFilter, exportFilters } from "../../lib/filters";
import { importFilters } from "./filterImport";

describe("importFilters", () => {
  test("round-trips our versioned export", () => {
    const f = emptyFilter();
    f.metrics.marketCap = { min: 5000, max: null };
    const parsed = importFilters(exportFilters(f));
    expect(parsed.kind).toBe("single");
    if (parsed.kind === "single") expect(parsed.filter.metrics.marketCap).toEqual({ min: 5000, max: null });
  });

  test("maps Axiom-style label keys, ranges and amounts", () => {
    const parsed = importFilters(
      JSON.stringify({
        "Search Keywords": ["pepe", "cat"],
        "Top 10 Holders %": { min: 0, max: 30 },
        "Bundle %": [null, 10],
        "Age (mins)": { max: "15" },
        "Market Cap ($)": { min: "5k", max: "1.2m" },
        numBuysMin: 40,
        Protocols: ["Pump", "Bonk", "Printr"],
        "Quote Tokens": ["SOL", "STOCK"],
        Twitter: true,
        "Dex Paid": true,
      }),
    );
    expect(parsed.kind).toBe("single");
    if (parsed.kind !== "single") return;
    const f = parsed.filter;
    expect(f.include).toBe("pepe, cat");
    expect(f.audit.top10).toEqual({ min: 0, max: 30 });
    expect(f.audit.bundlers).toEqual({ min: null, max: 10 });
    expect(f.audit.ageMin).toEqual({ min: null, max: 15 });
    expect(f.metrics.marketCap).toEqual({ min: 5000, max: 1_200_000 });
    expect(f.metrics.buys).toEqual({ min: 40, max: null });
    expect(f.protocols).toEqual(["pump", "bonk"]);
    expect(f.quotes).toEqual(["SOL"]);
    expect(f.socials.x).toBe(true);
    expect(f.socials.dexPaid).toBe(true);
  });

  test("reads per-column presets keyed by column name", () => {
    const parsed = importFilters(JSON.stringify({ "New Pairs": [{ Holders: { min: 50 } }], migrated: { Liquidity: [10000, null] } }));
    expect(parsed.kind).toBe("columns");
    if (parsed.kind !== "columns") return;
    expect(parsed.columns.new?.[0]?.audit.holders).toEqual({ min: 50, max: null });
    expect(parsed.columns.migrated?.[0]?.metrics.liquidity).toEqual({ min: 10000, max: null });
  });

  test("rejects JSON with no filter fields", () => {
    expect(() => importFilters('{"hello":1}')).toThrow();
    expect(() => importFilters("not json")).toThrow();
  });
});
