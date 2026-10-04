/**
 * Raydium LaunchLab and CPMM on the local mainnet fork (`bun run fork:start`, then `bun run e2e`): real
 * program binaries and cloned mainnet pools.
 *  - trades exactly as the CLI builds them (buy with wSOL wrap + ATA, partial sell, full exit + close), each
 *    filling the local quote to the unit;
 *  - armed orders: a LaunchLab take-profit and a CPMM stop-loss, signed through SignerService with the shipped
 *    policy, loading the operator lookup table, fired by the trigger engine on fork state, landing above
 *    their min-out and advancing their nonce.
 * Each venue is skipped, with the reason, when fork:start found no target for it. The LaunchLab -> CPMM
 * migration snipe has no fork case: `migrate_to_cpswap` is signed by Raydium's migration wallet.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { Address } from "@solana/kit";
import type { ForkTarget } from "../scripts/fork/env";
import {
  type ArmedOrder,
  type ArmedVariant,
  applyArmedOrderEvent,
  armedOrderFromJson,
  armedOrderToJson,
  armedStaticAccounts,
  armOrder,
  assertArmable,
  type CpmmState,
  type CpmmSwapEvent,
  cpmmFeeRates,
  cpmmSellTemplate,
  currentInterfaceVersion,
  decodeAmmGlobalConfig,
  decodePumpGlobal,
  decodeTokenAccount,
  detectStaleness,
  evaluateTrigger,
  fetchLookupTables,
  fetchNonceSlots,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  hasReservedBalance,
  JITO_TIP_ACCOUNTS_FALLBACK,
  jitoTipLevels,
  LAMPORTS_PER_SIGNATURE,
  type LaunchLabState,
  type LaunchLabTradeEvent,
  launchLabSellTemplate,
  launchLabTradeParams,
  liveQuoteOut,
  loadTokenState,
  minOutGrid,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_GLOBAL,
  quoteCpmmSwapBaseInput,
  quoteLaunchLabSellExactIn,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  type StalenessObservation,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  toAddressesByLookupTable,
  WSOL_MINT,
} from "../src";
import {
  ARMED_TIP_LEVELS,
  armedSigner,
  balanceOf,
  createNonceSlots,
  createOperatorTable,
  createTradingWallet,
  expectNonceAdvanced,
  type Landing,
  liveMarket,
  marketTrade,
  moveQuote,
  nonceConsumed,
  nonceRef,
  submitArmed,
  type TradingWallet,
  userTrade,
} from "./armedKit";
import {
  connectFork,
  type Fork,
  missingTarget,
  newWallet,
  runTrade,
  type TradeRun,
  targetOf,
  type Wallet,
  withSkipReason,
} from "./harness";

const TIP_LEVELS = jitoTipLevels(ARMED_TIP_LEVELS);
const bps = (v: bigint, b: bigint) => (v * b) / 10_000n;
const now = () => Date.now();

const noLaunchLab = missingTarget("launchlab");
const noCpmm = missingTarget("cpmm");
const noRaydium = noLaunchLab && noCpmm ? "the fork has no launchlab or cpmm target" : null;

function mustQuote(q: bigint | null): bigint {
  if (q === null) throw new Error("the venue cannot quote this amount");
  return q;
}

async function launchLabState(fork: Fork, mint: Address, user: Address): Promise<LaunchLabState> {
  const s = await loadTokenState(fork.rpc, { mint, user });
  if (s.venue !== "launchlab") throw new Error(`${mint} is not on its LaunchLab curve (${s.venue})`);
  return s;
}

async function cpmmState(fork: Fork, mint: Address, user: Address): Promise<CpmmState> {
  const s = await loadTokenState(fork.rpc, { mint, user });
  if (s.venue !== "cpmm") throw new Error(`${mint} is not on CPMM (${s.venue})`);
  return s;
}

/** Lamports the payer put into accounts this transaction created (base ATAs, LaunchLab fee vaults). */
const rentCreated = (tx: TradeRun["tx"]) => tx.created().reduce((s, a) => s + tx.lamports(a).post, 0n);
/** Rent refunded by accounts this transaction closed (the base ATA on a full exit). */
const rentClosed = (tx: TradeRun["tx"]) => tx.closed().reduce((s, a) => s + tx.lamports(a).pre, 0n);

