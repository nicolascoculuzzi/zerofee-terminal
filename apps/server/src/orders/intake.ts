/**
 * POST /api/orders/armed: everything an armed order must pass before the server holds it.
 *
 *   1. the trading wallet is one of the signed-in user's wallets;
 *   2. assertArmable: metadata policy + every signed transaction decoded and verified against it, with the
 *      operator lookup-table contents, the reviewed tip accounts (never a fetched list) and the server's
 *      safety policy;
 *   3. server rules on top: tables are operator tables, every variant pays a Jito tip and carries the
 *      jitodontfront marker (armed orders only travel Jito bundle-only), the reservation covers the worst
 *      case, an armed buy stays under the user's own per-trade cap (maxTradeSol);
 *   4. every nonce is live on chain at the value the order was signed against, with the wallet as authority;
 *   5. no nonce account belongs to another account;
 *   6. validateUserArmedOrders against the user's other open orders (notional cap with OCO exclusivity,
 *      nonce sharing only inside one OCO group) and the open-orders cap;
 *   7. stored atomically (all orders of the request or none), then handed to the engine.
 * One user's intakes run one at a time.
 */
import type { Address, AddressesByLookupTableAddress } from "@solana/kit";
import {
  type ArmedOrder,
  ArmedOrderRejected,
  type ArmedViolation,
  assertArmable,
  computeReservation,
  inspectArmedTransaction,
  JITO_DONT_FRONT,
  JITO_MIN_TIP_LAMPORTS,
  LAMPORTS_PER_SOL,
  nonceSlotAddresses,
  reviewedTipAccounts,
  validateUserArmedOrders,
  WSOL_MINT,
} from "@zerofee/core";
import type { ArmRejection, ArmViolation, NonceProbeResponse, NonceProbeState, NonceSlotProbe, Order } from "@zerofee/protocol";
import { isUniqueViolation, LimitExceededError } from "../db/pg";
import { type ChainReader, nonceSnapshot } from "./chain";
import type { HaltSource, OrderEngine } from "./engine";
import { tipsOf } from "./lanes";
import { type ArmedOrdersRepo, NonceSlotTakenError } from "./repo";

/** A refusal with its HTTP status and the reasons (ArmRejection body). */
export class IntakeError extends Error {
  constructor(
    readonly status: number,
    readonly code: ArmRejection["code"],
    message: string,
    readonly violations: ArmViolation[] = [],
  ) {
    super(message);
    this.name = "IntakeError";
  }

  body(): ArmRejection {
    return { error: this.message, code: this.code, violations: this.violations };
  }
}

const CONFLICT = new Set(["nonce-shared", "duplicate-order", "nonce-stale", "nonce-slot-taken", "oco-without-shared-nonce"]);
const LIMIT = new Set([
  "notional-cap",
  "buy-cap",
  "user-buy-cap",
  "grid-too-deep",
  "too-many-variants",
  "too-many-buy-variants",
  "too-many-attempts",
  "tip-cap",
  "priority-cap",
]);

/** Status for a set of violations: malformed or forged beats conflict beats over-limit. */
function refusal(violations: ArmViolation[]): IntakeError {
  const codes = violations.map((v) => v.code);
  const summary = [...new Set(codes)].join(", ");
  if (codes.some((c) => !CONFLICT.has(c) && !LIMIT.has(c)))
    return new IntakeError(400, "bad_request", `armed order refused: ${summary}`, violations);
  if (codes.some((c) => CONFLICT.has(c))) return new IntakeError(409, "conflict", `armed order refused: ${summary}`, violations);
  return new IntakeError(422, "limit_exceeded", `armed order refused: ${summary}`, violations);
}

const wire = (v: ArmedViolation): ArmViolation => ({
  code: v.code,
  orderId: v.orderId,
  message: v.message,
  ...(v.variantId ? { variantId: v.variantId } : {}),
});

/** Serializes async work per key. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface IntakeDeps {
  engine: OrderEngine;
  repo: ArmedOrdersRepo;
  chain: ChainReader;
  /** True when `address` is the user's main wallet or one of their trading wallets. */
  ownsWallet(userId: string, address: string): Promise<boolean>;
  /** The user's per-trade cap in SOL (settings maxTradeSol). */
  maxTradeSol(userId: string): Promise<number>;
  halt?: HaltSource | null;
  /** Initial trigger state (a migration snipe on a coin that already migrated starts as migrated). */
  initialState(order: ArmedOrder): { migrated?: boolean };
  now: () => number;
}

/** Armed-at times further ahead than this are refused (clock skew allowance). */
const FUTURE_SKEW_MS = 5 * 60_000;

export class OrderIntake {
  private readonly locks = new KeyedMutex();

  constructor(private readonly d: IntakeDeps) {}

  /** Lamports cap of one armed buy for this user: the server cap or the user's maxTradeSol, whichever is lower. */
  async userBuyCap(userId: string): Promise<bigint> {
    const sol = await this.d.maxTradeSol(userId);
    const user = Number.isFinite(sol) && sol > 0 ? BigInt(Math.floor(sol * 1e9)) : 0n;
    const server = this.d.engine.cfg.maxBuyLamports;
    return user < server ? user : server;
  }

