import { describe, expect, test } from "bun:test";
import {
  fmtAge,
  fmtCompact,
  fmtCount,
  fmtDate,
  fmtFee,
  fmtPct,
  fmtPnlPct,
  fmtPriceText,
  fmtProgress,
  fmtRiskPct,
  fmtSignedSol,
  fmtSignedUsd,
  fmtSol,
  fmtSolShort,
  fmtUsd,
  fmtUsdExact,
  parseAmount,
  plainDecimal,
  priceParts,
  shortAddr,
  solTapeParts,
} from "./format";

// Expectations are the examples in docs/design/DESIGN.md section 3.

describe("USD (3.2)", () => {
  test("compact keeps 3 significant digits and trailing zeros", () => {
    expect(fmtUsd(0.004)).toBe("<$0.01");
    expect(fmtUsd(8.4237)).toBe("$8.42");
    expect(fmtUsd(842.4)).toBe("$842");
    expect(fmtUsd(12_345)).toBe("$12.3K");
    expect(fmtUsd(120_050)).toBe("$120K");
    expect(fmtUsd(1_240_000)).toBe("$1.24M");
    expect(fmtUsd(12_400_000)).toBe("$12.4M");
    expect(fmtCompact(4200)).toBe("4.20K");
  });
  test("rounds before choosing the suffix", () => {
    expect(fmtUsd(999_950)).toBe("$1.00M");
    expect(fmtCompact(999_400)).toBe("999K");
  });
  test("exact and signed", () => {
    expect(fmtUsdExact(3812.4)).toBe("$3,812.40");
    expect(fmtUsdExact(-12.08)).toBe("−$12.08");
    expect(fmtUsdExact(124_000)).toBe("$124K");
    expect(fmtSignedUsd(12.08)).toBe("+$12.08");
    expect(fmtSignedUsd(-3.1)).toBe("−$3.10");
    expect(fmtSignedUsd(0)).toBe("$0.00");
  });
});

describe("prices (3.3)", () => {
  test("ranges", () => {
    expect(fmtPriceText(1234.5)).toBe("1,234.50");
    expect(fmtPriceText(1.234)).toBe("1.234");
    expect(fmtPriceText(12.345)).toBe("12.35");
    expect(fmtPriceText(123.4)).toBe("123.40");
    expect(fmtPriceText(0.01235)).toBe("0.01235");
    expect(fmtPriceText(0.0001235)).toBe("0.0001235");
  });
  test("subscript-zero parts from 4 zeros after the decimal point", () => {
    expect(priceParts(0.000004123)).toEqual({ kind: "sub", sign: "", zeros: 5, digits: "4123" });
    expect(priceParts(0.00000002796)).toEqual({ kind: "sub", sign: "", zeros: 7, digits: "2796" });
    expect(priceParts(0.0000041)).toEqual({ kind: "sub", sign: "", zeros: 5, digits: "4100" });
  });
  test("rounding is decided on the rounded value", () => {
    expect(fmtPriceText(0.000099996)).toBe("0.0001000");
  });
  test("plain text never uses subscript glyphs; canvas may", () => {
    expect(fmtPriceText(0.000004123)).toBe("0.000004123");
    expect(fmtPriceText(0.000004123, true)).toBe("0.0₅4123");
    expect(plainDecimal(0.00000002796)).toBe("0.00000002796");
  });
});

