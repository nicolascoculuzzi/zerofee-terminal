import { describe, expect, test } from "bun:test";
import type { TokenRef, TokenSummary, TrackedTrade } from "../../protocol";
import { rankTrending, sortRanked, trendScore } from "../discover/ranking";
import { filterTrades, mcSol, normalizeQuery, sizeBarPct } from "./feedFilters";
import { parseHandleImport } from "./handleImport";
import { aggregateMonitor, compareMonitor, FLOW_WINDOW_MS, sameMonitorRow } from "./monitorData";
import type { TradeFilters } from "./prefs";
import { parseWalletImport, parseWalletLine, walletsToJson, walletsToLines } from "./walletImport";

const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const C = "So11111111111111111111111111111111111111112";
const WHALE = "\u{1F40B}";
const SHARK = "\u{1F988}";

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
    // Imported tags are user data (other tools export emoji); escapes keep src/ free of emoji code points.
    expect(parseWalletLine(`${A},"Whale, big",${WHALE},true`)).toEqual({ address: A, name: "Whale, big", emoji: WHALE, alerts: true });
    expect(parseWalletLine(`${SHARK} Shark ${B}`)).toEqual({ address: B, name: "Shark", emoji: SHARK, alerts: false });
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

describe("live trades and monitor", () => {
  const now = 20_000_000_000;
  const ref = (mint: string, patch: Partial<TokenRef> = {}): TokenRef => ({
    mint,
    symbol: mint.toUpperCase(),
    name: `${mint} coin`,
    imageUri: null,
    launchpad: "pump",
    createdAt: now - 10 * 60_000,
    marketCapUsd: 10_000,
    ...patch,
  });
  let seq = 0;
  const trade = (
    maker: string,
    token: TokenRef,
    side: "buy" | "sell",
    sol: number,
    opts: { ago?: number; tokens?: number; mc?: number } = {},
  ): TrackedTrade => ({
    token,
    trade: {
      id: `t${seq++}`,
      signature: "sig",
      mint: token.mint,
      ts: now - (opts.ago ?? 0),
      slot: 1,
      side,
      solAmount: sol,
      tokenAmount: opts.tokens ?? sol * 1_000_000,
      priceSol: 0.000_000_03,
      priceUsd: 0.000_003_6,
      marketCapUsd: opts.mc ?? 12_400,
      maker,
      tags: [],
    },
  });
  const none: TradeFilters = { side: "all", minSol: null, mcMin: null, mcMax: null, launchpads: [], under1h: false };
  const never = () => false;

  test("filters: side, size, MC range, launchpad, age and search", () => {
    const wif = ref("wif");
    const old = ref("old", { launchpad: "bonk", createdAt: now - 2 * 3_600_000 });
    const feed = [trade(A, wif, "buy", 0.5), trade(B, wif, "sell", 2, { mc: 80_000 }), trade(A, old, "buy", 1.25)];
    const wallets = new Map([[A, { address: A, name: "Cupsey", emoji: "", alerts: false, createdAt: 0 }]]);
    const ids = (f: Partial<TradeFilters>, query = "") =>
      filterTrades(feed, { ...none, ...f }, never, { query, wallets, now }).map((t) => t.trade.id);
    const [t0, t1, t2] = feed.map((t) => t.trade.id);
    expect(ids({})).toEqual([t0, t1, t2]);
    expect(ids({ side: "sell" })).toEqual([t1]);
    expect(ids({ minSol: 1 })).toEqual([t1, t2]);
    expect(ids({ mcMin: 50_000 })).toEqual([t1]);
    expect(ids({ mcMax: 50_000 })).toEqual([t0, t2]);
    expect(ids({ launchpads: ["bonk"] })).toEqual([t2]);
    expect(ids({ under1h: true })).toEqual([t0, t1]);
    expect(ids({}, normalizeQuery("cup"))).toEqual([t0, t2]);
    expect(ids({}, normalizeQuery("$WIF"))).toEqual([t0, t1]);
    expect(filterTrades(feed, none, (m) => m === "wif").map((t) => t.trade.id)).toEqual([t2]);
  });

  test("size bar and SOL market cap", () => {
    expect(sizeBarPct(0)).toBe(0);
    expect(sizeBarPct(10)).toBe(60);
    expect(sizeBarPct(100)).toBe(60);
    expect(sizeBarPct(1)).toBeCloseTo(60 * (Math.log10(2) / Math.log10(11)), 6);
    expect(mcSol({ marketCapUsd: 12_000, priceSol: 1, priceUsd: 120 })).toBe(100);
    expect(mcSol({ marketCapUsd: 12_000, priceSol: 1, priceUsd: 0 })).toBeNull();
  });

  test("monitor: holders, 15 m net flow, first buy, exits", () => {
    const wif = ref("wif");
    const bonk = ref("bonk");
    // The feed is stored newest first.
    const feed = [
      trade(B, bonk, "sell", 1, { ago: 1_000, tokens: 1_000_000 }), // B exits BONK
      trade(A, wif, "buy", 0.5, { ago: 2_000 }),
      trade(B, wif, "buy", 1, { ago: 3_000 }),
      trade(B, bonk, "buy", 1, { ago: FLOW_WINDOW_MS + 60_000, tokens: 1_000_000 }), // outside the flow window
    ];
    const rows = aggregateMonitor(feed, now);
    const byMint = new Map(rows.map((r) => [r.mint, r]));
    const w = byMint.get("wif");
    const b = byMint.get("bonk");
    expect(w?.holders).toEqual([A, B]);
    expect(w?.flowSol).toBeCloseTo(1.5, 9);
    expect(w?.firstBuyAt).toBe(now - 3_000);
    expect(b?.holders).toEqual([]);
    expect(b?.flowSol).toBeCloseTo(-1, 9);
    expect(rows.slice().sort(compareMonitor("holders", "desc", (r) => r.lastMcUsd))[0]?.mint).toBe("wif");
    expect(rows.slice().sort(compareMonitor("flow", "asc", (r) => r.lastMcUsd))[0]?.mint).toBe("bonk");
    // Rebuilt rows compare equal until something they show changes (memoised rows skip renders).
    const again = new Map(aggregateMonitor(feed, now).map((r) => [r.mint, r]));
    expect(w && again.get("wif") && sameMonitorRow(w, again.get("wif") as typeof w)).toBe(true);
    const later = new Map(aggregateMonitor([trade(A, wif, "buy", 0.25), ...feed], now).map((r) => [r.mint, r]));
    expect(w && later.get("wif") && sameMonitorRow(w, later.get("wif") as typeof w)).toBe(false);
    // A token nobody holds and nobody touched for 15 minutes drops out.
    expect(aggregateMonitor(feed, now + FLOW_WINDOW_MS + 10_000).map((r) => r.mint)).toEqual(["wif"]);
  });
});
