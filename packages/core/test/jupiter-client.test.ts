/**
 * Jupiter long-tail fallback, part 1: the `/build` client and the response -> instruction conversion,
 * against real `/build` responses captured on 2026-10-03 (test/fixtures/jupiter-build.json; no network).
 */
import { describe, expect, test } from "bun:test";
import { AccountRole, address, getBase58Encoder, getBase64Encoder, getProgramDerivedAddress } from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  decodeJupiterRouteArgs,
  decodeJupiterSwapEvents,
  fetchJupiterBuild,
  findAssociatedTokenAddress,
  JUPITER_EVENT_AUTHORITY,
  JUPITER_IX,
  JUPITER_PROGRAM_ID,
  JUPITER_ROUTE_LAYOUTS,
  JupiterApiError,
  JupiterRouteError,
  jupiterBuildUrl,
  jupiterCuLimitFromSimulation,
  jupiterRouteFromBuild,
  parseJupiterBuildResponse,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  USDC_MINT,
  WSOL_MINT,
} from "../src";
import {
  DBC_COIN,
  JUPITER_ATTACKER,
  JUPITER_TAKER,
  type JupiterCaseLabel,
  jupiterCase,
  jupiterFetch,
  LEGIT_JUPITER_CASES,
} from "./jupiter-fixtures";

const b64 = getBase64Encoder();

const parsed = (label: JupiterCaseLabel) => parseJupiterBuildResponse(jupiterCase(label).response);
const expectationOf = (label: JupiterCaseLabel) => {
  const r = jupiterCase(label).request;
  return { user: r.taker, inputMint: r.inputMint, outputMint: r.outputMint, amount: r.amount, slippageBps: r.slippageBps };
};

describe("/build request", () => {
  const base = { inputMint: WSOL_MINT, outputMint: DBC_COIN, amount: 10_000_000n, slippageBps: 1500, taker: JUPITER_TAKER };

  test("only allowlisted parameters, numeric slippage (no RTSE), never a fee, tip or foreign destination", () => {
    const url = new URL(jupiterBuildUrl({ ...base, maxAccounts: 40, excludeDexes: ["A", "B"], forJitoBundle: true, mode: "fast" }));
    expect(url.origin + url.pathname).toBe("https://api.jup.ag/swap/v2/build");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputMint: WSOL_MINT,
      outputMint: DBC_COIN,
      amount: "10000000",
      taker: JUPITER_TAKER,
      slippageBps: "1500",
      maxAccounts: "40",
      excludeDexes: "A,B",
      forJitoBundle: "true",
      mode: "fast",
    });
    for (const forbidden of ["platformFeeBps", "feeAccount", "tipAmount", "destinationTokenAccount", "nativeDestinationAccount", "payer"]) {
      expect(url.searchParams.has(forbidden)).toBe(false);
    }
    expect(jupiterBuildUrl(base, "https://example.test/swap/v2/")).toStartWith("https://example.test/swap/v2/build?");
  });

  test("rejects requests /build would misread", () => {
    expect(() => jupiterBuildUrl({ ...base, amount: 0n })).toThrow("amount");
    expect(() => jupiterBuildUrl({ ...base, slippageBps: 10_001 })).toThrow("slippageBps");
    expect(() => jupiterBuildUrl({ ...base, slippageBps: 1.5 })).toThrow("slippageBps");
    expect(() => jupiterBuildUrl({ ...base, outputMint: WSOL_MINT })).toThrow("same");
    expect(() => jupiterBuildUrl({ ...base, maxAccounts: 65 })).toThrow("maxAccounts");
    expect(() => jupiterBuildUrl({ ...base, dexes: ["A"], excludeDexes: ["B"] })).toThrow("mutually exclusive");
  });

  test("fetch: API key header only when configured; HTTP errors carry Jupiter's message", async () => {
    const stub = jupiterFetch();
    const r = await fetchJupiterBuild(base, { fetchFn: stub.fetch });
    expect(r.outAmount).toBe(parsed("longtailCurveBuy").outAmount);
    expect(stub.requests[0]!.headers["x-api-key"]).toBeUndefined();
    await fetchJupiterBuild(base, { fetchFn: stub.fetch, apiKey: "jup_test" });
    expect(stub.requests[1]!.headers["x-api-key"]).toBe("jup_test");
    const err = await fetchJupiterBuild({ ...base, amount: 1n }, { fetchFn: stub.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(JupiterApiError);
    expect((err as JupiterApiError).status).toBe(400);
    expect((err as Error).message).toContain("No routes found");
  });

  test("response parsing is strict", () => {
    const body = jupiterCase("normalBuy").response;
    expect(() => parseJupiterBuildResponse({ ...body, outAmount: "1e9" })).toThrow("outAmount");
    expect(() => parseJupiterBuildResponse({ ...body, outAmount: "18446744073709551616" })).toThrow("u64");
    expect(() => parseJupiterBuildResponse({ ...body, inputMint: "not-an-address" })).toThrow("inputMint");
    expect(() => parseJupiterBuildResponse({ ...body, swapInstruction: { programId: JUPITER_PROGRAM_ID, accounts: [], data: 7 } })).toThrow(
      "swapInstruction.data",
    );
  });

  test("rate limits: waits for Retry-After and retries (twice by default), then reports the 429", async () => {
    const answers = [429, 429, 200];
    const urls: string[] = [];
    const ok = jupiterFetch();
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      const status = answers.shift() ?? 429;
      if (status === 429) return new Response("Too many requests", { status, headers: { "retry-after": "0.01" } });
      return ok.fetch(input, init);
    }) as typeof fetch;
    const r = await fetchJupiterBuild(base, { fetchFn: flaky });
    expect(r.inputMint).toBe(WSOL_MINT);
    expect(urls).toHaveLength(3);
    expect(new Set(urls).size).toBe(1);
    const err = await fetchJupiterBuild(base, { fetchFn: flaky, rateLimitRetries: 1 }).catch((e) => e);
    expect((err as JupiterApiError).status).toBe(429);
  });
});

