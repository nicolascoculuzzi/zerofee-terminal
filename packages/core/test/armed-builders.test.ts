/**
 * Arming: variant grids on one nonce, OCO pairs, full-exit ladders (and their refusal for buys and
 * partial sells), migration snipes, dual-venue orders, reservations, cap cost, the JSON codec, and
 * server-side verification of the signed bytes against the metadata.
 */
import { describe, expect, test } from "bun:test";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingDurableNonce,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  type ArmedOrder,
  ArmedOrderRejected,
  type ArmedOrderSpec,
  ArmingError,
  ammBuyTemplate,
  ammSellTemplate,
  armedOrderFromJson,
  armedOrderToJson,
  armMigrationSnipe,
  armOcoPair,
  armOrder,
  armOrders,
  assertArmable,
  assertLadderAllowed,
  canonicalPoolPda,
  computeReservation,
  currentInterfaceVersion,
  DEFAULT_CU_LIMITS,
  DEFAULT_MAX_ARMED_BUY_VARIANTS,
  findAssociatedTokenAddress,
  hasCancelForEveryNonce,
  inspectArmedTransaction,
  JITO_TIP_ACCOUNTS_FALLBACK,
  jitoTipLevels,
  LAMPORTS_PER_SIGNATURE,
  migrationPoolContext,
  minOutGrid,
  pumpBuyTemplate,
  pumpSellTemplate,
  SYSTEM_PROGRAM_ID,
  setComputeUnitPriceInstruction,
  signTransactionBatch,
  TOKEN_PROGRAM_ID,
  toSignedTx,
  verifyArmedOrderTransactions,
  WSOL_MINT,
} from "../src";
import { armedWallet, curveContext, nonceRefs, operatorTables, poolContext, TIP_LEVELS } from "./armedTestKit";

const AMOUNT = 1_234_567_890n;

/** Counts signer calls: arming must ask for signatures exactly once per batch (one wallet popup). */
function countingSigner(inner: KeyPairSigner): { signer: TransactionPartialSigner; calls: () => number } {
  let calls = 0;
  return {
    signer: {
      address: inner.address,
      signTransactions: async (txs) => {
        calls++;
        return inner.signTransactions(txs);
      },
    },
    calls: () => calls,
  };
}

async function stopLossSpec(wallet: Address, nonceCount = 1, overrides: Partial<ArmedOrderSpec> = {}): Promise<ArmedOrderSpec> {
  const curve = await curveContext(wallet);
  return {
    id: "sl",
    kind: "stop-loss",
    wallet,
    mint: curve.mint,
    amount: AMOUNT,
    fullExit: true,
    trigger: { type: "quote-at-most", threshold: 30_000_000n },
    templates: [await pumpSellTemplate(curve, { amount: AMOUNT, closeBaseAccount: true })],
    minOuts: minOutGrid(30_000_000n, [0, 300, 600, 900]),
    tipLevels: TIP_LEVELS,
    nonces: await nonceRefs(wallet, nonceCount),
    armingQuoteOut: 40_000_000n,
    lookupTables: await operatorTables(),
    ...overrides,
  };
}

describe("grid helpers", () => {
  test("minOutGrid steps below the reference, tightest first, deduplicated", () => {
    expect(minOutGrid(10_000n, [0, 100, 100, 250])).toEqual([10_000n, 9_900n, 9_750n]);
    expect(() => minOutGrid(0n, [0])).toThrow();
    expect(() => minOutGrid(1n, [10_000])).toThrow();
    expect(minOutGrid(1n, [5_000])).toEqual([]);
  });

  test("jitoTipLevels", () => {
    expect(jitoTipLevels([{ tipLamports: 1_000n, cuPriceMicroLamports: 5n }])).toEqual([
      { level: 0, cuPriceMicroLamports: 5n, tips: [{ lane: "jito", lamports: 1_000n }] },
    ]);
  });
});