/** A CLI trade on a Raydium venue: the venue's own event, the user's tokens and SOL, all to the unit. */
function expectRaydiumTrade(run: TradeRun): void {
  expect(run.confirm.status).toBe("confirmed");
  expect(run.tx.err).toBeNull();
  const q = run.trade.quote;
  const expected = q.expectedEvent;
  if (!expected) throw new Error(`${run.label}: no expected event`);
  if (run.state.venue === "launchlab") {
    const ev = run.tx.events.find((e): e is LaunchLabTradeEvent => e.kind === "launchlabTrade");
    if (!ev) throw new Error(`${run.label}: no LaunchLab TradeEvent`);
    expect(ev.pool).toBe((run.state as LaunchLabState).poolAddress);
    expect(ev.isBuy).toBe(q.side === "buy");
    expect([ev.amountIn, ev.amountOut]).toEqual([expected.amountIn, expected.amountOut]);
    expect(ev.shareFee).toBe(0n);
  } else {
    const ev = run.tx.events.find((e): e is CpmmSwapEvent => e.kind === "cpmmSwap");
    if (!ev) throw new Error(`${run.label}: no CPMM SwapEvent`);
    expect(ev.pool).toBe((run.state as CpmmState).poolAddress);
    expect(ev.baseInput).toBe(true);
    expect(ev.inputMint).toBe(q.side === "buy" ? WSOL_MINT : run.state.mint);
    expect([ev.inputAmount, ev.outputAmount]).toEqual([expected.amountIn, expected.amountOut]);
  }
  const ata = run.state.userBaseAta;
  expect(run.tx.tokens(ata).delta).toBe(q.side === "buy" ? q.expectedOut : -q.amountIn);
  const tips = run.plan.tips.reduce((s, t) => s + t.lamports, 0n);
  const sol = run.tx.lamports(run.wallet.address).delta;
  const flow = q.side === "buy" ? -q.amountIn : q.expectedOut;
  expect(sol).toBe(flow - run.tx.fee - tips - rentCreated(run.tx) + rentClosed(run.tx));
}

/** A filled armed full-exit sell: the quote it fired on is what the program paid, above the variant's min-out. */
function expectArmedSell(l: Landing, v: ArmedVariant, tw: TradingWallet, live: bigint, closed: Address[]): void {
  expect(l.confirm.status).toBe("confirmed");
  expect(l.tx.err).toBeNull();
  expect(live).toBeGreaterThanOrEqual(v.minOut);
  expect(l.tx.fee).toBe(LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports);
  const tip = l.tx.keys.find((k) => JITO_TIP_ACCOUNTS_FALLBACK.includes(k)) as Address;
  expect(l.tx.lamports(tip).delta).toBe(v.tipLamports);
  expect(l.tx.closed()).toEqual(closed);
  expect(l.tx.lamports(tw.address).delta).toBe(live - l.tx.fee - v.tipLamports - rentCreated(l.tx) + rentClosed(l.tx));
  // Only the sysvar and shared configs load from the operator table; everything the firewall pins stays static.
  const loaded = [...l.tx.loaded.writable, ...l.tx.loaded.readonly];
  expect(loaded).toContain(SYSVAR_RECENT_BLOCKHASHES_ID);
  for (const a of loaded) expect(Object.values(tw.tables).flat()).toContain(a);
}

