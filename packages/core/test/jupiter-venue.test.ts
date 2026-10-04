/**
 * Jupiter long-tail fallback, part 2: venue resolution (Jupiter only when no local venue matches),
 * buildTrade and ALT-aware assembly, against the captured `/build` responses (no network).
 */
import { describe, expect, test } from "bun:test";
import {
  type Address,
  address,
  type Blockhash,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  type Instruction,
} from "@solana/kit";
import {
  assembleTransaction,
  bondingCurvePda,
  buildTrade,
  DEFAULT_CU_LIMITS,
  decodeJupiterRouteArgs,
  decodeLaunchLabPool,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  firewallStaticAccounts,
  JUPITER_PROGRAM_ID,
  JUPITER_REVIEWED_DEX_LABELS,
  JUPITER_ROUTE_LAYOUTS,
  JUPITER_STATIC_POSITIONS,
  JupiterRouteError,
  type JupiterState,
  jupiterMaxAccountsSteps,
  jupiterRouteFits,
  jupiterRouteFromBuild,
  jupiterRouteProblem,
  loadTokenState,
  NoLocalVenueError,
  PACKET_DATA_SIZE,
  parseJupiterBuildResponse,
  planFees,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../src";
import {
  BONK,
  BONK_CURVE_PDA,
  DAMM_2022_COIN,
  DBC_COIN,
  JUPITER_ATTACKER,
  JUPITER_TAKER,
  type JupiterCaseLabel,
  jupiterCase,
  jupiterFetch,
  jupiterRpc,
  LEGIT_JUPITER_CASES,
  type RpcAccount,
  tokenAccountData,
} from "./jupiter-fixtures";
import { rfixture } from "./raydium-fixtures";

const BLOCKHASH = { blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM" as Blockhash, lastValidBlockHeight: 1_000n };

const parsed = (label: JupiterCaseLabel) => parseJupiterBuildResponse(jupiterCase(label).response);
const expectationOf = (label: JupiterCaseLabel) => {
  const r = jupiterCase(label).request;
  return { user: r.taker, inputMint: r.inputMint, outputMint: r.outputMint, amount: r.amount, slippageBps: r.slippageBps };
};

describe("venue resolution: Jupiter is the last fallback", () => {
  test("a Meteora DBC coin (no pump curve, PumpSwap pool or LaunchLab pair) resolves to Jupiter", async () => {
    const s = (await loadTokenState(jupiterRpc(), { mint: DBC_COIN, user: JUPITER_TAKER })) as JupiterState;
    expect(s.venue).toBe("jupiter");
    expect(s.reason).toContain("no pump bonding curve, PumpSwap pool or Raydium LaunchLab SOL pair");
    expect(s.quoteMint).toBe(WSOL_MINT);
    expect(s.quoteDecimals).toBe(9);
    expect(s.mintInfo.tokenProgram).toBe(TOKEN_PROGRAM_ID);
    expect(s.userLamports).toBe(10_000_000_000n);
    expect(s.userBaseBalance).toBe(0n);
    expect(s.userBaseAtaExists).toBe(false);
  });

  test("a venue PDA that its program does not own is ignored (BONK's curve PDA holds SOL on mainnet)", async () => {
    // The captured mainnet account: a System account with 1.12 SOL at BONK's would-be pump curve address.
    expect(BONK_CURVE_PDA).toBe(await bondingCurvePda(BONK));
    const [acc] = await fetchRawAccounts(jupiterRpc(), [BONK_CURVE_PDA]);
    expect(acc?.owner).toBe(SYSTEM_PROGRAM_ID);
    // Before the owner check this resolved as a "complete" pump curve and threw "migration pending?".
    const s = await loadTokenState(jupiterRpc(), { mint: BONK, user: JUPITER_TAKER });
    expect(s.venue).toBe("jupiter");
    const err = await loadTokenState(jupiterRpc(), { mint: BONK, user: JUPITER_TAKER, jupiterFallback: false }).catch((e) => e);
    expect(err).toBeInstanceOf(NoLocalVenueError);
  });

  test("jupiterFallback: false throws NoLocalVenueError; quoteMint picks the Jupiter quote asset", async () => {
    await expect(loadTokenState(jupiterRpc(), { mint: DBC_COIN, user: JUPITER_TAKER, jupiterFallback: false })).rejects.toThrow(
      NoLocalVenueError,
    );
    const usdc = (await loadTokenState(jupiterRpc(), { mint: DAMM_2022_COIN, user: JUPITER_TAKER, quoteMint: USDC_MINT })) as JupiterState;
    expect(usdc.venue).toBe("jupiter");
    expect(usdc.quoteMint).toBe(USDC_MINT);
    expect(usdc.quoteDecimals).toBe(6);
    expect(usdc.mintInfo.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
  });

  test("a held position: balance read from the Token-2022 ATA; lamports parked on the ATA address are not a token account", async () => {
    const ata = await findAssociatedTokenAddress(JUPITER_TAKER, DAMM_2022_COIN, TOKEN_2022_PROGRAM_ID);
    const held = (await loadTokenState(
      jupiterRpc(JUPITER_TAKER, { [ata]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(DAMM_2022_COIN, JUPITER_TAKER, 42n) } }),
      { mint: DAMM_2022_COIN, user: JUPITER_TAKER },
    )) as JupiterState;
    expect(held.userBaseBalance).toBe(42n);
    expect(held.userBaseAtaExists).toBe(true);
    const parked = (await loadTokenState(
      jupiterRpc(JUPITER_TAKER, { [ata]: { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(0), lamports: 5_000n } }),
      { mint: DAMM_2022_COIN, user: JUPITER_TAKER },
    )) as JupiterState;
    expect(parked.userBaseBalance).toBe(0n);
    expect(parked.userBaseAtaExists).toBe(false);
  });

  test("a LaunchLab coin that graduated to Raydium AMM v4 (not built locally) falls back to Jupiter", async () => {
    // The snapshot's graduated BONK.fun pool, re-labelled migrate_type 0 (AMM v4).
    const pool = rfixture("yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S");
    const data = new Uint8Array(pool.data);
    expect(data[17]).toBe(2); // status: migrated
    data[20] = 0; // migrate_type: AMM v4
    const mint = address("7dmcQ9TyPDcfTTjfCfcZhuwK79FThVuKqmzVM9uKpRhK");
    const extra: Record<string, RpcAccount> = { [pool.address]: { owner: RAYDIUM_LAUNCHLAB_PROGRAM_ID, data } };
    // LaunchLab resolution also reads the mint, the pool's GlobalConfig and PlatformConfig, and the Clock.
    const decoded = decodeLaunchLabPool(data);
    for (const a of [mint, decoded.globalConfig, decoded.platformConfig, SYSVAR_CLOCK_ID]) {
      const f = rfixture(a);
      extra[a] = { owner: f.owner, data: f.data };
    }
    const s = (await loadTokenState(jupiterRpc(JUPITER_TAKER, extra), {
      mint,
      user: JUPITER_TAKER,
      poolAddress: pool.address,
    })) as JupiterState;
    expect(s.venue).toBe("jupiter");
    expect(s.reason).toContain("graduated to Raydium AMM v4");
  });
});

describe("buildTrade on the Jupiter fallback", () => {
  const state = (mint: Address, extra = {}) => loadTokenState(jupiterRpc(JUPITER_TAKER, extra), { mint, user: JUPITER_TAKER });

  test("buy: Jupiter's quote, our CU default, the route's lookup tables, no fees itemized", async () => {
    const stub = jupiterFetch();
    const s = await state(DBC_COIN);
    const r = parsed("longtailCurveBuy");
    const t = await buildTrade(
      s,
      { side: "buy", amount: 10_000_000n, slippageBps: 1500 },
      { jupiter: { fetchFn: stub.fetch, apiKey: "k" } },
    );
    expect(t.quote).toMatchObject({
      venue: "jupiter",
      side: "buy",
      amountIn: 10_000_000n,
      expectedOut: r.outAmount,
      minOut: r.otherAmountThreshold,
    });
    expect(t.quote.feesQuote.total).toBe(0n);
    expect(t.quote.jupiter).toMatchObject({ instruction: "route_v2", labels: ["Dynamic Bonding Curve"] });
    expect(t.defaultCuLimit).toBe(DEFAULT_CU_LIMITS.jupiter);
    expect(t.hotAccount).toBe(r.routePlan[0]!.ammKey);
    expect(t.lookupTables).toEqual({});
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.headers["x-api-key"]).toBe("k");
  });

  test("sell of the whole balance closes the token account after Jupiter's cleanup; a partial sell does not", async () => {
    const r = jupiterCase("longtail2022Sell").request;
    const ata = await findAssociatedTokenAddress(JUPITER_TAKER, DAMM_2022_COIN, TOKEN_2022_PROGRAM_ID);
    const holding = (amount: bigint) => ({
      [ata]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccountData(DAMM_2022_COIN, JUPITER_TAKER, amount) },
    });
    const full = await buildTrade(
      await state(DAMM_2022_COIN, holding(r.amount)),
      { side: "sell", amount: r.amount, slippageBps: 1500 },
      { jupiter: { fetchFn: jupiterFetch().fetch } },
    );
    const last = full.instructions.at(-1)!;
    expect(last.programAddress).toBe(TOKEN_2022_PROGRAM_ID);
    expect(last.data).toEqual(new Uint8Array([9]));
    expect(last.accounts?.map((a) => a.address)).toEqual([ata, JUPITER_TAKER, JUPITER_TAKER]);
    const partial = await buildTrade(
      await state(DAMM_2022_COIN, holding(r.amount + 1n)),
      { side: "sell", amount: r.amount, slippageBps: 1500 },
      { jupiter: { fetchFn: jupiterFetch().fetch } },
    );
    expect(partial.instructions).toHaveLength(full.instructions.length - 1);
    await expect(
      buildTrade(
        await state(DAMM_2022_COIN),
        { side: "sell", amount: r.amount, slippageBps: 1500 },
        { jupiter: { fetchFn: jupiterFetch().fetch } },
      ),
    ).rejects.toThrow("exceeds balance");
  });

  test("a misbehaving API is refused before anything is signed", async () => {
    const stub = jupiterFetch((body) => {
      (body.swapInstruction as { accounts: { pubkey: string }[] }).accounts[JUPITER_ROUTE_LAYOUTS.route_v2.destination]!.pubkey =
        JUPITER_ATTACKER;
    });
    await expect(
      buildTrade(await state(DBC_COIN), { side: "buy", amount: 10_000_000n, slippageBps: 1500 }, { jupiter: { fetchFn: stub.fetch } }),
    ).rejects.toThrow(JupiterRouteError);
  });

  const maxAccountsOf = (stub: ReturnType<typeof jupiterFetch>) => stub.requests.map((x) => new URL(x.url).searchParams.get("maxAccounts"));

  test("a route too large for one packet is re-quoted with fewer accounts (Jupiter's remedy)", async () => {
    // The captured two-hop BONK sell is 1,392 bytes without its lookup tables: serve it that way unless
    // the request carries a smaller account budget.
    const stub = jupiterFetch((body, _label, query) => {
      if (!query.has("maxAccounts")) body.addressesByLookupTableAddress = null;
    });
    const r = jupiterCase("normalSell").request;
    const ata = await findAssociatedTokenAddress(JUPITER_TAKER, BONK, TOKEN_PROGRAM_ID);
    const s = await state(BONK, { [ata]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(BONK, JUPITER_TAKER, r.amount * 2n) } });
    const t = await buildTrade(s, { side: "sell", amount: r.amount, slippageBps: 1500 }, { jupiter: { fetchFn: stub.fetch } });
    expect(maxAccountsOf(stub)).toEqual([null, "48"]);
    expect(t.quote.jupiter).toMatchObject({ maxAccounts: 48, droppedAtaCreate: false });
    expect(jupiterRouteFits(JUPITER_TAKER, t.instructions, t.lookupTables!)).toBe(true);
    expect(jupiterMaxAccountsSteps()).toEqual([undefined, 48, 32, 24]);
    expect(jupiterMaxAccountsSteps(40)).toEqual([40, 32, 24]);
  });

  test("an existing token account's no-op creation is left out when that alone makes the route fit", async () => {
    // Grow the DBC buy (an extra "other" instruction with k data bytes) to the first size that no
    // longer fits with Jupiter's ATA creation.
    const route = await jupiterRouteFromBuild(parsed("longtailCurveBuy"), expectationOf("longtailCurveBuy"));
    const filler = (k: number) => ({ programAddress: SYSTEM_PROGRAM_ID, data: new Uint8Array(k) });
    let k = 0;
    while (jupiterRouteFits(JUPITER_TAKER, [...route.instructions, filler(k)], {})) k++;
    const pad = (body: Record<string, unknown>) => {
      body.otherInstructions = [{ programId: SYSTEM_PROGRAM_ID, accounts: [], data: Buffer.from(new Uint8Array(k)).toString("base64") }];
    };
    const ata = await findAssociatedTokenAddress(JUPITER_TAKER, DBC_COIN, TOKEN_PROGRAM_ID);
    const held = { [ata]: { owner: TOKEN_PROGRAM_ID, data: tokenAccountData(DBC_COIN, JUPITER_TAKER, 1n) } };
    const stub = jupiterFetch(pad);
    const t = await buildTrade(
      await state(DBC_COIN, held),
      { side: "buy", amount: 10_000_000n, slippageBps: 1500 },
      { jupiter: { fetchFn: stub.fetch } },
    );
    expect(maxAccountsOf(stub)).toEqual([null]);
    expect(t.quote.jupiter?.droppedAtaCreate).toBe(true);
    expect(t.instructions.some((ix) => ix.accounts?.[1]?.address === ata && ix.programAddress.startsWith("AToken"))).toBe(false);
    // Without the account to fall back on, every smaller budget is tried, then the trade is refused.
    const fresh = jupiterFetch(pad);
    await expect(
      buildTrade(await state(DBC_COIN), { side: "buy", amount: 10_000_000n, slippageBps: 1500 }, { jupiter: { fetchFn: fresh.fetch } }),
    ).rejects.toThrow("no usable route (too large for one transaction)");
    expect(maxAccountsOf(fresh)).toEqual([null, "48", "32", "24"]);
  });
});

