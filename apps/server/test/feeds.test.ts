/** Metadata fetcher, SOL/USD feed, PumpPortal cross-check, tx handler and config. Offline. */
import { describe, expect, test } from "bun:test";
import { loadConfig, redactUrl } from "../src/config";
import type { ParsedMetadata } from "../src/feeds/metadata";
import { extractCid, isSafeUrl, isSafeUrlSyntax, MetadataFetcher, parseMetadataJson, rewriteIpfsUrl } from "../src/feeds/metadata";
import { SolUsdFeed } from "../src/feeds/solUsd";
import { firstSignature, lanesForPreset, TxHandler } from "../src/gateway/tx";
import { PumpPortalSource, Reconciler } from "../src/ingest/pumpPortal";
import { mockFetch, waitFor } from "./helpers";

const CID = "Qme95r8YzjeMNFeE8UTE6LRr3ZQRSHrktTYi97hPbNPjNF";
const GW = ["https://ipfs.io", "https://dweb.link"];

describe("metadata", () => {
  test("CIDs from every common URI form; Cloudflare gateways rewritten to public ones", () => {
    expect(extractCid(`https://ipfs.io/ipfs/${CID}`)).toEqual({ cid: CID, path: "" });
    expect(extractCid(`ipfs://${CID}/meta.json`)).toEqual({ cid: CID, path: "/meta.json" });
    expect(extractCid(`https://cf-ipfs.com/ipfs/${CID}`)).toEqual({ cid: CID, path: "" });
    expect(extractCid("https://bafkreifmkbmzfr7ugex7k3f3wrtoz6fvpr5ehlwpdbwak4azqweajtqic4.ipfs.w3s.link/")?.cid).toBe(
      "bafkreifmkbmzfr7ugex7k3f3wrtoz6fvpr5ehlwpdbwak4azqweajtqic4",
    );
    expect(extractCid("https://example.com/token.json")).toBeNull();
    expect(rewriteIpfsUrl(`https://cloudflare-ipfs.com/ipfs/${CID}`, GW)).toBe(`https://ipfs.io/ipfs/${CID}`);
  });

  test("pump-style JSON: image, description, socials (handles normalized, junk dropped)", () => {
    const p = parseMetadataJson(
      {
        name: "SPECTRE",
        symbol: "SPEC",
        image: `ipfs://${CID}`,
        description: "d",
        twitter: "@spectre_sol",
        telegram: "https://t.me/spec",
        website: "javascript:alert(1)",
      },
      GW,
    );
    expect(p).toEqual({
      name: "SPECTRE",
      symbol: "SPEC",
      description: "d",
      image: `https://ipfs.io/ipfs/${CID}`,
      socials: { x: "https://x.com/spectre_sol", telegram: "https://t.me/spec", website: null },
    });
    expect(parseMetadataJson({ extensions: { website: "https://spec.xyz" } }, GW).socials.website).toBe("https://spec.xyz");
  });

  test("SSRF guard: private, local and credentialed URLs are refused", async () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://localhost/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://[::1]/x",
      "file:///etc/passwd",
      "https://u:p@example.com/x",
      "http://metadata.internal/x",
    ]) {
      expect(isSafeUrlSyntax(u)).toBe(false);
    }
    expect(isSafeUrlSyntax("https://example.com/x.json")).toBe(true);
    expect(await isSafeUrl("https://evil.example/x", async () => ["10.1.2.3"])).toBe(false);
    expect(await isSafeUrl("https://ok.example/x", async () => ["93.184.216.34"])).toBe(true);
  });

  test("fetcher races gateways, caches by CID, never blocks callers", async () => {
    const m = mockFetch((url) =>
      url.startsWith("https://ipfs.io") ? [504, {}] : [200, { name: "S", image: `https://dweb.link/ipfs/${CID}`, twitter: "x_handle" }],
    );
    const results: [string, ParsedMetadata | null][] = [];
    const f = new MetadataFetcher({ gateways: GW, timeoutMs: 1_000, fetchFn: m.fn, onResult: (mint, meta) => results.push([mint, meta]) });
    f.request("MINT1", `https://ipfs.io/ipfs/${CID}`);
    await waitFor(() => results.length === 1);
    expect(results[0]?.[1]?.socials.x).toBe("https://x.com/x_handle");
    expect(m.calls.map((c) => new URL(c.url).host).sort()).toEqual(["dweb.link", "ipfs.io"]);
    f.request("MINT2", `ipfs://${CID}`); // same CID: cache hit, no fetch
    expect(results).toHaveLength(2);
    expect(m.calls).toHaveLength(2);
    expect(f.stats.cacheHits).toBe(1);
  });

  test("non-IPFS URIs resolving to private addresses are not fetched", async () => {
    const m = mockFetch(() => [200, {}]);
    const results: (ParsedMetadata | null)[] = [];
    const f = new MetadataFetcher({
      gateways: GW,
      timeoutMs: 1_000,
      fetchFn: m.fn,
      resolve: async () => ["127.0.0.1"],
      onResult: (_m, meta) => results.push(meta),
    });
    f.request("M", "https://rebind.example/meta.json");
    await waitFor(() => results.length === 1);
    expect(results).toEqual([null]);
    expect(m.calls).toHaveLength(0);
    expect(f.stats.unsafe).toBe(1);
  });
});

