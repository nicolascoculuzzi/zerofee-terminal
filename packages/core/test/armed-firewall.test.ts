/**
 * Every transaction the armed-order builders produce must pass the browser signer firewall
 * (@zerofee/signer checkTransaction) under a realistic policy: nonce-slot creation and reclaim,
 * armed sells (grid, OCO, full-exit ladder, PumpSwap), armed buys (<= 3 variants), the migration
 * snipe and every pre-signed cancel - all as v0 transactions that load the operator lookup table.
 */
import { describe, expect, test } from "bun:test";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
} from "@solana/kit";
import {
  checkTransaction,
  createPumpBondingCurveRule,
  createPumpSwapRule,
  type FirewallContext,
  type FirewallResult,
} from "@zerofee/signer";
import {
  type ArmedOrder,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ammBuyTemplate,
  ammSellTemplate,
  armMigrationSnipe,
  armOcoPair,
  armOrder,
  COMPUTE_BUDGET_PROGRAM_ID,
  createNonceSlotInstructions,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  LAMPORTS_PER_SOL,
  minOutGrid,
  nonceSlotAddresses,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  pumpBuyTemplate,
  pumpSellTemplate,
  SYSTEM_PROGRAM_ID,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  withdrawNonceInstruction,
} from "../src";
import { armedWallet, curveContext, nonceRefs, operatorTables, poolContext, randomNonceValue, TIP_LEVELS } from "./armedTestKit";

const CONNECTED = "Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c" as Address;
const bytes = (wireBase64: string) => new Uint8Array(getBase64Encoder().encode(wireBase64));

async function firewallContext(wallet: Address, tables: Record<Address, Address[]>): Promise<FirewallContext> {
  return {
    signer: wallet,
    connectedWallet: CONNECTED,
    ownedNonceAccounts: await nonceSlotAddresses(wallet, 10),
    allowedPrograms: [
      SYSTEM_PROGRAM_ID,
      COMPUTE_BUDGET_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      PUMP_PROGRAM_ID,
      PUMP_AMM_PROGRAM_ID,
    ],
    tipAccounts: [...JITO_TIP_ACCOUNTS_FALLBACK, ...HELIUS_SENDER_TIP_ACCOUNTS],
    caps: {
      maxTipLamports: 10_000_000n,
      maxPriorityFeeLamports: 5_000_000n,
      maxComputeUnitLimit: 400_000,
      maxBuyLamports: LAMPORTS_PER_SOL,
      maxBuyQuote: {},
    },
    addressLookupTables: tables,
    venueRules: [
      createPumpBondingCurveRule({ programId: PUMP_PROGRAM_ID }),
      createPumpSwapRule({ programId: PUMP_AMM_PROGRAM_ID, pumpProgramId: PUMP_PROGRAM_ID }),
    ],
  };
}

async function expectAllowed(tx: Uint8Array, ctx: FirewallContext, what: string): Promise<FirewallResult & { ok: true }> {
  const r = await checkTransaction(tx, ctx);
  if (!r.ok) throw new Error(`firewall refused ${what}:\n  ${r.violations.join("\n  ")}`);
  return r;
}

/** Every signed tx of the orders (variants and cancels, deduplicated) must pass. */
async function expectOrdersAllowed(orders: ArmedOrder[], ctx: FirewallContext): Promise<number> {
  const seen = new Set<string>();
  for (const o of orders) {
    for (const a of o.attempts) {
      for (const tx of [...a.variants.map((v) => v.tx), a.nonce.cancel]) {
        if (seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        const r = await expectAllowed(bytes(tx.wireBase64), ctx, `${o.id} attempt ${a.index}`);
        expect(r.summary.durableNonce).toEqual({ nonceAccount: a.nonce.account, nonceValue: a.nonce.value });
      }
    }
  }
  return seen.size;
}

function blockhashTx(feePayer: Address, instructions: Instruction[]): Uint8Array {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(32))) as Blockhash, lastValidBlockHeight: 0n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg)));
}