describe("min-out x tip grid on ONE nonce", async () => {
  const inner = await armedWallet();
  const { signer, calls } = countingSigner(inner);
  const wallet = inner.address;
  const spec = await stopLossSpec(wallet);
  const order = await armOrder(spec, signer);
  const attempt = order.attempts[0];

  test("4 min-outs x 2 tips = 8 variants, all against the same nonce value; signed in one call", () => {
    expect(calls()).toBe(1);
    expect(order.status).toBe("armed");
    expect(order.attempts).toHaveLength(1);
    expect(attempt?.variants).toHaveLength(8);
    expect(new Set(attempt?.variants.map((v) => v.tx.signature)).size).toBe(8);
    for (const v of attempt?.variants ?? []) {
      const insp = inspectArmedTransaction(v.tx.wireBase64);
      expect(insp.lifetimeToken).toBe(spec.nonces[0]?.value as string);
      expect(insp.nonce?.account).toBe(spec.nonces[0]?.account as Address);
      expect(insp.feePayer).toBe(wallet);
      expect(insp.signers).toEqual([wallet]);
      expect(v.venue).toBe("pump");
      expect(v.id).toMatch(/^sl\/0\/pump\/\d\/[01]$/);
    }
    expect(hasCancelForEveryNonce(order)).toBe(true);
  });

  test("the cancel only advances that nonce", () => {
    const insp = inspectArmedTransaction(attempt?.nonce.cancel.wireBase64 ?? "");
    expect(insp.lifetimeToken).toBe(spec.nonces[0]?.value as string);
    expect(insp.instructions[0]?.program).toBe(SYSTEM_PROGRAM_ID);
    expect(insp.instructions.filter((i) => i.program !== "ComputeBudget111111111111111111111111111111")).toHaveLength(1);
  });

  test("frozen account facts, pinned tip account, interface version", () => {
    expect(order.frozen.venues).toHaveLength(1);
    expect(order.frozen.venues[0]).toMatchObject({ venue: "pump", creator: spec.templates[0]?.frozen.creator });
    expect(order.frozen.tipAccounts).toHaveLength(1);
    expect(JITO_TIP_ACCOUNTS_FALLBACK).toContain(order.frozen.tipAccounts[0] as Address);
    expect(order.frozen.lookupTables).toHaveLength(1);
    expect(order.frozen.interfaceVersion).toBe(currentInterfaceVersion());
    expect(currentInterfaceVersion()).toMatch(/^pump:[0-9a-f]{12}\|pump_amm:[0-9a-f]{12}\|pump_fees:[0-9a-f]{12}$/);
  });

  test("reservation and daily-cap cost of a sell", () => {
    const fill = order.attempts[0]?.variants.reduce((m, v) => {
      const c = LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports + v.tipLamports;
      return c > m ? c : m;
    }, 0n);
    expect(order.reservation).toEqual({ lamports: fill as bigint, mint: spec.mint, tokens: AMOUNT });
    expect(order.capCost.buyLamports).toBe(0n);
    const fees = (attempt?.variants ?? []).reduce((s, v) => s + LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports + v.tipLamports, 0n);
    expect(order.capCost.feeLamports).toBe(fees + LAMPORTS_PER_SIGNATURE); // + the cancel's base fee
  });

  test("server-side verification of the signed bytes passes, and catches tampering", async () => {
    const tables = await operatorTables();
    expect(await verifyArmedOrderTransactions(order, { lookupTables: tables })).toEqual([]);
    await assertArmable(order, { lookupTables: tables });

    const v0 = attempt?.variants[0];
    const v1 = attempt?.variants[1];
    if (!attempt || !v0 || !v1) throw new Error("fixture");
    const codes = async (o: ArmedOrder) => (await verifyArmedOrderTransactions(o, { lookupTables: tables })).map((x) => x.code);
    /** Copy of the order with attempt 0 patched. */
    const withAttempt0 = (patch: Partial<NonNullable<typeof attempt>>): ArmedOrder => {
      const o = structuredClone(order);
      o.attempts[0] = { ...(o.attempts[0] as NonNullable<typeof attempt>), ...patch };
      return o;
    };
    const withVariant0 = (patch: Partial<typeof v0>) => withAttempt0({ variants: [{ ...v0, ...patch }, ...attempt.variants.slice(1)] });

    expect(await codes(withVariant0({ minOut: v0.minOut - 1n }))).toContain("trade-mismatch");
    expect(await codes({ ...order, amount: order.amount + 1n })).toContain("trade-mismatch");
    expect(await codes(withVariant0({ tipLamports: 1n }))).toContain("tip-mismatch");
    expect(await codes(withVariant0({ tx: { ...v0.tx, signature: v1.tx.signature } }))).toContain("signature-invalid");
    expect(await codes(withAttempt0({ nonce: { ...attempt.nonce, value: "11111111111111111111111111111111" } }))).toContain(
      "lifetime-mismatch",
    );
    expect(await codes({ ...order, wallet: "Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c" as Address })).toContain("fee-payer");
    const noCancel = structuredClone(order);
    (noCancel.attempts[0] as typeof attempt).nonce.cancel = { wireBase64: "", signature: "", size: 0 };
    expect(hasCancelForEveryNonce(noCancel)).toBe(false);
    await expect(assertArmable(noCancel, { lookupTables: tables })).rejects.toThrow(ArmedOrderRejected);
  });

  test("JSON codec round-trips bigints exactly", () => {
    const back = armedOrderFromJson(armedOrderToJson(order));
    expect(back).toEqual(order);
    expect(typeof back.amount).toBe("bigint");
    expect(() => armedOrderFromJson("{}")).toThrow();
  });
});

