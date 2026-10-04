/**
 * SPL Token / Token-2022 / ATA / System helpers: PDA derivation, the handful of instructions the
 * trade path needs, and raw account decoders. Token-2022 aware: always pass the token program that
 * OWNS the mint (read it from the mint account owner; never infer from the mint suffix - notes §7).
 */
import { AccountRole, type Address, getProgramDerivedAddress, type Instruction } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants";
import { decodeToken2022MintExtensions, type Token2022Extensions } from "./token2022";
import { addressBytes, concatBytes, Reader, u32le, u64le } from "./util/bytes";

export type TokenProgram = typeof TOKEN_PROGRAM_ID | typeof TOKEN_2022_PROGRAM_ID;

export function isTokenProgram(owner: Address): owner is TokenProgram {
  return owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
}

/** Validates a mint account owner and returns it as the token program to use. */
export function tokenProgramFromMintOwner(owner: Address): TokenProgram {
  if (!isTokenProgram(owner)) throw new Error(`mint owner ${owner} is not an SPL token program`);
  return owner;
}

/** ATA = PDA([owner, token_program, mint], ATA program). */
export async function findAssociatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    seeds: [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
  });
  return ata;
}

/** ATA program `CreateIdempotent` (discriminator 1). Safe to include in every buy. */
export function createAtaIdempotentInstruction(args: {
  payer: Address;
  ata: Address;
  owner: Address;
  mint: Address;
  tokenProgram: Address;
}): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
      { address: args.ata, role: AccountRole.WRITABLE },
      { address: args.owner, role: AccountRole.READONLY },
      { address: args.mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
      { address: args.tokenProgram, role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]),
  };
}

/** Token `SyncNative` (17) - after funding a wSOL ATA with lamports. */
export function syncNativeInstruction(account: Address, tokenProgram: Address = TOKEN_PROGRAM_ID): Instruction {
  return {
    programAddress: tokenProgram,
    accounts: [{ address: account, role: AccountRole.WRITABLE }],
    data: new Uint8Array([17]),
  };
}

/** Token `CloseAccount` (9) - unwrap wSOL / reclaim rent on full exits. */
export function closeAccountInstruction(args: {
  account: Address;
  destination: Address;
  owner: Address;
  tokenProgram?: Address;
}): Instruction {
  return {
    programAddress: args.tokenProgram ?? TOKEN_PROGRAM_ID,
    accounts: [
      { address: args.account, role: AccountRole.WRITABLE },
      { address: args.destination, role: AccountRole.WRITABLE },
      { address: args.owner, role: AccountRole.READONLY_SIGNER },
    ],
    data: new Uint8Array([9]),
  };
}

/** System `Transfer` (2). Extra read-only accounts may be appended (used for the jitodontfront marker). */
export function systemTransferInstruction(args: {
  from: Address;
  to: Address;
  lamports: bigint;
  extraReadonly?: readonly Address[];
}): Instruction {
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: args.from, role: AccountRole.WRITABLE_SIGNER },
      { address: args.to, role: AccountRole.WRITABLE },
      ...(args.extraReadonly ?? []).map((a) => ({ address: a, role: AccountRole.READONLY })),
    ],
    data: concatBytes(u32le(2), u64le(args.lamports)),
  };
}

export interface MintInfo {
  supply: bigint;
  decimals: number;
  tokenProgram: TokenProgram;
  /** Token-2022 extensions (transfer fee, hook, pausable); empty for SPL Token mints. */
  extensions: Token2022Extensions;
}

/** Decodes the 82-byte base mint layout (Token and Token-2022 share it) plus Token-2022 extensions. */
export function decodeMint(data: Uint8Array, owner: Address): MintInfo {
  if (data.length < 82) throw new Error(`mint account too short (${data.length})`);
  const r = new Reader(data, 36);
  const supply = r.u64();
  const decimals = r.u8();
  const tokenProgram = tokenProgramFromMintOwner(owner);
  const extensions = decodeToken2022MintExtensions(tokenProgram === TOKEN_2022_PROGRAM_ID ? data : new Uint8Array(0));
  return { supply, decimals, tokenProgram, extensions };
}

/**
 * Refuses mints a plain swap cannot move: an active transfer hook (needs extra accounts the venue
 * does not pass), a paused mint, or a non-transferable mint.
 */
export function assertSwappableMint(mint: Address, info: Pick<MintInfo, "extensions">): void {
  const x = info.extensions;
  if (x.transferHookProgramId) throw new Error(`${mint} has an active transfer hook (${x.transferHookProgramId}); not supported`);
  if (x.paused) throw new Error(`${mint} is paused (Token-2022 pausable)`);
  if (x.nonTransferable) throw new Error(`${mint} is non-transferable`);
}

export interface TokenAccountInfo {
  mint: Address;
  owner: Address;
  amount: bigint;
}

/** Decodes the 165-byte base token-account layout (Token-2022 accounts extend it). */
export function decodeTokenAccount(data: Uint8Array): TokenAccountInfo {
  if (data.length < 165) throw new Error(`token account too short (${data.length})`);
  const r = new Reader(data);
  return { mint: r.pubkey(), owner: r.pubkey(), amount: r.u64() };
}
