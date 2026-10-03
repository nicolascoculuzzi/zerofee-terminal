/**
 * Arming: turn order specs into signed armed orders, in the browser, with ONE signer call per
 * batch (one wallet popup in direct mode).
 *
 *  - min-out x tip variant grid on ONE nonce        armOrder / armOrders
 *  - OCO pair sharing a nonce                       armOcoPair
 *  - full-exit sell attempt ladder over N nonces    armOrder with several nonces (refused for
 *                                                   buys and partial sells: double-fill risk)
 *  - migration snipe against the canonical pool     armMigrationSnipe
 *  - a pre-signed cancel per nonce, always          (an order without one is never "armed")
 */
import type { Address, AddressesByLookupTableAddress, Instruction, Transaction, TransactionPartialSigner } from "@solana/kit";
import { BPS_DENOMINATOR as BPS, DEFAULT_CU_LIMITS, LAMPORTS_PER_SIGNATURE, WSOL_MINT } from "../constants";
import { canonicalPoolPda } from "../pump/accounts";
import {
  buildPumpBuyInstructions,
  buildPumpSellInstructions,
  type PumpTradeContext,
  pickBuybackFeeRecipient,
  pickPumpFeeRecipient,
  resolvePumpTradeAccounts,
} from "../pump/instructions";
import {
  type AmmTradeContext,
  buildAmmBuyInstructions,
  buildAmmSellInstructions,
  pickAmmProtocolFeeRecipient,
  resolveAmmSwapAccounts,
} from "../pumpswap/instructions";
import { priorityFeeLamports } from "../tx/computeBudget";
import { resolveTipAccount, type TipAccountSets, type TipSpec } from "../tx/tip";
import { filterSet } from "../util/sets";
import {
  type CancelTxOptions,
  compileArmedTransaction,
  compileCancelTransaction,
  DEFAULT_CANCEL_CU_LIMIT,
  type DurableNonceRef,
  type SignedTx,
  signTransactionBatch,
  toSignedTx,
} from "./armedTx";
import { currentInterfaceVersion } from "./interfaceVersion";
import { type MigrationPoolArgs, migrationPoolContext } from "./migration";
import {
  ARMED_ORDER_SIDE,
  type ArmedAttempt,
  type ArmedCapCost,
  type ArmedNonceBinding,
  type ArmedOrder,
  type ArmedOrderKind,
  type ArmedSide,
  type ArmedTrigger,
  type ArmedVariant,
  type ArmedVenue,
  DEFAULT_MAX_ARMED_BUY_VARIANTS,
  type FrozenAccounts,
  type Reservation,
} from "./model";

// ---------------------------------------------------------------------------------------------
// Trade templates: one trade with fixed accounts, parameterised by min-out
// ---------------------------------------------------------------------------------------------

export interface TradeTemplate {
  venue: ArmedVenue;
  side: ArmedSide;
  mint: Address;
  /** buy: quote spend; sell: base tokens. */
  amount: bigint;
  /** Sell templates: the trade closes the base token account (the on-chain full-exit guard). */
  closesBaseAccount: boolean;
  /** Trade instructions for one min-out level. Accounts and fee recipients are pinned at creation. */
  build(minOut: bigint): Promise<Instruction[]>;
  frozen: {
    baseTokenProgram: Address;
    quoteMint: Address;
    creator: Address;
    /** Bonding curve (pump) or pool (pumpswap). */
    market: Address;
    feeRecipient: Address;
    buybackFeeRecipient: Address;
    /** Coin flags that shape the account list (fee recipient list, PumpSwap remaining accounts). */
    isMayhemMode?: boolean;
    isCashbackCoin?: boolean;
  };
  defaultCuLimit: number;
}