describe("full-exit attempt ladders across nonces", async () => {
  const signer = await armedWallet();
  const wallet = signer.address;

  test("3 nonces: 3 attempts, each with its own grid and cancel; reservation covers two failed attempts", async () => {
    const order = await armOrder(await stopLossSpec(wallet, 3), signer);
    expect(order.attempts.map((a) => a.variants.length)).toEqual([8, 8, 8]);
    expect(new Set(order.attempts.map((a) => a.nonce.cancel.signature)).size).toBe(3);
    const maxFail =
      order.attempts[0]?.variants.reduce(
        (m, v) => (LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports > m ? LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports : m),
        0n,
      ) ?? 0n;
    const single = computeReservation({ side: "sell", mint: order.mint, amount: AMOUNT, attempts: order.attempts.slice(0, 1) });
    expect(order.reservation.lamports).toBe(single.lamports + 2n * maxFail);
  });

  test("refused for buys and partial sells (double-fill risk) and without the CloseAccount guard", async () => {
    const curve = await curveContext(wallet);
    const buy = await pumpBuyTemplate(curve, { spend: 10_000_000n });
    await expect(
      armOrder(
        {
          ...(await stopLossSpec(wallet, 2)),
          kind: "limit-buy",
          amount: 10_000_000n,
          fullExit: false,
          templates: [buy],
          minOuts: [1n],
          tipLevels: TIP_LEVELS.slice(0, 1),
        },
        signer,
      ),
    ).rejects.toThrow("refused for buys");
    const partial = await pumpSellTemplate(curve, { amount: AMOUNT });
    await expect(armOrder({ ...(await stopLossSpec(wallet, 2)), fullExit: false, templates: [partial] }, signer)).rejects.toThrow(
      "refused for partial sells",
    );
    await expect(armOrder({ ...(await stopLossSpec(wallet, 2)), templates: [partial] }, signer)).rejects.toThrow(
      "close the base token account",
    );
    expect(() => assertLadderAllowed("sell", true, [{ closesBaseAccount: true }])).not.toThrow();
  });
});

describe("OCO pairs share one nonce", async () => {
  const signer = await armedWallet();
  const wallet = signer.address;

  test("take-profit + stop-loss: same nonce account, value and cancel; extra stop-loss nonces ladder", async () => {
    const [n0, n1] = await nonceRefs(wallet, 2);
    const base = await stopLossSpec(wallet);
    const { nonces: _n, ...rest } = base;
    const [tp, sl] = await armOcoPair(
      {
        group: "g1",
        nonce: n0 as never,
        extraStopLossNonces: [n1 as never],
        takeProfit: {
          ...rest,
          id: "tp",
          kind: "take-profit",
          trigger: { type: "quote-at-least", threshold: 60_000_000n },
          minOuts: [60_000_000n],
        },
        stopLoss: { ...rest, id: "sl" },
      },
      signer,
    );
    expect(tp.ocoGroup).toBe("g1");
    expect(sl.ocoGroup).toBe("g1");
    expect(tp.attempts[0]?.nonce).toEqual(sl.attempts[0]?.nonce as never);
    expect(sl.attempts).toHaveLength(2);
    // The shared cancel is charged once (to the first order); the stop-loss pays for its extra nonce's cancel.
    const variantFees = (o: ArmedOrder) =>
      o.attempts.flatMap((a) => a.variants).reduce((s, v) => s + LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports + v.tipLamports, 0n);
    expect(tp.capCost.feeLamports).toBe(variantFees(tp) + LAMPORTS_PER_SIGNATURE);
    expect(sl.capCost.feeLamports).toBe(variantFees(sl) + LAMPORTS_PER_SIGNATURE);
  });

  test("sharing a nonce outside an OCO group, or with two values, is refused", async () => {
    const [n0] = await nonceRefs(wallet, 1);
    const a = await stopLossSpec(wallet, 1, { id: "a", nonces: [n0 as never] });
    const b = await stopLossSpec(wallet, 1, { id: "b", nonces: [n0 as never] });
    await expect(armOrders([a, b], signer)).rejects.toThrow("not in one OCO group");
    await expect(
      armOrders(
        [
          { ...a, ocoGroup: "g" },
          { ...b, ocoGroup: "g", nonces: [{ ...(n0 as never), value: "11111111111111111111111111111111" as never }] },
        ],
        signer,
      ),
    ).rejects.toThrow("two different values");
    await expect(armOrders([a, { ...a }], signer)).rejects.toThrow("duplicate order ids");
  });
});

