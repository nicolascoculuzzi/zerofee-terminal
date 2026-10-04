/**
 * Armed orders on the local mainnet fork (`bun run fork:start`, then `bun run e2e`).
 *
 * Pre-signed durable-nonce transactions, signed by a vault-held trading wallet through @zerofee/signer's
 * SignerService with the shipped policy and checked again byte for byte before every send, triggered by core's
 * trigger engine on live fork state, and landed through SubmitRouter + RpcLane against mainnet's pump, PumpSwap,
 * Token-2022, durable-nonce and lookup-table code. No real money.
 *
 * One trading wallet, ten nonce slots and one operator lookup table, used in order:
 *   1 lookup table   2 nonce slots   3 take-profit (curve)   4 OCO   5 full-exit SL ladder
 *   6 cancel         7 stop-loss (PumpSwap)   8 migration snipe   9 sizes
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Address, AddressesByLookupTableAddress } from "@solana/kit";
import type { ForkTarget } from "../scripts/fork/env";
import {
  type AmmSwapEvent,
  type AmmTradeContext,
  type ArmedOrder,
  type ArmedVariant,
  aggregateReservations,
  ammFeeRates,
  ammSellTemplate,
  ammUserVolumeAccumulatorPda,
  applyArmedOrderEvent,
  armedOrderFromJson,
  armedOrderToJson,
  armedStaticAccounts,
  armMigrationSnipe,
  armOcoPair,
  armOrder,
  assertArmable,
  assertShareableLookupTableContents,
  canonicalPoolPda,
  coinCreatorVaultAuthorityPda,
  curveFeeRates,
  DEFAULT_CANCEL_CU_LIMIT,
  decodeAmmGlobalConfig,
  decodeFeeConfig,
  decodePumpGlobal,
  detectStaleness,
  effectiveQuoteReserve,
  estimateMigrationPoolReserves,
  evaluateTrigger,
  exclusiveGroups,
  fetchNonceSlots,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  hasReservedBalance,
  inspectArmedTransaction,
  JITO_TIP_ACCOUNTS_FALLBACK,
  jitoTipLevels,
  LAMPORTS_PER_SIGNATURE,
  type LiveMarketState,
  LOOKUP_TABLE_META_SIZE,
  liveQuoteOut,
  loadTokenState,
  lookupTableStatus,
  marketEventFromDecoded,
  migrationPoolContext,
  minOutGrid,
  NONCE_ACCOUNT_LENGTH,
  nonceSlotAddresses,
  PACKET_DATA_SIZE,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM_ID,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  type PumpCurveState,
  type PumpMigrationEvent,
  type PumpSwapState,
  type PumpTradeEvent,
  pumpBuyTemplate,
  pumpSellTemplate,
  quoteAmmBuyExactQuoteIn,
  quoteAmmSell,
  quoteSell,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  signaturesOnNonce,
  TOKEN_PROGRAM_ID,
  toAddressesByLookupTable,
  usableLookupTableAddresses,
  validateUserArmedOrders,
  WSOL_MINT,
} from "../src";
import {
  ARMED_TIP_LEVELS,
  armedSigner,
  balanceOf,
  completeCurve,
  createNonceSlots,
  createOperatorTable,
  createTradingWallet,
  curveStillActive,
  expectDead,
  expectNonceAdvanced,
  type Landing,
  liveMarket,
  marketTrade,
  migrateInstruction,
  moveQuote,
  nonceConsumed,
  nonceRef,
  observe,
  plainTx,
  pumpContext,
  sizeWithoutTables,
  spendDelta,
  submitArmed,
  type TradingWallet,
  tokenBalance,
  userTrade,
} from "./armedKit";
import {
  accountDataLength,
  connectFork,
  type Fork,
  forkRent,
  missingTarget,
  newWallet,
  targetOf,
  type Wallet,
  withSkipReason,
} from "./harness";

const TIP_LEVELS = jitoTipLevels(ARMED_TIP_LEVELS);
/** v x bps / 10,000 (bps of the value, so 10_500n = +5%). */
const bps = (v: bigint, b: bigint) => (v * b) / 10_000n;
const now = () => Date.now();

const curveTarget = targetOf("curve2022");
const poolTarget = targetOf("pumpswap");
const migrationTarget = targetOf("migration");
// A missing target is an explicit, explained skip of the cases that trade it (not a cascade of failures).
const noCurve = missingTarget("curve2022");
const noPool = missingTarget("pumpswap");
// The migration case consumes its coin, so it can run once per fork.
let migrationSkip = "";
if (!migrationTarget) migrationSkip = "the fork has no migration target (fork:start found no second Token-2022 curve coin)";
else if (!(await curveStillActive(await connectFork(), migrationTarget.market))) {
  migrationSkip = `${migrationTarget.mint} already completed on this fork (an earlier run migrated it); re-fork with \`bun run fork:stop && bun run fork:start --reuse\``;
}
if (migrationSkip) console.warn(`armed migration snipe skipped: ${migrationSkip}`);
const noOrders =
  noCurve && noPool && migrationSkip ? "no case armed an order (the fork has no curve2022, pumpswap or migration target)" : null;

function need(t: ForkTarget | undefined, kind: string): ForkTarget {
  if (!t) throw new Error(`the fork has no ${kind} target; run bun run fork:start`);
  return t;
}

