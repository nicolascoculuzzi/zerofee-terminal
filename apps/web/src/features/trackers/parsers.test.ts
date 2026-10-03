import { describe, expect, test } from "bun:test";
import type { TokenSummary } from "../../protocol";
import { rankTrending, sortRanked, trendScore } from "../discover/ranking";
import { parseHandleImport } from "./handleImport";
import { parseWalletImport, parseWalletLine, walletsToJson, walletsToLines } from "./walletImport";

const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const C = "So11111111111111111111111111111111111111112";

const plain = (address: string, name: string) => ({ address, name, emoji: "", alerts: false });

describe("wallet import: one line per wallet", () => {
  test("separators other tools export", () => {
    expect(parseWalletLine(`${A} Smart money 1`)).toEqual(plain(A, "Smart money 1"));
    expect(parseWalletLine(`Fresh whale:${B}`)).toEqual(plain(B, "Fresh whale"));
    expect(parseWalletLine(`${A},Dev wallet`)).toEqual(plain(A, "Dev wallet"));
    expect(parseWalletLine(`${A}:KOL`)).toEqual(plain(A, "KOL"));
    expect(parseWalletLine(`${A} - Insider`)).toEqual(plain(A, "Insider"));
    expect(parseWalletLine(`${A}\tTabbed name`)).toEqual(plain(A, "Tabbed name"));
  });

  test("quoted CSV, a leading tag and an alerts flag", () => {
    expect(parseWalletLine(`${A},"Whale, big",🐋,true`)).toEqual({ address: A, name: "Whale, big", emoji: "🐋", alerts: true });
    expect(parseWalletLine(`🦈 Shark ${B}`)).toEqual({ address: B, name: "Shark", emoji: "🦈", alerts: false });
  });

  test("address only falls back to the short address; no address is no wallet", () => {
    expect(parseWalletLine(C)?.name).toBe("So11…1112");
    expect(parseWalletLine("hello world")).toBeNull();
  });

  test("headers, comments, junk and duplicates", () => {
    const r = parseWalletImport(`address,name\n# comment\n${A},One\n${B} Two\nnot a wallet\n${A},Dupe\n`);
    expect(r.format).toBe("lines");
    expect(r.wallets.map((w) => w.name)).toEqual(["One", "Two"]);
    expect(r.skipped.map((s) => s.where)).toEqual(["Line 5"]);
    expect(r.duplicates).toBe(1);
  });
});

describe("wallet import: JSON", () => {
  test("our export round-trips", () => {
    const ours = [{ address: A, name: "Whale", emoji: "W", alerts: true, createdAt: 1 }];
    expect(parseWalletImport(walletsToJson(ours)).wallets).toEqual([{ address: A, name: "Whale", emoji: "W", alerts: true }]);
    expect(walletsToLines(ours)).toBe(`${A} Whale`);
  });

  test("other tools' shapes", () => {
    const bullx = parseWalletImport(
      JSON.stringify([
        { walletAddress: A, label: "KOL A" },
        { address: B, tag: "Sniper" },
        { walletAddress: "bad", label: "x" },
      ]),
    );
    expect(bullx.wallets.map((w) => w.name)).toEqual(["KOL A", "Sniper"]);
    expect(bullx.skipped.map((s) => s.reason)).toEqual(["Not a Solana address"]);
    expect(parseWalletImport(JSON.stringify({ wallets: [{ address: A, name: "W" }] })).wallets).toHaveLength(1);
    expect(
      parseWalletImport(JSON.stringify({ [A]: "Mapped", [B]: { name: "Obj", emoji: "F" } })).wallets.map((w) => [w.name, w.emoji]),
    ).toEqual([
      ["Mapped", ""],
      ["Obj", "F"],
    ]);
    expect(parseWalletImport(JSON.stringify({ address: A, name: "Solo" })).wallets.map((w) => w.name)).toEqual(["Solo"]);
    expect(parseWalletImport(JSON.stringify([[A, "Pair"]])).wallets.map((w) => w.name)).toEqual(["Pair"]);
  });

  test("broken JSON explains itself; blank input is empty", () => {
    expect(parseWalletImport("[{ address: ").error?.startsWith("Looks like JSON")).toBe(true);
    expect(parseWalletImport("   ").format).toBe("empty");
  });
});

describe("X handle import", () => {
  test("handles, profile URLs, invalid entries and duplicates", () => {
    const r = parseHandleImport("@Curve_Hunter, https://x.com/migration_alpha\nbad-handle! toolonghandle_123456 curve_hunter");
    expect(r.handles.map((h) => h.handle)).toEqual(["curve_hunter", "migration_alpha"]);
    expect(r.invalid).toEqual(["bad-handle!", "toolonghandle_123456"]);
    expect(r.duplicates).toBe(1);
  });

  test("JSON keeps per-handle switches", () => {
    const r = parseHandleImport(JSON.stringify([{ handle: "a_b", tweets: false, profile: true, follows: true }, "c"]));
    expect(r.handles).toEqual([{ handle: "a_b", tweets: false, profile: true, follows: true }, { handle: "c" }]);
  });
});

describe("trending rank", () => {
  const now = 10_000_000_000;
  const token = (patch: Partial<TokenSummary>): TokenSummary =>
    ({
      mint: "m",
      createdAt: now - 30 * 60_000,
      lastTradeAt: now - 5_000,
      change5mPct: 40,
      txns: 100,
      volumeUsd: 50_000,
      ...patch,
    }) as TokenSummary;
  const base = token({});

  test("5m favours recent, busy, rising tokens", () => {
    expect(trendScore(base, "5m", now)).toBeGreaterThan(trendScore(token({ lastTradeAt: now - 10 * 60_000 }), "5m", now));
    expect(trendScore(base, "5m", now)).toBeGreaterThan(trendScore(token({ txns: 2 }), "5m", now));
    expect(trendScore(base, "5m", now)).toBeGreaterThan(trendScore(token({ change5mPct: -30 }), "5m", now));
  });

  test("windows pro-rate older tokens; idle ones drop out", () => {
    const young = token({ mint: "y", createdAt: now - 20 * 60_000, volumeUsd: 40_000, txns: 80 });
    const old = token({ mint: "o", createdAt: now - 20 * 3_600_000, volumeUsd: 200_000, txns: 400 });
    expect(trendScore(young, "1h", now)).toBeGreaterThan(trendScore(old, "1h", now));
    expect(trendScore(old, "24h", now)).toBeGreaterThan(trendScore(young, "24h", now));
    expect(trendScore({ ...old, lastTradeAt: now - 2 * 3_600_000 }, "1h", now)).toBeLessThan(0.01);

    const ranked = rankTrending([young, old], "1h", now, () => true);
    expect(ranked.map((r) => [r.token.mint, r.rank])).toEqual([
      ["y", 1],
      ["o", 2],
    ]);
    expect(sortRanked(ranked, "vol", "desc").map((r) => r.token.mint)).toEqual(["o", "y"]);
    expect(sortRanked(ranked, "rank", "desc").map((r) => r.rank)).toEqual([2, 1]);
  });
});