describe("Jupiter swap events", () => {
  test("decodes the SwapsEvent Jupiter emitted (event CPI) in a mainnet simulation of a DAMM v2 buy", () => {
    // Inner-instruction data of the JUP6 self-invoke, simulateTransaction at slot ~453,130,650 (2026-10-03):
    // 0.01 SOL -> 6Vsnb… through Meteora DAMM v2, 10,495,161,908 base units credited to the buyer's ATA.
    const data = getBase58Encoder().encode(
      "3drYVtAcBYiMtM5fDAD2VT79gAoN6vD18v9Jn7pH7sLP26vfth5Vxkahuq6cwH9UADUkYXfefL9ZgwAAKUkgJZataSLM45UawcDFRaFg91XH7afgXBuSuGoMtmZgM69iLsiwnc7pnxoNcNxtY5PCUfbs19gu6RmVQPjdfPGvMhDBRiBbjKWmr",
    );
    expect(decodeJupiterSwapEvents(new Uint8Array(data))).toEqual([
      {
        amm: address("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"),
        inputMint: WSOL_MINT,
        inputAmount: 10_000_000n,
        outputMint: address("6VsnbKz6erJRTPiiD34Msq7eWmmgZHDnh4Bxan4MpGjm"),
        outputAmount: 10_495_161_908n,
      },
    ]);
    expect(decodeJupiterSwapEvents(new Uint8Array(data).subarray(0, 40))).toBeNull();
    expect(decodeJupiterSwapEvents(new Uint8Array(16))).toBeNull();
  });
});