describe("buy grids, canonical pools, snipes, dual venue", async () => {
  const signer = await armedWallet();
  const wallet = signer.address;
  const curve = await curveContext(wallet);
  const pool = poolContext(wallet);
  const tables = await operatorTables();
  const buySpec = async (overrides: Partial<ArmedOrderSpec> = {}): Promise<ArmedOrderSpec> => ({
    id: "lb",
    kind: "limit-buy",
    wallet,
    mint: curve.mint,
    amount: 50_000_000n,
    trigger: { type: "quote-at-least", threshold: 1_000_000_000n },
    templates: [await pumpBuyTemplate(curve, { spend: 50_000_000n })],
    minOuts: [1_000_000_000n, 980_000_000n, 960_000_000n],
    tipLevels: TIP_LEVELS.slice(0, 1),
    nonces: await nonceRefs(wallet, 1),
    armingQuoteOut: 900_000_000n,
    lookupTables: tables,
    ...overrides,
  });

  test(`buy grids are capped at ${DEFAULT_MAX_ARMED_BUY_VARIANTS} variants (each counts against the daily buy cap)`, async () => {
    const ok = await armOrder(await buySpec(), signer);
    expect(ok.capCost.buyLamports).toBe(3n * 50_000_000n);
    expect(ok.reservation.lamports).toBeGreaterThan(50_000_000n);
    await expect(armOrder(await buySpec({ tipLevels: TIP_LEVELS }), signer)).rejects.toThrow("6 buy variants > 3");
    const four = await armOrder(await buySpec({ minOuts: [4n, 3n, 2n, 1n], maxBuyVariants: 4 }), signer);
    expect(four.attempts[0]?.variants).toHaveLength(4);
  });

  test("PumpSwap templates refuse non-canonical pools unless explicitly allowed", async () => {
    const fake = { ...pool, poolAddress: "Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c" as Address };
    await expect(ammSellTemplate(fake, { amount: 1n })).rejects.toThrow(ArmingError);
    await expect(ammBuyTemplate(fake, { spend: 1n })).rejects.toThrow("canonical");
    await expect(ammBuyTemplate(fake, { spend: 1n, allowNonCanonicalPool: true })).resolves.toBeDefined();
    await expect(ammBuyTemplate(pool, { spend: 1n })).resolves.toBeDefined();
  });

  test("migration snipe: PumpSwap buy against the deterministic canonical pool, migration trigger", async () => {
    const snipe = await armMigrationSnipe(
      {
        id: "snipe",
        wallet,
        mint: curve.mint,
        amount: 50_000_000n,
        minOuts: [800_000_000n, 700_000_000n],
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(wallet, 1),
        armingQuoteOut: 850_000_000n,
        lookupTables: tables,
        pool: { curve: curve.curve, baseTokenProgram: curve.baseTokenProgram, globalConfig: pool.globalConfig },
      },
      signer,
    );
    const canonical = await canonicalPoolPda(curve.mint);
    expect(snipe.kind).toBe("migration-snipe");
    expect(snipe.trigger).toEqual({ type: "migration" });
    expect(snipe.frozen.venues).toEqual([expect.objectContaining({ venue: "pumpswap", market: canonical, creator: curve.curve.creator })]);
    const insp = inspectArmedTransaction(snipe.attempts[0]?.variants[0]?.tx.wireBase64 ?? "", tables);
    expect(insp.staticAccounts).toContain(canonical);
    await expect(armMigrationSnipe({ ...(snipe as never), nonces: await nonceRefs(wallet, 2), pool: {} as never }, signer)).rejects.toThrow(
      "exactly one nonce",
    );
  });

  test("an exit that survives graduation: curve and PumpSwap variants on the same nonce", async () => {
    const ctx = await migrationPoolContext({
      mint: curve.mint,
      curve: curve.curve,
      baseTokenProgram: curve.baseTokenProgram,
      user: wallet,
    });
    const order = await armOrder(
      {
        ...(await stopLossSpec(wallet)),
        templates: [
          await pumpSellTemplate(curve, { amount: AMOUNT, closeBaseAccount: true }),
          await ammSellTemplate(ctx, { amount: AMOUNT, closeBaseAccount: true }),
        ],
        minOuts: [30_000_000n, 29_000_000n],
        tipLevels: TIP_LEVELS.slice(0, 1),
      },
      signer,
    );
    expect(order.attempts[0]?.variants.map((v) => v.venue).sort()).toEqual(["pump", "pump", "pumpswap", "pumpswap"]);
    expect(order.frozen.venues.map((v) => v.venue)).toEqual(["pump", "pumpswap"]);
    expect(await verifyArmedOrderTransactions(order, { lookupTables: tables })).toEqual([]);
  });

  test("spec validation", async () => {
    const other = await armedWallet();
    await expect(armOrder(await stopLossSpec(other.address), signer)).rejects.toThrow("is not the signer");
    await expect(armOrder(await stopLossSpec(wallet, 1, { minOuts: [5n, 5n] }), signer)).rejects.toThrow("duplicate min-out");
    await expect(armOrder(await stopLossSpec(wallet, 1, { minOuts: [0n] }), signer)).rejects.toThrow("> 0");
    await expect(armOrder(await stopLossSpec(wallet, 1, { amount: 5n }), signer)).rejects.toThrow("template amount");
    await expect(armOrder(await stopLossSpec(wallet, 1, { trigger: { type: "migration" } }), signer)).rejects.toThrow("PumpSwap template");
    const [n] = await nonceRefs(wallet, 1);
    await expect(
      armOrder(await stopLossSpec(wallet, 1, { nonces: [{ ...(n as never), authority: other.address }] }), signer),
    ).rejects.toThrow("authority");
    await expect(armOrder(await stopLossSpec(wallet, 1, { kind: "limit-buy" }), signer)).rejects.toThrow(
      "is a buy but a template is a sell",
    );
  });

  test("a signer that returns the wrong number of signature sets is rejected", async () => {
    const broken: TransactionPartialSigner = { address: wallet, signTransactions: async (_txs: readonly Transaction[]) => [] };
    await expect(armOrder(await buySpec(), broken)).rejects.toThrow("signature sets");
  });
});

