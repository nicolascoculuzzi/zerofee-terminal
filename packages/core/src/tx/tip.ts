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
  /** Live list from Jito getTipAccounts (send/jito.ts). Used only to skip retired accounts. */
  jito?: readonly Address[];
}

/** The reviewed tip accounts per lane. The signer firewall embeds the same lists and refuses any other. */
export function reviewedTipAccounts(lane: TipLane): readonly Address[] {
  return lane === "helius" ? HELIUS_SENDER_TIP_ACCOUNTS : JITO_TIP_ACCOUNTS_FALLBACK;
}

/**
 * Tip accounts come only from the reviewed lists. A live list can narrow the choice (skipping an
 * account the lane retired) but never add one: an unreviewed account would be refused by the signer,
 * and trusting a fetched list would let whoever serves it redirect tips.
 */
export function resolveTipAccount(spec: TipSpec, sets: TipAccountSets = {}): Address {
  const reviewed = reviewedTipAccounts(spec.lane);
  if (spec.tipAccount) {
    if (!reviewed.includes(spec.tipAccount)) throw new Error(`tip account ${spec.tipAccount} is not a reviewed ${spec.lane} tip account`);
    return spec.tipAccount;
  }
  const live = spec.lane === "helius" ? sets.helius : sets.jito;
  const usable = live?.length ? reviewed.filter((a) => live.includes(a)) : reviewed;
  return pickRandom(usable.length ? usable : reviewed);
}

/** Live accounts missing from the reviewed list: a drift alarm (update constants and the signer together). */
export function unreviewedTipAccounts(lane: TipLane, live: readonly Address[]): Address[] {
  const reviewed = reviewedTipAccounts(lane);
  return live.filter((a) => !reviewed.includes(a));
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