/** Curve buy via buy_exact_quote_in_v2: spend `spend` (fees included) for >= minOut tokens. */
export async function pumpBuyTemplate(ctx: PumpTradeContext, order: { spend: bigint; createAta?: boolean }): Promise<TradeTemplate> {
  if (order.spend <= 0n) throw new RangeError("spend must be > 0");
  const pinned: PumpTradeContext = {
    ...ctx,
    feeRecipient: ctx.feeRecipient ?? pickPumpFeeRecipient(ctx.curve.isMayhemMode, ctx.global),
    buybackFeeRecipient: ctx.buybackFeeRecipient ?? pickBuybackFeeRecipient(ctx.global?.buybackFeeRecipients),
  };
  const a = await resolvePumpTradeAccounts(pinned);
  return {
    venue: "pump",
    side: "buy",
    mint: ctx.mint,
    amount: order.spend,
    closesBaseAccount: false,
    build: async (minOut) =>
      (await buildPumpBuyInstructions(pinned, { mode: "exactQuoteIn", amount: order.spend, limit: minOut, createAta: order.createAta }))
        .instructions,
    frozen: {
      baseTokenProgram: ctx.baseTokenProgram,
      quoteMint: a.quoteMint,
      creator: ctx.curve.creator,
      market: a.bondingCurve,
      feeRecipient: a.feeRecipient,
      buybackFeeRecipient: a.buybackFeeRecipient,
      isMayhemMode: ctx.curve.isMayhemMode,
    },
    defaultCuLimit: DEFAULT_CU_LIMITS.pumpBuy,
  };
}

/** Curve sell via sell_v2: sell `amount` tokens for >= minOut quote; `closeBaseAccount` for full exits. */
export async function pumpSellTemplate(
  ctx: PumpTradeContext,
  order: { amount: bigint; closeBaseAccount?: boolean },
): Promise<TradeTemplate> {
  if (order.amount <= 0n) throw new RangeError("amount must be > 0");
  const pinned: PumpTradeContext = {
    ...ctx,
    feeRecipient: ctx.feeRecipient ?? pickPumpFeeRecipient(ctx.curve.isMayhemMode, ctx.global),
    buybackFeeRecipient: ctx.buybackFeeRecipient ?? pickBuybackFeeRecipient(ctx.global?.buybackFeeRecipients),
  };
  const a = await resolvePumpTradeAccounts(pinned);
  const close = order.closeBaseAccount ?? false;
  return {
    venue: "pump",
    side: "sell",
    mint: ctx.mint,
    amount: order.amount,
    closesBaseAccount: close,
    build: async (minOut) =>
      (await buildPumpSellInstructions(pinned, { amount: order.amount, minQuoteOut: minOut, closeBaseAccount: close })).instructions,
    frozen: {
      baseTokenProgram: ctx.baseTokenProgram,
      quoteMint: a.quoteMint,
      creator: ctx.curve.creator,
      market: a.bondingCurve,
      feeRecipient: a.feeRecipient,
      buybackFeeRecipient: a.buybackFeeRecipient,
      isMayhemMode: ctx.curve.isMayhemMode,
    },
    defaultCuLimit: DEFAULT_CU_LIMITS.pumpSell,
  };
}

/**
 * The signer firewall only trades PumpSwap's canonical pool (created by pump's migrate, LP burned):
 * anyone can create a second pool for a pair and take tokens sold into it at min-out 0.
 */
async function assertCanonicalPool(ctx: AmmTradeContext, allowNonCanonical: boolean | undefined): Promise<void> {
  if (allowNonCanonical) return;
  const canonical = await canonicalPoolPda(ctx.pool.baseMint, ctx.pool.quoteMint);
  if (ctx.poolAddress !== canonical) {
    throw new ArmingError(`pool ${ctx.poolAddress} is not the canonical LP-burned pool ${canonical} of ${ctx.pool.baseMint}`);
  }
}

function pinAmm(ctx: AmmTradeContext): AmmTradeContext {
  return {
    ...ctx,
    protocolFeeRecipient: ctx.protocolFeeRecipient ?? pickAmmProtocolFeeRecipient(ctx.pool.isMayhemMode, ctx.globalConfig),
    buybackFeeRecipient: ctx.buybackFeeRecipient ?? pickBuybackFeeRecipient(ctx.globalConfig?.buybackFeeRecipients),
  };
}

