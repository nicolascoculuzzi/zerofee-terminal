/**
 * Safety validators for armed orders.
 *
 * A compromised server cannot redirect funds - an armed tx can only do what the user signed - but
 * it can submit armed orders at their WORST allowed terms or withhold them. These checks bound that:
 *  - the widest variant may only reach `maxGridDepthBps` below the arming quote;
 *  - total armed notional per user is capped;
 *  - every transaction on a nonce spends from the same wallet (fee payer, nonce authority, only signer);
 *  - an order does not count as armed until every nonce has a valid pre-signed cancel;
 *  - the signed bytes must match the metadata the trigger engine relies on (amount, min-out, tips,
 *    priority fee, nonce) and pass the signer-firewall rules (allowlisted programs, transfers only
 *    to tip accounts or the wallet's own wSOL account, no Approve / SetAuthority).
 */
import {
  type Address,
  type AddressesByLookupTableAddress,
  getBase58Decoder,
  getPublicKeyFromAddress,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPS_DENOMINATOR as BPS,
  COMPUTE_BUDGET_PROGRAM_ID,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  LAMPORTS_PER_SOL,
  PACKET_DATA_SIZE,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  PUMP_IX,
  PUMP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../constants";
import { findAssociatedTokenAddress } from "../token";
import { priorityFeeLamports } from "../tx/computeBudget";
import { Reader, startsWith } from "../util/bytes";
import { type ArmedTxInspection, inspectArmedTransaction, type SignedTx } from "./armedTx";
import {
  type ArmedAttempt,
  type ArmedOrder,
  type ArmedVariant,
  armedNotional,
  DEFAULT_MAX_ARMED_BUY_VARIANTS,
  reservationHeld,
} from "./model";
import { FIREWALL_ALL_STATIC_PROGRAMS, FIREWALL_STATIC_VENUE_POSITIONS } from "./staticAccounts";

export interface ArmedSafetyPolicy {
  /** Max distance of the widest variant below the arming quote, in bps of the arming quote. */
  maxGridDepthBps: number;
  /** Max total armed notional per user (buys: spend; sells: arming quote; OCO groups count once). */
  maxArmedNotionalLamports: bigint;
  /** Max spend of one armed buy. */
  maxBuyLamports: bigint;
  /** Max total tip of one variant. */
  maxTipLamports: bigint;
  /** Max priority fee (cu_price x cu_limit) of one variant. */
  maxPriorityFeeLamports: bigint;
  maxVariantsPerNonce: number;
  /** Max signed variants of one BUY order (each counts against the signer's daily buy cap). */
  maxBuyVariants: number;
  /** Max ladder length. */
  maxAttempts: number;
}

/** Conservative defaults; the server sets the real values per deployment. */
export const DEFAULT_ARMED_SAFETY_POLICY: ArmedSafetyPolicy = {
  maxGridDepthBps: 5_000,
  maxArmedNotionalLamports: 25n * LAMPORTS_PER_SOL,
  maxBuyLamports: 5n * LAMPORTS_PER_SOL,
  maxTipLamports: 10_000_000n,
  maxPriorityFeeLamports: 10_000_000n,
  maxVariantsPerNonce: 64,
  maxBuyVariants: DEFAULT_MAX_ARMED_BUY_VARIANTS,
  maxAttempts: 5,
};

export type ArmedViolationCode =
  | "no-attempts"
  | "no-cancel"
  | "no-variants"
  | "too-many-variants"
  | "too-many-buy-variants"
  | "too-many-attempts"
  | "ladder-not-allowed"
  | "duplicate-nonce"
  | "nonce-authority"
  | "nonce-shared"
  | "duplicate-order"
  | "duplicate-signature"
  | "grid-too-deep"
  | "notional-cap"
  | "buy-cap"
  | "tip-cap"
  | "priority-cap"
  | "fee-payer"
  | "extra-signer"
  | "signature-invalid"
  | "nonce-instruction"
  | "nonce-not-static"
  | "lifetime-mismatch"
  | "size"
  | "program-not-allowed"
  | "instruction-not-allowed"
  | "trade-mismatch"
  | "tip-mismatch"
  | "priority-mismatch"
  | "transfer-not-allowed"
  | "lookup-not-allowed"
  | "undecodable";

export interface ArmedViolation {
  code: ArmedViolationCode;
  orderId: string;
  message: string;
  variantId?: string;
}

/** How far (bps) the widest variant reaches below the arming quote; <= 0 when no variant is below it. */
export function gridDepthBps(order: Pick<ArmedOrder, "attempts" | "armingQuoteOut">): number {
  if (order.armingQuoteOut <= 0n) return 10_000;
  let min: bigint | null = null;
  for (const a of order.attempts) for (const v of a.variants) if (min === null || v.minOut < min) min = v.minOut;
  if (min === null) return 0;
  return Number(((order.armingQuoteOut - min) * BPS) / order.armingQuoteOut);
}

/** Structural and policy checks on one order's metadata (no signature verification). */
export function validateArmedOrder(order: ArmedOrder, policy: ArmedSafetyPolicy = DEFAULT_ARMED_SAFETY_POLICY): ArmedViolation[] {
  const out: ArmedViolation[] = [];
  const add = (code: ArmedViolationCode, message: string, variantId?: string) =>
    out.push({ code, orderId: order.id, message, ...(variantId ? { variantId } : {}) });
  if (order.attempts.length === 0) add("no-attempts", "order has no attempts");
  if (order.attempts.length > policy.maxAttempts) add("too-many-attempts", `${order.attempts.length} attempts > ${policy.maxAttempts}`);
  if (order.attempts.length > 1 && (order.side !== "sell" || !order.fullExit)) {
    add("ladder-not-allowed", "attempt ladders are only allowed for full-exit sells (double-fill risk)");
  }
  if (new Set(order.attempts.map((a) => a.nonce.account)).size !== order.attempts.length)
    add("duplicate-nonce", "a nonce appears in two attempts");
  const sigs = new Set<string>();
  for (const a of order.attempts) {
    if (!a.nonce.cancel?.signature || !a.nonce.cancel.wireBase64) add("no-cancel", `attempt ${a.index} has no pre-signed cancel`);
    if (a.nonce.authority !== order.wallet)
      add("nonce-authority", `nonce ${a.nonce.account} authority ${a.nonce.authority} is not the wallet`);
    if (a.variants.length === 0) add("no-variants", `attempt ${a.index} has no variants`);
    if (a.variants.length > policy.maxVariantsPerNonce)
      add("too-many-variants", `attempt ${a.index}: ${a.variants.length} > ${policy.maxVariantsPerNonce}`);
    for (const v of a.variants) {
      if (v.tipLamports > policy.maxTipLamports) add("tip-cap", `tip ${v.tipLamports} > ${policy.maxTipLamports}`, v.id);
      if (v.priorityFeeLamports > policy.maxPriorityFeeLamports) add("priority-cap", `priority fee ${v.priorityFeeLamports} > cap`, v.id);
      if (sigs.has(v.tx.signature)) add("duplicate-signature", `signature ${v.tx.signature} repeated`, v.id);
      sigs.add(v.tx.signature);
    }
  }
  if (order.side === "buy" && order.amount > policy.maxBuyLamports) add("buy-cap", `buy ${order.amount} > ${policy.maxBuyLamports}`);
  const buyVariants = order.side === "buy" ? order.attempts.reduce((n, a) => n + a.variants.length, 0) : 0;
  if (buyVariants > policy.maxBuyVariants) {
    add("too-many-buy-variants", `${buyVariants} buy variants > ${policy.maxBuyVariants} (each counts against the daily buy cap)`);
  }
  const depth = gridDepthBps(order);
  if (depth > policy.maxGridDepthBps)
    add("grid-too-deep", `widest variant is ${depth} bps below the arming quote (cap ${policy.maxGridDepthBps})`);
  return out;
}

/** True once every attempt has variants and a pre-signed cancel (the minimum for "armed"). */
export function hasCancelForEveryNonce(order: Pick<ArmedOrder, "attempts">): boolean {
  return (
    order.attempts.length > 0 &&
    order.attempts.every((a) => a.variants.length > 0 && Boolean(a.nonce.cancel?.signature && a.nonce.cancel.wireBase64))
  );
}

/** Per-user checks across all of a user's orders: notional cap and nonce sharing (OCO only). */
export function validateUserArmedOrders(
  orders: readonly ArmedOrder[],
  policy: ArmedSafetyPolicy = DEFAULT_ARMED_SAFETY_POLICY,
): ArmedViolation[] {
  const out: ArmedViolation[] = orders.flatMap((o) => validateArmedOrder(o, policy));
  const ids = new Set<string>();
  for (const o of orders) {
    if (ids.has(o.id)) out.push({ code: "duplicate-order", orderId: o.id, message: "duplicate order id" });
    ids.add(o.id);
  }
  const notional = armedNotional(orders);
  if (notional > policy.maxArmedNotionalLamports) {
    out.push({ code: "notional-cap", orderId: "*", message: `armed notional ${notional} > ${policy.maxArmedNotionalLamports}` });
  }
  const byNonce = new Map<Address, { order: ArmedOrder; attempt: ArmedAttempt }[]>();
  for (const o of orders) {
    if (!reservationHeld(o)) continue;
    for (const a of o.attempts) byNonce.set(a.nonce.account, [...(byNonce.get(a.nonce.account) ?? []), { order: o, attempt: a }]);
  }
  for (const [nonce, users] of byNonce) {
    if (users.length < 2) continue;
    const first = users[0] as { order: ArmedOrder; attempt: ArmedAttempt };
    const ok = users.every(
      (u) =>
        u.order.ocoGroup !== undefined &&
        u.order.ocoGroup === first.order.ocoGroup &&
        u.order.wallet === first.order.wallet &&
        u.attempt.nonce.value === first.attempt.nonce.value,
    );
    if (!ok) {
      for (const u of users)
        out.push({ code: "nonce-shared", orderId: u.order.id, message: `nonce ${nonce} is shared outside one OCO group / wallet / value` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Signed-bytes verification
// ---------------------------------------------------------------------------------------------

export interface VerifyOptions {
  /** Operator lookup tables, to resolve loaded accounts (tip accounts are always static in armed txs). */
  lookupTables?: AddressesByLookupTableAddress;
  /** Accepted tip accounts. Default: Helius Sender list + Jito fallback list (pass the live Jito list). */
  tipAccounts?: readonly Address[];
  policy?: ArmedSafetyPolicy;
}

const ALLOWED_PROGRAMS = new Set<Address>([
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
]);

const base58 = getBase58Decoder();

interface Ctx {
  order: ArmedOrder;
  wallet: Address;
  walletWsolAta: Address;
  publicKey: CryptoKey;
  tipAccounts: Set<Address>;
  tables: AddressesByLookupTableAddress;
  policy: ArmedSafetyPolicy;
  out: ArmedViolation[];
}

function u32At(data: Uint8Array, at: number): number | null {
  return data.length >= at + 4 ? new DataView(data.buffer, data.byteOffset).getUint32(at, true) : null;
}

async function checkCommon(
  c: Ctx,
  tx: SignedTx,
  attempt: ArmedAttempt,
  label: string,
  variantId?: string,
): Promise<ArmedTxInspection | null> {
  const add = (code: ArmedViolationCode, message: string) =>
    c.out.push({ code, orderId: c.order.id, message: `${label}: ${message}`, ...(variantId ? { variantId } : {}) });
  let insp: ArmedTxInspection;
  try {
    insp = inspectArmedTransaction(tx.wireBase64, c.tables);
  } catch (e) {
    add("undecodable", (e as Error).message);
    return null;
  }
  if (insp.feePayer !== c.wallet) add("fee-payer", `fee payer ${insp.feePayer} is not the wallet`);
  if (insp.signers.length !== 1 || insp.signers[0] !== c.wallet)
    add("extra-signer", `signers ${insp.signers.join(",")} (only the wallet may sign)`);
  const sig = insp.signatures[c.wallet];
  if (!sig) add("signature-invalid", "missing wallet signature");
  else {
    if (base58.decode(sig) !== tx.signature) add("signature-invalid", "declared signature does not match the bytes");
    if (!(await verifySignature(c.publicKey, sig as SignatureBytes, insp.messageBytes)))
      add("signature-invalid", "wallet signature does not verify");
  }
  const n = insp.nonce;
  if (!n) add("nonce-instruction", "first instruction is not AdvanceNonceAccount");
  else {
    if (n.account !== attempt.nonce.account) add("nonce-instruction", `advances ${n.account}, expected ${attempt.nonce.account}`);
    if (!n.accountIsStatic) add("nonce-not-static", "nonce account is loaded from a lookup table (SIMD-0242)");
    if (!n.accountIsWritable) add("nonce-instruction", "nonce account is not writable");
    if (n.authority !== c.wallet) add("nonce-instruction", `nonce authority ${n.authority} is not the wallet`);
  }
  if (insp.lifetimeToken !== attempt.nonce.value) add("lifetime-mismatch", "lifetime token is not the attempt's nonce value");
  if (insp.size > PACKET_DATA_SIZE) add("size", `${insp.size} > ${PACKET_DATA_SIZE} bytes`);
  return insp;
}

interface Scan {
  tips: bigint;
  cuLimit: number | null;
  cuPrice: bigint;
  trades: { program: Address; disc: Uint8Array; amount: bigint; limit: bigint }[];
}

/** Firewall pass over instructions 1..n. */
function scanInstructions(c: Ctx, insp: ArmedTxInspection, label: string, variantId?: string, allowTrade = true): Scan {
  const add = (code: ArmedViolationCode, message: string) =>
    c.out.push({ code, orderId: c.order.id, message: `${label}: ${message}`, ...(variantId ? { variantId } : {}) });
  const scan: Scan = { tips: 0n, cuLimit: null, cuPrice: 0n, trades: [] };
  const staticCount = insp.staticAccounts.length;
  // Lookup-table contents are untrusted (signer firewall): these accounts must be static keys.
  const requireStatic = (ix: ArmedTxInspection["instructions"][number], i: number, positions: readonly number[]) => {
    for (const k of positions) {
      const idx = ix.accountIndices[k];
      if (idx !== undefined && idx >= staticCount)
        add("lookup-not-allowed", `instruction ${i}: account ${k} is loaded from a lookup table`);
    }
  };
  for (const [i, ix] of insp.instructions.entries()) {
    if (i === 0) continue; // AdvanceNonceAccount, checked in checkCommon
    ix.accounts.forEach((a, k) => {
      if (a?.startsWith("jitodontfront")) requireStatic(ix, i, [k]);
    });
    if (FIREWALL_ALL_STATIC_PROGRAMS.has(ix.program))
      requireStatic(
        ix,
        i,
        ix.accountIndices.map((_x, k) => k),
      );
    requireStatic(ix, i, FIREWALL_STATIC_VENUE_POSITIONS.get(ix.program) ?? []);
    if (!ALLOWED_PROGRAMS.has(ix.program)) {
      add("program-not-allowed", `instruction ${i} calls ${ix.program}`);
      continue;
    }
    const d = ix.data;
    if (ix.program === COMPUTE_BUDGET_PROGRAM_ID) {
      if (d[0] === 2 && d.length === 5) scan.cuLimit = u32At(d, 1);
      else if (d[0] === 3 && d.length === 9) scan.cuPrice = new Reader(d, 1).u64();
      else if (d[0] !== 4) add("instruction-not-allowed", `instruction ${i}: compute budget op ${d[0]}`);
      continue;
    }
    if (ix.program === SYSTEM_PROGRAM_ID) {
      if (u32At(d, 0) !== 2 || d.length !== 12) {
        add("instruction-not-allowed", `instruction ${i}: system op ${u32At(d, 0)} (only transfers)`);
        continue;
      }
      const lamports = new Reader(d, 4).u64();
      const [from, to] = ix.accounts;
      if (from !== c.wallet) add("transfer-not-allowed", `instruction ${i}: transfer from ${from}`);
      if (to && c.tipAccounts.has(to)) scan.tips += lamports;
      else if (to === c.walletWsolAta && c.order.side === "buy" && lamports <= c.order.amount) {
        /* PumpSwap wSOL wrap into the wallet's own account */
      } else add("transfer-not-allowed", `instruction ${i}: ${lamports} lamports to ${to ?? "an unresolved lookup"}`);
      continue;
    }
    if (ix.program === TOKEN_PROGRAM_ID || ix.program === TOKEN_2022_PROGRAM_ID) {
      if (d[0] === 17 && d.length === 1) continue; // SyncNative
      if (d[0] === 9 && d.length === 1) {
        // CloseAccount: rent must return to the wallet, authority must be the wallet.
        if (ix.accounts[1] !== c.wallet || ix.accounts[2] !== c.wallet)
          add("instruction-not-allowed", `instruction ${i}: CloseAccount not to/by the wallet`);
        continue;
      }
      add("instruction-not-allowed", `instruction ${i}: token op ${d[0]} (Approve/SetAuthority/transfers are refused)`);
      continue;
    }
    if (ix.program === ASSOCIATED_TOKEN_PROGRAM_ID) {
      if (!(d.length === 1 && d[0] === 1) || ix.accounts[0] !== c.wallet || ix.accounts[2] !== c.wallet) {
        add("instruction-not-allowed", `instruction ${i}: only CreateIdempotent for the wallet's own accounts`);
      }
      continue;
    }
    // pump / PumpSwap trade
    if (!allowTrade) {
      add("instruction-not-allowed", `instruction ${i}: trade instruction in a cancel`);
      continue;
    }
    if (d.length < 24) {
      add("trade-mismatch", `instruction ${i}: trade data too short`);
      continue;
    }
    const r = new Reader(d, 8);
    scan.trades.push({ program: ix.program, disc: d.subarray(0, 8), amount: r.u64(), limit: r.u64() });
  }
  return scan;
}

function checkTrade(c: Ctx, v: ArmedVariant, scan: Scan, label: string): void {
  const add = (code: ArmedViolationCode, message: string) =>
    c.out.push({ code, orderId: c.order.id, message: `${label}: ${message}`, variantId: v.id });
  if (scan.trades.length !== 1) {
    add("trade-mismatch", `expected exactly one trade instruction, found ${scan.trades.length}`);
    return;
  }
  const t = scan.trades[0] as Scan["trades"][number];
  const expectedProgram = v.venue === "pump" ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;
  if (t.program !== expectedProgram) add("trade-mismatch", `trade program ${t.program} does not match venue ${v.venue}`);
  const disc =
    c.order.side === "buy"
      ? v.venue === "pump"
        ? PUMP_IX.buyExactQuoteInV2
        : PUMP_AMM_IX.buyExactQuoteIn
      : v.venue === "pump"
        ? PUMP_IX.sellV2
        : PUMP_AMM_IX.sell;
  if (!startsWith(t.disc, disc)) add("trade-mismatch", `unexpected trade instruction for a ${c.order.side} on ${v.venue}`);
  if (t.amount !== c.order.amount) add("trade-mismatch", `signed amount ${t.amount} != order amount ${c.order.amount}`);
  if (t.limit !== v.minOut) add("trade-mismatch", `signed min-out ${t.limit} != declared ${v.minOut}`);
  if (scan.tips !== v.tipLamports) add("tip-mismatch", `signed tips ${scan.tips} != declared ${v.tipLamports}`);
  if (scan.tips > c.policy.maxTipLamports) add("tip-cap", `signed tips ${scan.tips} > ${c.policy.maxTipLamports}`);
  const priority = scan.cuLimit === null ? 0n : priorityFeeLamports(scan.cuPrice, scan.cuLimit);
  if (priority !== v.priorityFeeLamports) add("priority-mismatch", `signed priority fee ${priority} != declared ${v.priorityFeeLamports}`);
  if (priority > c.policy.maxPriorityFeeLamports) add("priority-cap", `signed priority fee ${priority} > cap`);
}

/**
 * Decodes and verifies every signed transaction of an order against its metadata. Run it on the
 * server before accepting an order, and in the browser before uploading.
 */
export async function verifyArmedOrderTransactions(order: ArmedOrder, opts: VerifyOptions = {}): Promise<ArmedViolation[]> {
  const c: Ctx = {
    order,
    wallet: order.wallet,
    walletWsolAta: await findAssociatedTokenAddress(order.wallet, WSOL_MINT, TOKEN_PROGRAM_ID),
    publicKey: await getPublicKeyFromAddress(order.wallet),
    tipAccounts: new Set(opts.tipAccounts ?? [...HELIUS_SENDER_TIP_ACCOUNTS, ...JITO_TIP_ACCOUNTS_FALLBACK]),
    tables: opts.lookupTables ?? {},
    policy: opts.policy ?? DEFAULT_ARMED_SAFETY_POLICY,
    out: [],
  };
  const seen = new Set<string>();
  const dup = (sig: string, label: string, variantId?: string) => {
    if (seen.has(sig))
      c.out.push({
        code: "duplicate-signature",
        orderId: order.id,
        message: `${label}: signature repeated`,
        ...(variantId ? { variantId } : {}),
      });
    seen.add(sig);
  };
  for (const a of order.attempts) {
    if (!a.nonce.cancel?.wireBase64) {
      c.out.push({ code: "no-cancel", orderId: order.id, message: `attempt ${a.index} has no pre-signed cancel` });
    } else {
      const label = `attempt ${a.index} cancel`;
      const insp = await checkCommon(c, a.nonce.cancel, a, label);
      if (insp) scanInstructions(c, insp, label, undefined, false);
      dup(a.nonce.cancel.signature, label);
    }
    for (const v of a.variants) {
      const label = `variant ${v.id}`;
      const insp = await checkCommon(c, v.tx, a, label, v.id);
      if (insp) checkTrade(c, v, scanInstructions(c, insp, label, v.id), label);
      dup(v.tx.signature, label, v.id);
    }
  }
  return c.out;
}

export class ArmedOrderRejected extends Error {
  constructor(readonly violations: ArmedViolation[]) {
    super(`armed order rejected: ${violations.map((v) => `${v.code} (${v.message})`).join("; ")}`);
  }
}

/** Server intake: metadata checks + signed-bytes verification; throws ArmedOrderRejected on any violation. */
export async function assertArmable(order: ArmedOrder, opts: VerifyOptions = {}): Promise<void> {
  const violations = [...validateArmedOrder(order, opts.policy), ...(await verifyArmedOrderTransactions(order, opts))];
  if (!hasCancelForEveryNonce(order) && !violations.some((v) => v.code === "no-cancel")) {
    violations.push({ code: "no-cancel", orderId: order.id, message: "an order without a cancel for every nonce is not armed" });
  }
  if (violations.length) throw new ArmedOrderRejected(violations);
}
