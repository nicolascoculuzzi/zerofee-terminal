import { describe, expect, test } from "bun:test";
import type { TokenSummary } from "../../protocol";
import { findDevs } from "./devs";

const token = (mint: string, creator: string, migrated = false) =>
  ({ mint, symbol: mint.toUpperCase(), creator, migratedAt: migrated ? 1 : null }) as unknown as TokenSummary;

const live = Object.fromEntries(
  [token("a", "DevAlpha111"), token("b", "DevAlpha111", true), token("c", "DevBeta2222"), token("d", "Other33333")].map((t) => [t.mint, t]),
);

describe("palette dev hits", () => {
  test("address prefix matches come first, with live-set counts", () => {
    const hits = findDevs("devalp", live, [], 5);
    expect(hits).toEqual([{ address: "DevAlpha111", launches: 2, migrated: 1, via: null }]);
  });

  test("creators of the top token hits follow, once each", () => {
    const hits = findDevs("c", live, [live.c!, live.a!, live.b!, live.d!], 5);
    expect(hits.map((h) => [h.address, h.via?.mint])).toEqual([
      ["DevBeta2222", "c"],
      ["DevAlpha111", "a"],
    ]);
  });

  test("short queries skip prefix matching; limit applies", () => {
    expect(findDevs("de", live, [], 5)).toEqual([]);
    expect(findDevs("dev", live, [], 1)).toHaveLength(1);
    expect(findDevs("", live, [live.a!], 5)).toEqual([]);
  });

  test("a token without a known creator yields no dev row", () => {
    const anon = token("e", "");
    expect(findDevs("e", { ...live, e: anon }, [anon], 5)).toEqual([]);
  });
});