  /**
   * The wallet's derived nonce slots 0..count-1 as they stand on chain, and which of them this user's open
   * orders hold. The browser arms against `ready` slots and creates `absent` ones.
   */
  async probeSlots(userId: string, wallet: string, count: number): Promise<NonceProbeResponse> {
    if (!(await this.d.ownsWallet(userId, wallet))) {
      throw new IntakeError(403, "forbidden", `wallet ${wallet} is not one of your wallets (register the trading wallet first)`);
    }
    const addresses = await nonceSlotAddresses(wallet as Address, count);
    let read: Awaited<ReturnType<ChainReader["accounts"]>>;
    try {
      read = await this.d.chain.accounts(addresses);
    } catch (e) {
      throw new IntakeError(503, "unavailable", `cannot read the nonce accounts right now (${e instanceof Error ? e.message : e}); retry`);
    }
    const held = new Map((await this.d.repo.slots(userId)).filter((s) => s.status === "in-use").map((s) => [s.nonceAccount, s.orderId]));
    const slots = addresses.map((nonceAccount, index): NonceSlotProbe => {
      const raw = read.accounts[index] ?? null;
      const snap = nonceSnapshot(raw);
      const state: NonceProbeState = snap ? (snap.authority === wallet ? "ready" : "foreign") : raw ? "occupied" : "absent";
      return {
        index,
        nonceAccount,
        state,
        nonceValue: snap?.value ?? null,
        lamports: raw ? raw.lamports.toString() : null,
        orderId: held.get(nonceAccount) ?? null,
      };
    });
    return { wallet, slot: read.slot, slots };
  }

  /** Validates and stores `orders` for `userId`; returns their views. Throws IntakeError on refusal. */
  async arm(userId: string, orders: ArmedOrder[]): Promise<Order[]> {
    if (this.d.halt?.isHalted()) throw new IntakeError(503, "halted", "trading is halted: armed orders are not accepted");
    return this.locks.run(userId, () => this.armLocked(userId, orders));
  }

  private async armLocked(userId: string, orders: ArmedOrder[]): Promise<Order[]> {
    const { engine } = this.d;
    const now = this.d.now();

    // 1. ownership
    for (const wallet of new Set(orders.map((o) => o.wallet))) {
      if (!(await this.d.ownsWallet(userId, wallet))) {
        throw new IntakeError(403, "forbidden", `wallet ${wallet} is not one of your wallets (register the trading wallet first)`, [
          {
            code: "wallet-not-yours",
            orderId: orders.find((o) => o.wallet === wallet)?.id ?? "*",
            message: `wallet ${wallet} is not yours`,
          },
        ]);
      }
    }

    // 2 + 3. signed bytes and server policy
    const tables = engine.lookupTables();
    if (!tables && engine.cfg.lookupTables.length) {
      throw new IntakeError(503, "unavailable", "the operator lookup tables are not loaded yet; retry in a moment");
    }
    const contents: AddressesByLookupTableAddress = tables ?? {};
    const policy = engine.policy();
    const userCap = await this.userBuyCap(userId);
    const violations: ArmViolation[] = [];
    for (const o of orders) {
      if (o.armedAtMs > now + FUTURE_SKEW_MS) {
        violations.push({ code: "armed-in-future", orderId: o.id, message: `armedAtMs ${o.armedAtMs} is in the future` });
      }
      try {
        await assertArmable(o, {
          lookupTables: contents,
          tipAccounts: [...reviewedTipAccounts("jito"), ...reviewedTipAccounts("helius")],
          policy,
        });
      } catch (e) {
        if (!(e instanceof ArmedOrderRejected)) throw e;
        violations.push(...e.violations.map(wire));
      }
      violations.push(...serverRules(o, contents, userCap));
    }
    if (violations.length) throw refusal(violations);

    // 4. nonces are live at the signed value, with the wallet as authority
    const accounts = [...new Set(orders.flatMap((o) => o.attempts.map((a) => a.nonce.account as string)))];
    let snaps: Awaited<ReturnType<ChainReader["accounts"]>>;
    try {
      snaps = await this.d.chain.accounts(accounts);
    } catch (e) {
      throw new IntakeError(503, "unavailable", `cannot read the nonce accounts right now (${e instanceof Error ? e.message : e}); retry`);
    }
    const live = new Map(accounts.map((a, i) => [a, nonceSnapshot(snaps.accounts[i] ?? null)]));
    for (const o of orders) {
      for (const a of o.attempts) {
        const s = live.get(a.nonce.account);
        if (!s)
          violations.push({
            code: "nonce-missing",
            orderId: o.id,
            message: `nonce account ${a.nonce.account} does not exist or is not initialized`,
          });
        else if (s.authority !== o.wallet)
          violations.push({
            code: "nonce-authority",
            orderId: o.id,
            message: `nonce ${a.nonce.account} authority is ${s.authority}, not the wallet`,
          });
        else if (s.value !== a.nonce.value) {
          violations.push({
            code: "nonce-stale",
            orderId: o.id,
            message: `nonce ${a.nonce.account} is at ${s.value}, the order was signed against ${a.nonce.value}: re-arm`,
          });
        }
      }
    }
    if (violations.length) throw refusal(violations);

    // 5. nonce slots of other accounts
    const taken = await this.d.repo.slotsOwnedByOthers(userId, accounts);
    if (taken.length) {
      throw refusal(
        taken.map((a) => ({ code: "nonce-slot-taken", orderId: "*", message: `nonce account ${a} belongs to another account` })),
      );
    }

    // 6. the user's book: notional cap, nonce sharing, OCO groups
    const ids = new Set(orders.map((o) => o.id));
    const book = validateUserArmedOrders([...engine.openOrdersOf(userId), ...orders], policy)
      .filter((v) => v.orderId === "*" || ids.has(v.orderId))
      .map(wire);
    if (book.length) throw refusal(book);

    // 7. store atomically, then watch
    let stored: Awaited<ReturnType<ArmedOrdersRepo["insertBatch"]>>;
    try {
      stored = await this.d.repo.insertBatch(
        userId,
        orders.map((order) => ({ order, triggerState: this.d.initialState(order) })),
        { now, maxActive: engine.cfg.maxOpenPerUser },
      );
    } catch (e) {
      if (e instanceof LimitExceededError) {
        throw new IntakeError(422, "limit_exceeded", e.message, [{ code: "open-orders-cap", orderId: "*", message: e.message }]);
      }
      if (e instanceof NonceSlotTakenError) {
        throw refusal(
          e.accounts.map((a) => ({ code: "nonce-slot-taken", orderId: "*", message: `nonce account ${a} belongs to another account` })),
        );
      }
      if (isUniqueViolation(e))
        throw new IntakeError(409, "conflict", "an order with this id already exists", [
          { code: "duplicate-order", orderId: "*", message: "order id already exists" },
        ]);
      throw e;
    }
    return engine.admit(stored);
  }
}