describe("verification binds the metadata to the signed bytes (accounts, full-exit guard, fees)", async () => {
  const signer = await armedWallet();
  const wallet = signer.address;
  const curve = await curveContext(wallet);
  const tables = await operatorTables();
  const codes = async (o: ArmedOrder, withTables = true) =>
    (await verifyArmedOrderTransactions(o, withTables ? { lookupTables: tables } : {})).map((x) => x.code);

  test("full exit claimed but the signed sells do not close the base token account", async () => {
    const partial = await armOrder(
      { ...(await stopLossSpec(wallet)), fullExit: false, templates: [await pumpSellTemplate(curve, { amount: AMOUNT })] },
      signer,
    );
    expect(await codes(partial)).toEqual([]);
    expect(await codes({ ...partial, fullExit: true })).toContain("full-exit-guard-missing");
  });

  test("mint, market, creator, fee and buyback recipients must match the frozen facts", async () => {
    const order = await armOrder(await stopLossSpec(wallet), signer);
    expect(await codes(order)).toEqual([]);
    const other = "Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c" as Address;
    type Venue = ArmedOrder["frozen"]["venues"][number];
    const withVenue = (patch: Partial<Venue>): ArmedOrder => ({
      ...order,
      frozen: { ...order.frozen, venues: [{ ...(order.frozen.venues[0] as Venue), ...patch }] },
    });
    expect(await codes({ ...order, mint: other })).toContain("trade-mismatch");
    for (const patch of [{ market: other }, { creator: other }, { feeRecipient: other }, { buybackFeeRecipient: other }]) {
      expect(await codes(withVenue(patch))).toContain("account-mismatch");
    }
    expect(await codes({ ...order, frozen: { ...order.frozen, venues: [] } })).toContain("account-mismatch");
    // Without the table contents the recipients loaded from it cannot be checked: say so.
    expect(await codes(order, false)).toContain("unresolved-account");
  });

  test("each venue keeps its own CU limit in an exit that survives graduation", async () => {
    const ctx = await migrationPoolContext({
      mint: curve.mint,
      curve: curve.curve,
      baseTokenProgram: curve.baseTokenProgram,
      user: wallet,
    });
    const order = await armOrder(
      {
        ...(await stopLossSpec(wallet)),
        templates: [
          await pumpSellTemplate(curve, { amount: AMOUNT, closeBaseAccount: true }),
          await ammSellTemplate(ctx, { amount: AMOUNT, closeBaseAccount: true }),
        ],
        minOuts: [30_000_000n],
        tipLevels: TIP_LEVELS.slice(0, 1),
      },
      signer,
    );
    const fee = (venue: string) => order.attempts[0]?.variants.find((v) => v.venue === venue)?.priorityFeeLamports;
    const price = TIP_LEVELS[0]?.cuPriceMicroLamports ?? 0n;
    expect(fee("pump")).toBe((price * BigInt(DEFAULT_CU_LIMITS.pumpSell) + 999_999n) / 1_000_000n);
    expect(fee("pumpswap")).toBe((price * BigInt(DEFAULT_CU_LIMITS.ammSell) + 999_999n) / 1_000_000n);
    expect(await codes(order)).toEqual([]);
  });

  test("cancels are held to the fee caps and may only tip known tip accounts", async () => {
    const tip = JITO_TIP_ACCOUNTS_FALLBACK[0] as Address;
    const pricey = await armOrder(
      { ...(await stopLossSpec(wallet)), cancel: { tips: [{ lane: "jito", lamports: 20_000_000n, tipAccount: tip }] } },
      signer,
    );
    expect(await codes(pricey)).toContain("tip-cap");
    const wsol = await findAssociatedTokenAddress(wallet, WSOL_MINT, TOKEN_PROGRAM_ID);
    // core refuses an unreviewed tip account while building, before intake validation ever sees it
    await expect(
      armOrder({ ...(await stopLossSpec(wallet)), cancel: { tips: [{ lane: "jito", lamports: 1_000n, tipAccount: wsol }] } }, signer),
    ).rejects.toThrow(/not a reviewed jito tip account/);
  });

  test("a CU price without a CU limit is charged on the default limit and refused", async () => {
    const order = await armOrder({ ...(await stopLossSpec(wallet)), minOuts: [30_000_000n], tipLevels: TIP_LEVELS.slice(0, 1) }, signer);
    const attempt = order.attempts[0];
    const v = attempt?.variants[0];
    if (!v || !attempt) throw new Error("fixture");
    const ixs = await (await pumpSellTemplate(curve, { amount: AMOUNT, closeBaseAccount: true })).build(v.minOut);
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(wallet, m),
      (m) => appendTransactionMessageInstructions([setComputeUnitPriceInstruction(100_000n), ...ixs], m),
      (m) =>
        setTransactionMessageLifetimeUsingDurableNonce(
          { nonce: attempt.nonce.value as never, nonceAccountAddress: attempt.nonce.account, nonceAuthorityAddress: wallet },
          m,
        ),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
    );
    const [signed] = await signTransactionBatch(signer, [compileTransaction(msg)]);
    const forged = { ...v, tipLamports: 0n, priorityFeeLamports: 0n, tx: toSignedTx(signed as Transaction, wallet) };
    expect(await codes({ ...order, attempts: [{ ...attempt, variants: [forged] }] })).toContain("priority-mismatch");
  });

  test("an OCO group whose orders share no nonce is refused at arming", async () => {
    const a = await stopLossSpec(wallet, 1, { id: "a", ocoGroup: "g" });
    const b = await stopLossSpec(wallet, 1, { id: "b", ocoGroup: "g", nonces: await nonceRefs(wallet, 1, 5) });
    await expect(armOrders([a, b], signer)).rejects.toThrow("share no nonce");
  });
});
