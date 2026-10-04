/**
 * v0 transaction assembly with @solana/kit. Layout:
 *   [SetComputeUnitLimit, SetComputeUnitPrice, ...trade instructions, ...tip transfers]
 * Signing uses a WebCrypto Ed25519 CryptoKeyPair (works unchanged in browsers and Bun) - the
 * browser-held trading wallet signs with no popup; the server never sees the key.
 */
import {
  type Address,
  type AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Transaction,
} from "@solana/kit";
import { PACKET_DATA_SIZE } from "../constants";
import { setComputeUnitLimitInstruction, setComputeUnitPriceInstruction } from "./computeBudget";
import { compressKeepingStatic, firewallStaticAccounts } from "./lookupTables";
import type { FeePlan } from "./policy";
import { type TipAccountSets, tipInstruction } from "./tip";

export interface BlockhashInfo {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
}

export interface AssembleParams {
  feePayer: Address;
  instructions: readonly Instruction[];
  blockhash: BlockhashInfo;
  fees: Pick<FeePlan, "cuLimit" | "cuPriceMicroLamports" | "tips" | "jitoDontFront">;
  tipAccounts?: TipAccountSets;
  /**
   * Lookup tables the trade needs (BuiltTrade.lookupTables, Jupiter routes). Accounts the signer firewall
   * requires as static keys stay static (tx/lookupTables.ts); the signer must be handed the same tables.
   */
  lookupTables?: AddressesByLookupTableAddress;
}

/** Full ordered instruction list (compute budget + trade + tips). */
export function withBudgetAndTips(p: Omit<AssembleParams, "blockhash">): Instruction[] {
  const tips = p.fees.tips.map((spec, i) =>
    tipInstruction({
      from: p.feePayer,
      spec,
      tipAccounts: p.tipAccounts,
      // The marker only matters on the Jito path; attach it once, to the first Jito tip.
      jitoDontFront: p.fees.jitoDontFront && spec.lane === "jito" && p.fees.tips.findIndex((t) => t.lane === "jito") === i,
    }),
  );
  return [
    setComputeUnitLimitInstruction(p.fees.cuLimit),
    setComputeUnitPriceInstruction(p.fees.cuPriceMicroLamports),
    ...p.instructions,
    ...tips,
  ];
}

export function assembleTransaction(p: AssembleParams): Transaction {
  const instructions = withBudgetAndTips(p);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(p.feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(p.blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
    (m) => compressKeepingStatic(m, p.lookupTables, firewallStaticAccounts(p.feePayer, instructions, p.tipAccounts)),
  );
  const tx = compileTransaction(message);
  const size = transactionSize(tx);
  if (size > PACKET_DATA_SIZE) throw new Error(`transaction too large: ${size} > ${PACKET_DATA_SIZE} bytes`);
  return tx;
}

/** Signs with a WebCrypto Ed25519 key pair (non-extractable keys are fine). */
export async function signAssembled(tx: Transaction, keyPair: CryptoKeyPair): Promise<Transaction> {
  return signTransaction([keyPair], tx);
}

export function transactionSize(tx: Transaction): number {
  return getTransactionEncoder().encode(tx).length;
}

/** Base64 wire format (missing signatures are encoded as zero bytes - fine for sigVerify:false simulation). */
export function toWireBase64(tx: Transaction): string {
  return getBase64EncodedWireTransaction(tx);
}

/** Fee-payer signature (base58) - the tx id, known before sending. Null if not yet signed. */
export function feePayerSignature(tx: Transaction, feePayer: Address): string | null {
  const sig = tx.signatures[feePayer];
  return sig ? getBase58Decoder().decode(sig) : null;
}