describe("captured /build responses", () => {
  test.each(LEGIT_JUPITER_CASES)("%s: Jupiter v6, a v2 route, no fee, the user's slippage, our compute budget only", (label) => {
    const r = parsed(label);
    const want = jupiterCase(label).request;
    expect(r.swapInstruction.programId).toBe(JUPITER_PROGRAM_ID);
    const args = decodeJupiterRouteArgs(r.swapInstruction.data)!;
    expect(["route_v2", "shared_accounts_route_v2"]).toContain(args.instruction);
    expect(args).toMatchObject({ inAmount: want.amount, quotedOutAmount: r.outAmount, slippageBps: want.slippageBps });
    expect(args.platformFeeBps).toBe(0);
    expect(args.positiveSlippageBps).toBe(0);
    expect(r.computeBudgetInstructions.every((ix) => ix.programId === COMPUTE_BUDGET_PROGRAM_ID)).toBe(true);
    expect(r.tipInstruction).toBeNull();
    const L = JUPITER_ROUTE_LAYOUTS[args.instruction];
    expect(r.swapInstruction.accounts[L.eventAuthority]!.pubkey).toBe(JUPITER_EVENT_AUTHORITY);
    expect(r.swapInstruction.accounts[L.program]!.pubkey).toBe(JUPITER_PROGRAM_ID);
  });

  test("the captures cover both v2 routes, ALT-free and ALT routes, SPL and Token-2022 coins, SOL and USDC funding", () => {
    const kinds = LEGIT_JUPITER_CASES.map((l) => decodeJupiterRouteArgs(parsed(l).swapInstruction.data)!.instruction);
    expect(new Set(kinds)).toEqual(new Set(["route_v2", "shared_accounts_route_v2"]));
    expect(Object.keys(parsed("longtailCurveBuy").addressesByLookupTableAddress)).toHaveLength(0);
    expect(Object.keys(parsed("usdcBuy").addressesByLookupTableAddress).length).toBeGreaterThan(0);
    expect(parsed("longtail2022Buy").swapInstruction.accounts[JUPITER_ROUTE_LAYOUTS.route_v2.destinationTokenProgram]!.pubkey).toBe(
      TOKEN_2022_PROGRAM_ID,
    );
    expect(parsed("usdcBuy").inputMint).toBe(USDC_MINT);
    expect(parsed("longtailCurveBuy").routePlan.map((s) => s.label)).toEqual(["Dynamic Bonding Curve"]);
  });

  test("the malicious capture really carries a 50 bps platform fee paid to the attacker's account (first hop account)", () => {
    const r = parsed("platformFeeBuy");
    const args = decodeJupiterRouteArgs(r.swapInstruction.data)!;
    expect(args.instruction).toBe("route_v2");
    expect(args.platformFeeBps).toBe(50);
    const feeAccount = r.swapInstruction.accounts[JUPITER_ROUTE_LAYOUTS.route_v2.fixedAccounts]!;
    expect(feeAccount).toEqual({ pubkey: JUPITER_ATTACKER, isSigner: false, isWritable: true });
  });

  test('shared-accounts routes use the program authority PDA ["authority", id] and its ATAs', async () => {
    for (const label of ["normalSell", "usdcBuy"] as const) {
      const r = parsed(label);
      const args = decodeJupiterRouteArgs(r.swapInstruction.data)!;
      expect(args.instruction).toBe("shared_accounts_route_v2");
      const L = JUPITER_ROUTE_LAYOUTS.shared_accounts_route_v2;
      const acc = r.swapInstruction.accounts.map((a) => a.pubkey);
      const [authority] = await getProgramDerivedAddress({
        programAddress: JUPITER_PROGRAM_ID,
        seeds: [new TextEncoder().encode("authority"), Uint8Array.of(args.id!)],
      });
      expect(acc[L.programAuthority]).toBe(authority);
      expect(acc[L.programSource]).toBe(await findAssociatedTokenAddress(authority, acc[L.sourceMint]!, acc[L.sourceTokenProgram]!));
      expect(acc[L.programDestination]).toBe(
        await findAssociatedTokenAddress(authority, acc[L.destinationMint]!, acc[L.destinationTokenProgram]!),
      );
    }
  });
});

