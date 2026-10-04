import { describe, expect, test } from "bun:test";
import { activeFilterCount, emptyFilter } from "../../lib/filters";
import { filterChips, rangeText, shortNumber } from "./filterChips";

describe("shortNumber", () => {
  test("drops padding zeros after the point only", () => {
    expect(shortNumber(5000)).toBe("5K");
    expect(shortNumber(1_200_000)).toBe("1.2M");
    expect(shortNumber(100_000)).toBe("100K");
    expect(shortNumber(12_500)).toBe("12.5K");
    expect(shortNumber(950)).toBe("950");
    expect(shortNumber(0.5)).toBe("0.5");
  });
});

describe("rangeText", () => {
  const usd = (n: number) => `$${shortNumber(n)}`;
  test("writes ranges out without comparison glyphs", () => {
    expect(rangeText({ min: 5000, max: 50_000 }, usd)).toBe("$5K–$50K");
    expect(rangeText({ min: 5000, max: null }, usd)).toBe("$5K+");
    expect(rangeText({ min: null, max: 20 }, (n) => `${n}%`)).toBe("up to 20%");
  });
});

describe("filterChips", () => {
  test("an empty filter has no chips", () => {
    expect(filterChips(emptyFilter())).toEqual([]);
  });

  test("one chip per active condition, and clear removes exactly that one", () => {
    const f = emptyFilter();
    f.include = "pepe, cat";
    f.metrics.marketCap = { min: 5000, max: 50_000 };
    f.audit.top10 = { min: null, max: 20 };
    f.socials.x = true;
    f.protocols = ["pump", "bonk"];
    const chips = filterChips(f);
    expect(chips.map((c) => `${c.label}|${c.value}`)).toEqual([
      "Include|pepe, cat",
      "Protocols|Pump, Bonk",
      "Top 10|up to 20%",
      "MC|$5K–$50K",
      "Has|X",
    ]);
    expect(chips.length).toBe(activeFilterCount(f));
    const mc = chips.find((c) => c.id === "metrics.marketCap");
    const cleared = mc?.clear(f);
    expect(cleared?.metrics.marketCap).toEqual({ min: null, max: null });
    expect(cleared?.audit.top10).toEqual({ min: null, max: 20 });
  });
});
