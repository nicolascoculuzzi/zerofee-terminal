import { describe, expect, test } from "bun:test";
import { fmtAge, fmtCompact, fmtPct, fmtPnlPct, fmtSmall, fmtSol, fmtSolShort, fmtUsd, parseAmount, shortAddr } from "./format";

describe("fmtSmall", () => {
  test("subscript-zero notation counts the zeros after the decimal point", () => {
    expect(fmtSmall(0.00000002796)).toBe("0.0₇2796");
    expect(fmtSmall(0.0001)).toBe("0.0₃1");
    expect(fmtSmall(0.000001234)).toBe("0.0₅1234");
  });
  test("rounding carries into the exponent", () => {
    expect(fmtSmall(0.00099996, 4)).toBe("0.001");
  });
  test("ordinary numbers keep significant digits", () => {
    expect(fmtSmall(0.01234)).toBe("0.01234");
    expect(fmtSmall(12.5)).toBe("12.5");
  });
});

describe("fmtCompact / fmtUsd", () => {
  test("keeps trailing zeros so columns line up", () => {
    expect(fmtCompact(4200)).toBe("4.20K");
    expect(fmtCompact(12_345_678)).toBe("12.3M");
  });
  test("rolls over to the next unit instead of printing 1000K", () => {
    expect(fmtCompact(999_950)).toBe("1.00M");
    expect(fmtCompact(999_400)).toBe("999K");
  });
  test("usd prefix and sign", () => {
    expect(fmtUsd(45_812)).toBe("$45.8K");
    expect(fmtUsd(-1520)).toBe("-$1.52K");
  });
});

describe("SOL amounts", () => {
  test("fixed decimals per magnitude", () => {
    expect(fmtSol(0.0123)).toBe("0.012");
    expect(fmtSol(1.25)).toBe("1.250");
    expect(fmtSol(12.3)).toBe("12.30");
    expect(fmtSol(123.45)).toBe("123.5");
  });
  test("user-entered amounts stay short", () => {
    expect(fmtSolShort(0.5)).toBe("0.5");
    expect(fmtSolShort(0.25)).toBe("0.25");
  });
});

describe("percentages and PnL", () => {
  test("signed percent with one decimal", () => {
    expect(fmtPct(12.34, { signed: true })).toBe("+12.3%");
    expect(fmtPct(-0.5, { signed: true })).toBe("-0.5%");
  });
  test("never prints +Infinity% for a zero cost basis", () => {
    expect(fmtPnlPct(1, 0)).toBe("—");
    expect(fmtPnlPct(0.5, 1)).toBe("+50.0%");
  });
});

describe("misc", () => {
  test("relative ages", () => {
    expect(fmtAge(0, 25_000)).toBe("25s");
    expect(fmtAge(0, 4 * 60_000)).toBe("4m");
    expect(fmtAge(0, 3 * 3_600_000)).toBe("3h");
  });
  test("parses typed amounts", () => {
    expect(parseAmount("1,5")).toBe(1.5);
    expect(parseAmount("2k")).toBe(2000);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
  });
  test("short addresses", () => {
    expect(shortAddr("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX…gAsU");
  });
});
