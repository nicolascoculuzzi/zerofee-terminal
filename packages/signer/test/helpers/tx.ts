/**
 * Transaction assembly for tests with @solana/kit (the same library core uses), plus the official
 * @solana-program/* builders for System / Token / Compute Budget instructions. Using the official
 * encoders here means the firewall's hand-written decoders are tested against real encodings.
 */

import {
  type AccountMeta,
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  type Instruction,
  type Nonce,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLifetimeUsingDurableNonce,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCloseAccountInstruction, getCreateAssociatedTokenIdempotentInstruction, getSyncNativeInstruction } from "@solana-program/token";
import { randomBytes } from "../../src/bytes";
import { findAssociatedTokenAddress } from "../../src/firewall/ata";
import { TOKEN_PROGRAM, WSOL_MINT } from "../../src/firewall/programs";
import { JITO_DONT_FRONT } from "./fixtures";

export const noop = (address: Address) => createNoopSigner(address);

export function randomBlockhash(): Blockhash {
  return getBase58Decoder().decode(randomBytes(32)) as Blockhash;
}

export interface BuildOptions {
  feePayer: Address;
  instructions: readonly Instruction[];
  version?: "legacy" | 0;
  /** Accounts found in these tables (non-signer, non-program) are loaded through ALTs. v0 only. */
  lookupTables?: Record<Address, Address[]>;
  durableNonce?: { nonceAccount: Address; authority: Address; nonce?: string };
}

/** Compiles to wire bytes with empty signature slots (what the backend would hand the signer). */
export function buildTransaction(options: BuildOptions): Uint8Array {
  const version = options.version ?? 0;
  const base = setTransactionMessageFeePayer(options.feePayer, createTransactionMessage({ version }));
  const withLifetime = options.durableNonce
    ? setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: (options.durableNonce.nonce ?? randomBlockhash()) as string as Nonce,
          nonceAccountAddress: options.durableNonce.nonceAccount,
          nonceAuthorityAddress: options.durableNonce.authority,
        },
        base,
      )
    : setTransactionMessageLifetimeUsingBlockhash({ blockhash: randomBlockhash(), lastValidBlockHeight: 0n }, base);
  let message = appendTransactionMessageInstructions(options.instructions, withLifetime);
  if (options.lookupTables) {
    if (version !== 0) throw new Error("lookup tables need a v0 message");
    message = compressTransactionMessageUsingAddressLookupTables(
      message as Parameters<typeof compressTransactionMessageUsingAddressLookupTables>[0],
      options.lookupTables,
    ) as typeof message;
  }
  return new Uint8Array(getTransactionEncoder().encode(compileTransaction(message as Parameters<typeof compileTransaction>[0])));
}

// ---- common instructions (official encoders) ----

export function computeBudget(units: number, microLamports: bigint): Instruction[] {
  return [getSetComputeUnitLimitInstruction({ units }), getSetComputeUnitPriceInstruction({ microLamports })];
}

export function transferSol(from: Address, to: Address, amount: bigint): Instruction {
  return getTransferSolInstruction({ source: noop(from), destination: to, amount });
}

/** Tip transfer with the jitodontfront marker appended read-only, exactly as @zerofee/core does. */
export function tipWithDontFront(
  from: Address,
  to: Address,
  amount: bigint,
  marker: AccountMeta = { address: JITO_DONT_FRONT, role: AccountRole.READONLY },
): Instruction {
  const ix = transferSol(from, to, amount);
  return { ...ix, accounts: [...(ix.accounts ?? []), marker] };
}

export async function createAtaIdempotent(
  payer: Address,
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM,
): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstruction({
    payer: noop(payer),
    ata: await findAssociatedTokenAddress(owner, mint, tokenProgram),
    owner,
    mint,
    tokenProgram,
  });
}

export async function wsolAta(owner: Address): Promise<Address> {
  return findAssociatedTokenAddress(owner, WSOL_MINT, TOKEN_PROGRAM);
}

/** Wrap: create wSOL ATA, transfer lamports in, SyncNative. */
export async function wrapSol(owner: Address, lamports: bigint): Promise<Instruction[]> {
  const account = await wsolAta(owner);
  return [await createAtaIdempotent(owner, owner, WSOL_MINT), transferSol(owner, account, lamports), getSyncNativeInstruction({ account })];
}

/** Unwrap: close the wSOL ATA back to the owner. */
export async function unwrapSol(owner: Address): Promise<Instruction> {
  return getCloseAccountInstruction({ account: await wsolAta(owner), destination: owner, owner: noop(owner) });
}

/** Appends extra accounts to an instruction. */
export function withExtraAccounts(ix: Instruction, ...extra: AccountMeta[]): Instruction {
  return { ...ix, accounts: [...(ix.accounts ?? []), ...extra] };
}