describe("routes the signer can verify (hops may not act on the user's accounts unchecked)", () => {
  const state = (mint: Address) => loadTokenState(jupiterRpc(), { mint, user: JUPITER_TAKER });
  const routeOf = async (label: JupiterCaseLabel, mutate?: (body: Record<string, unknown>) => void) => {
    const body = jupiterCase(label).response;
    mutate?.(body);
    return jupiterRouteFromBuild(parseJupiterBuildResponse(body), expectationOf(label));
  };
  const swapAccounts = (body: Record<string, unknown>) => (body.swapInstruction as { accounts: { pubkey: string }[] }).accounts;
  const swapData = (body: Record<string, unknown>, patch: (d: Uint8Array) => Uint8Array) => {
    const ix = body.swapInstruction as { data: string };
    ix.data = Buffer.from(patch(new Uint8Array(Buffer.from(ix.data, "base64")))).toString("base64");
  };

  test.each(LEGIT_JUPITER_CASES)("%s: every captured route is verifiable as /build returned it", async (label) => {
    expect(jupiterRouteProblem(await routeOf(label), JUPITER_TAKER)).toBeNull();
  });

  test("route_v2 hops: output or input slot moved, authority swapped, an unreviewed venue, two hops", async () => {
    // DBC hop: [program, pool_authority, config, pool, input, output, ..., payer (10), ...] from position 10.
    const at = (slot: number) => 10 + slot;
    const cases: [string, (b: Record<string, unknown>) => void, RegExp][] = [
      ["output", (b) => (swapAccounts(b)[at(5)]!.pubkey = JUPITER_ATTACKER), /slot 5 is not the user's account/],
      ["input", (b) => (swapAccounts(b)[at(4)]!.pubkey = JUPITER_ATTACKER), /slot 4 is not the user's account/],
      ["authority", (b) => (swapAccounts(b)[at(10)]!.pubkey = JUPITER_ATTACKER), /slot 10 is not the user's account/],
      ["stray", (b) => (swapAccounts(b)[at(16)]!.pubkey = JUPITER_TAKER), /names the user's wallet or token account in slot 16/],
      [
        "venue",
        (b) => swapData(b, (d) => Uint8Array.from(d, (x, i) => (i === 34 ? 7 : x))),
        /Swap variant 7, a venue whose hop layout is not reviewed/,
      ],
      [
        "hops",
        (b) => swapData(b, (d) => Uint8Array.from([...d, 88, 0x10, 0x27, 1, 2], (x, i) => (i === 30 ? 2 : x))),
        /route_v2 with 2 hops/,
      ],
    ];
    for (const [, mutate, pattern] of cases) {
      expect(jupiterRouteProblem(await routeOf("longtailCurveBuy", mutate), JUPITER_TAKER)).toMatch(pattern);
    }
  });

  test("shared-accounts hops may not name the user's wallet or token accounts", async () => {
    const route = await routeOf("usdcBuy", (b) => (swapAccounts(b)[20]!.pubkey = JUPITER_TAKER));
    expect(jupiterRouteProblem(route, JUPITER_TAKER)).toMatch(
      /shared-accounts hop names the user's wallet or token account \(position 20\)/,
    );
  });

  test("buildTrade re-quotes an unverifiable route over the reviewed venues", async () => {
    // Without a venue restriction the API (or something between) returns a hop crediting the attacker.
    const stub = jupiterFetch((body, _label, query) => {
      if (!query.has("dexes")) swapAccounts(body)[15]!.pubkey = JUPITER_ATTACKER;
    });
    const t = await buildTrade(
      await state(DBC_COIN),
      { side: "buy", amount: 10_000_000n, slippageBps: 1500 },
      { jupiter: { fetchFn: stub.fetch, excludeDexes: ["X"] } },
    );
    const queries = stub.requests.map((x) => new URL(x.url).searchParams);
    expect(queries.map((q) => [q.get("dexes"), q.get("excludeDexes")])).toEqual([
      [null, "X"],
      [JUPITER_REVIEWED_DEX_LABELS.join(","), null],
    ]);
    expect(JUPITER_REVIEWED_DEX_LABELS).toEqual(["Whirlpool", "Meteora DAMM v2", "Dynamic Bonding Curve"]);
    expect(jupiterRouteProblem({ instructions: t.instructions, instruction: t.quote.jupiter!.instruction }, JUPITER_TAKER)).toBeNull();
  });

  test("buildTrade refuses with the reason when no route over the reviewed venues exists", async () => {
    const open = jupiterFetch((body) => {
      swapAccounts(body)[15]!.pubkey = JUPITER_ATTACKER;
    });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).searchParams.has("dexes")
        ? new Response(JSON.stringify({ error: "No routes found" }), { status: 400 })
        : open.fetch(input, init)) as typeof fetch;
    await expect(
      buildTrade(await state(DBC_COIN), { side: "buy", amount: 10_000_000n, slippageBps: 1500 }, { jupiter: { fetchFn } }),
    ).rejects.toThrow(
      /no route the signer can verify \(MeteoraDynamicBondingCurveSwapWithRemainingAccounts hop slot 5 is not the user's account; none over Whirlpool, Meteora DAMM v2, Dynamic Bonding Curve\)/,
    );
  });
});

describe("assembly with lookup tables keeps the firewall's static keys static", () => {
  const plan = planFees({
    mode: "standard",
    preset: "fast",
    cuLimit: DEFAULT_CU_LIMITS.jupiter,
    prioritySamples: [],
    caps: { maxPriorityFeeLamports: 5_000_000n, maxTipLamports: 10_000_000n },
    minCuPriceMicroLamports: 100_000n,
  });

  test.each(LEGIT_JUPITER_CASES)("%s: fits one packet; user side and every System/Token/ATA account static", async (label) => {
    const route = await jupiterRouteFromBuild(parsed(label), expectationOf(label));
    const tx = assembleTransaction({
      feePayer: JUPITER_TAKER,
      instructions: route.instructions,
      blockhash: BLOCKHASH,
      fees: plan,
      lookupTables: route.lookupTables,
    });
    const bytes = getTransactionEncoder().encode(tx);
    expect(bytes.length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const staticKeys = new Set<string>(msg.staticAccounts);
    const keep = firewallStaticAccounts(JUPITER_TAKER, route.instructions);
    const swap = route.instructions.find((ix) => ix.programAddress === JUPITER_PROGRAM_ID)!;
    const kind = decodeJupiterRouteArgs(new Uint8Array(swap.data!))!.instruction;
    for (const i of JUPITER_STATIC_POSITIONS[kind]) {
      expect(keep.has(swap.accounts![i]!.address)).toBe(true);
      expect(staticKeys.has(swap.accounts![i]!.address)).toBe(true);
    }
    for (const ix of route.instructions as Instruction[]) {
      if ([SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].includes(ix.programAddress)) {
        for (const a of ix.accounts ?? []) expect(staticKeys.has(a.address)).toBe(true);
      }
    }
    const lookups = "addressTableLookups" in msg ? (msg.addressTableLookups ?? []) : [];
    if (Object.keys(route.lookupTables).length) expect(lookups.length).toBeGreaterThan(0);
    else expect(lookups).toHaveLength(0);
  });

  test("without the tables a multi-hop route does not fit (1,392 of 1,232 bytes for the captured BONK sell)", async () => {
    const route = await jupiterRouteFromBuild(parsed("normalSell"), expectationOf("normalSell"));
    expect(() =>
      assembleTransaction({ feePayer: JUPITER_TAKER, instructions: route.instructions, blockhash: BLOCKHASH, fees: plan }),
    ).toThrow("too large");
  });
});