describe("SOL/USD", () => {
  test("parses aggTrade (raw and combined stream) and tracks freshness", () => {
    const f = new SolUsdFeed({ urls: [], staleMs: 30_000 });
    f.handle(JSON.stringify({ e: "aggTrade", s: "SOLUSDT", p: "119.88", T: 1 }), 1_000);
    expect(f.snapshot(2_000)).toEqual({ price: 119.88, updatedAt: 1_000, stale: false, source: "binance" });
    f.handle(JSON.stringify({ stream: "solusdt@aggTrade", data: { p: "120.5" } }), 5_000);
    expect(f.current()).toBe(120.5);
    expect(f.snapshot(40_000)?.stale).toBe(true);
    f.handle("garbage", 50_000);
    f.handle(JSON.stringify({ p: "-1" }), 50_000);
    expect(f.current()).toBe(120.5);
  });
});

describe("PumpPortal cross-check", () => {
  test("parses create / migration messages and reconciles against the primary feed", () => {
    const pp = new PumpPortalSource({ url: "wss://pumpportal.fun/api/data", apiKey: null });
    expect(pp.handle(JSON.stringify({ message: "Successfully subscribed" }))).toBeNull();
    expect(pp.handle(JSON.stringify({ signature: "s1", mint: "M1", txType: "create", name: "x" }), 10)).toMatchObject({
      kind: "create",
      mint: "M1",
    });
    expect(pp.handle(JSON.stringify({ signature: "s2", mint: "M2", txType: "migrate", pool: "pump-amm" }), 20)).toMatchObject({
      kind: "migrate",
      mint: "M2",
      pool: "pump-amm",
    });
    expect(pp.stats.byPool).toEqual({ "create:?": 1, "migrate:pump-amm": 1 });
    const r = new Reconciler(1_000, 2_000);
    const missed: string[] = [];
    r.onMismatch = (m) => missed.push(`${m.side}:${m.mint}:${m.info.signature ?? ""}`);
    r.seenPrimary("create", "A", 100);
    r.seenCross("create", "A", 400); // primary was 300 ms ahead
    r.seenPrimary("create", "B", 100, { signature: "sigB" });
    r.seenCross("create", "C", 100, { signature: "sigC", pool: "bonk" });
    r.sweep(1_500); // past the window: B and C wait out the grace period
    expect(r.stats).toMatchObject({ matched: 1, primaryOnly: 0, crossOnly: 0 });
    r.sweep(5_000);
    expect(r.stats).toMatchObject({ matched: 1, primaryOnly: 1, crossOnly: 1, leadMs: [300] });
    expect(missed.sort()).toEqual(["cross:C:sigC", "primary:B:sigB"]);
    expect(r.mismatches.find((m) => m.mint === "C")?.info.pool).toBe("bonk");
  });

  test("a counterpart after the window is a late match, not a miss on each side; repeats are ignored", () => {
    const r = new Reconciler(1_000, 10_000);
    r.seenPrimary("create", "A", 0);
    r.sweep(2_000); // A is past the window
    r.seenCross("create", "A", 4_000); // PumpPortal 4 s behind
    r.seenPrimary("migrate", "B", 0);
    r.seenCross("migrate", "B", 100);
    r.seenPrimary("migrate", "B", 500); // the same transaction again in another fork
    r.seenPrimary("create", "D", 0);
    r.seenPrimary("create", "D", 10); // duplicate before any match
    r.sweep(60_000);
    expect(r.stats).toMatchObject({ matched: 1, late: 1, primaryOnly: 1, crossOnly: 0, repeats: 2 });
    expect(r.pending).toBe(0);
  });
});