/** Server rules beyond core's validators (see the module comment). */
export function serverRules(o: ArmedOrder, tables: AddressesByLookupTableAddress, userBuyCap: bigint): ArmViolation[] {
  const out: ArmViolation[] = [];
  const add = (code: string, message: string, variantId?: string) =>
    out.push({ code, orderId: o.id, message, ...(variantId ? { variantId } : {}) });
  const known = new Set(Object.keys(tables));
  for (const t of o.frozen.lookupTables) if (!known.has(t)) add("lookup-table-unknown", `lookup table ${t} is not an operator table`);
  const declared = new Set<string>(o.frozen.lookupTables);
  const usesTables = (wire: string) => {
    try {
      return inspectArmedTransaction(wire).lookupTables;
    } catch {
      return [] as Address[]; // undecodable bytes are reported by assertArmable
    }
  };
  for (const a of o.attempts) {
    for (const t of usesTables(a.nonce.cancel.wireBase64))
      if (!declared.has(t)) add("lookup-table-undeclared", `attempt ${a.index} cancel loads from undeclared table ${t}`);
    for (const v of a.variants) {
      for (const t of usesTables(v.tx.wireBase64))
        if (!declared.has(t)) add("lookup-table-undeclared", `loads from undeclared table ${t}`, v.id);
      if (tipsOf(v.tx.wireBase64).jito < JITO_MIN_TIP_LAMPORTS) {
        add(
          "jito-tip-missing",
          `armed variants go Jito bundle-only and must tip a Jito tip account at least ${JITO_MIN_TIP_LAMPORTS} lamports`,
          v.id,
        );
      }
      let marker = false;
      try {
        marker = inspectArmedTransaction(v.tx.wireBase64).staticAccounts.includes(JITO_DONT_FRONT);
      } catch {
        marker = true; // undecodable: assertArmable reports it
      }
      if (!marker) add("dontfront-missing", "armed variants must carry the read-only jitodontfront marker", v.id);
    }
  }
  const wantTokens = o.side === "sell" ? o.amount : 0n;
  if (o.reservation.tokens !== wantTokens)
    add("reservation-mismatch", `reservation holds ${o.reservation.tokens} tokens, expected ${wantTokens}`);
  const floor = computeReservation({ side: o.side, mint: o.mint, amount: o.amount, attempts: o.attempts });
  if (o.reservation.lamports < floor.lamports) {
    add("reservation-too-low", `reservation of ${o.reservation.lamports} lamports is below the worst case ${floor.lamports}`);
  }
  if (o.side === "buy" && o.frozen.quoteMint === WSOL_MINT && o.amount > userBuyCap) {
    add(
      "user-buy-cap",
      `armed buy of ${o.amount} lamports is above your per-trade cap of ${userBuyCap} lamports (${Number(userBuyCap) / Number(LAMPORTS_PER_SOL)} SOL)`,
    );
  }
  return out;
}