describe("armed transactions pass the signer firewall (realistic policy, operator ALT)", async () => {
  const signer = await armedWallet();
  const wallet = signer.address;
  const tables = (await operatorTables()) as Record<Address, Address[]>;
  const ctx = await firewallContext(wallet, tables);
  const curve = await curveContext(wallet);
  const pool = poolContext(wallet);

  test("nonce slot creation (CreateAccountWithSeed + InitializeNonceAccount, one signer) and rent reclaim", async () => {
    const { address, instructions } = await createNonceSlotInstructions({ wallet, index: 0, rentLamports: 1_056_640n });
    const r = await expectAllowed(
      blockhashTx(wallet, [setComputeUnitLimitInstruction(20_000), setComputeUnitPriceInstruction(10_000n), ...instructions]),
      ctx,
      "nonce slot creation",
    );
    expect(r.summary.actions).toContainEqual({ kind: "nonce_create", nonceAccount: address, lamports: 1_056_640n });
    for (const recipient of [wallet, CONNECTED]) {
      await expectAllowed(
        blockhashTx(wallet, [withdrawNonceInstruction({ nonceAccount: address, authority: wallet, recipient, lamports: 1_056_640n })]),
        ctx,
        "nonce withdraw",
      );
    }
  });

  test("armed sells: OCO take-profit + stop-loss ladder (full exit, curve), every variant and cancel", async () => {
    const amount = 1_234_567_890n;
    const [n0, n1, n2] = await nonceRefs(wallet, 3);
    const tp = await pumpSellTemplate(curve, { amount, closeBaseAccount: true });
    const sl = await pumpSellTemplate(curve, { amount, closeBaseAccount: true });
    const [takeProfit, stopLoss] = await armOcoPair(
      {
        group: "oco-1",
        nonce: n0 as never,
        extraStopLossNonces: [n1, n2] as never,
        takeProfit: {
          id: "tp",
          kind: "take-profit",
          wallet,
          mint: curve.mint,
          amount,
          fullExit: true,
          trigger: { type: "quote-at-least", threshold: 60_000_000n },
          templates: [tp],
          minOuts: minOutGrid(60_000_000n, [0, 100, 200]),
          tipLevels: TIP_LEVELS,
          armingQuoteOut: 40_000_000n,
          lookupTables: tables,
        },
        stopLoss: {
          id: "sl",
          kind: "stop-loss",
          wallet,
          mint: curve.mint,
          amount,
          fullExit: true,
          trigger: { type: "quote-at-most", threshold: 30_000_000n },
          templates: [sl],
          minOuts: minOutGrid(30_000_000n, [0, 300, 600]),
          tipLevels: TIP_LEVELS,
          armingQuoteOut: 40_000_000n,
          lookupTables: tables,
        },
      },
      signer,
    );
    // 6 TP variants + 18 SL variants (3 nonces) + 3 cancels (the TP shares the SL's first cancel).
    expect(await expectOrdersAllowed([takeProfit, stopLoss], ctx)).toBe(27);
    expect(stopLoss.capCost.buyLamports).toBe(0n);
  });

  test("armed PumpSwap full-exit sell (canonical pool)", async () => {
    const amount = 5_000_000_000n;
    const order = await armOrder(
      {
        id: "amm-sl",
        kind: "stop-loss",
        wallet,
        mint: pool.pool.baseMint,
        amount,
        fullExit: true,
        trigger: { type: "quote-at-most", threshold: 20_000_000n },
        templates: [await ammSellTemplate(pool, { amount, closeBaseAccount: true })],
        minOuts: minOutGrid(20_000_000n, [0, 300]),
        tipLevels: TIP_LEVELS,
        nonces: await nonceRefs(wallet, 1, 3),
        armingQuoteOut: 25_000_000n,
        lookupTables: tables,
      },
      signer,
    );
    expect(await expectOrdersAllowed([order], ctx)).toBe(5);
  });

  test("armed buys: curve limit buy and PumpSwap limit buy (3 variants each), migration snipe", async () => {
    const spend = 100_000_000n;
    const curveBuy = await armOrder(
      {
        id: "lb-curve",
        kind: "limit-buy",
        wallet,
        mint: curve.mint,
        amount: spend,
        trigger: { type: "quote-at-least", threshold: 3_000_000_000n },
        templates: [await pumpBuyTemplate(curve, { spend })],
        minOuts: minOutGrid(3_000_000_000n, [0, 200, 400]),
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(wallet, 1, 4),
        armingQuoteOut: 2_500_000_000n,
        lookupTables: tables,
      },
      signer,
    );
    const ammBuy = await armOrder(
      {
        id: "lb-amm",
        kind: "limit-buy",
        wallet,
        mint: pool.pool.baseMint,
        amount: spend,
        trigger: { type: "quote-at-least", threshold: 5_000_000_000n },
        templates: [await ammBuyTemplate(pool, { spend })],
        minOuts: minOutGrid(5_000_000_000n, [0, 200, 400]),
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(wallet, 1, 5),
        armingQuoteOut: 4_000_000_000n,
        lookupTables: tables,
      },
      signer,
    );
    const snipe = await armMigrationSnipe(
      {
        id: "snipe",
        wallet,
        mint: curve.mint,
        amount: spend,
        minOuts: [1_000_000_000n, 900_000_000n],
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(wallet, 1, 6),
        armingQuoteOut: 1_100_000_000n,
        lookupTables: tables,
        pool: { curve: curve.curve, baseTokenProgram: curve.baseTokenProgram, globalConfig: pool.globalConfig },
      },
      signer,
    );
    expect(await expectOrdersAllowed([curveBuy, ammBuy, snipe], ctx)).toBe(3 + 1 + 3 + 1 + 2 + 1);
    // Each signed buy variant counts in full against the daily buy cap.
    expect(curveBuy.capCost.buyLamports).toBe(3n * spend);
    expect(snipe.capCost.buyLamports).toBe(2n * spend);
  });

  test("control: the same variant compressed naively (mints, token programs, user ATAs from the table) is refused", async () => {
    const amount = 1_000n;
    const tmpl = await pumpSellTemplate(curve, { amount, closeBaseAccount: true });
    const ixs = await tmpl.build(1n);
    const everything = [...new Set(ixs.flatMap((ix) => (ix.accounts ?? []).map((a) => a.address)))].filter((a) => a !== wallet);
    const table = Object.keys(tables)[0] as Address;
    const poisoned = { [table]: [...(tables[table] as Address[]), ...everything] };
    const [nonce] = await nonceRefs(wallet, 1, 7);
    const naive = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(wallet, m),
      (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(100_000), ...ixs], m),
      (m) =>
        setTransactionMessageLifetimeUsingDurableNonce(
          { nonce: nonce?.value ?? randomNonceValue(), nonceAccountAddress: nonce?.account as Address, nonceAuthorityAddress: wallet },
          m,
        ),
      (m) => compressTransactionMessageUsingAddressLookupTables(m, poisoned),
    );
    const r = await checkTransaction(new Uint8Array(getTransactionEncoder().encode(compileTransaction(naive))), {
      ...ctx,
      addressLookupTables: poisoned,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.violations.join("\n")).toMatch(/static account key/);
  });
});