describe("POST /api/tx handler", () => {
  const signedTx = Buffer.from(new Uint8Array([1, ...new Array(64).fill(9), 0x80, 1, 0, 0])).toString("base64");
  const landing = { heliusRegion: "fra" as const, jitoRegion: "frankfurt" as const };

  test("first-signature parsing", () => {
    expect(firstSignature(new Uint8Array([1, ...new Array(64).fill(0)]))).toMatchObject({ signed: false });
    expect(firstSignature(new Uint8Array([0]))).toBeNull();
    expect(firstSignature(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("live mode refuses anonymous callers and unsigned transactions; presets map to lanes", async () => {
    const m = mockFetch(() => [200, { jsonrpc: "2.0", id: 1, result: "SIG" }]);
    const h = new TxHandler({
      rpc: { simulateTransaction: async () => ({ context: { slot: 1 }, value: { err: null, logs: [] } }) },
      dryRun: false,
      allowAnonymous: false,
      landing,
      fetchFn: m.fn,
    });
    const anon = { id: "a", wallet: null, anonymous: true, expiresAt: null };
    expect((await h.handle({ tx: signedTx, preset: "reduced" }, anon)).status).toBe(401);
    expect(m.calls).toHaveLength(0);
    expect(lanesForPreset("reduced", landing).map((l) => l.name)).toEqual(["helius-swqos-fra"]);
    expect(lanesForPreset("secure", landing).map((l) => l.name)).toEqual(["jito-bundleOnly-frankfurt"]);
    expect(lanesForPreset("fast", landing).map((l) => l.name)).toEqual(["helius-max-fra"]);
  });

  test("dry-run never sends, whatever the session", async () => {
    const m = mockFetch(() => [200, {}]);
    let simulated = 0;
    const h = new TxHandler({
      rpc: {
        simulateTransaction: async () => {
          simulated++;
          return { context: { slot: 3 }, value: { err: null, logs: ["ok"], unitsConsumed: 5 } };
        },
      },
      dryRun: true,
      allowAnonymous: true,
      landing,
      fetchFn: m.fn,
    });
    const r = await h.handle({ tx: signedTx, preset: "fast" }, { id: "u", wallet: "W", anonymous: false, expiresAt: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, lanes: [], simulation: { unitsConsumed: 5 } });
    expect(simulated).toBe(1);
    expect(m.calls).toHaveLength(0);
  });
});

describe("config", () => {
  test("safe defaults: localhost bind, dry run, public RPC, no secrets required", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      host: "127.0.0.1",
      dryRun: true,
      source: "rpc",
      rpcLogsPrograms: ["pump", "pumpswap"],
      allowAnonymousTx: false,
      pumpPortalEnabled: false,
    });
    expect(c.pulse).toMatchObject({ finalStretchBps: 6_000, migratedWindowMs: 24 * 3_600_000 });
    expect(c.metrics).toMatchObject({ sniperSlots: 3, bundleMinBuyers: 4 });
    expect(() => loadConfig({ INGEST_SOURCE: "yellowstone" })).toThrow("YELLOWSTONE_ENDPOINT");
    expect(() => loadConfig({ DRY_RUN: "maybe" })).toThrow();
    expect(loadConfig({ DRY_RUN: "false" }).dryRun).toBe(false);
  });

  test("redactUrl hides keys and credentials", () => {
    expect(redactUrl("https://mainnet.helius-rpc.com/?api-key=SECRET")).toBe("https://mainnet.helius-rpc.com/?api-key=***");
    expect(redactUrl("https://user:pass@host.example/x")).not.toContain("pass");
  });
});
