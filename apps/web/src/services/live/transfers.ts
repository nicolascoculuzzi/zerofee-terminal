/**
 * SOL transfers between the connected wallet and a trading wallet, and POST /api/tx.
 *
 * Built with @zerofee/core like a trade: compute budget, the System transfer, and the Helius Sender tip
 * the Reduced landing preset needs (Sender refuses a transaction without one). A withdrawal is signed by
 * the trading wallet in the signer, whose firewall allows SOL only to the connected wallet bound into the
 * vault and to reviewed tip accounts; a deposit is signed by the connected wallet's own popup. Either way
 * the signed bytes go to the server, which simulates them while DRY_RUN is on and sends nothing.
 */
import type { Address, Blockhash } from "@solana/kit";
import { getTransactionEncoder } from "@solana/kit";
import { assembleTransaction, HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS, systemTransferInstruction } from "@zerofee/core";
import type { ChainState, LandingPreset, TxSubmitRequest, TxSubmitResponse } from "@zerofee/protocol";
import { api } from "./api";
import { toBase64 } from "./bytes";

/** Two System transfers and two compute-budget instructions use well under 1,000 CU. */
const TRANSFER_CU_LIMIT = 3_000;

export class TransferError extends Error {}

export function recentBlockhash(chain: ChainState | null): { blockhash: Blockhash; lastValidBlockHeight: bigint } {
  if (!chain?.blockhash || chain.lastValidBlockHeight === null) {
    throw new TransferError("No recent blockhash from the server yet. Try again in a moment.");
  }
  return { blockhash: chain.blockhash as Blockhash, lastValidBlockHeight: BigInt(chain.lastValidBlockHeight) };
}

/** CU price (micro-lamports): the live p75 estimate, at least 1 (Sender needs a non-zero price). */
export function cuPriceFrom(chain: ChainState | null): bigint {
  const p75 = chain?.priorityFees?.p75 ?? 0;
  return BigInt(Math.max(1, Math.ceil(p75)));
}

/** Unsigned v0 wire transaction moving `lamports` from `from` (fee payer) to `to`, with the Sender tip. */
export function buildSolTransfer(args: { from: string; to: string; lamports: bigint; chain: ChainState | null }): Uint8Array {
  if (args.lamports <= 0n) throw new TransferError("Enter an amount");
  const tx = assembleTransaction({
    feePayer: args.from as Address,
    instructions: [systemTransferInstruction({ from: args.from as Address, to: args.to as Address, lamports: args.lamports })],
    blockhash: recentBlockhash(args.chain),
    fees: {
      cuLimit: TRANSFER_CU_LIMIT,
      cuPriceMicroLamports: cuPriceFrom(args.chain),
      tips: [{ lane: "helius", lamports: HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS }],
      jitoDontFront: false,
    },
  });
  return new Uint8Array(getTransactionEncoder().encode(tx));
}

/** Network cost of a transfer built above (base fee + tip + priority fee), SOL. */
export function transferCostSol(chain: ChainState | null): number {
  const priority = (cuPriceFrom(chain) * BigInt(TRANSFER_CU_LIMIT)) / 1_000_000n;
  return Number(5_000n + HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS + priority) / 1e9;
}

/** POST /api/tx with signed bytes. A DRY_RUN server simulates; a failed simulation becomes an error. */
export async function submitSigned(wire: Uint8Array, preset: LandingPreset, clientSentAt = Date.now()): Promise<TxSubmitResponse> {
  const body: TxSubmitRequest = { tx: toBase64(wire), preset, clientSentAt };
  return api<TxSubmitResponse>("/api/tx", { method: "POST", body });
}

/** Short reason for a simulation error object ({ InstructionError: [2, { Custom: 6003 }] } ...). */
export function simulationError(err: unknown, logs: readonly string[]): string {
  const failed = logs.find((l) => /failed:|Error:/i.test(l));
  if (failed) return failed.replace(/^Program \S+ /, "");
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