describe("SOL amounts (3.4)", () => {
  test("by magnitude", () => {
    expect(fmtSol(12_345)).toBe("12.3K");
    expect(fmtSol(1234.5)).toBe("1,234.5");
    expect(fmtSol(123.45)).toBe("123.45");
    expect(fmtSol(1.25)).toBe("1.25");
    expect(fmtSol(12.3456)).toBe("12.346");
    expect(fmtSol(0.5)).toBe("0.50");
    expect(fmtSol(0.0125)).toBe("0.0125");
    expect(fmtSol(0.2512)).toBe("0.2512");
    expect(fmtSol(0.000312)).toBe("0.000312");
    expect(fmtSol(0.005)).toBe("0.005");
    expect(fmtSol(0.00004)).toBe("<0.0001");
    expect(fmtSignedSol(-1.25)).toBe("−1.25");
  });
  test("tape cells dim trailing zeros", () => {
    expect(solTapeParts(0.5)).toEqual({ main: "0.5", dim: "00" });
    expect(solTapeParts(1.234)).toEqual({ main: "1.234", dim: "" });
    expect(solTapeParts(2)).toEqual({ main: "2", dim: ".000" });
    expect(solTapeParts(0.0002)).toEqual({ main: "<0.001", dim: "" });
  });
  test("fees and user-entered amounts", () => {
    expect(fmtFee(0.000005)).toBe("0.000005");
    expect(fmtFee(0.0001)).toBe("0.0001");
    expect(fmtFee(0.00106)).toBe("0.00106");
    expect(fmtSolShort(0.25)).toBe("0.25");
    expect(fmtSolShort(1)).toBe("1");
  });
});

describe("percentages and counts (3.5, 3.6)", () => {
  test("decimals by range, explicit signs, U+2212", () => {
    expect(fmtPct(0.42)).toBe("0.42%");
    expect(fmtPct(12.34)).toBe("12.3%");
    expect(fmtPct(248.4)).toBe("248%");
    expect(fmtPct(1234)).toBe("1,234%");
    expect(fmtPct(12_345)).toBe("12.3K%");
    expect(fmtPct(12.34, { signed: true })).toBe("+12.3%");
    expect(fmtPct(-0.5, { signed: true })).toBe("−0.50%");
    expect(fmtPct(0, { signed: true })).toBe("0.00%");
  });
  test("risk chips and progress", () => {
    expect(fmtRiskPct(18.4)).toBe("18%");
    expect(fmtRiskPct(4.5)).toBe("4.5%");
    expect(fmtRiskPct(0.02)).toBe("<0.1%");
    expect(fmtRiskPct(0)).toBe("0%");
    expect(fmtProgress(0.873)).toBe("87%");
    expect(fmtProgress(1)).toBe("Migrating");
  });
  test("never prints +Infinity% for a zero cost basis", () => {
    expect(fmtPnlPct(1, 0)).toBe("–");
    expect(fmtPnlPct(0.5, 1)).toBe("+50.0%");
  });
  test("counts", () => {
    expect(fmtCount(1234)).toBe("1,234");
    expect(fmtCount(12_345)).toBe("12.3K");
  });
  test("unknown values are an en dash", () => {
    expect(fmtUsd(Number.NaN)).toBe("–");
    expect(fmtSol(Number.POSITIVE_INFINITY)).toBe("–");
  });
});

describe("ages, dates and addresses (3.7, 3.8)", () => {
  test("relative ages", () => {
    expect(fmtAge(0, 25_000)).toBe("25s");
    expect(fmtAge(0, 4 * 60_000)).toBe("4m");
    expect(fmtAge(0, 3 * 3_600_000)).toBe("3h");
    expect(fmtAge(0, 2 * 86_400_000)).toBe("2d");
    expect(fmtAge(0, 150 * 86_400_000)).toBe("5mo");
    expect(fmtAge(0, 400 * 86_400_000)).toBe("1y");
  });
  test("dates carry the year only outside the current one", () => {
    const now = new Date();
    expect(fmtDate(new Date(now.getFullYear(), 9, 3).getTime())).toBe("Oct 3");
    expect(fmtDate(new Date(2025, 9, 3).getTime())).toBe(now.getFullYear() === 2025 ? "Oct 3" : "Oct 3, 2025");
  });
  test("short addresses, with the pump rule", () => {
    expect(shortAddr("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
    expect(shortAddr("9Hd4cZqy3R5CCQ7cTxW6aRwRkGyiHnwyp9Pg2Rc7pump")).toBe("9Hd4cZ…pump");
  });
  test("parses typed amounts", () => {
    expect(parseAmount("1,5")).toBe(1.5);
    expect(parseAmount("2k")).toBe(2000);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
});
