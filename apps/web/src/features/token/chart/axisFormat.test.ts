import { describe, expect, test } from "bun:test";
import { AxisFormat, compactAt, minMoveFor, priceAtParts, priceAtText, stepDecimals, tickStep } from "./axisFormat";

const SUB5 = String.fromCharCode(0x2085);
const SUB4 = String.fromCharCode(0x2084);

describe("stepDecimals", () => {
  test("decimals that print every multiple exactly", () => {
    expect(stepDecimals(10)).toBe(0);
    expect(stepDecimals(1)).toBe(0);
    expect(stepDecimals(0.5)).toBe(1);
    expect(stepDecimals(0.25)).toBe(2);
    expect(stepDecimals(0.02)).toBe(2);
    expect(stepDecimals(0.0025)).toBe(4);
    expect(stepDecimals(0)).toBe(0);
    expect(stepDecimals(Number.NaN)).toBe(0);
  });
});

describe("tickStep", () => {
  test("smallest gap between distinct ticks", () => {
    expect(tickStep([42700, 42750, 42800])).toBe(50);
    expect(tickStep([3, 1, 2, 2])).toBe(1);
    expect(tickStep([5])).toBeNaN();
  });
});

describe("compactAt", () => {
  test("adapts decimals to the step so neighbouring ticks differ", () => {
    const ticks = [42700, 42710, 42720, 42730, 42740];
    const labels = ticks.map((v) => compactAt(v, 10));
    expect(labels).toEqual(["42.70K", "42.71K", "42.72K", "42.73K", "42.74K"]);
    expect(new Set(labels).size).toBe(ticks.length);
  });
  test("coarse steps keep the minimum significant digits", () => {
    expect(compactAt(42709, 1000)).toBe("42.7K");
    expect(compactAt(60000, 10000, 2)).toBe("60K");
    expect(compactAt(5050, 10000)).toBe("5.05K");
  });
  test("units, rounding into the next unit, small values and signs", () => {
    expect(compactAt(999_960, 10)).toBe("999.96K");
    expect(compactAt(999_960, 100)).toBe("1.0000M");
    expect(compactAt(999_999, 100_000)).toBe("1.00M");
    expect(compactAt(1_234_567, 1000)).toBe("1.235M");
    expect(compactAt(353.17, 0.01)).toBe("353.17");
    expect(compactAt(-1500, 100)).toBe("−1.50K");
    expect(compactAt(0, 200)).toBe("0");
    expect(compactAt(Number.NaN, 1)).toBe("–");
  });
  test("unknown step falls back to 3 significant digits", () => {
    expect(compactAt(42709.5, Number.NaN)).toBe("42.7K");
  });
});

describe("priceAtParts", () => {
  test("tiny prices use subscript-zero notation with step-adaptive digits", () => {
    expect(priceAtParts(0.000004123, Number.NaN)).toEqual({ kind: "sub", zeros: 5, digits: "4123" });
    expect(priceAtParts(0.0000041, Number.NaN)).toEqual({ kind: "sub", zeros: 5, digits: "4100" });
    // A step of 1e-10 needs 10 decimals: 6 significant digits after the 4 zeros.
    expect(priceAtParts(0.000042709, 1e-10)).toEqual({ kind: "sub", zeros: 4, digits: "427090" });
    expect(priceAtText(0.000004123, Number.NaN)).toBe(`0.0${SUB5}4123`);
    expect(priceAtText(0.000042709, Number.NaN)).toBe(`0.0${SUB4}4271`);
  });
  test("rounding that removes a zero", () => {
    expect(priceAtParts(0.000099999, Number.NaN)).toEqual({ kind: "plain", text: "0.0001000" });
  });
  test("plain ranges follow DESIGN.md 3.3", () => {
    expect(priceAtParts(0.01235, Number.NaN)).toEqual({ kind: "plain", text: "0.01235" });
    expect(priceAtParts(12.345, Number.NaN)).toEqual({ kind: "plain", text: "12.35" });
    expect(priceAtParts(1234.5, Number.NaN)).toEqual({ kind: "plain", text: "1,234.50" });
    expect(priceAtParts(1.5, 0.001)).toEqual({ kind: "plain", text: "1.500" });
    expect(priceAtParts(0, 1)).toEqual({ kind: "plain", text: "0" });
  });
});

describe("AxisFormat", () => {
  test("MC mode: one $42.7K-range axis prints distinct ticks and matching labels", () => {
    const f = new AxisFormat("mc", "USD", 1e9);
    const ticks = f.tickmarks([42680, 42690, 42700, 42710]);
    expect(ticks).toEqual(["$42.68K", "$42.69K", "$42.70K", "$42.71K"]);
    expect(f.format(42709.5)).toBe("$42.71K");
  });
  test("SOL quote has no $", () => {
    const f = new AxisFormat("mc", "SOL", 1e9);
    expect(f.tickmarks([353.1, 353.2])).toEqual(["353.1", "353.2"]);
  });
  test("price mode divides by supply and keeps ticks distinct", () => {
    const f = new AxisFormat("price", "USD", 1e9);
    const ticks = f.tickmarks([42700, 42710, 42720]);
    expect(new Set(ticks).size).toBe(3);
    expect(ticks[0]?.startsWith(`$0.0${SUB4}`)).toBe(true);
    expect(f.legend(42710)).toEqual({ prefix: "$", parts: { kind: "sub", zeros: 4, digits: "4271" } });
  });
  test("never negative: blank ticks below zero, labels clamp to 0", () => {
    const f = new AxisFormat("mc", "USD", 1e9);
    expect(f.tickmarks([-10000, 0, 10000])).toEqual(["", "$0", "$10K"]);
    expect(f.format(-5000)).toBe("$0");
  });
});

describe("minMoveFor", () => {
  test("follows magnitude", () => {
    expect(minMoveFor(42709)).toBe(0.001);
    expect(minMoveFor(353)).toBeCloseTo(0.00001, 12);
    expect(minMoveFor(0)).toBe(0.0001);
  });
});