/** PumpSwap buy via buy_exact_quote_in (wSOL wrapped and unwrapped around the swap). */
export async function ammBuyTemplate(
  ctx: AmmTradeContext,
  order: { spend: bigint; allowNonCanonicalPool?: boolean },
): Promise<TradeTemplate> {
  if (order.spend <= 0n) throw new RangeError("spend must be > 0");
  await assertCanonicalPool(ctx, order.allowNonCanonicalPool);
  const pinned = pinAmm(ctx);
  const a = await resolveAmmSwapAccounts(pinned);
  return {
    venue: "pumpswap",
    side: "buy",
    mint: ctx.pool.baseMint,
    amount: order.spend,
    closesBaseAccount: false,
    build: async (minOut) =>
      (await buildAmmBuyInstructions(pinned, { mode: "exactQuoteIn", amount: order.spend, limit: minOut })).instructions,
    frozen: {
      baseTokenProgram: ctx.baseTokenProgram,
      quoteMint: ctx.pool.quoteMint,
      creator: ctx.pool.coinCreator,
      market: ctx.poolAddress,
      feeRecipient: a.protocolFeeRecipient,
      buybackFeeRecipient: a.buybackFeeRecipient,
      isMayhemMode: ctx.pool.isMayhemMode,
      isCashbackCoin: ctx.pool.isCashbackCoin,
    },
    defaultCuLimit: DEFAULT_CU_LIMITS.ammBuy,
  };
}

/** PumpSwap sell; `closeBaseAccount` for full exits. */
export async function ammSellTemplate(
  ctx: AmmTradeContext,
  order: { amount: bigint; closeBaseAccount?: boolean; allowNonCanonicalPool?: boolean },
): Promise<TradeTemplate> {
  if (order.amount <= 0n) throw new RangeError("amount must be > 0");
  await assertCanonicalPool(ctx, order.allowNonCanonicalPool);
  const pinned = pinAmm(ctx);
  const a = await resolveAmmSwapAccounts(pinned);
  const close = order.closeBaseAccount ?? false;
  return {
    venue: "pumpswap",
    side: "sell",
    mint: ctx.pool.baseMint,
    amount: order.amount,
    closesBaseAccount: close,
    build: async (minOut) =>
      (await buildAmmSellInstructions(pinned, { baseAmountIn: order.amount, minQuoteOut: minOut, closeBaseAccount: close })).instructions,
    frozen: {
      baseTokenProgram: ctx.baseTokenProgram,
      quoteMint: ctx.pool.quoteMint,
      creator: ctx.pool.coinCreator,
      market: ctx.poolAddress,
      feeRecipient: a.protocolFeeRecipient,
      buybackFeeRecipient: a.buybackFeeRecipient,
      isMayhemMode: ctx.pool.isMayhemMode,
      isCashbackCoin: ctx.pool.isCashbackCoin,
    },
    defaultCuLimit: DEFAULT_CU_LIMITS.ammSell,
  };
}

// ---------------------------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------------------------

/** One tip level of the grid: CU price plus the tips (armed orders default to one Jito tip). */
export interface TipLevel {
  level: number;
  cuPriceMicroLamports: bigint;
  tips: TipSpec[];
}

/** Jito bundle-only tip levels (the armed default): one Jito tip per level. */
export function jitoTipLevels(levels: readonly { tipLamports: bigint; cuPriceMicroLamports: bigint }[]): TipLevel[] {
  return levels.map((l, level) => ({
    level,
    cuPriceMicroLamports: l.cuPriceMicroLamports,
    tips: [{ lane: "jito", lamports: l.tipLamports }],
  }));
}

/**
 * Min-out levels `reference x (1 - step)` for each step in bps (0 = exactly the reference),
 * deduplicated and sorted tightest (highest) first.
 */