/** xs[i], or a clear failure (noUncheckedIndexedAccess). */
function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element ${i}`);
  return x;
}

/** `{ InstructionError: [index, { Custom: code }] }` from landed meta, as numbers (the RPC returns bigints). */
function instructionError(err: unknown): { index: number; custom: number | null } {
  const ie = (err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError;
  if (!ie) throw new Error(`not an instruction error: ${JSON.stringify(err, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  const custom = (ie[1] as { Custom?: number | bigint } | null)?.Custom;
  return { index: Number(ie[0]), custom: custom === undefined ? null : Number(custom) };
}

function mustQuote(q: bigint | null): bigint {
  if (q === null) throw new Error("the venue cannot quote this amount");
  return q;
}

async function curveState(fork: Fork, mint: Address, user: Address): Promise<PumpCurveState> {
  const s = await loadTokenState(fork.rpc, { mint, user });
  if (s.venue !== "pump") throw new Error(`${mint} is not on its bonding curve`);
  return s;
}

async function poolState(fork: Fork, mint: Address, user: Address): Promise<PumpSwapState> {
  const s = await loadTokenState(fork.rpc, { mint, user });
  if (s.venue !== "pumpswap") throw new Error(`${mint} is not on PumpSwap`);
  return s;
}

function ammContext(s: PumpSwapState, user: Address): AmmTradeContext {
  return {
    poolAddress: s.poolAddress,
    pool: s.pool,
    user,
    baseTokenProgram: s.mintInfo.tokenProgram,
    quoteTokenProgram: s.quoteTokenProgram,
    globalConfig: s.globalConfig,
  };
}

/** The amount and min-out argument the variant actually signed (trade instruction data bytes 8..24). */
function signedTrade(v: ArmedVariant, tables: AddressesByLookupTableAddress): { amount: bigint; limit: bigint } {
  const ix = inspectArmedTransaction(v.tx.wireBase64, tables).instructions.find(
    (i) => i.program === PUMP_PROGRAM_ID || i.program === PUMP_AMM_PROGRAM_ID,
  );
  if (!ix) throw new Error(`${v.id} has no trade instruction`);
  const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
  return { amount: view.getBigUint64(8, true), limit: view.getBigUint64(16, true) };
}

/** Server intake: assertArmable passes, the order survives its JSON codec, and the signer's daily totals moved by exactly its capCost. */
async function expectAccepted(tw: TradingWallet, orders: ArmedOrder[], cost: { buyLamports: bigint; feeLamports: bigint }): Promise<void> {
  for (const o of orders) {
    await assertArmable(o, { lookupTables: tw.tables });
    expect(armedOrderFromJson(armedOrderToJson(o))).toEqual(o);
    expect(o.status).toBe("armed");
    expect(o.frozen.lookupTables).toEqual(Object.keys(tw.tables) as Address[]);
  }
  expect(cost.feeLamports).toBe(orders.reduce((s, o) => s + o.capCost.feeLamports, 0n));
  expect(cost.buyLamports).toBe(orders.reduce((s, o) => s + o.capCost.buyLamports, 0n));
}

/** What the server checks before submitting: the reserved balance is still there and nothing went stale. */
async function expectPreSubmitChecks(fork: Fork, tw: TradingWallet, order: ArmedOrder, tokens: bigint): Promise<void> {
  expect(hasReservedBalance(order, { lamports: await balanceOf(fork, tw.address), tokens })).toEqual({ ok: true });
  expect(detectStaleness(order, await observe(fork, tw, order))).toEqual([]);
}

/** Base fee + the variant's priority fee; its one Jito tip landed in a cloned tip account, or reverted on failure. */
function expectFeesAndTip(l: Landing, v: ArmedVariant): void {
  expect(l.tx.fee).toBe(LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports);
  const tips = l.tx.keys.filter((k) => JITO_TIP_ACCOUNTS_FALLBACK.includes(k));
  expect(tips).toHaveLength(1);
  const tip = l.tx.lamports(tips[0] as Address);
  expect(tip.pre).toBeGreaterThan(0n);
  expect(tip.delta).toBe(l.tx.err === null ? v.tipLamports : 0n);
}

/** A pre-signed cancel: base fee only (no priority fee, no tip), well inside its CU budget, no lookup table. */
function expectCancelLanded(l: Landing, tw: TradingWallet): void {
  expect(l.confirm.status).toBe("confirmed");
  expect(l.tx.err).toBeNull();
  expect(l.tx.fee).toBe(LAMPORTS_PER_SIGNATURE);
  expect(l.tx.lamports(tw.address).delta).toBe(-LAMPORTS_PER_SIGNATURE);
  expect(l.tx.computeUnits).toBeLessThanOrEqual(BigInt(DEFAULT_CANCEL_CU_LIMIT));
  expect([...l.tx.loaded.writable, ...l.tx.loaded.readonly]).toEqual([]);
}

describe("armed orders on the mainnet fork", () => {
  let fork: Fork;
  let tw: TradingWallet;
  let operator: Wallet;
  let table: Address;
  let tableContents: Address[] = [];
  const armedOrders: ArmedOrder[] = [];

  /** The variant loaded only shared accounts from the operator table; the nonce account stayed static (SIMD-0242). */
  function expectLoadedFromTable(l: Landing, nonce: Address): void {
    const loaded = [...l.tx.loaded.writable, ...l.tx.loaded.readonly];
    expect(loaded.length).toBeGreaterThan(0);
    for (const a of loaded) expect(tableContents).toContain(a);
    expect(l.tx.loaded.readonly).toContain(SYSVAR_RECENT_BLOCKHASHES_ID);
    expect(loaded).not.toContain(nonce);
  }

  /** A filled full-exit curve sell, to the lamport: the program's TradeEvent, the closed ATA, the user's SOL. */
  function expectCurveSellFill(l: Landing, v: ArmedVariant, s: PumpCurveState, position: bigint, expectedNet: bigint, nonce: Address) {
    expect(l.confirm.status).toBe("confirmed");
    expect(l.tx.err).toBeNull();
    const rates = curveFeeRates({ curve: s.curve, global: s.global, feeConfig: s.feeConfig, mintSupply: s.mintInfo.supply });
    const x = quoteSell(s.curve, position, rates);
    expect(x.quoteNet).toBe(expectedNet);
    expect(signedTrade(v, tw.tables)).toEqual({ amount: position, limit: v.minOut });
    expect(x.quoteNet).toBeGreaterThanOrEqual(v.minOut);
    const ev = l.tx.events.find((e): e is PumpTradeEvent => e.kind === "pumpTrade");
    if (!ev) throw new Error(`${l.label}: no TradeEvent`);
    expect(ev.isBuy).toBe(false);
    expect(ev.user).toBe(tw.address);
    expect(ev.mint).toBe(s.mint);
    expect(ev.tokenAmount).toBe(position);
    expect(ev.quoteAmount).toBe(x.quoteGross);
    expect(ev.fee).toBe(x.protocolFee);
    expect(ev.creatorFee).toBe(x.creatorFee);
    expect(l.tx.tokens(s.userBaseAta).delta).toBe(-position);
    expect(l.tx.closed()).toEqual([s.userBaseAta]);
    expect(l.tx.created()).toEqual([]);
    expectFeesAndTip(l, v);
    const refund = l.tx.lamports(s.userBaseAta).pre;
    expect(l.tx.lamports(tw.address).delta).toBe(x.quoteNet - l.tx.fee - v.tipLamports + refund);
    expectLoadedFromTable(l, nonce);
  }

  /** A filled full-exit PumpSwap sell: SellEvent, vault-side fill, wSOL unwrapped in the same tx, ATA closed, user SOL exact. */
  async function expectAmmSellFill(l: Landing, v: ArmedVariant, s: PumpSwapState, position: bigint, expectedNet: bigint, nonce: Address) {
    expect(l.confirm.status).toBe("confirmed");
    expect(l.tx.err).toBeNull();
    const rates = ammFeeRates({
      pool: s.pool,
      isCanonical: s.isCanonical,
      reserves: s.reserves,
      baseMintSupply: s.mintInfo.supply,
      feeConfig: s.feeConfig,
      globalConfig: s.globalConfig,
    });
    const x = quoteAmmSell(s.reserves, position, rates);
    expect(x.quoteOutNet).toBe(expectedNet);
    expect(signedTrade(v, tw.tables)).toEqual({ amount: position, limit: v.minOut });
    expect(x.quoteOutNet).toBeGreaterThanOrEqual(v.minOut);
    const ev = l.tx.events.find((e): e is AmmSwapEvent => e.kind === "ammSell");
    if (!ev) throw new Error(`${l.label}: no SellEvent`);
    expect(ev.user).toBe(tw.address);
    expect(ev.pool).toBe(s.poolAddress);
    expect(ev.baseAmount).toBe(position);
    expect(ev.quoteAmount).toBe(x.quoteOutGross);
    expect(ev.userQuoteAmount).toBe(x.quoteOutNet);
    expect(ev.lpFee).toBe(x.lpFee);
    expect(ev.protocolFee).toBe(x.protocolFee);
    expect(l.tx.tokens(s.pool.poolBaseTokenAccount).delta).toBe(position);
    expect(l.tx.tokens(s.pool.poolQuoteTokenAccount).delta).toBe(-(x.quoteOutGross - x.lpFee));
    const wsol = l.tx.lamports(await findAssociatedTokenAddress(tw.address, WSOL_MINT, TOKEN_PROGRAM_ID));
    expect([wsol.pre, wsol.post]).toEqual([0n, 0n]);
    expect(l.tx.closed()).toEqual([s.userBaseAta]);
    expect(l.tx.created()).toEqual([]);
    expectFeesAndTip(l, v);
    const refund = l.tx.lamports(s.userBaseAta).pre;
    expect(l.tx.lamports(tw.address).delta).toBe(x.quoteOutNet - l.tx.fee - v.tipLamports + refund);
    expectLoadedFromTable(l, nonce);
  }

  beforeAll(async () => {
    fork = await connectFork();
    operator = await newWallet(fork, 2n);
    tw = await createTradingWallet(fork, { sol: 20n, slotCount: 10 });
  });

  test("1. operator lookup table: created and extended from armedStaticAccounts (live Global and GlobalConfig), active before use", async () => {
    const [globalAcc, gcAcc] = await fetchRawAccounts(fork.rpc, [PUMP_GLOBAL, PUMP_AMM_GLOBAL_CONFIG]);
    if (!globalAcc || !gcAcc) throw new Error("pump Global / PumpSwap GlobalConfig missing on the fork");
    tableContents = await armedStaticAccounts({
      pumpGlobal: decodePumpGlobal(globalAcc.data),
      ammGlobalConfig: decodeAmmGlobalConfig(gcAcc.data),
    });
    assertShareableLookupTableContents(tableContents);
    const created = await createOperatorTable(fork, operator, tableContents);
    table = created.table;
    for (const l of created.landings) expect(l.tx.err).toBeNull();
    expect(created.state.addresses).toEqual(tableContents);
    expect(created.state.authority).toBe(operator.address);
    const slot = await fork.rpc.getSlot({ commitment: "confirmed" }).send();
    expect(lookupTableStatus(created.state, slot)).toBe("active");
    expect(usableLookupTableAddresses(created.state, slot)).toEqual(tableContents);
    // The operator pays the table's rent (the fork's rate), never the users.
    const len = LOOKUP_TABLE_META_SIZE + 32 * tableContents.length;
    expect(await accountDataLength(fork.rpc, table)).toBe(len);
    expect(await balanceOf(fork, table)).toBe(await forkRent(fork.rpc, len));
    tw.tables = toAddressesByLookupTable({ [table]: created.state });
    console.log(
      `  table ${table}: ${tableContents.length} shared addresses; ${created.landings.length} operator txs, ` +
        `CU ${created.landings.map((l) => l.tx.computeUnits).join("/")}; usable at slot ${created.usableSlot}, ` +
        `extension finalized ${(created.finalizedAfterMs / 1000).toFixed(1)} s later`,
    );
  });

  test("2. nonce slots: CreateAccountWithSeed + InitializeNonceAccount with the trading wallet as the only signer, through the shipped firewall", async () => {
    const before = await balanceOf(fork, tw.address);
    const { rent, landings } = await createNonceSlots(fork, tw);
    expect(rent).toBe(await forkRent(fork.rpc, NONCE_ACCOUNT_LENGTH));
    expect(rent).toBeLessThanOrEqual(tw.policy.caps.maxNonceAccountLamports ?? 0n);
    let paid = 0n;
    const created: Address[] = [];
    for (const l of landings) {
      expect(l.tx.err).toBeNull();
      expect(l.sizeBytes).toBeLessThanOrEqual(PACKET_DATA_SIZE);
      const slots = l.summary.actions.flatMap((a) => (a.kind === "nonce_create" ? [a] : []));
      for (const s of slots) expect(s.lamports).toBe(rent);
      expect([...l.tx.created()].sort()).toEqual(slots.map((s) => s.nonceAccount).sort());
      created.push(...slots.map((s) => s.nonceAccount));
      paid += l.tx.fee + rent * BigInt(slots.length);
    }
    expect(created).toEqual(tw.slots);
    expect(before - (await balanceOf(fork, tw.address))).toBe(paid);
    for (const [i, s] of (await fetchNonceSlots(fork.rpc, tw.slots)).entries()) {
      expect(s).not.toBeNull();
      expect(s?.account).toBe(tw.slots[i] as Address);
      expect(s?.authority).toBe(tw.address);
      expect(s?.lamports).toBe(rent);
    }
    // No stored keys: the slots derive from the wallet and an index alone.
    expect(tw.slots).toEqual(await nonceSlotAddresses(tw.address, tw.slots.length));
    expect(tw.audit.list().filter((e) => e.status === "refused")).toEqual([]);
    console.log(
      `  ${tw.slots.length} slots in ${landings.length} txs (${landings.map((l) => `${l.sizeBytes} B / ${l.tx.computeUnits} CU`).join(", ")}), rent ${rent} each`,
    );
  });

  test.skipIf(noCurve !== null)(
    withSkipReason(
      "3. take-profit on a curve coin: 3 x 2 grid on one nonce; the engine fires on fork state; fill exact and above min-out; nonce advanced; filled",
      noCurve,
    ),
    async () => {
      const mint = need(curveTarget, "curve2022").mint;
      const buy = await userTrade(fork, tw, {
        label: "armed setup: buy 0.1 SOL position (curve)",
        mint,
        side: "buy",
        amount: 100_000_000n,
      });
      const s0 = await curveState(fork, mint, tw.address);
      const position = s0.userBaseBalance;
      expect(position).toBe(buy.trade.quote.expectedOut);
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const threshold = bps(q0, 10_500n);
      const nonce = await nonceRef(fork, tw, 0);
      const template = await pumpSellTemplate(pumpContext(s0, tw.address), { amount: position, closeBaseAccount: true });
      const { result, ...cost } = await spendDelta(tw, () =>
        armOrder(
          {
            id: "tp-curve",
            kind: "take-profit",
            wallet: tw.address,
            mint,
            amount: position,
            fullExit: true,
            trigger: { type: "quote-at-least", threshold },
            templates: [template],
            minOuts: minOutGrid(threshold, [0, 100, 250]),
            tipLevels: TIP_LEVELS,
            nonces: [nonce],
            armingQuoteOut: q0,
            lookupTables: tw.tables,
          },
          armedSigner(tw),
        ),
      );
      let order = result;
      armedOrders.push(order);
      await expectAccepted(tw, [order], cost);
      expect(order.attempts[0]?.variants).toHaveLength(6);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: q0, venue: "pump", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });

      // Other traders lift the price past the target plus the engine's 1% safety margin.
      const market = await newWallet(fork, 100n);
      const { live } = await moveQuote(fork, market, mint, position, bps(threshold, 10_150n), "up");
      const s1 = await curveState(fork, mint, tw.address);
      expect(liveQuoteOut("sell", position, liveMarket(s1))).toBe(live);
      const decision = evaluateTrigger(order, {}, { liveQuoteOut: live, venue: "pump", nowMs: now() });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      expect(decision.attempt).toBe(0);
      expect(decision.variant.minOut).toBe(threshold); // the tightest min-out clears the margin
      expect(decision.variant.tipLevel).toBe(0);
      await expectPreSubmitChecks(fork, tw, order, position);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;
      expect(order.status).toBe("submitted");

      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed TP sell, curve (fires at +5%)",
        venue: "pump",
        side: "sell",
        mint,
        simulate: true,
      });
      expectCurveSellFill(fill, decision.variant, s1, position, live, nonce.account);
      await expectNonceAdvanced(fork, tw, nonce);
      const done = applyArmedOrderEvent(order, nonceConsumed(fill, nonce));
      expect(done.order.status).toBe("filled");
      expect(done.order.attempts[0]).toMatchObject({ status: "landed-ok", consumedBy: fill.signature });
      expect(done.effects).toEqual([
        { type: "notify", orderId: "tp-curve", kind: "filled", message: expect.stringContaining(decision.variant.id) },
      ]);

      // One landed attempt per nonce: another variant and the cancel can never land now.
      const sibling = at(order.attempts, 0).variants.find((v) => v.id !== decision.variant.id) as ArmedVariant;
      const refused = await expectDead(fork, tw, sibling.tx);
      await expectDead(fork, tw, at(order.attempts, 0).nonce.cancel);
      console.log(
        `  TP: quote ${q0} -> ${live} (target ${threshold}); filled ${live} >= min-out ${decision.variant.minOut}; ` +
          `${fill.tx.computeUnits} CU, ${decision.variant.tx.size} B; dead sibling refused at preflight: "${refused}"`,
      );
    },
  );

  test.skipIf(noCurve !== null)(
    withSkipReason(
      "4. OCO: a TP and an SL ladder share a nonce; the TP fills, the SL can never land, nonce-consumed burns it and fires its ladder cancel",
      noCurve,
    ),
    async () => {
      const mint = need(curveTarget, "curve2022").mint;
      await userTrade(fork, tw, { label: "armed setup: buy 0.1 SOL position (curve, OCO)", mint, side: "buy", amount: 100_000_000n });
      const s0 = await curveState(fork, mint, tw.address);
      const position = s0.userBaseBalance;
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const tpAt = bps(q0, 10_500n);
      const slAt = bps(q0, 9_500n);
      const shared = await nonceRef(fork, tw, 1);
      const extra = await nonceRef(fork, tw, 2);
      const ctx = pumpContext(s0, tw.address);
      const common = {
        wallet: tw.address,
        mint,
        amount: position,
        fullExit: true,
        tipLevels: TIP_LEVELS.slice(0, 1),
        armingQuoteOut: q0,
        lookupTables: tw.tables,
      };
      const tpTemplate = await pumpSellTemplate(ctx, { amount: position, closeBaseAccount: true });
      const slTemplate = await pumpSellTemplate(ctx, { amount: position, closeBaseAccount: true });
      const { result, ...cost } = await spendDelta(tw, () =>
        armOcoPair(
          {
            group: "oco-curve",
            nonce: shared,
            extraStopLossNonces: [extra],
            takeProfit: {
              ...common,
              id: "oco-tp",
              kind: "take-profit",
              trigger: { type: "quote-at-least", threshold: tpAt },
              templates: [tpTemplate],
              minOuts: minOutGrid(tpAt, [0, 100]),
            },
            stopLoss: {
              ...common,
              id: "oco-sl",
              kind: "stop-loss",
              trigger: { type: "quote-at-most", threshold: slAt },
              templates: [slTemplate],
              minOuts: minOutGrid(slAt, [0, 300, 600]),
            },
          },
          armedSigner(tw),
        ),
      );
      let [tp, sl] = result;
      armedOrders.push(tp, sl);
      await expectAccepted(tw, [tp, sl], cost);
      expect(validateUserArmedOrders([tp, sl])).toEqual([]);
      expect(exclusiveGroups([tp, sl])).toEqual([{ orders: [tp, sl], exclusive: true }]);
      expect(aggregateReservations([tp, sl]).tokens[mint]).toBe(position); // the position is reserved once
      expect(at(tp.attempts, 0).nonce.cancel).toEqual(at(sl.attempts, 0).nonce.cancel);
      expect(sl.attempts).toHaveLength(2);

      const market = await newWallet(fork, 100n);
      const { live } = await moveQuote(fork, market, mint, position, bps(tpAt, 10_150n), "up");
      const s1 = await curveState(fork, mint, tw.address);
      expect(evaluateTrigger(sl, {}, { liveQuoteOut: live, venue: "pump", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });
      const decision = evaluateTrigger(tp, {}, { liveQuoteOut: live, venue: "pump", nowMs: now() });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      await expectPreSubmitChecks(fork, tw, tp, position);
      tp = applyArmedOrderEvent(tp, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;
      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed OCO: TP sell, curve (fills)",
        venue: "pump",
        side: "sell",
        mint,
        simulate: true,
      });
      expectCurveSellFill(fill, decision.variant, s1, position, live, shared.account);
      await expectNonceAdvanced(fork, tw, shared);

      // The SL on the same nonce can never land: refused at preflight, and dropped without a fee when sent blind.
      const refused = await expectDead(fork, tw, at(at(sl.attempts, 0).variants, 0).tx);

      // The engine resolves which order consumed the nonce and dispatches the event to every order on it.
      const onNonce = signaturesOnNonce([tp, sl], shared.account, shared.value);
      expect(onNonce.find((s) => s.signature === fill.signature)).toMatchObject({ orderId: "oco-tp", kind: "variant", attempt: 0 });
      const tpDone = applyArmedOrderEvent(tp, nonceConsumed(fill, shared));
      expect(tpDone.order.status).toBe("filled");
      expect(tpDone.effects).toEqual([{ type: "notify", orderId: "oco-tp", kind: "filled", message: expect.any(String) }]);
      const slBurned = applyArmedOrderEvent(sl, nonceConsumed(fill, shared, "oco-tp"));
      expect(slBurned.order.status).toBe("cancelled");
      expect(slBurned.order.statusReason).toBe("OCO sibling oco-tp filled");
      expect(slBurned.order.attempts.map((a) => a.status)).toEqual(["burned", "cancelling"]);
      const ladderCancel = at(sl.attempts, 1).nonce.cancel;
      expect(slBurned.effects).toEqual([
        { type: "fire-cancel", orderId: "oco-sl", nonce: extra.account, cancel: ladderCancel },
        { type: "notify", orderId: "oco-sl", kind: "cancelled", message: "cancelled: OCO sibling oco-tp filled" },
      ]);

      // Execute the effect: the SL ladder's second nonce is burned by its pre-signed cancel.
      const fire = slBurned.effects[0];
      if (fire?.type !== "fire-cancel") throw new Error("expected a fire-cancel effect");
      const cancel = await submitArmed(fork, tw, fire.cancel, {
        label: "armed OCO: SL ladder cancel (fired by the status machine)",
        venue: "system",
        side: "cancel",
        mint,
      });
      expectCancelLanded(cancel, tw);
      await expectNonceAdvanced(fork, tw, extra);
      await expectDead(fork, tw, at(at(sl.attempts, 1).variants, 0).tx);
      const slDone = applyArmedOrderEvent(slBurned.order, nonceConsumed(cancel, extra));
      expect(slDone.order.status).toBe("cancelled");
      expect(slDone.order.attempts.map((a) => a.status)).toEqual(["burned", "burned"]);
      expect(slDone.effects).toEqual([]);
      console.log(`  OCO: TP filled ${live}; SL on the shared nonce refused: "${refused}"; ladder cancel ${cancel.tx.computeUnits} CU`);
    },
  );

  test.skipIf(noCurve !== null)(
    withSkipReason(
      "5. full-exit SL ladder over 3 nonces: attempt 1 lands and FAILS (nonce consumed, base + priority fee only, tip reverted), attempt 2 fills, attempt 3 fails harmlessly with no tokens left",
      noCurve,
    ),
    async () => {
      const mint = need(curveTarget, "curve2022").mint;
      const market = await newWallet(fork, 100n);
      const sm = await curveState(fork, mint, market.address);
      // The market holds tokens worth ~15% of the curve's quote, to dump twice later.
      await marketTrade(fork, market, mint, "buy", bps(sm.curve.virtualQuoteReserves, 1_500n));
      await userTrade(fork, tw, { label: "armed setup: buy 0.1 SOL position (curve, ladder)", mint, side: "buy", amount: 100_000_000n });
      const s0 = await curveState(fork, mint, tw.address);
      const position = s0.userBaseBalance;
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const slAt = bps(q0, 9_700n);
      const n1 = await nonceRef(fork, tw, 3);
      const n2 = await nonceRef(fork, tw, 4);
      const n3 = await nonceRef(fork, tw, 5);
      const nonces = [n1, n2, n3];
      const template = await pumpSellTemplate(pumpContext(s0, tw.address), { amount: position, closeBaseAccount: true });
      const { result, ...cost } = await spendDelta(tw, () =>
        armOrder(
          {
            id: "sl-ladder",
            kind: "stop-loss",
            wallet: tw.address,
            mint,
            amount: position,
            fullExit: true,
            trigger: { type: "quote-at-most", threshold: slAt },
            templates: [template],
            minOuts: minOutGrid(slAt, [0, 400, 800, 1200]),
            tipLevels: TIP_LEVELS,
            nonces,
            armingQuoteOut: q0,
            lookupTables: tw.tables,
          },
          armedSigner(tw),
        ),
      );
      let order = result;
      armedOrders.push(order);
      await expectAccepted(tw, [order], cost);
      expect(order.attempts.map((a) => a.variants.length)).toEqual([8, 8, 8]);
      // Reserved: two attempts may land and fail (base + max priority fee each), the third fills (+ its tip).
      const variants = order.attempts.flatMap((a) => a.variants);
      const maxPriority = variants.reduce((m, v) => (v.priorityFeeLamports > m ? v.priorityFeeLamports : m), 0n);
      const maxTip = variants.reduce((m, v) => (v.tipLamports > m ? v.tipLamports : m), 0n);
      expect(order.reservation).toEqual({ lamports: 3n * (LAMPORTS_PER_SIGNATURE + maxPriority) + maxTip, mint, tokens: position });

      // The market dumps below the stop: the engine picks attempt 1's variant just under the live quote...
      const t1 = await moveQuote(fork, market, mint, position, bps(q0, 9_600n), "down");
      const d1 = evaluateTrigger(order, {}, { liveQuoteOut: t1.live, venue: "pump", nowMs: now() });
      if (!d1.fire) throw new Error(`the engine held: ${d1.reason}`);
      expect(d1.attempt).toBe(0);
      await expectPreSubmitChecks(fork, tw, order, position);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: d1.variant.id }).order;
      // ...and dumps again before it lands, so the chosen min-out is out of reach.
      const t2 = await moveQuote(fork, market, mint, position, bps(d1.variant.minOut, 9_500n), "down");
      expect(t2.live).toBeLessThan(d1.variant.minOut);
      const failed = await submitArmed(fork, tw, d1.variant.tx, {
        label: "armed SL ladder attempt 1: lands and FAILS (min-out out of reach)",
        venue: "pump",
        side: "sell",
        mint,
      });
      expect(failed.confirm.status).toBe("failed");
      expect(instructionError(failed.tx.err)).toEqual({ index: 3, custom: 6003 }); // sell_v2: TooLittleSolReceived
      expectFeesAndTip(failed, d1.variant); // base + priority fee; the tip transfer reverted with the trade
      expect(failed.tx.lamports(tw.address).delta).toBe(-(LAMPORTS_PER_SIGNATURE + d1.variant.priorityFeeLamports));
      expect(await tokenBalance(fork, s0.userBaseAta)).toBe(position);
      await expectNonceAdvanced(fork, tw, n1);
      await expectDead(fork, tw, at(order.attempts, 0).nonce.cancel);
      const afterFail = applyArmedOrderEvent(order, nonceConsumed(failed, n1));
      expect(afterFail.order.status).toBe("armed");
      expect(afterFail.order.attempts.map((a) => a.status)).toEqual(["landed-failed", "live", "live"]);
      expect(afterFail.effects).toEqual([{ type: "notify", orderId: "sl-ladder", kind: "ladder-continues", message: expect.any(String) }]);
      order = afterFail.order;

      // Attempt 2 picks a variant under the new quote and fills.
      const s2 = await curveState(fork, mint, tw.address);
      const live2 = mustQuote(liveQuoteOut("sell", position, liveMarket(s2)));
      expect(live2).toBe(t2.live);
      const d2 = evaluateTrigger(order, {}, { liveQuoteOut: live2, venue: "pump", nowMs: now() });
      if (!d2.fire) throw new Error(`the engine held: ${d2.reason}`);
      expect(d2.attempt).toBe(1);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 1, variantId: d2.variant.id }).order;
      const fill = await submitArmed(fork, tw, d2.variant.tx, {
        label: "armed SL ladder attempt 2: fills",
        venue: "pump",
        side: "sell",
        mint,
        simulate: true,
      });
      expectCurveSellFill(fill, d2.variant, s2, position, live2, n2.account);
      await expectNonceAdvanced(fork, tw, n2);
      const filled = applyArmedOrderEvent(order, nonceConsumed(fill, n2));
      expect(filled.order.status).toBe("filled");
      expect(filled.order.attempts.map((a) => a.status)).toEqual(["landed-failed", "landed-ok", "cancelling"]);
      expect(filled.effects).toEqual([
        { type: "fire-cancel", orderId: "sl-ladder", nonce: n3.account, cancel: at(order.attempts, 2).nonce.cancel },
        { type: "notify", orderId: "sl-ladder", kind: "filled", message: expect.any(String) },
      ]);

      // Attempt 3 lands anyway (a leaked copy, or the engine racing its own cancel). Nothing is left to sell and
      // the account is closed, so it fails harmlessly: base + priority fee, tip reverted, and its nonce is spent.
      const v3 = at(at(order.attempts, 2).variants, 0);
      const third = await submitArmed(fork, tw, v3.tx, {
        label: "armed SL ladder attempt 3: lands after the fill, fails harmlessly",
        venue: "pump",
        side: "sell",
        mint,
      });
      expect(third.confirm.status).toBe("failed");
      const thirdErr = instructionError(third.tx.err);
      // sell_v2 fails with Anchor's AccountNotInitialized: the fill closed the user's token account.
      expect(thirdErr).toEqual({ index: 3, custom: 3012 });
      expectFeesAndTip(third, v3);
      expect(third.tx.lamports(tw.address).delta).toBe(-(LAMPORTS_PER_SIGNATURE + v3.priorityFeeLamports));
      expect(await tokenBalance(fork, s0.userBaseAta)).toBeNull();
      await expectNonceAdvanced(fork, tw, n3);
      await expectDead(fork, tw, at(order.attempts, 2).nonce.cancel);
      const done = applyArmedOrderEvent(filled.order, nonceConsumed(third, n3));
      expect(done.order.status).toBe("filled");
      expect(done.order.attempts.map((a) => a.status)).toEqual(["landed-failed", "landed-ok", "landed-failed"]);
      expect(done.effects).toEqual([]);
      console.log(
        `  ladder: stop ${slAt}; attempt 1 min-out ${d1.variant.minOut} vs fill ${t2.live} -> error 6003 at #3, fee ${failed.tx.fee} ` +
          `(${failed.tx.computeUnits} CU); attempt 2 filled ${live2} >= ${d2.variant.minOut}; attempt 3 -> error 3012 at #3, ` +
          `fee ${third.tx.fee} (${third.tx.computeUnits} CU)`,
      );
    },
  );

  test.skipIf(noCurve !== null)(
    withSkipReason(
      "6. cancel: the pre-signed cancel advances the nonce and every variant of a 3-variant limit buy becomes invalid",
      noCurve,
    ),
    async () => {
      const mint = need(curveTarget, "curve2022").mint;
      const s0 = await curveState(fork, mint, tw.address);
      const spend = 50_000_000n;
      const tokensNow = mustQuote(liveQuoteOut("buy", spend, liveMarket(s0)));
      const threshold = bps(tokensNow, 11_000n);
      const nonce = await nonceRef(fork, tw, 6);
      const template = await pumpBuyTemplate(pumpContext(s0, tw.address), { spend });
      const { result: order, ...cost } = await spendDelta(tw, () =>
        armOrder(
          {
            id: "limit-buy",
            kind: "limit-buy",
            wallet: tw.address,
            mint,
            amount: spend,
            trigger: { type: "quote-at-least", threshold },
            templates: [template],
            minOuts: minOutGrid(threshold, [0, 200, 400]),
            tipLevels: TIP_LEVELS.slice(0, 1),
            nonces: [nonce],
            armingQuoteOut: tokensNow,
            lookupTables: tw.tables,
          },
          armedSigner(tw),
        ),
      );
      armedOrders.push(order);
      await expectAccepted(tw, [order], cost);
      // Every signed buy variant counts in full against the signer's daily buy cap.
      expect(cost.buyLamports).toBe(3n * spend);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: tokensNow, venue: "pump", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });

      const { order: cancelled, effects } = applyArmedOrderEvent(order, { type: "cancel-requested", reason: "user cancel" });
      expect(cancelled.status).toBe("cancelled");
      expect(effects).toEqual([
        { type: "fire-cancel", orderId: "limit-buy", nonce: nonce.account, cancel: at(order.attempts, 0).nonce.cancel },
        { type: "notify", orderId: "limit-buy", kind: "cancelled", message: "cancelled: user cancel" },
      ]);
      const fire = effects[0];
      if (fire?.type !== "fire-cancel") throw new Error("expected a fire-cancel effect");
      const landed = await submitArmed(fork, tw, fire.cancel, {
        label: "armed cancel (nonce advance only)",
        venue: "system",
        side: "cancel",
        mint,
      });
      expectCancelLanded(landed, tw);
      await expectNonceAdvanced(fork, tw, nonce);
      const refused: string[] = [];
      for (const v of at(order.attempts, 0).variants) refused.push(await expectDead(fork, tw, v.tx));
      expect(refused).toHaveLength(3);
      const done = applyArmedOrderEvent(cancelled, nonceConsumed(landed, nonce));
      expect(done.order.status).toBe("cancelled");
      expect(done.order.attempts[0]).toMatchObject({ status: "burned", consumedBy: landed.signature });
      expect(done.effects).toEqual([]);
      console.log(
        `  cancel: ${landed.tx.computeUnits} CU, fee ${landed.tx.fee}, ${fire.cancel.size} B; 3 variants refused: "${refused[0]}"`,
      );
    },
  );

  test.skipIf(noPool !== null)(
    withSkipReason(
      "7. PumpSwap stop-loss on the canonical pool: grid on one nonce; fires on fork state; fill exact and above min-out; nonce advanced; filled",
      noPool,
    ),
    async () => {
      const mint = need(poolTarget, "pumpswap").mint;
      const sm = await poolState(fork, mint, tw.address);
      // The market holds tokens bought with ~3% of the pool's effective quote, to sell later.
      const marketBuy = bps(sm.reserves.quoteVaultReserve + sm.reserves.virtualQuoteReserves, 300n);
      const market = await newWallet(fork, marketBuy / 1_000_000_000n + 10n);
      await marketTrade(fork, market, mint, "buy", marketBuy);
      await userTrade(fork, tw, { label: "armed setup: buy 0.1 SOL position (PumpSwap)", mint, side: "buy", amount: 100_000_000n });
      const s0 = await poolState(fork, mint, tw.address);
      expect(s0.isCanonical).toBe(true);
      const position = s0.userBaseBalance;
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const slAt = bps(q0, 9_850n);
      const nonce = await nonceRef(fork, tw, 7);
      const template = await ammSellTemplate(ammContext(s0, tw.address), { amount: position, closeBaseAccount: true });
      const { result, ...cost } = await spendDelta(tw, () =>
        armOrder(
          {
            id: "sl-pumpswap",
            kind: "stop-loss",
            wallet: tw.address,
            mint,
            amount: position,
            fullExit: true,
            trigger: { type: "quote-at-most", threshold: slAt },
            templates: [template],
            minOuts: minOutGrid(slAt, [0, 300, 600, 1000]),
            tipLevels: TIP_LEVELS,
            nonces: [nonce],
            armingQuoteOut: q0,
            lookupTables: tw.tables,
          },
          armedSigner(tw),
        ),
      );
      let order = result;
      armedOrders.push(order);
      await expectAccepted(tw, [order], cost);
      expect(order.frozen.venues).toMatchObject([{ venue: "pumpswap", market: s0.poolAddress, creator: s0.pool.coinCreator }]);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: q0, venue: "pumpswap", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });

      const { live } = await moveQuote(fork, market, mint, position, bps(q0, 9_750n), "down");
      const s1 = await poolState(fork, mint, tw.address);
      expect(liveQuoteOut("sell", position, liveMarket(s1))).toBe(live);
      const decision = evaluateTrigger(order, {}, { liveQuoteOut: live, venue: "pumpswap", nowMs: now() });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      expect(decision.variant.minOut * 10_000n).toBeLessThanOrEqual(live * 9_900n);
      await expectPreSubmitChecks(fork, tw, order, position);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;
      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed SL sell, PumpSwap (fires at -1.5%)",
        venue: "pumpswap",
        side: "sell",
        mint,
        simulate: true,
      });
      await expectAmmSellFill(fill, decision.variant, s1, position, live, nonce.account);
      await expectNonceAdvanced(fork, tw, nonce);
      const done = applyArmedOrderEvent(order, nonceConsumed(fill, nonce));
      expect(done.order.status).toBe("filled");
      expect(done.order.attempts[0]).toMatchObject({ status: "landed-ok", consumedBy: fill.signature });
      console.log(
        `  PumpSwap SL: quote ${q0} -> ${live} (stop ${slAt}); filled ${live} >= min-out ${decision.variant.minOut}; ` +
          `${fill.tx.computeUnits} CU, ${decision.variant.tx.size} B`,
      );
    },
  );

  test.skipIf(migrationSkip !== "")(
    withSkipReason(
      "8. migration snipe: armed before graduation; the market completes the curve and anyone migrates; the buy lands on the deterministic canonical pool",
      migrationSkip,
    ),
    async () => {
      const mint = (migrationTarget as ForkTarget).mint;
      const s0 = await curveState(fork, mint, tw.address);
      const [gcAcc, feeAcc] = await fetchRawAccounts(fork.rpc, [PUMP_AMM_GLOBAL_CONFIG, PUMP_AMM_FEE_CONFIG]);
      if (!gcAcc) throw new Error("PumpSwap GlobalConfig missing on the fork");
      const globalConfig = decodeAmmGlobalConfig(gcAcc.data);
      // Centre the grid on the expected opening pool: the curve's terminal reserves less the migration fee. The
      // boost (taken from the fork's live canonical pool) only splits that quote into real and virtual.
      const boost = poolTarget ? (await poolState(fork, poolTarget.mint, tw.address)).reserves.virtualQuoteReserves : 0n;
      const estimate = estimateMigrationPoolReserves(s0.curve, s0.global, boost);
      const spend = 100_000_000n;
      const expectedPool: LiveMarketState = {
        venue: "pumpswap",
        pool: {
          quoteMint: WSOL_MINT,
          isMayhemMode: s0.curve.isMayhemMode,
          coinCreator: s0.curve.creator,
          creatorFeeBps: s0.curve.creatorFeeBps,
        },
        reserves: estimate,
        isCanonical: true,
        baseMintSupply: s0.mintInfo.supply,
        feeConfig: feeAcc ? decodeFeeConfig(feeAcc.data) : null,
        globalConfig,
      };
      const armingQuoteOut = mustQuote(liveQuoteOut("buy", spend, expectedPool));
      const nonce = await nonceRef(fork, tw, 8);
      const { result, ...cost } = await spendDelta(tw, () =>
        armMigrationSnipe(
          {
            id: "migration-snipe",
            wallet: tw.address,
            mint,
            amount: spend,
            minOuts: minOutGrid(armingQuoteOut, [200, 700, 1500]),
            tipLevels: TIP_LEVELS.slice(0, 1),
            nonces: [nonce],
            armingQuoteOut,
            lookupTables: tw.tables,
            pool: { curve: s0.curve, baseTokenProgram: s0.mintInfo.tokenProgram, globalConfig },
          },
          armedSigner(tw),
        ),
      );
      let order = result;
      armedOrders.push(order);
      await expectAccepted(tw, [order], cost);
      expect(cost.buyLamports).toBe(3n * spend);
      const pool = await canonicalPoolPda(mint);
      expect(order.frozen.venues).toMatchObject([{ venue: "pumpswap", market: pool, creator: s0.curve.creator }]);
      expect(await fetchRawAccounts(fork.rpc, [pool])).toEqual([null]); // signed against a pool that does not exist yet
      expect(evaluateTrigger(order, {}, { liveQuoteOut: null, venue: "pump", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "no-quote",
      });
      expect(detectStaleness(order, await observe(fork, tw, order))).toEqual([]);

      // Other traders buy out the curve. Complete but not migrated: still nothing to quote, so the engine holds
      // (a submission now would land, fail and burn the nonce).
      const market = await newWallet(fork, 150n);
      await completeCurve(fork, market, mint);
      expect(await curveStillActive(fork, s0.curveAddress)).toBe(false);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: null, venue: "pumpswap", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "no-quote",
      });

      // Anyone can migrate.
      const migration = await plainTx(
        fork,
        market,
        [
          await migrateInstruction({
            mint,
            user: market.address,
            withdrawAuthority: s0.global.withdrawAuthority,
            baseTokenProgram: s0.mintInfo.tokenProgram,
          }),
        ],
        { label: "market: pump migrate (permissionless)", venue: "pump", side: "migrate", mint, cuLimit: 1_000_000, record: true },
      );
      const migrated = migration.tx.events.find((e): e is PumpMigrationEvent => e.kind === "pumpMigrate");
      expect(migrated?.pool).toBe(pool);
      expect(migrated?.mint).toBe(mint);
      expect(migration.tx.events.some((e) => e.kind === "ammCreatePool")).toBe(true);
      const events = migration.tx.events.flatMap((e) => {
        const m = marketEventFromDecoded(e, { slot: migration.tx.slot });
        return m ? [m] : [];
      });
      expect(events).toContainEqual({ type: "migration", mint, pool, slot: migration.tx.slot });

      const s1 = await poolState(fork, mint, tw.address);
      expect(s1.poolAddress).toBe(pool);
      expect(s1.isCanonical).toBe(true);
      expect(s1.pool.coinCreator).toBe(s0.curve.creator);
      // The opening pool is what the curve sold out to: base exact, effective quote (real + boost) exact.
      expect(s1.reserves.baseReserve).toBe(estimate.baseReserve);
      expect(migrated?.mintAmount).toBe(s1.reserves.baseReserve);
      expect(effectiveQuoteReserve(s1.reserves)).toBe(effectiveQuoteReserve(estimate));
      expect(s1.reserves.virtualQuoteReserves).toBeGreaterThan(0n);
      const ctx = await migrationPoolContext({
        mint,
        curve: s0.curve,
        baseTokenProgram: s0.mintInfo.tokenProgram,
        user: tw.address,
        globalConfig,
      });
      expect([s1.pool.poolBaseTokenAccount, s1.pool.poolQuoteTokenAccount]).toEqual([
        ctx.pool.poolBaseTokenAccount,
        ctx.pool.poolQuoteTokenAccount,
      ]);
      const live = mustQuote(liveQuoteOut("buy", spend, liveMarket(s1)));
      expect(live).toBe(armingQuoteOut); // the snipe was armed at exactly the quote it fires at
      const decision = evaluateTrigger(order, {}, { liveQuoteOut: live, venue: "pumpswap", nowMs: now(), events });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      expect(decision.state.migrated).toBe(true);
      await expectPreSubmitChecks(fork, tw, order, 0n);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;

      // Accounts the first buy may create at the buyer's expense (whatever does not exist yet).
      const creatorAta = await findAssociatedTokenAddress(
        await coinCreatorVaultAuthorityPda(s1.pool.coinCreator),
        WSOL_MINT,
        TOKEN_PROGRAM_ID,
      );
      const candidates = [s1.userBaseAta, await ammUserVolumeAccumulatorPda(tw.address), creatorAta];
      const existing = await fetchRawAccounts(fork.rpc, candidates);
      const expectCreated = candidates.filter((_, i) => !existing[i]);

      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed migration snipe: PumpSwap buy on the new canonical pool",
        venue: "pumpswap",
        side: "buy",
        mint,
        simulate: true,
      });
      expect(fill.confirm.status).toBe("confirmed");
      expect(fill.tx.err).toBeNull();
      const rates = ammFeeRates({
        pool: s1.pool,
        isCanonical: s1.isCanonical,
        reserves: s1.reserves,
        baseMintSupply: s1.mintInfo.supply,
        feeConfig: s1.feeConfig,
        globalConfig: s1.globalConfig,
      });
      const x = quoteAmmBuyExactQuoteIn(s1.reserves, spend, rates);
      expect(x.baseOut).toBe(live);
      expect(signedTrade(decision.variant, tw.tables)).toEqual({ amount: spend, limit: decision.variant.minOut });
      expect(x.baseOut).toBeGreaterThanOrEqual(decision.variant.minOut);
      const ev = fill.tx.events.find((e): e is AmmSwapEvent => e.kind === "ammBuy");
      if (!ev) throw new Error("no BuyEvent");
      expect(ev.pool).toBe(pool);
      expect(ev.user).toBe(tw.address);
      expect(ev.baseAmount).toBe(x.baseOut);
      // buy_exact_quote_in: quote_amount_in = total paid incl. fees, user_quote_amount_in = pre-fee quote (FORK_TESTING finding 3).
      expect(ev.quoteAmount).toBe(x.totalQuote);
      expect(ev.userQuoteAmount).toBe(x.quoteIn);
      expect(fill.tx.tokens(s1.userBaseAta).delta).toBe(x.baseOut);
      expect(fill.tx.tokens(s1.pool.poolBaseTokenAccount).delta).toBe(-x.baseOut);
      expect(fill.tx.tokens(s1.pool.poolQuoteTokenAccount).delta).toBe(x.quoteIn + x.lpFee);
      const wsol = fill.tx.lamports(await findAssociatedTokenAddress(tw.address, WSOL_MINT, TOKEN_PROGRAM_ID));
      expect([wsol.pre, wsol.post]).toEqual([0n, 0n]);
      expect([...fill.tx.created()].sort()).toEqual([...expectCreated].sort());
      // The buyer pays the rent of every account the buy creates. A brand-new coin's creator vault wSOL ATA is
      // one of them, and it is credited the creator fee in the same transaction (wSOL lamports = rent + amount).
      let createdRent = 0n;
      for (const a of expectCreated) {
        const rent = await forkRent(fork.rpc, (await accountDataLength(fork.rpc, a)) as number);
        const credited = a === creatorAta ? x.creatorFee : 0n;
        expect(fill.tx.lamports(a).post).toBe(rent + credited);
        createdRent += rent;
      }
      expect(fill.tx.tokens(creatorAta).delta).toBe(x.creatorFee);
      expectFeesAndTip(fill, decision.variant);
      expect(fill.tx.lamports(tw.address).delta).toBe(-(x.totalQuote + fill.tx.fee + decision.variant.tipLamports + createdRent));
      expectLoadedFromTable(fill, nonce.account);
      await expectNonceAdvanced(fork, tw, nonce);
      const done = applyArmedOrderEvent(order, nonceConsumed(fill, nonce));
      expect(done.order.status).toBe("filled");
      console.log(
        `  snipe: armed for ${armingQuoteOut} tokens, fired at ${live}; pool opened at ${s1.reserves.baseReserve} base / ` +
          `${s1.reserves.quoteVaultReserve} real + ${s1.reserves.virtualQuoteReserves} virtual quote (migration event: ` +
          `${migrated?.mintAmount} tokens, ${migrated?.solAmount} lamports, fee ${migrated?.poolMigrationFee}); migrate ${migration.tx.computeUnits} CU; ` +
          `snipe ${fill.tx.computeUnits} CU, ${decision.variant.tx.size} B, created ${expectCreated.length} account(s) ` +
          `(rent ${createdRent}${expectCreated.includes(creatorAta) ? ", incl. the coin creator vault wSOL ATA" : ""})`,
      );
    },
  );

  test.skipIf(noOrders !== null)(
    withSkipReason("9. sizes: every armed transaction (variants and cancels) fits in 1,232 bytes with the operator table", noOrders),
    () => {
      expect(armedOrders.length).toBeGreaterThan(0);
      const rows = new Map<string, { n: number; max: number; maxWithout: number }>();
      const cancels = new Map<string, number>();
      for (const o of armedOrders) {
        for (const a of o.attempts) {
          for (const v of a.variants) {
            const insp = inspectArmedTransaction(v.tx.wireBase64, tw.tables);
            expect(insp.size).toBe(v.tx.size);
            expect(v.tx.size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
            expect(insp.version).toBe(0);
            expect(insp.lookupTables).toEqual([table]);
            expect(insp.nonce).toEqual({ account: a.nonce.account, authority: tw.address, accountIsStatic: true, accountIsWritable: true });
            const key = `${o.side} ${v.venue}${o.fullExit ? " + close" : ""}`;
            const row = rows.get(key) ?? { n: 0, max: 0, maxWithout: 0 };
            const without = sizeWithoutTables(v.tx, tw.tables);
            rows.set(key, { n: row.n + 1, max: Math.max(row.max, v.tx.size), maxWithout: Math.max(row.maxWithout, without) });
          }
          const c = a.nonce.cancel;
          expect(c.size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
          expect(inspectArmedTransaction(c.wireBase64).lookupTables).toEqual([]);
          cancels.set(c.signature, c.size);
        }
      }
      // Everything the trading wallet signed this run went through SignerService and its firewall; nothing was refused.
      const audit = tw.audit.list();
      expect(audit.filter((e) => e.status === "refused")).toEqual([]);
      expect(audit.length).toBeGreaterThanOrEqual([...rows.values()].reduce((s, r) => s + r.n, 0) + cancels.size);
      console.log(`  signer: ${audit.length} transactions signed through SignerService (shipped policy), 0 refused`);
      const lines = [...rows].map(
        ([k, r]) => `    ${k.padEnd(26)} ${String(r.n).padStart(3)} variants, max ${r.max} B with the table (${r.maxWithout} B without)`,
      );
      const cancelSizes = [...new Set(cancels.values())].join("/");
      console.log(
        `  ${[...rows.values()].reduce((s, r) => s + r.n, 0)} variants + ${cancels.size} cancels (${cancelSizes} B), all <= ${PACKET_DATA_SIZE} B:\n${lines.join("\n")}`,
      );
    },
  );
});
