/**
 * Jupiter-only coins priced from a keyless /build quote (market/jupiterPrice.ts), against a recorded response
 * (0.01 SOL -> JUP). No live calls: every request goes to a mocked fetch.
 */
import { describe, expect, test } from "bun:test";
import { JUPITER_BUILD_PATH, JUPITER_SWAP_API_BASE, WSOL_MINT } from "@zerofee/core";
import {
  JupiterPricer,
  jupiterQuoter,
  jupiterRouteProbe,
  PROBE_TAKER,
  priceSolFromQuote,
  QUOTE_IN_LAMPORTS,
  QUOTE_REFRESH_MS,
} from "../src/market/jupiterPrice";
import { MarketState } from "../src/market/state";
import fx from "./fixtures/jupiter-build-jup.json";
import { FakeResolver } from "./helpers";

const JUP = fx.request.outputMint;
const OUT = BigInt(fx.response.outAmount);

/** A fetch that answers the recorded quote for JUP and the recorded 400 for anything else. */
function recordedJupiter() {
  const urls: URL[] = [];
  const at: number[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url);
    at.push(Date.now());
    if (url.searchParams.get("outputMint") === JUP) return Response.json(fx.response);
    return Response.json(fx.noRoute.body, { status: fx.noRoute.status });
  }) as typeof fetch;
  return { fn, urls, at };
}

