/**
 * The firehose matcher's index: deduplicated, reference-counted watchers per address, per-user and
 * global caps, emoji-free tags, and a benchmark of the full match path (index lookup, row building,
 * alert hook) at 100,000 tracked addresses.
 */
import { describe, expect, test } from "bun:test";
import { setLogLevel } from "../src/log";
import { plainTag, WalletIndex } from "../src/trackers/walletIndex";

setLogLevel("error");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seed = 42;
function rnd(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
}
/** A random 44-character base58 string (address-shaped; the index never decodes it). */
function randomAddress(): string {
  let s = "";
  for (let i = 0; i < 44; i++) s += B58[rnd() % 58];
  return s;
}

const tw = (address: string, label = "", emoji = "") => ({ address, label, emoji, tags: [] as string[] });

describe("WalletIndex", () => {
  test("one entry per address however many users watch it; it leaves with its last watcher", () => {
    const idx = new WalletIndex({ maxEntries: 100, maxTrackedPerUser: 10 });
    const a = randomAddress();
    const b = randomAddress();
    idx.setTracked("u1", [tw(a, "🐳 Whale", "🐳"), tw(b)]);
    idx.setTracked("u2", [tw(a, "big guy")]);
    expect(
      idx
        .get(a)
        ?.map((w) => w.userId)
        .sort(),
    ).toEqual(["u1", "u2"]);
    expect(idx.stats).toEqual({ addresses: 2, entries: 3, users: 2, refused: 0 });
    expect(idx.watcher("u1", a)?.tracked).toEqual({ label: "🐳 Whale", emoji: "🐳", tag: "Whale", tags: [] });
    expect(idx.tracks("u2", b)).toBe(false);

    // Relabel + drop b for u1 (a replace), then u2 leaves entirely.
    expect(idx.setTracked("u1", [tw(a, "Whale 2")])).toEqual({ added: 0, removed: 1, updated: 1, refused: 0 });
    expect(idx.has(b)).toBe(false);
    expect(idx.watcher("u1", a)?.tracked?.label).toBe("Whale 2");
    idx.removeUser("u2");
    expect(idx.get(a)?.map((w) => w.userId)).toEqual(["u1"]);
    idx.setTracked("u1", []);
    expect(idx.has(a)).toBe(false);
    expect(idx.stats).toEqual({ addresses: 0, entries: 0, users: 0, refused: 0 });
  });

  test("copy leaders share the watcher entry with tracking, and are counted separately", () => {
    const idx = new WalletIndex({ maxEntries: 100, maxTrackedPerUser: 10 });
    const lead = randomAddress();
    idx.setTracked("u1", [tw(lead, "KOL")]);
    idx.setLeaders("u1", [lead]);
    expect(idx.get(lead)).toHaveLength(1);
    expect(idx.get(lead)?.[0]).toMatchObject({ leader: true, tracked: { label: "KOL" } });
    idx.setTracked("u1", []); // still copied
    expect(idx.get(lead)?.[0]).toMatchObject({ leader: true, tracked: null });
    expect(idx.trackedOf("u1")).toBe(0);
    idx.setLeaders("u1", []);
    expect(idx.has(lead)).toBe(false);
  });

  test("per-user and global caps bound memory", () => {
    const idx = new WalletIndex({ maxEntries: 15, maxTrackedPerUser: 10 });
    const many = Array.from({ length: 12 }, () => tw(randomAddress()));
    expect(idx.setTracked("u1", many).added).toBe(10); // first 10 kept
    expect(idx.trackedOf("u1")).toBe(10);
    expect(idx.has(many[10]?.address as string)).toBe(false);
    const r = idx.setTracked(
      "u2",
      Array.from({ length: 8 }, () => tw(randomAddress())),
    );
    expect(r).toMatchObject({ added: 5, refused: 3 });
    expect(idx.stats.entries).toBe(15);
    expect(idx.stats.refused).toBe(3);
    idx.setLeaders("u3", [randomAddress()]); // full: refused too
    expect(idx.stats.refused).toBe(4);
  });

  test("plainTag strips emoji, flags, skin tones and joiners; falls back to a short address", () => {
    const a = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    expect(plainTag("🐳 Whale", a)).toBe("Whale");
    expect(plainTag("Ansem 👨🏽‍💻", a)).toBe("Ansem");
    expect(plainTag("🇺🇸🔥", a)).toBe("7xKX…gAsU");
    expect(plainTag("1️⃣ first", a)).toBe("1 first");
    expect(plainTag("  smart   money ", a)).toBe("smart money");
    expect(plainTag("", a)).toBe("7xKX…gAsU");
  });
});

describe("benchmark: 100,000 tracked addresses", () => {
  test("the full match path runs well over 2,000 trades/s; the index stays under 1 KB per address", () => {
    // A clean process (scripts/tracker-bench.ts) so heap numbers are not polluted by other suites.
    const r = Bun.spawnSync(["bun", "scripts/tracker-bench.ts", "--json"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, USERS: "1000", PER_USER: "100", POPULAR: "500", FANS: "40", TRADES: "100000", MATCH_PCT: "2" },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout.toString().trim().split("\n").pop() as string);
    expect(out).toMatchObject({ addresses: 100_000, watchers: 120_000, trades: 100_000, matches: 2_000, hits: 2_000, alertCalls: 2_000 });
    expect(out.tradesPerSec).toBeGreaterThan(2_000);
    expect(out.bytesPerAddress).toBeGreaterThan(0);
    expect(out.bytesPerAddress).toBeLessThan(1_000);
    expect(out.rowsPublished).toBeGreaterThan(0);
    console.log(
      `tracker bench: ${out.addresses} addresses / ${out.watchers} watchers indexed in ${out.buildMs} ms, ~${out.bytesPerAddress} B/address; ` +
        `lookups ${out.lookupsPerSec}/s; full match path ${out.tradesPerSec} trades/s (${out.matches} matches, ${out.rowsPublished} rows)`,
    );
  }, 60_000);
});