describe.skipIf(noRaydium !== null)(withSkipReason("Raydium LaunchLab and CPMM on the mainnet fork", noRaydium), () => {
  let fork: Fork;
  let trader: Wallet;
  let tw: TradingWallet;

  /** What the server would observe for a Raydium order right now (detectStaleness). */
  async function observe(order: ArmedOrder, s: LaunchLabState | CpmmState): Promise<StalenessObservation> {
    const slots = order.attempts.map((a) => a.nonce.account);
    const snaps = await fetchNonceSlots(fork.rpc, slots);
    const ata = await findAssociatedTokenAddress(tw.address, order.mint, order.frozen.baseTokenProgram);
    const [ataAcc] = await fetchRawAccounts(fork.rpc, [ata]);
    return {
      ...(s.venue === "launchlab" ? { launchLabPool: { creator: s.pool.creator, status: s.pool.status } } : {}),
      nonces: Object.fromEntries(slots.map((a, i) => [a, snaps[i] ?? null])),
      lookupTables: await fetchLookupTables(fork.rpc, order.frozen.lookupTables),
      currentSlot: await fork.rpc.getSlot({ commitment: "confirmed" }).send(),
      interfaceVersion: currentInterfaceVersion(),
      jitoTipAccounts: JITO_TIP_ACCOUNTS_FALLBACK,
      walletTokenBalance: ataAcc ? decodeTokenAccount(ataAcc.data).amount : 0n,
    };
  }

  async function arm(spec: Parameters<typeof armOrder>[0]): Promise<ArmedOrder> {
    const order = await armOrder(spec, armedSigner(tw));
    await assertArmable(order, { lookupTables: tw.tables });
    expect(armedOrderFromJson(armedOrderToJson(order))).toEqual(order);
    return order;
  }

  beforeAll(async () => {
    fork = await connectFork();
    trader = await newWallet(fork, 2n);
    const operator = await newWallet(fork, 2n);
    tw = await createTradingWallet(fork, { sol: 5n, slotCount: 2 });
    const [globalAcc, gcAcc] = await fetchRawAccounts(fork.rpc, [PUMP_GLOBAL, PUMP_AMM_GLOBAL_CONFIG]);
    if (!globalAcc || !gcAcc) throw new Error("pump Global / PumpSwap GlobalConfig missing on the fork");
    const contents = await armedStaticAccounts({
      pumpGlobal: decodePumpGlobal(globalAcc.data),
      ammGlobalConfig: decodeAmmGlobalConfig(gcAcc.data),
    });
    const created = await createOperatorTable(fork, operator, contents);
    tw.tables = toAddressesByLookupTable({ [created.table]: created.state });
    await createNonceSlots(fork, tw);
  });

  test.skipIf(noLaunchLab !== null)(
    withSkipReason("LaunchLab: buy 0.01 SOL (wSOL wrap + ATA), sell 50%, full exit + close; each fills the local quote", noLaunchLab),
    async () => {
      const t = targetOf("launchlab") as ForkTarget;
      const buy = await runTrade(fork, trader, { label: "LaunchLab buy 0.01 SOL (wSOL wrap)", mint: t.mint, side: "buy", sol: "0.01" });
      expect(buy.state.venue).toBe("launchlab");
      expect(buy.trade.instructions.some((i) => i.programAddress === RAYDIUM_LAUNCHLAB_PROGRAM_ID)).toBe(true);
      expect(buy.tx.created()).toContain(buy.state.userBaseAta);
      expectRaydiumTrade(buy);
      const half = await runTrade(fork, trader, { label: "LaunchLab sell 50%", mint: t.mint, side: "sell", percent: "50" });
      expectRaydiumTrade(half);
      const exit = await runTrade(fork, trader, { label: "LaunchLab full exit + close", mint: t.mint, side: "sell", percent: "100" });
      expect(exit.tx.closed()).toEqual([exit.state.userBaseAta]);
      expectRaydiumTrade(exit);
      console.log(
        `  LaunchLab ${t.mint}: buy ${buy.tx.computeUnits} CU / ${buy.sizeBytes} B, sell ${half.tx.computeUnits} CU, ` +
          `full exit ${exit.tx.computeUnits} CU / ${exit.sizeBytes} B`,
      );
    },
  );

  test.skipIf(noCpmm !== null)(
    withSkipReason("CPMM: buy 0.01 SOL (wSOL wrap + ATA), sell 50%, full exit + close; each fills the local quote", noCpmm),
    async () => {
      const t = targetOf("cpmm") as ForkTarget;
      const buy = await runTrade(fork, trader, { label: "CPMM buy 0.01 SOL (wSOL wrap)", mint: t.mint, side: "buy", sol: "0.01" });
      expect(buy.state.venue).toBe("cpmm");
      expect((buy.state as CpmmState).poolAddress).toBe(t.market);
      expect(buy.trade.instructions.some((i) => i.programAddress === RAYDIUM_CPMM_PROGRAM_ID)).toBe(true);
      expectRaydiumTrade(buy);
      const half = await runTrade(fork, trader, { label: "CPMM sell 50%", mint: t.mint, side: "sell", percent: "50" });
      expectRaydiumTrade(half);
      const exit = await runTrade(fork, trader, { label: "CPMM full exit + close", mint: t.mint, side: "sell", percent: "100" });
      expect(exit.tx.closed()).toEqual([exit.state.userBaseAta]);
      expectRaydiumTrade(exit);
      console.log(
        `  CPMM ${t.mint}: buy ${buy.tx.computeUnits} CU / ${buy.sizeBytes} B, sell ${half.tx.computeUnits} CU, ` +
          `full exit ${exit.tx.computeUnits} CU / ${exit.sizeBytes} B`,
      );
    },
  );

  test.skipIf(noLaunchLab !== null)(
    withSkipReason(
      "armed LaunchLab take-profit: grid on one nonce through the signer; fires on fork state; fills above min-out; nonce advanced",
      noLaunchLab,
    ),
    async () => {
      const t = targetOf("launchlab") as ForkTarget;
      await userTrade(fork, tw, {
        label: "armed setup: buy 0.05 SOL position (LaunchLab)",
        mint: t.mint,
        side: "buy",
        amount: 50_000_000n,
      });
      const s0 = await launchLabState(fork, t.mint, tw.address);
      const position = s0.userBaseBalance;
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const threshold = bps(q0, 10_500n);
      const nonce = await nonceRef(fork, tw, 0);
      const close = s0.userBaseWithheld === 0n;
      let order = await arm({
        id: "tp-launchlab",
        kind: "take-profit",
        wallet: tw.address,
        mint: t.mint,
        amount: position,
        fullExit: close,
        trigger: { type: "quote-at-least", threshold },
        templates: [
          await launchLabSellTemplate(
            { poolAddress: s0.poolAddress, pool: s0.pool, user: tw.address },
            { amount: position, closeBaseAccount: close, userBaseWithheld: s0.userBaseWithheld },
          ),
        ],
        minOuts: minOutGrid(threshold, [0, 100, 250]),
        tipLevels: TIP_LEVELS,
        nonces: [nonce],
        armingQuoteOut: q0,
        lookupTables: tw.tables,
      });
      expect(order.frozen.venues).toEqual([
        { venue: "launchlab", creator: s0.pool.creator, market: s0.poolAddress, config: s0.pool.platformConfig },
      ]);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: q0, venue: "launchlab", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });

      // Other traders lift the curve past the target plus the engine's 1% safety margin.
      const market = await newWallet(fork, 60n);
      const { live } = await moveQuote(fork, market, t.mint, position, bps(threshold, 10_150n), "up");
      const s1 = await launchLabState(fork, t.mint, tw.address);
      expect(liveQuoteOut("sell", position, liveMarket(s1))).toBe(live);
      const decision = evaluateTrigger(order, {}, { liveQuoteOut: live, venue: "launchlab", nowMs: now() });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      expect(decision.variant.minOut).toBe(threshold);
      expect(hasReservedBalance(order, { lamports: await balanceOf(fork, tw.address), tokens: position })).toEqual({ ok: true });
      expect(detectStaleness(order, await observe(order, s1))).toEqual([]);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;

      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed TP sell, LaunchLab (fires at +5%)",
        venue: "launchlab",
        side: "sell",
        mint: t.mint,
        simulate: true,
      });
      const params = launchLabTradeParams({ globalConfig: s1.globalConfig, platformConfig: s1.platformConfig });
      const x = quoteLaunchLabSellExactIn(s1.pool, position, params, {
        base: s1.mintInfo.extensions.transferFeeConfig,
        quote: s1.quoteMintInfo.extensions.transferFeeConfig,
        epoch: s1.clock.epoch,
      });
      expect(x.quoteReceived).toBe(live);
      const ev = fill.tx.events.find((e): e is LaunchLabTradeEvent => e.kind === "launchlabTrade");
      if (!ev) throw new Error("no LaunchLab TradeEvent");
      expect([ev.isBuy, ev.amountIn, ev.amountOut, ev.shareFee]).toEqual([false, x.baseToVault, x.quoteFromVault, 0n]);
      expect(fill.tx.tokens(s1.userBaseAta).delta).toBe(-position);
      expectArmedSell(fill, decision.variant, tw, live, close ? [s1.userBaseAta] : []);
      await expectNonceAdvanced(fork, tw, nonce);
      expect(applyArmedOrderEvent(order, nonceConsumed(fill, nonce)).order.status).toBe("filled");
      console.log(
        `  LaunchLab TP: quote ${q0} -> ${live} (target ${threshold}); filled ${live} >= min-out ${decision.variant.minOut}; ` +
          `${fill.tx.computeUnits} CU, ${decision.variant.tx.size} B`,
      );
    },
  );

  test.skipIf(noCpmm !== null)(
    withSkipReason(
      "armed CPMM stop-loss: grid on one nonce through the signer; fires on fork state; fills above min-out; nonce advanced",
      noCpmm,
    ),
    async () => {
      const t = targetOf("cpmm") as ForkTarget;
      const sm = await cpmmState(fork, t.mint, tw.address);
      // The market holds tokens bought with ~3% of the pool's quote reserve, to sell later.
      const quoteVault = sm.pool.token0Mint === WSOL_MINT ? sm.vault0Amount : sm.vault1Amount;
      const marketBuy = bps(quoteVault, 300n);
      const market = await newWallet(fork, marketBuy / 1_000_000_000n + 10n);
      await marketTrade(fork, market, t.mint, "buy", marketBuy);
      await userTrade(fork, tw, { label: "armed setup: buy 0.05 SOL position (CPMM)", mint: t.mint, side: "buy", amount: 50_000_000n });
      const s0 = await cpmmState(fork, t.mint, tw.address);
      const position = s0.userBaseBalance;
      const q0 = mustQuote(liveQuoteOut("sell", position, liveMarket(s0)));
      const slAt = bps(q0, 9_850n);
      const nonce = await nonceRef(fork, tw, 1);
      const close = s0.userBaseWithheld === 0n;
      let order = await arm({
        id: "sl-cpmm",
        kind: "stop-loss",
        wallet: tw.address,
        mint: t.mint,
        amount: position,
        fullExit: close,
        trigger: { type: "quote-at-most", threshold: slAt },
        templates: [
          await cpmmSellTemplate(
            { poolAddress: s0.poolAddress, pool: s0.pool, user: tw.address, baseMint: t.mint },
            { amount: position, closeBaseAccount: close, userBaseWithheld: s0.userBaseWithheld },
          ),
        ],
        minOuts: minOutGrid(slAt, [0, 300, 600, 1000]),
        tipLevels: TIP_LEVELS,
        nonces: [nonce],
        armingQuoteOut: q0,
        lookupTables: tw.tables,
      });
      expect(order.frozen.venues).toEqual([
        { venue: "cpmm", creator: s0.pool.poolCreator, market: s0.poolAddress, config: s0.pool.ammConfig },
      ]);
      expect(evaluateTrigger(order, {}, { liveQuoteOut: q0, venue: "cpmm", nowMs: now() })).toMatchObject({
        fire: false,
        reason: "condition-not-met",
      });

      const { live } = await moveQuote(fork, market, t.mint, position, bps(q0, 9_750n), "down");
      const s1 = await cpmmState(fork, t.mint, tw.address);
      expect(liveQuoteOut("sell", position, liveMarket(s1))).toBe(live);
      const decision = evaluateTrigger(order, {}, { liveQuoteOut: live, venue: "cpmm", nowMs: now() });
      if (!decision.fire) throw new Error(`the engine held: ${decision.reason}`);
      expect(decision.variant.minOut * 10_000n).toBeLessThanOrEqual(live * 9_900n);
      expect(detectStaleness(order, await observe(order, s1))).toEqual([]);
      order = applyArmedOrderEvent(order, { type: "submitted", attempt: 0, variantId: decision.variant.id }).order;

      const fill = await submitArmed(fork, tw, decision.variant.tx, {
        label: "armed SL sell, CPMM (fires at -1.5%)",
        venue: "cpmm",
        side: "sell",
        mint: t.mint,
        simulate: true,
      });
      const x = quoteCpmmSwapBaseInput({
        pool: s1.pool,
        vault0Amount: s1.vault0Amount,
        vault1Amount: s1.vault1Amount,
        inputMint: t.mint,
        rates: cpmmFeeRates(s1.ammConfig, s1.pool),
        transferFees: {
          input: s1.mintInfo.extensions.transferFeeConfig,
          output: s1.quoteMintInfo.extensions.transferFeeConfig,
          epoch: s1.clock.epoch,
        },
        unixTimestamp: s1.clock.unixTimestamp,
        amountIn: position,
      });
      expect(x.amountReceived).toBe(live);
      const ev = fill.tx.events.find((e): e is CpmmSwapEvent => e.kind === "cpmmSwap");
      if (!ev) throw new Error("no CPMM SwapEvent");
      expect([ev.inputMint, ev.inputAmount, ev.outputAmount]).toEqual([t.mint, x.amountIn - x.inputTransferFee, x.outputAmount]);
      expect(fill.tx.tokens(s1.userBaseAta).delta).toBe(-position);
      expectArmedSell(fill, decision.variant, tw, live, close ? [s1.userBaseAta] : []);
      await expectNonceAdvanced(fork, tw, nonce);
      expect(applyArmedOrderEvent(order, nonceConsumed(fill, nonce)).order.status).toBe("filled");
      console.log(
        `  CPMM SL: quote ${q0} -> ${live} (stop ${slAt}); filled ${live} >= min-out ${decision.variant.minOut}; ` +
          `${fill.tx.computeUnits} CU, ${decision.variant.tx.size} B`,
      );
    },
  );
});