describe("keyless Jupiter quoter", () => {
  test("asks /build for a 0.01 SOL buy by the system program and reads outAmount", async () => {
    const j = recordedJupiter();
    const q = jupiterQuoter(j.fn, { spacingMs: 0 });
    expect(await q(JUP)).toBe(OUT);
    const u = j.urls[0] as URL;
    expect(`${u.origin}${u.pathname}`).toBe(`${JUPITER_SWAP_API_BASE}${JUPITER_BUILD_PATH}`);
    expect(Object.fromEntries(u.searchParams)).toEqual({ ...fx.request, inputMint: WSOL_MINT, taker: PROBE_TAKER });
    expect(u.searchParams.get("amount")).toBe(QUOTE_IN_LAMPORTS.toString());
  });

  test("no route (HTTP 400), a malformed body or a network error answer null", async () => {
    const j = recordedJupiter();
    const q = jupiterQuoter(j.fn, { spacingMs: 0 });
    expect(await q("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBeNull();
    const bad = jupiterQuoter((async () => Response.json({ outAmount: 12 })) as unknown as typeof fetch, { spacingMs: 0 });
    expect(await bad(JUP)).toBeNull();
    const down = jupiterQuoter(
      (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      { spacingMs: 0 },
    );
    expect(await down(JUP)).toBeNull();
  });

  test("calls are serialized and spaced (keyless access allows 0.5 RPS)", async () => {
    const j = recordedJupiter();
    const q = jupiterQuoter(j.fn, { spacingMs: 60 });
    await Promise.all([q(JUP), q(JUP), q(JUP)]);
    expect(j.at).toHaveLength(3);
    for (let i = 1; i < j.at.length; i++) expect((j.at[i] as number) - (j.at[i - 1] as number)).toBeGreaterThanOrEqual(55);
  });

  test("the route probe reuses its answer (routable or not) for a while", async () => {
    const j = recordedJupiter();
    const probe = jupiterRouteProbe(jupiterQuoter(j.fn, { spacingMs: 0 }));
    expect(await probe(JUP)).toBe(OUT);
    expect(await probe(JUP)).toBe(OUT);
    expect(await probe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBeNull();
    expect(await probe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin")).toBeNull();
    expect(j.urls).toHaveLength(2);
  });

  test("price per whole token from the recorded quote", () => {
    const p = priceSolFromQuote(QUOTE_IN_LAMPORTS, OUT, fx.outputDecimals);
    expect(p).toBeCloseTo(0.01 / (Number(OUT) / 1e6), 12);
    expect(priceSolFromQuote(QUOTE_IN_LAMPORTS, 0n, 6)).toBeNull();
    expect(priceSolFromQuote(0n, OUT, 6)).toBeNull();
  });
});

function marketWith(...mints: string[]) {
  const market = new MarketState(
    { sniperSlots: 3, bundleMinBuyers: 4, proTraderWallets: [] },
    { resolver: new FakeResolver(), solUsd: () => 150 },
  );
  for (const m of mints) {
    market.ensureOtherToken(m);
    const rec = market.tokens.get(m);
    if (!rec) throw new Error("no record");
    rec.decimals = 6;
    rec.supply = 6_999_216_000_000_000n; // ~7B JUP
  }
  return market;
}

describe("Jupiter-only coin prices", () => {
  test("a quote prices the coin: price, market cap from supply, USD, and the summary says it is quote-derived", () => {
    const market = marketWith(JUP);
    market.setJupiterQuote(JUP, QUOTE_IN_LAMPORTS, OUT, 1_000);
    const s = market.summary(JUP);
    const price = 0.01 / (Number(OUT) / 1e6);
    expect(s?.priceSol).toBeCloseTo(price, 12);
    expect(s?.mcSol).toBeCloseTo(price * 6_999_216_000, 3);
    expect(s?.mcUsd).toBeCloseTo(price * 6_999_216_000 * 150, 0);
    expect(s?.athMcSol).toBeCloseTo(price * 6_999_216_000, 3);
    expect(s).toMatchObject({ priceSource: "jupiter_quote", priceAt: 1_000, liquidity: null });
  });

  test("a coin priced from reserves ignores Jupiter quotes", () => {
    const market = marketWith();
    market.ensureLaunchLabToken("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk", "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo", WSOL_MINT);
    market.setJupiterQuote("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk", QUOTE_IN_LAMPORTS, OUT, 1_000);
    expect(market.tokens.get("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk")?.quotePrice).toBeNull();
    expect(market.summary("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk")?.priceSource).toBeUndefined();
  });

  test("the pricer re-quotes only viewed Jupiter-only coins, one per tick, each about every 30 s", async () => {
    const OTHER = "So11111111111111111111111111111111111111112";
    const market = marketWith(JUP, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    let now = 100_000;
    const asked: string[] = [];
    let watched = [JUP, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", OTHER];
    const pricer = new JupiterPricer({
      quote: async (m) => {
        asked.push(m);
        return m === JUP ? OUT : null;
      },
      market,
      watched: () => watched,
      now: () => now,
    });
    // seeded by the resolve's probe just now: nothing due for JUP, the other coin (never quoted) goes first
    market.setJupiterQuote(JUP, QUOTE_IN_LAMPORTS, OUT, now);
    expect(await pricer.tick()).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    expect(await pricer.tick()).toBeNull(); // its failed quote waits a full period too; wSOL is no "other" coin
    now += QUOTE_REFRESH_MS - 1;
    expect(await pricer.tick()).toBeNull();
    now += 1;
    expect(await pricer.tick()).toBe(JUP); // both due: the oldest first, one per tick
    expect(market.tokens.get(JUP)?.quotePrice?.at).toBe(now);
    expect(await pricer.tick()).toBe("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
    // nobody views them any more: no calls
    watched = [];
    now += 10 * QUOTE_REFRESH_MS;
    expect(await pricer.tick()).toBeNull();
    expect(asked).toEqual(["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", JUP, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
    expect(pricer.stats).toEqual({ quotes: 1, failures: 2 });
  });

  test("prime quotes an unpriced coin at once, at most once per period", async () => {
    const market = marketWith(JUP);
    let now = 50_000;
    let calls = 0;
    const pricer = new JupiterPricer({
      quote: async () => (++calls === 1 ? null : OUT),
      market,
      watched: () => [],
      now: () => now,
    });
    await pricer.prime(JUP); // Jupiter failed: still unpriced
    await pricer.prime(JUP); // asked again right away: no second call
    expect(calls).toBe(1);
    now += QUOTE_REFRESH_MS;
    await pricer.prime(JUP);
    expect(market.tokens.get(JUP)?.quotePrice?.at).toBe(now);
    await pricer.prime(JUP); // priced: nothing to do
    expect(calls).toBe(2);
  });
});