export function minOutGrid(reference: bigint, stepsBps: readonly number[]): bigint[] {
  if (reference <= 0n) throw new RangeError("reference must be > 0");
  const out = new Set<bigint>();
  for (const s of stepsBps) {
    if (!Number.isInteger(s) || s < 0 || s >= 10_000) throw new RangeError(`grid step must be an integer in [0, 10000): ${s}`);
    const v = (reference * (BPS - BigInt(s))) / BPS;
    if (v > 0n) out.add(v);
  }
  return [...out].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------------------------

export interface ArmedOrderSpec {
  id: string;
  kind: ArmedOrderKind;
  wallet: Address;
  mint: Address;
  /** buy: quote spend; sell: base tokens. Must equal every template's amount. */
  amount: bigint;
  /** Sell the whole armed balance and close the account. Required for ladders (nonces.length > 1). */
  fullExit?: boolean;
  trigger: ArmedTrigger;
  /** One template per venue (two for an order that must survive graduation). */
  templates: readonly TradeTemplate[];
  minOuts: readonly bigint[];
  tipLevels: readonly TipLevel[];
  /** One nonce per attempt. More than one = attempt ladder (full-exit sells only). */
  nonces: readonly DurableNonceRef[];
  /** Live quote out for `amount` at arming (grid-depth cap reference). */
  armingQuoteOut: bigint;
  /** Required on every order that shares a nonce with another. */
  ocoGroup?: string;
  /** Overrides every template's static CU limit (default: each venue's own DEFAULT_CU_LIMITS entry). */
  cuLimit?: number;
  /** Default true: armed orders go Jito bundle-only with the anti-sandwich marker. */
  jitoDontFront?: boolean;
  lookupTables?: AddressesByLookupTableAddress;
  tipAccounts?: TipAccountSets;
  cancel?: CancelTxOptions;
  /** Rent the trade may need on top of spend + fees (base ATA, wSOL ATA, volume accumulator), from RPC. */
  extraReserveLamports?: bigint;
  /**
   * Max signed variants for a BUY order (default DEFAULT_MAX_ARMED_BUY_VARIANTS = 3): the signer
   * firewall counts every signed buy variant in full against the daily buy cap.
   */
  maxBuyVariants?: number;
  interfaceVersion?: string;
  armedAtMs?: number;
}

export class ArmingError extends Error {}

/** Ladders are only safe for full-exit sells; buys and partial sells could fill twice. */
export function assertLadderAllowed(
  side: ArmedSide,
  fullExit: boolean,
  templates: readonly Pick<TradeTemplate, "closesBaseAccount">[],
): void {
  if (side !== "sell") throw new ArmingError("attempt ladders are refused for buys (double-fill risk); arm one nonce");
  if (!fullExit) throw new ArmingError("attempt ladders are refused for partial sells (double-fill risk); arm one nonce");
  if (!templates.every((t) => t.closesBaseAccount)) {
    throw new ArmingError("full-exit ladder attempts must close the base token account (the on-chain guard against a second fill)");
  }
}

function validateSpec(spec: ArmedOrderSpec, signer: Address): ArmedSide {
  const side = ARMED_ORDER_SIDE[spec.kind];
  const fail = (m: string): never => {
    throw new ArmingError(`order ${spec.id}: ${m}`);
  };
  if (spec.wallet !== signer) fail(`wallet ${spec.wallet} is not the signer ${signer}`);
  if (spec.amount <= 0n) fail("amount must be > 0");
  if (spec.templates.length === 0) fail("needs at least one trade template");
  const venues = new Set<ArmedVenue>();
  for (const t of spec.templates) {
    if (t.side !== side) fail(`${spec.kind} is a ${side} but a template is a ${t.side}`);
    if (t.mint !== spec.mint) fail(`template mint ${t.mint} != ${spec.mint}`);
    if (t.amount !== spec.amount) fail(`template amount ${t.amount} != order amount ${spec.amount}`);
    if (venues.has(t.venue)) fail(`two templates for venue ${t.venue}`);
    venues.add(t.venue);
  }
  if (spec.minOuts.length === 0 || spec.minOuts.some((m) => m <= 0n)) fail("min-outs must be non-empty and > 0");
  if (new Set(spec.minOuts).size !== spec.minOuts.length) fail("duplicate min-out levels");
  if (spec.tipLevels.length === 0) fail("needs at least one tip level");
  if (new Set(spec.tipLevels.map((t) => t.level)).size !== spec.tipLevels.length) fail("duplicate tip levels");
  if (spec.nonces.length === 0) fail("needs at least one nonce");
  if (new Set(spec.nonces.map((n) => n.account)).size !== spec.nonces.length) fail("the same nonce appears twice in one order");
  for (const n of spec.nonces) if (n.authority !== spec.wallet) fail(`nonce ${n.account} authority ${n.authority} is not the wallet`);
  const fullExit = spec.fullExit ?? false;
  if (fullExit && (side !== "sell" || !spec.templates.every((t) => t.closesBaseAccount))) {
    fail("fullExit requires a sell whose templates close the base token account");
  }
  if (spec.nonces.length > 1) {
    try {
      assertLadderAllowed(side, fullExit, spec.templates);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  if (spec.trigger.type === "migration" && !venues.has("pumpswap")) fail("a migration trigger needs a PumpSwap template");
  if (side === "buy") {
    const variants = spec.minOuts.length * spec.tipLevels.length * spec.templates.length * spec.nonces.length;
    const cap = spec.maxBuyVariants ?? DEFAULT_MAX_ARMED_BUY_VARIANTS;
    if (variants > cap) {
      fail(`${variants} buy variants > ${cap}: every signed buy variant counts in full against the daily buy cap; shrink the grid`);
    }
  }
  return side;
}

/** Pins one tip account per lane for the whole order, so every variant pays the same accounts. */
function pinTips(levels: readonly TipLevel[], sets?: TipAccountSets): TipLevel[] {
  const chosen: Partial<Record<TipSpec["lane"], Address>> = {};
  return levels.map((l) => ({
    ...l,
    tips: l.tips.map((t) => {
      if (t.tipAccount) return t;
      chosen[t.lane] ??= resolveTipAccount(t, sets);
      return { ...t, tipAccount: chosen[t.lane] };
    }),
  }));
}

interface PendingVariant {
  attempt: number;
  venue: ArmedVenue;
  minOut: bigint;
  minOutIndex: number;
  level: TipLevel;
  cuLimit: number;
  tx: Transaction;
}

/**
 * Builds, signs (one signer call for the whole batch) and returns armed orders. Orders that share
 * a nonce (OCO) share its cancel. Throws ArmingError on any rule violation; nothing is signed then.
 */
export async function armOrders(specs: readonly ArmedOrderSpec[], signer: TransactionPartialSigner): Promise<ArmedOrder[]> {
  if (specs.length === 0) return [];
  const sides = specs.map((s) => validateSpec(s, signer.address));
  if (new Set(specs.map((s) => s.id)).size !== specs.length) throw new ArmingError("duplicate order ids in one batch");

  // Nonce sharing is only allowed inside an OCO group, against the same nonce value.
  const byNonce = new Map<Address, { spec: ArmedOrderSpec; nonce: DurableNonceRef }[]>();
  for (const spec of specs) for (const n of spec.nonces) byNonce.set(n.account, [...(byNonce.get(n.account) ?? []), { spec, nonce: n }]);
  for (const [account, users] of byNonce) {
    if (users.length < 2) continue;
    const group = users[0]?.spec.ocoGroup;
    if (!group || users.some((u) => u.spec.ocoGroup !== group)) {
      throw new ArmingError(`nonce ${account} is shared by orders that are not in one OCO group`);
    }
    if (users.some((u) => u.nonce.value !== users[0]?.nonce.value))
      throw new ArmingError(`nonce ${account} has two different values in one batch`);
  }
  // An OCO group only means something if its orders really share a nonce (all of them, one common nonce).
  const groups = new Map<string, ArmedOrderSpec[]>();
  for (const spec of specs) if (spec.ocoGroup) groups.set(spec.ocoGroup, [...(groups.get(spec.ocoGroup) ?? []), spec]);
  for (const [group, members] of groups) {
    const common = members.reduce(
      (acc, m) => filterSet(acc, (a) => m.nonces.some((n) => n.account === a)),
      new Set((members[0] as ArmedOrderSpec).nonces.map((n) => n.account)),
    );
    if (members.length > 1 && common.size === 0) throw new ArmingError(`OCO group ${group}: its orders share no nonce`);
  }

  const unsigned: Transaction[] = [];
  const pendingPerSpec: PendingVariant[][] = [];
  const tipLevelsPerSpec: TipLevel[][] = [];
  for (const spec of specs) {
    const levels = pinTips(spec.tipLevels, spec.tipAccounts);
    tipLevelsPerSpec.push(levels);
    const pending: PendingVariant[] = [];
    for (const [attempt, nonce] of spec.nonces.entries()) {
      for (const template of spec.templates) {
        // Each venue keeps its own static CU limit (running out of CU is a landed failure).
        const cuLimit = spec.cuLimit ?? template.defaultCuLimit;
        for (const [minOutIndex, minOut] of spec.minOuts.entries()) {
          const instructions = await template.build(minOut);
          for (const level of levels) {
            const { transaction } = compileArmedTransaction({
              feePayer: spec.wallet,
              nonce,
              instructions,
              fees: {
                cuLimit,
                cuPriceMicroLamports: level.cuPriceMicroLamports,
                tips: level.tips,
                jitoDontFront: spec.jitoDontFront ?? true,
              },
              lookupTables: spec.lookupTables,
              tipAccounts: spec.tipAccounts,
            });
            pending.push({ attempt, venue: template.venue, minOut, minOutIndex, level, cuLimit, tx: transaction });
            unsigned.push(transaction);
          }
        }
      }
    }
    pendingPerSpec.push(pending);
  }
  // One cancel per distinct nonce, owned (for cap accounting) by the first order that uses it.
  const cancelIndex = new Map<Address, number>();
  const cancelCosts: { tipLamports: bigint; priorityFeeLamports: bigint }[][] = specs.map(() => []);
  for (const [si, spec] of specs.entries()) {
    for (const nonce of spec.nonces) {
      if (cancelIndex.has(nonce.account)) continue;
      cancelIndex.set(nonce.account, unsigned.length);
      unsigned.push(compileCancelTransaction(spec.wallet, nonce, spec.cancel).transaction);
      cancelCosts[si]?.push(cancelCost(spec.cancel));
    }
  }

  const signed = await signTransactionBatch(signer, unsigned);
  const signedTx = (i: number, wallet: Address): SignedTx => toSignedTx(signed[i] as Transaction, wallet);

  let cursor = 0;
  return specs.map((spec, si) => {
    const side = sides[si] as ArmedSide;
    const pending = pendingPerSpec[si] as PendingVariant[];
    const attempts: ArmedAttempt[] = spec.nonces.map((nonce, index) => {
      const binding: ArmedNonceBinding = {
        account: nonce.account,
        authority: nonce.authority,
        value: nonce.value,
        cancel: signedTx(cancelIndex.get(nonce.account) as number, spec.wallet),
      };
      return { index, nonce: binding, variants: [], status: "live" };
    });
    for (const p of pending) {
      const v: ArmedVariant = {
        id: `${spec.id}/${p.attempt}/${p.venue}/${p.minOutIndex}/${p.level.level}`,
        venue: p.venue,
        minOut: p.minOut,
        tipLevel: p.level.level,
        tipLamports: p.level.tips.reduce((s, t) => s + t.lamports, 0n),
        priorityFeeLamports: priorityFeeLamports(p.level.cuPriceMicroLamports, p.cuLimit),
        tx: signedTx(cursor++, spec.wallet),
      };
      (attempts[p.attempt] as ArmedAttempt).variants.push(v);
    }
    const fullExit = spec.fullExit ?? false;
    return {
      id: spec.id,
      wallet: spec.wallet,
      kind: spec.kind,
      side,
      mint: spec.mint,
      amount: spec.amount,
      fullExit,
      trigger: spec.trigger,
      attempts,
      ...(spec.ocoGroup ? { ocoGroup: spec.ocoGroup } : {}),
      armingQuoteOut: spec.armingQuoteOut,
      armedAtMs: spec.armedAtMs ?? Date.now(),
      frozen: frozenAccounts(spec, tipLevelsPerSpec[si] as TipLevel[]),
      reservation: computeReservation({
        side,
        mint: spec.mint,
        amount: spec.amount,
        attempts,
        extraLamports: spec.extraReserveLamports ?? 0n,
      }),
      capCost: computeCapCost({
        side,
        amount: spec.amount,
        quoteMint: (spec.templates[0] as TradeTemplate).frozen.quoteMint,
        variants: attempts.flatMap((a) => a.variants),
        cancels: cancelCosts[si] ?? [],
      }),
      status: "armed",
    } satisfies ArmedOrder;
  });
}

function frozenAccounts(spec: ArmedOrderSpec, levels: readonly TipLevel[]): FrozenAccounts {
  const t0 = spec.templates[0] as TradeTemplate;
  return {
    mint: spec.mint,
    baseTokenProgram: t0.frozen.baseTokenProgram,
    quoteMint: t0.frozen.quoteMint,
    venues: spec.templates.map((t) => ({
      venue: t.venue,
      creator: t.frozen.creator,
      market: t.frozen.market,
      feeRecipient: t.frozen.feeRecipient,
      buybackFeeRecipient: t.frozen.buybackFeeRecipient,
      ...(t.frozen.isMayhemMode !== undefined ? { isMayhemMode: t.frozen.isMayhemMode } : {}),
      ...(t.frozen.isCashbackCoin !== undefined ? { isCashbackCoin: t.frozen.isCashbackCoin } : {}),
    })),
    tipAccounts: [...new Set(levels.flatMap((l) => l.tips.map((t) => t.tipAccount)).filter((a): a is Address => a !== undefined))],
    lookupTables: Object.keys(spec.lookupTables ?? {}) as Address[],
    interfaceVersion: spec.interfaceVersion ?? currentInterfaceVersion(),
  };
}

/**
 * Worst-case lamports/tokens an order needs in the wallet:
 *  - every attempt but the last may land and FAIL: base fee + priority fee each (tips revert);
 *  - the filling attempt pays base fee + priority fee + tip, plus the spend for buys;
 *  - plus `extraLamports` of rent for accounts the trade may create.
 */
export function computeReservation(args: {
  side: ArmedSide;
  mint: Address;
  amount: bigint;
  attempts: readonly Pick<ArmedAttempt, "variants">[];
  extraLamports?: bigint;
}): Reservation {
  let failedAttempts = 0n;
  let fill = 0n;
  for (const [i, a] of args.attempts.entries()) {
    let maxFail = 0n;
    for (const v of a.variants) {
      const failCost = LAMPORTS_PER_SIGNATURE + v.priorityFeeLamports;
      const fillCost = failCost + v.tipLamports;
      if (failCost > maxFail) maxFail = failCost;
      if (fillCost > fill) fill = fillCost;
    }
    if (i < args.attempts.length - 1) failedAttempts += maxFail;
  }
  const spend = args.side === "buy" ? args.amount : 0n;
  return {
    lamports: spend + fill + failedAttempts + (args.extraLamports ?? 0n),
    mint: args.mint,
    tokens: args.side === "sell" ? args.amount : 0n,
  };
}

function cancelCost(opts: CancelTxOptions | undefined): { tipLamports: bigint; priorityFeeLamports: bigint } {
  const price = opts?.cuPriceMicroLamports ?? 0n;
  return {
    tipLamports: (opts?.tips ?? []).reduce((s, t) => s + t.lamports, 0n),
    priorityFeeLamports: price > 0n ? priorityFeeLamports(price, opts?.cuLimit ?? DEFAULT_CANCEL_CU_LIMIT) : 0n,
  };
}

/**
 * What arming costs against the signer's DAILY caps (packages/signer SpendTracker), which count
 * every signed transaction in full whether or not it lands:
 *  - buy cap: each buy variant's spend (variants on one nonce cannot be proven exclusive offline);
 *  - fee budget: base fee + priority fee + tips of every signed tx, variants and cancels, sells too.
 */
export function computeCapCost(args: {
  side: ArmedSide;
  amount: bigint;
  quoteMint: Address;
  variants: readonly Pick<ArmedVariant, "tipLamports" | "priorityFeeLamports">[];
  cancels: readonly { tipLamports: bigint; priorityFeeLamports: bigint }[];
}): ArmedCapCost {
  let feeLamports = 0n;
  for (const t of [...args.variants, ...args.cancels]) feeLamports += LAMPORTS_PER_SIGNATURE + t.priorityFeeLamports + t.tipLamports;
  const buy = args.side === "buy" ? args.amount * BigInt(args.variants.length) : 0n;
  const isSol = args.quoteMint === WSOL_MINT;
  return {
    buyLamports: isSol ? buy : 0n,
    buyQuote: !isSol && buy > 0n ? { [args.quoteMint]: buy } : {},
    feeLamports,
  };
}

export async function armOrder(spec: ArmedOrderSpec, signer: TransactionPartialSigner): Promise<ArmedOrder> {
  const [order] = await armOrders([spec], signer);
  return order as ArmedOrder;
}

/**
 * Take-profit + stop-loss sharing one nonce: whichever lands first burns the other. Extra
 * stop-loss nonces (full exits only) turn the stop into a ladder; a take-profit fill then cancels
 * the remaining stop-loss nonces through the status machine.
 */
export async function armOcoPair(
  args: {
    group: string;
    nonce: DurableNonceRef;
    takeProfit: Omit<ArmedOrderSpec, "nonces" | "ocoGroup">;
    stopLoss: Omit<ArmedOrderSpec, "nonces" | "ocoGroup">;
    extraStopLossNonces?: readonly DurableNonceRef[];
  },
  signer: TransactionPartialSigner,
): Promise<[ArmedOrder, ArmedOrder]> {
  const orders = await armOrders(
    [
      { ...args.takeProfit, nonces: [args.nonce], ocoGroup: args.group },
      { ...args.stopLoss, nonces: [args.nonce, ...(args.extraStopLossNonces ?? [])], ocoGroup: args.group },
    ],
    signer,
  );
  return [orders[0] as ArmedOrder, orders[1] as ArmedOrder];
}

/**
 * Migration snipe: a PumpSwap buy pre-signed against the deterministic canonical pool, fired on
 * CompletePumpAmmMigrationEvent once the pool is live.
 */
export async function armMigrationSnipe(
  args: Omit<ArmedOrderSpec, "kind" | "templates" | "trigger"> & { pool: Omit<MigrationPoolArgs, "user" | "mint"> },
  signer: TransactionPartialSigner,
): Promise<ArmedOrder> {
  if (args.nonces.length !== 1) throw new ArmingError("a migration snipe is a buy: exactly one nonce");
  const ctx = await migrationPoolContext({ ...args.pool, mint: args.mint, user: args.wallet });
  const template = await ammBuyTemplate(ctx, { spend: args.amount });
  return armOrder({ ...args, kind: "migration-snipe", templates: [template], trigger: { type: "migration" } }, signer);
}
