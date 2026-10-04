/**
 * Checks shared by the venue rules (Raydium LaunchLab / CPMM, Jupiter): instruction selection by
 * discriminator, static-key requirements, the trading wallet's own token accounts, fixed and derived
 * accounts, and which side of a two-mint swap is the quote asset (and therefore the capped spend).
 */
import { type Address, getAddressEncoder, getProgramDerivedAddress, type ReadonlyUint8Array } from "@solana/kit";
import { startsWith, toHex } from "../../bytes";
import { TOKEN_PROGRAMS, WSOL_MINT } from "../programs";
import type { AccountRef, DecodedInstruction, FirewallCaps, RuleEnv } from "../types";
import { where } from "./common";

export const addressEncoder = getAddressEncoder();
export const utf8 = (text: string) => new TextEncoder().encode(text);
export const key = (address: Address) => addressEncoder.encode(address);

export async function findPda(programAddress: Address, seeds: ReadonlyUint8Array[]): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds });
  return pda;
}

export const hasCap = (caps: FirewallCaps, mint: string) => Object.hasOwn(caps.maxBuyQuote, mint);
/** wSOL, or a mint the user configured a per-trade cap for: what a buy may spend. */
export const isQuoteAsset = (caps: FirewallCaps, mint: Address) => mint === WSOL_MINT || hasCap(caps, mint);

/** One instruction under check: its label for violations, its accounts and the violations so far. */
export interface Check {
  readonly label: string;
  readonly core: readonly AccountRef[];
  readonly env: RuleEnv;
  readonly violations: string[];
}

/** The payer is the trading wallet (signing), and the trading wallet appears in no other position. */
export function checkPayer(c: Check, payerIndex: number): void {
  const { signer } = c.env.ctx;
  const payer = c.core[payerIndex]!;
  if (payer.address !== signer || !payer.isSigner) c.violations.push(`${c.label}: user must be the trading wallet`);
  c.core.forEach((account, i) => {
    if (i !== payerIndex && account.address === signer)
      c.violations.push(`${c.label}: trading wallet used in an unexpected position (${i})`);
  });
}

/** Mints pick the cap and the user's token accounts, so their identity must not come from lookup-table data. */
export function staticMint(c: Check, index: number, what: string): Address {
  const ref = c.core[index]!;
  if (!ref.isStatic) c.violations.push(`${c.label}: ${what} must be a static account key, not loaded from a lookup table`);
  return ref.address;
}

/**
 * The token program at `programIndex` is SPL Token or Token-2022 (static: the venue CPIs into it with
 * the user's signature), and the account at `accountIndex` is the trading wallet's ATA for `mint` under it.
 */
export async function checkUserTokenAccount(c: Check, accountIndex: number, mint: Address, programIndex: number): Promise<void> {
  const tokenProgram = c.core[programIndex]!;
  if (!tokenProgram.isStatic || !TOKEN_PROGRAMS.includes(tokenProgram.address)) {
    c.violations.push(`${c.label}: token program at position ${programIndex} must be SPL Token or Token-2022 (static key)`);
    return;
  }
  const account = c.core[accountIndex]!;
  const expected = await c.env.ata(c.env.ctx.signer, mint, tokenProgram.address);
  if (account.address !== expected) {
    c.violations.push(
      `${c.label}: token account at position ${accountIndex} must be the trading wallet's associated token account for ${mint}`,
    );
  } else if (!account.isStatic) {
    // The runtime resolves a looked-up key from the real table, which need not hold what we were told.
    c.violations.push(
      `${c.label}: token account at position ${accountIndex} must be the trading wallet's associated token account for ${mint} as a static key, not loaded from a lookup table`,
    );
  }
}

export const NOT_STATIC = "must be a static account key, not loaded from a lookup table";

/** The account at `index` is exactly `expected`, as a static key. `what` names it in the violation. */
export function checkFixed(c: Check, index: number, expected: Address, what: string, why = ""): void {
  const ref = c.core[index]!;
  const reason = why ? ` (${why})` : "";
  if (ref.address !== expected) c.violations.push(`${c.label}: position ${index} must be ${what}, not ${ref.address}${reason}`);
  else if (!ref.isStatic) c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC}${reason}`);
}

/** The account at `index` is the derivation `expected` (described by `pda`), as a static key. */
export function checkDerived(c: Check, index: number, expected: Address, what: string, pda: string): void {
  const ref = c.core[index]!;
  if (ref.address !== expected) {
    c.violations.push(`${c.label}: ${what} ${ref.address} at position ${index} is not ${pda} (expected ${expected})`);
  } else if (!ref.isStatic) {
    c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC}`);
  }
}

/** An account used as a derivation seed must be the account the program will actually load. */
export function checkStaticSeed(c: Check, index: number, what: string, seeds: string): void {
  if (!c.core[index]!.isStatic) c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC} (it seeds ${seeds})`);
}

/** Common prologue: program, discriminator (unknown instructions are refused by name), label. */
export function select<T extends { readonly name: string; readonly discriminator: readonly number[] }>(
  ix: DecodedInstruction,
  programId: Address,
  name: string,
  defs: readonly { def: T; bytes: Uint8Array }[],
  instructionNames: Readonly<Record<string, string>>,
): { def: T; label: string } | { refusal: string } {
  const base = where(ix, name);
  if (ix.programAddress !== programId) return { refusal: `${base}: rule applied to the wrong program` };
  if (ix.data.length < 8) return { refusal: `${base}: instruction data too short` };
  const def = defs.find((d) => startsWith(ix.data, d.bytes))?.def;
  if (!def) {
    const hex = toHex(ix.data.subarray(0, 8));
    const allowed = defs.map((d) => d.def.name).join(", ");
    return { refusal: `${base}: instruction "${instructionNames[hex] ?? `unknown ${hex}`}" is not allowed (only ${allowed})` };
  }
  return { def, label: `${base} ${def.name}` };
}

export const withBytes = <T extends { readonly discriminator: readonly number[] }>(defs: readonly T[]) =>
  defs.map((def) => ({ def, bytes: Uint8Array.from(def.discriminator) }));

export interface SwapDirection {
  readonly side: "buy" | "sell";
  readonly baseMint: Address;
  readonly quoteMint: Address;
}

/** Spending wSOL (then a capped quote mint) is a buy of the other mint; receiving it is a sell. */
export function swapDirection(caps: FirewallCaps, inputMint: Address, outputMint: Address): SwapDirection | undefined {
  if (inputMint === WSOL_MINT) return { side: "buy", baseMint: outputMint, quoteMint: inputMint };
  if (outputMint === WSOL_MINT) return { side: "sell", baseMint: inputMint, quoteMint: outputMint };
  if (hasCap(caps, inputMint)) return { side: "buy", baseMint: outputMint, quoteMint: inputMint };
  if (hasCap(caps, outputMint)) return { side: "sell", baseMint: inputMint, quoteMint: outputMint };
  return undefined;
}
