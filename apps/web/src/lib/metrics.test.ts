import { describe, expect, test } from "bun:test";
import type { Token2022Flags, TokenRisk } from "../protocol";
import { bandsText, buyRiskReasons, RISK_DEFAULTS, riskTone } from "./metrics";

const calm: TokenRisk = { top10Pct: 18.2, devPct: 2.1, devSold: false, snipersPct: 4.4, insidersPct: 1.3, bundlersPct: 6.7 };
const noFlags: Token2022Flags = {
  permanentDelegate: false,
  transferHook: false,
  pausable: false,
  nonTransferable: false,
  defaultFrozen: false,
};

describe("risk bands (DESIGN.md 3.11)", () => {
  test("bands are decided on the displayed value", () => {
    // 34.96 reads "35%", so it is red, never amber.
    expect(riskTone("top10", 34.96)).toBe("bad");
    expect(riskTone("top10", 34.4)).toBe("warn");
    expect(riskTone("dev", 4.96)).toBe("warn");
    expect(riskTone("dev", 4.94)).toBe("good");
    expect(riskTone("insiders", 3)).toBe("warn");
  });
  test("unknown values have their own tone", () => {
    expect(riskTone("snipers", null)).toBe("unknown");
    expect(riskTone("snipers", Number.NaN)).toBe("unknown");
  });
  test("tooltips write the bands out in words, without comparison glyphs", () => {
    expect(bandsText("top10")).toBe("Green under 20% · Amber 20–35% · Red 35% or more");
  });
});

describe("buys that need the countdown confirm (DESIGN.md 1.7)", () => {
  test("a calm token goes straight through", () => {
    expect(buyRiskReasons({ risk: calm, token2022: null })).toEqual([]);
    expect(buyRiskReasons({ risk: calm, token2022: noFlags })).toEqual([]);
  });

  test("any Token-2022 danger flag asks", () => {
    const reasons = buyRiskReasons({ risk: calm, token2022: { ...noFlags, permanentDelegate: true, transferHook: true } });
    expect(reasons).toEqual(["Token-2022 extensions: permanentDelegate, transferHook"]);
  });

  test("three high-risk holder metrics ask; two don't", () => {
    const two = { ...calm, top10Pct: 41.7, snipersPct: 18.3 };
    expect(buyRiskReasons({ risk: two, token2022: null })).toEqual([]);
    const three = { ...two, bundlersPct: 22.4 };
    expect(buyRiskReasons({ risk: three, token2022: null })).toEqual([
      "High risk on 3 holder metrics: Top 10 42%, Snipers 18%, Bundlers 22%",
    ]);
  });

  test("a dev who sold everything doesn't count as a dev-holdings risk", () => {
    const risk = { ...calm, top10Pct: 41.7, snipersPct: 18.3, devPct: 12.6, devSold: true };
    expect(buyRiskReasons({ risk, token2022: null })).toEqual([]);
  });

  test("user thresholds apply", () => {
    const strict = {
      ...RISK_DEFAULTS,
      top10: [10, 15] as [number, number],
      dev: [1, 2] as [number, number],
      bundlers: [2, 5] as [number, number],
    };
    expect(buyRiskReasons({ risk: calm, token2022: null }, strict)).toEqual([
      "High risk on 3 holder metrics: Top 10 18%, Dev 2.1%, Bundlers 6.7%",
    ]);
  });
});