describe("conversion to our instruction list", () => {
  test.each(LEGIT_JUPITER_CASES)("%s: setup, swap, cleanup kept in order; compute budget and tips dropped", async (label) => {
    const r = parsed(label);
    const route = await jupiterRouteFromBuild(r, expectationOf(label));
    const programs = route.instructions.map((ix) => ix.programAddress);
    expect(programs).not.toContain(COMPUTE_BUDGET_PROGRAM_ID);
    const expected = [
      ...r.setupInstructions.map((i) => i.programId),
      JUPITER_PROGRAM_ID,
      ...(r.cleanupInstruction ? [r.cleanupInstruction.programId] : []),
      ...r.otherInstructions.map((i) => i.programId),
    ];
    expect(programs).toEqual(expected);
    expect(route.minOut).toBe(r.otherAmountThreshold);
    expect(route.minOut).toBeGreaterThanOrEqual((r.outAmount * BigInt(10_000 - r.slippageBps)) / 10_000n);
    expect(route.lookupTables).toEqual(r.addressesByLookupTableAddress);
    // Only the taker signs.
    for (const ix of route.instructions) {
      for (const a of ix.accounts ?? []) {
        if (a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.READONLY_SIGNER) expect(a.address).toBe(JUPITER_TAKER);
      }
    }
  });

  const swapAccount = (body: Record<string, unknown>, i: number) =>
    (body.swapInstruction as { accounts: { pubkey: string }[] }).accounts[i] as { pubkey: string; isSigner: boolean; isWritable: boolean };
  const setSwapData = (body: Record<string, unknown>, patch: (d: Uint8Array) => void) => {
    const ix = body.swapInstruction as { data: string };
    const d = new Uint8Array(b64.encode(ix.data));
    patch(d);
    ix.data = Buffer.from(d).toString("base64");
  };
  const refuse = async (label: JupiterCaseLabel, mutate: (body: Record<string, unknown>) => void, pattern: RegExp) => {
    const body = jupiterCase(label).response;
    mutate(body);
    const err = await jupiterRouteFromBuild(parseJupiterBuildResponse(body), expectationOf(label)).catch((e) => e);
    expect(err).toBeInstanceOf(JupiterRouteError);
    expect((err as Error).message).toMatch(pattern);
  };

  test("refuses a platform fee (the real malicious capture)", async () => {
    const route = await jupiterRouteFromBuild(parsed("platformFeeBuy"), expectationOf("platformFeeBuy")).catch((e) => e);
    expect((route as Error).message).toContain("platform fee of 50 bps");
  });

  test("refuses quotes for anything other than the request", async () => {
    await refuse("normalBuy", (b) => (b.inAmount = "123"), /inAmount 123/);
    await refuse("normalBuy", (b) => (b.slippageBps = 50), /slippageBps 50/);
    await refuse("normalBuy", (b) => (b.swapMode = "ExactOut"), /swapMode/);
    await refuse("normalBuy", (b) => (b.outputMint = USDC_MINT), /quote is for/);
    await refuse("normalBuy", (b) => (b.outAmount = "1"), /quoted_out_amount/);
    await refuse("normalBuy", (b) => (b.otherAmountThreshold = "1"), /otherAmountThreshold/);
  });

  test("refuses route arguments that disagree with the quote, and fees on positive slippage", async () => {
    // route_v2 data: disc 8 | in_amount 8 | quoted_out 8 | slippage u16 @24 | platform u16 @26 | positive u16 @28
    await refuse("normalBuy", (b) => setSwapData(b, (d) => new DataView(d.buffer).setUint16(24, 50, true)), /slippage_bps 50/);
    await refuse("normalBuy", (b) => setSwapData(b, (d) => new DataView(d.buffer).setUint16(28, 100, true)), /positive slippage/);
    await refuse("normalBuy", (b) => setSwapData(b, (d) => new DataView(d.buffer).setBigUint64(8, 1n, true)), /in_amount 1 /);
    await refuse(
      "normalBuy",
      (b) =>
        setSwapData(b, (d) =>
          d.set(
            JUPITER_IX.sharedAccountsRouteV2.map((x) => x ^ 1),
            0,
          ),
        ),
      /not route_v2/,
    );
    await refuse(
      "normalBuy",
      (b) => ((b.swapInstruction as { programId: string }).programId = RAYDIUM_LAUNCHLAB_PROGRAM_ID),
      /not Jupiter v6/,
    );
  });

  test("refuses user accounts that are not the taker's own, and a redirected output", async () => {
    const L = JUPITER_ROUTE_LAYOUTS.route_v2;
    await refuse("normalBuy", (b) => (swapAccount(b, L.destination).pubkey = JUPITER_ATTACKER), /destination token account/);
    await refuse("normalBuy", (b) => (swapAccount(b, L.source).pubkey = JUPITER_ATTACKER), /source token account/);
    await refuse("normalBuy", (b) => (swapAccount(b, L.optionalDestination).pubkey = JUPITER_ATTACKER), /redirects the output/);
    await refuse("normalBuy", (b) => (swapAccount(b, L.authority).pubkey = JUPITER_ATTACKER), /not the taker/);
    const S = JUPITER_ROUTE_LAYOUTS.shared_accounts_route_v2;
    await refuse("usdcBuy", (b) => (swapAccount(b, S.destination).pubkey = JUPITER_ATTACKER), /destination token account/);
  });

  test("refuses unexpected programs, signers, tips and compute-budget impostors", async () => {
    const attackerIx = { programId: JUPITER_ATTACKER, accounts: [], data: "" };
    await refuse("normalBuy", (b) => (b.otherInstructions = [attackerIx]), /unexpected program/);
    await refuse("normalBuy", (b) => (b.setupInstructions = [{ ...attackerIx, programId: JUPITER_PROGRAM_ID }]), /unexpected program/);
    await refuse(
      "normalBuy",
      (b) => (b.tipInstruction = { programId: SYSTEM_PROGRAM_ID, accounts: [], data: "AgAAAICWmAAAAAAA" }),
      /tip instruction/,
    );
    await refuse("normalBuy", (b) => (b.computeBudgetInstructions = [attackerIx]), /computeBudgetInstructions/);
    await refuse(
      "normalBuy",
      (b) => {
        const setup = b.setupInstructions as { accounts: { pubkey: string; isSigner: boolean }[] }[];
        setup[0]!.accounts[1] = { ...setup[0]!.accounts[1]!, pubkey: JUPITER_ATTACKER, isSigner: true };
      },
      /only the taker may/,
    );
  });

  test("CU limit from simulation: x1.2, capped", () => {
    expect(jupiterCuLimitFromSimulation(100_000)).toBe(120_000);
    expect(jupiterCuLimitFromSimulation(100_001n)).toBe(120_002);
    expect(jupiterCuLimitFromSimulation(1_300_000)).toBe(1_400_000);
    expect(jupiterCuLimitFromSimulation(300_000, 330_000)).toBe(330_000);
    expect(() => jupiterCuLimitFromSimulation(0)).toThrow();
  });
});
