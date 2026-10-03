/**
 * Tip instructions for landing lanes. Tips always go INSIDE the trade transaction (Jito: standalone
 * tip txs risk "uncle bandit"; Sender: a tip transfer is mandatory). One random tip account per tx.
 *   Helius Sender: https://www.helius.dev/docs/sending-transactions/sender
 *   Jito:          https://docs.jito.wtf/lowlatencytxnsend/
 */
import type { Address, Instruction } from "@solana/kit";
import {
  HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS,
  HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_DONT_FRONT,
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
} from "../constants";
import { systemTransferInstruction } from "../token";
import { pickRandom } from "../util/random";

export type TipLane = "helius" | "jito";

export interface TipSpec {
  lane: TipLane;
  lamports: bigint;
  /** Explicit tip account; otherwise one is picked at random from `tipAccounts` / the lane list. */
  tipAccount?: Address;
}

export function minTipFor(lane: TipLane, heliusMode: "swqos" | "max" = "swqos"): bigint {
  if (lane === "jito") return JITO_MIN_TIP_LAMPORTS;
  return heliusMode === "max" ? HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS : HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS;
}

export interface TipAccountSets {
  helius?: readonly Address[];
  /** Live list from Jito getTipAccounts (send/jito.ts); falls back to the documented list. */
  jito?: readonly Address[];
}

export function resolveTipAccount(spec: TipSpec, sets: TipAccountSets = {}): Address {
  if (spec.tipAccount) return spec.tipAccount;
  if (spec.lane === "helius") return pickRandom(sets.helius?.length ? sets.helius : HELIUS_SENDER_TIP_ACCOUNTS);
  return pickRandom(sets.jito?.length ? sets.jito : JITO_TIP_ACCOUNTS_FALLBACK);
}

/**
 * SOL transfer to a lane's tip account. `jitoDontFront` appends the read-only `jitodontfront…`
 * marker to this instruction's account list (the System program ignores extra accounts), which
 * keeps the swap instruction's positional remaining accounts untouched.
 */
export function tipInstruction(args: { from: Address; spec: TipSpec; tipAccounts?: TipAccountSets; jitoDontFront?: boolean }): Instruction {
  if (args.spec.lamports <= 0n) throw new RangeError("tip must be > 0");
  return systemTransferInstruction({
    from: args.from,
    to: resolveTipAccount(args.spec, args.tipAccounts),
    lamports: args.spec.lamports,
    extraReadonly: args.jitoDontFront ? [JITO_DONT_FRONT] : [],
  });
}

export function isHeliusTipAccount(a: Address): boolean {
  return HELIUS_SENDER_TIP_ACCOUNTS.includes(a);
}
