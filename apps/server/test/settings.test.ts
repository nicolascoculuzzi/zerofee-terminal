/**
 * Settings REST against the running gateway with a PGlite user database: trading wallets, presets,
 * settings, watchlist, blacklists, the wallet tracker (CRUD, BullX / GMGN / Axiom / text import and
 * export), per-user isolation and limits.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type BlacklistsResponse,
  DEFAULT_PRESETS,
  DEFAULT_USER_SETTINGS,
  type TrackedWallet,
  type TrackedWalletImportResult,
  type TradingPreset,
  type TradingWallet,
  type UserSettings,
  type WatchlistEntry,
} from "@zerofee/protocol";
import { exportWalletList, parseWalletList, WalletListError } from "../src/api/walletFormats";
import { addr } from "./helpers";
import { Browser, startUserApp, type UserTestEnv } from "./userHelpers";

let env: UserTestEnv;
let alice: Browser;
let bob: Browser;

beforeAll(async () => {
  env = await startUserApp();
  alice = new Browser(env);
  bob = new Browser(env);
  await alice.signIn();
  await bob.signIn();
}, 60_000);
afterAll(async () => {
  await env.close();
});

describe("access", () => {
  test("settings need a session, mutations also need our Origin", async () => {
    expect((await fetch(`${env.base}/api/settings`)).status).toBe(401);
    const noOrigin = new Browser(env, null);
    noOrigin.cookie = alice.cookie;
    expect((await noOrigin.req("GET", "/api/settings")).status).toBe(200);
    expect((await noOrigin.req("PATCH", "/api/settings", { theme: "light" })).status).toBe(403);
    const evil = new Browser(env, "https://evil.example");
    evil.cookie = alice.cookie;
    expect((await evil.req("PUT", `/api/watchlist/${addr("w")}`)).status).toBe(403);
    expect((await alice.req("POST", "/api/settings", {})).status).toBe(405);
  });
});

describe("trading wallets", () => {
  test("public keys + labels, never the connected wallet, capped at 25", async () => {
    const k = addr("tw-a");
    const created = await alice.json<TradingWallet>("POST", "/api/trading-wallets", { publicKey: k, label: "main" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ publicKey: k, label: "main" });
    expect((await alice.json("POST", "/api/trading-wallets", { publicKey: k, label: "x", secretKey: "nope" })).status).toBe(400);
    expect((await alice.json("POST", "/api/trading-wallets", { publicKey: "not-an-address" })).status).toBe(400);
    const me = (await alice.json<{ wallet: string }>("GET", "/api/me")).body;
    expect((await alice.json("POST", "/api/trading-wallets", { publicKey: me.wallet })).status).toBe(400);
    expect((await alice.json<TradingWallet>("PATCH", `/api/trading-wallets/${k}`, { label: "sniper" })).body.label).toBe("sniper");
    expect((await alice.json<TradingWallet[]>("GET", "/api/trading-wallets")).body.map((w) => w.publicKey)).toEqual([k]);
    expect((await bob.json<TradingWallet[]>("GET", "/api/trading-wallets")).body).toEqual([]);
    expect((await bob.json("PATCH", `/api/trading-wallets/${k}`, { label: "mine now" })).status).toBe(404);

    for (let i = 1; i < 25; i++)
      expect((await alice.req("POST", "/api/trading-wallets", { publicKey: addr(`tw-a-${i}`) })).status).toBe(200);
    const over = await alice.json<{ code: string }>("POST", "/api/trading-wallets", { publicKey: addr("tw-a-25") });
    expect(over.status).toBe(422);
    expect(over.body.code).toBe("limit_exceeded");
    expect((await alice.req("DELETE", `/api/trading-wallets/${k}`)).status).toBe(200);
    expect((await alice.req("DELETE", `/api/trading-wallets/${k}`)).status).toBe(404);
  });
});

describe("presets and settings", () => {
  test("presets: three slots with defaults; PUT validates every field", async () => {
    expect((await alice.json<TradingPreset[]>("GET", "/api/presets")).body).toEqual([...DEFAULT_PRESETS]);
    const side = { slippageBps: 800, priorityFeeSol: 0.001, tipSol: 0.0002, landing: "secure", autoFee: false };
    const r = await alice.json<TradingPreset>("PUT", "/api/presets/2", { name: "Safe", buy: side, sell: { ...side, slippageBps: 2000 } });
    expect(r.status).toBe(200);
    const list = (await alice.json<TradingPreset[]>("GET", "/api/presets")).body;
    expect(list[1]).toEqual({ slot: 2, name: "Safe", buy: side, sell: { ...side, slippageBps: 2000 } } as TradingPreset);
    expect(list[0]).toEqual(DEFAULT_PRESETS[0] as TradingPreset);
    expect((await bob.json<TradingPreset[]>("GET", "/api/presets")).body[1]).toEqual(DEFAULT_PRESETS[1] as TradingPreset);
    const bad = [
      ["/api/presets/4", { name: "x", buy: side, sell: side }],
      ["/api/presets/1", { name: "x", buy: { ...side, landing: "turbo" }, sell: side }],
      ["/api/presets/1", { name: "x", buy: { ...side, slippageBps: 0 }, sell: side }],
      ["/api/presets/1", { name: "x", buy: { ...side, tipSol: 5 }, sell: side }],
      ["/api/presets/1", { name: "x", buy: side, sell: side, extra: 1 }],
      ["/api/presets/1", { name: "", buy: side, sell: side }],
    ] as const;
    for (const [path, body] of bad) expect((await alice.req("PUT", path, body)).status).toBe(400);
  });

  test("settings: defaults, partial PATCH merges, nested notifications, validation", async () => {
    expect((await bob.json<UserSettings>("GET", "/api/settings")).body).toEqual(DEFAULT_USER_SETTINGS);
    const r = await bob.json<UserSettings>("PATCH", "/api/settings", {
      theme: "light",
      quickBuySol: [0.1, 0.5],
      notifications: { walletChannels: ["telegram", "discord", "telegram"] },
      display: { miniCharts: true, pnlRows: false, density: "compact" },
      hotkeys: { buy1: "Q" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      theme: "light",
      quickBuySol: [0.1, 0.5],
      tradeMode: "instant",
      notifications: {
        walletChannels: ["telegram", "discord"],
        orderChannels: DEFAULT_USER_SETTINGS.notifications.orderChannels,
        digestSeconds: 60,
      },
      display: { miniCharts: true, pnlRows: false, density: "compact" },
    });
    expect((await bob.json<UserSettings>("GET", "/api/settings")).body.theme).toBe("light");
    expect((await alice.json<UserSettings>("GET", "/api/settings")).body.theme).toBe("dark");
    const bad = [
      { theme: "neon" },
      { autoLockMinutes: 0 },
      { maxTradeSol: 50, maxDailySol: 10 },
      { quickSellPct: [150] },
      { notifications: { walletChannels: ["sms"] } },
      { notifications: { digestSeconds: 1 } },
      { hotkeys: { "bad key": "Q" } },
      { display: { nested: { a: 1 } } },
      { unknownSetting: true },
      { activePreset: 7 },
    ];
    for (const body of bad) expect((await bob.req("PATCH", "/api/settings", body)).status).toBe(400);
  });
});

describe("watchlist and blacklists", () => {
  test("watchlist PUT is idempotent, DELETE 404s when absent", async () => {
    const m = addr("watch-1");
    expect((await alice.json<WatchlistEntry>("PUT", `/api/watchlist/${m}`)).body.mint).toBe(m);
    expect((await alice.req("PUT", `/api/watchlist/${m}`)).status).toBe(200);
    expect((await alice.req("PUT", "/api/watchlist/nope")).status).toBe(400);
    expect((await alice.json<WatchlistEntry[]>("GET", "/api/watchlist")).body.map((w) => w.mint)).toEqual([m]);
    expect((await bob.json<WatchlistEntry[]>("GET", "/api/watchlist")).body).toEqual([]);
    expect((await bob.req("DELETE", `/api/watchlist/${m}`)).status).toBe(404);
    expect((await alice.req("DELETE", `/api/watchlist/${m}`)).status).toBe(200);
  });

  test("blacklists: tokens, devs, funders by address; X handles normalized", async () => {
    await alice.req("PUT", `/api/blacklists/token/${addr("bad-token")}`, { note: "honeypot" });
    await alice.req("PUT", `/api/blacklists/dev/${addr("bad-dev")}`);
    await alice.req("PUT", `/api/blacklists/funder/${addr("bad-funder")}`);
    expect((await alice.json<{ value: string }>("PUT", "/api/blacklists/x/@ScamCaller_1")).body.value).toBe("scamcaller_1");
    expect((await alice.req("PUT", "/api/blacklists/x/not a handle!")).status).toBe(400);
    expect((await alice.req("PUT", "/api/blacklists/dev/notanaddress")).status).toBe(400);
    expect((await alice.req("PUT", `/api/blacklists/caller/${addr("x")}`)).status).toBe(400);
    const bl = (await alice.json<BlacklistsResponse>("GET", "/api/blacklists")).body;
    expect(bl.token).toMatchObject([{ value: addr("bad-token"), note: "honeypot" }]);
    expect(bl.dev.length + bl.funder.length + bl.x.length).toBe(3);
    expect((await alice.req("DELETE", "/api/blacklists/x/ScamCaller_1")).status).toBe(200);
    expect((await alice.json<BlacklistsResponse>("GET", "/api/blacklists")).body.x).toEqual([]);
    expect((await bob.json<BlacklistsResponse>("GET", "/api/blacklists")).body).toEqual({ token: [], dev: [], funder: [], x: [] });
  });
});

describe("wallet tracker", () => {
  test("add, edit, alert flags, delete; other users cannot touch it", async () => {
    const w = addr("kol-1");
    const r = await alice.json<TrackedWallet>("POST", "/api/tracked-wallets", {
      address: w,
      label: "Kol One",
      emoji: "🐳",
      alerts: { buy: true, minSol: 2 },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      address: w,
      label: "Kol One",
      emoji: "🐳",
      alerts: { buy: true, sell: false, create: false, minSol: 2 },
    });
    const p = await alice.json<TrackedWallet>("PATCH", `/api/tracked-wallets/${w}`, {
      alerts: { sell: true },
      tags: ["kol", "kol", "smart"],
    });
    expect(p.body).toMatchObject({ label: "Kol One", tags: ["kol", "smart"], alerts: { buy: true, sell: true, minSol: 2 } });
    expect((await alice.req("PATCH", `/api/tracked-wallets/${w}`, { emoji: "two words" })).status).toBe(400);
    expect((await bob.req("PATCH", `/api/tracked-wallets/${w}`, { label: "stolen" })).status).toBe(404);
    expect((await bob.req("DELETE", `/api/tracked-wallets/${w}`)).status).toBe(404);
    expect((await alice.req("DELETE", `/api/tracked-wallets/${w}`)).status).toBe(200);
    expect((await alice.json<TrackedWallet[]>("GET", "/api/tracked-wallets")).body).toEqual([]);
  });

  test("import GMGN / BullX / Axiom / text, then export round-trips into another account", async () => {
    const [a, b, c, d] = [addr("imp-a"), addr("imp-b"), addr("imp-c"), addr("imp-d")];
    const gmgn = JSON.stringify([
      { address: a, name: "Alpha", emoji: "😁" },
      { address: b, name: "Beta", emoji: "🔥" },
      { address: a, name: "dup", emoji: "" },
      { address: "garbage", name: "bad" },
    ]);
    const r1 = await alice.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: gmgn });
    expect(r1.body).toMatchObject({ detected: "gmgn", added: 2, updated: 0, skipped: 2, removed: 0 });
    expect(r1.body.errors).toEqual([{ entry: 4, error: "missing or invalid address" }]);

    const bullx = [{ name: "Beta renamed", address: b, emoji: "🍕", tags: ["kol", "fast"] }];
    const r2 = await alice.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: bullx });
    expect(r2.body).toMatchObject({ detected: "bullx", added: 0, updated: 1 });

    const axiom = JSON.stringify([{ trackedWalletAddress: c, name: "Gamma", emoji: "🧠", alertsOn: true }]);
    const r3 = await alice.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: axiom });
    expect(r3.body).toMatchObject({ detected: "axiom", added: 1 });

    const text = `# my list\n${d} 🚀 Delta Force\n\nnot an address line\n${a}, Alpha again`;
    const r4 = await alice.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: text });
    expect(r4.body).toMatchObject({ detected: "text", added: 1, updated: 1, skipped: 1 });

    const list = (await alice.json<TrackedWallet[]>("GET", "/api/tracked-wallets")).body;
    const by = Object.fromEntries(list.map((w) => [w.address, w]));
    expect(by[a]).toMatchObject({ label: "Alpha again", emoji: "" });
    expect(by[b]).toMatchObject({ label: "Beta renamed", emoji: "🍕", tags: ["kol", "fast"] });
    expect(by[c]).toMatchObject({ label: "Gamma", alerts: { buy: true, sell: true } });
    expect(by[d]).toMatchObject({ label: "Delta Force", emoji: "🚀" });

    for (const format of ["gmgn", "bullx", "axiom"] as const) {
      const ex = await alice.req("GET", `/api/tracked-wallets/export?format=${format}`);
      expect(ex.headers.get("content-disposition")).toContain(`tracked-wallets-${format}.json`);
      const exported = await ex.text();
      const fresh = new Browser(env);
      await fresh.signIn();
      const imp = await fresh.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: exported });
      expect(imp.body).toMatchObject({ detected: format, added: 4, skipped: 0 });
      const copy = (await fresh.json<TrackedWallet[]>("GET", "/api/tracked-wallets")).body;
      expect(copy.map((w) => [w.address, w.label, w.emoji]).sort()).toEqual(list.map((w) => [w.address, w.label, w.emoji]).sort());
    }
    expect((await alice.req("GET", "/api/tracked-wallets/export?format=csv")).status).toBe(400);

    const rep = await alice.json<TrackedWalletImportResult>("POST", "/api/tracked-wallets/import", { data: [a], mode: "replace" });
    expect(rep.body).toMatchObject({ detected: "addresses", removed: 3, updated: 1 });
    expect((await alice.json<TrackedWallet[]>("GET", "/api/tracked-wallets")).body.map((w) => w.address)).toEqual([a]);
  });

  test("imports beyond 10,000 wallets, empty or unusable imports are refused", async () => {
    const many = Array.from({ length: 10_001 }, (_, i) => addr(`many-${i}`));
    const r = await bob.json<{ code: string }>("POST", "/api/tracked-wallets/import", { data: many });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("limit_exceeded");
    expect((await bob.req("POST", "/api/tracked-wallets/import", { data: "" })).status).toBe(400);
    expect((await bob.req("POST", "/api/tracked-wallets/import", { data: "[not json" })).status).toBe(400);
    expect((await bob.req("POST", "/api/tracked-wallets/import", { data: "hello\nworld" })).status).toBe(400);
    expect((await bob.req("POST", "/api/tracked-wallets/import", { data: 42 })).status).toBe(400);
    expect((await bob.json<TrackedWallet[]>("GET", "/api/tracked-wallets")).body).toEqual([]);
  });
});

describe("wallet list formats (unit)", () => {
  test("detection, cleaning and export shapes", () => {
    const a = addr("fmt-a");
    const p = parseWalletList(`{"wallets":[{"address":"${a}","name":"x\\u202eevil\\u0007","emoji":"🐸"}]}`, 10);
    expect(p.detected).toBe("gmgn");
    expect(p.wallets[0]).toMatchObject({ address: a, label: "x evil", emoji: "🐸" });
    expect(() => parseWalletList([a, addr("fmt-b")], 1)).toThrow(WalletListError);
    const tw: TrackedWallet = {
      address: a,
      label: "L",
      emoji: "🐸",
      tags: ["t"],
      alerts: { buy: false, sell: false, create: true, minSol: 0 },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(exportWalletList([tw], "gmgn")).toEqual([{ address: a, name: "L", emoji: "🐸" }]);
    expect(exportWalletList([tw], "bullx")).toEqual([{ name: "L", address: a, emoji: "🐸", tags: ["t"] }]);
    expect(exportWalletList([tw], "axiom")).toEqual([{ trackedWalletAddress: a, name: "L", emoji: "🐸", alertsOn: true }]);
  });
});
