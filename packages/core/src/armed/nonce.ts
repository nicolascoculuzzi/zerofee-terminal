/**
 * Durable-nonce slots for armed orders (System program, own encoders - no @solana-program/system).
 *
 * A slot is one nonce account whose authority is the user's trading wallet. Every transaction an
 * armed order pre-signs starts with `AdvanceNonceAccount` on its slot and uses the stored nonce as
 * its lifetime token, so it never expires; once ANY transaction on the slot lands (even one that
 * fails during execution - docs/experiments/nonce-failure) the nonce advances and every other
 * transaction signed against the old value is dead.
 *
 * Signer-firewall rules (packages/signer/src/firewall/rules/system.ts) shape this module:
 *  - the trading wallet is the only signer, so slots are created with `CreateAccountWithSeed`
 *    (base = wallet, owner = System, space = 80), immediately followed by `InitializeNonceAccount`
 *    with authority = wallet; plain `CreateAccount` would need the new account's own signature;
 *  - slot funding is capped (MAX_NONCE_SLOT_LAMPORTS, 0.002 SOL by default);
 *  - `WithdrawNonceAccount` may only pay the trading wallet or the connected wallet;
 *  - `AuthorizeNonceAccount` is refused (the encoder exists for operator-held or test slots).
 *
 * Layouts: https://github.com/anza-xyz/solana-sdk/blob/master/system-interface/src/instruction.rs
 *          https://github.com/anza-xyz/solana-sdk/blob/master/nonce/src/state.rs
 * Rent is read live (`getMinimumBalanceForRentExemption(80)`), never hardcoded.
 */
import {
  AccountRole,
  type Address,
  createAddressWithSeed,
  getBase58Decoder,
  type Instruction,
  type Nonce,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  DEFAULT_PUBKEY,
  MAX_NONCE_SLOT_LAMPORTS,
  MAX_SEED_LENGTH,
  NONCE_ACCOUNT_LENGTH,
  NONCE_SLOT_SEED_PREFIX,
  SYSTEM_IX,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RECENT_BLOCKHASHES_ID,
  SYSVAR_RENT_ID,
} from "../constants";
import { fetchRawAccounts } from "../state";
import { addressBytes, concatBytes, Reader, u32le, u64le, utf8 } from "../util/bytes";

const base58 = getBase58Decoder();

function systemIx(tag: number, accounts: Instruction["accounts"], ...data: Uint8Array[]): Instruction {
  return { programAddress: SYSTEM_PROGRAM_ID, accounts, data: concatBytes(u32le(tag), ...data) };
}

// ---------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------

/** `CreateAccountWithSeed` (3): only `payer` and `base` sign (`base` may be the payer). Seed is a bincode String. */
export function createAccountWithSeedInstruction(args: {
  payer: Address;
  newAccount: Address;
  base: Address;
  seed: string;
  lamports: bigint;
  space: number;
  owner: Address;
}): Instruction {
  const seed = utf8(args.seed);
  if (seed.length > MAX_SEED_LENGTH) throw new RangeError(`seed longer than ${MAX_SEED_LENGTH} bytes: ${args.seed}`);
  const accounts: Instruction["accounts"] = [
    { address: args.payer, role: AccountRole.WRITABLE_SIGNER },
    { address: args.newAccount, role: AccountRole.WRITABLE },
    ...(args.base === args.payer ? [] : [{ address: args.base, role: AccountRole.READONLY_SIGNER }]),
  ];
  return systemIx(
    SYSTEM_IX.createAccountWithSeed,
    accounts,
    addressBytes(args.base),
    u64le(BigInt(seed.length)),
    seed,
    u64le(args.lamports),
    u64le(BigInt(args.space)),
    addressBytes(args.owner),
  );
}

/** `InitializeNonceAccount` (6). The account must already hold rent-exempt lamports for 80 bytes. */
export function initializeNonceInstruction(args: { nonceAccount: Address; authority: Address }): Instruction {
  return systemIx(
    SYSTEM_IX.initializeNonceAccount,
    [
      { address: args.nonceAccount, role: AccountRole.WRITABLE },
      { address: SYSVAR_RECENT_BLOCKHASHES_ID, role: AccountRole.READONLY },
      { address: SYSVAR_RENT_ID, role: AccountRole.READONLY },
    ],
    addressBytes(args.authority),
  );
}

/**
 * `AdvanceNonceAccount` (4). Byte-identical to the advance kit prepends for a durable-nonce
 * lifetime. Alone in a transaction it is the armed order's pre-signed CANCEL.
 */
export function advanceNonceInstruction(args: { nonceAccount: Address; authority: Address }): Instruction {
  return systemIx(SYSTEM_IX.advanceNonceAccount, [
    { address: args.nonceAccount, role: AccountRole.WRITABLE },
    { address: SYSVAR_RECENT_BLOCKHASHES_ID, role: AccountRole.READONLY },
    { address: args.authority, role: AccountRole.READONLY_SIGNER },
  ]);
}

/**
 * `WithdrawNonceAccount` (5). Withdrawing the whole balance closes the slot and refunds its rent.
 * The signer firewall only lets it pay the trading wallet or the connected wallet. The runtime
 * refuses a full withdrawal in the same blockhash window the nonce was last advanced in
 * (`NonceError::NotExpired`), so wait a slot after a cancel before reclaiming.
 */
export function withdrawNonceInstruction(args: {
  nonceAccount: Address;
  authority: Address;
  recipient: Address;
  lamports: bigint;
}): Instruction {
  return systemIx(
    SYSTEM_IX.withdrawNonceAccount,
    [
      { address: args.nonceAccount, role: AccountRole.WRITABLE },
      { address: args.recipient, role: AccountRole.WRITABLE },
      { address: SYSVAR_RECENT_BLOCKHASHES_ID, role: AccountRole.READONLY },
      { address: SYSVAR_RENT_ID, role: AccountRole.READONLY },
      { address: args.authority, role: AccountRole.READONLY_SIGNER },
    ],
    u64le(args.lamports),
  );
}

/**
 * `AuthorizeNonceAccount` (7): hands the slot to `newAuthority`; every armed tx on it stops working.
 * The signer firewall refuses this for trading-wallet slots; it exists for operator-held or test slots.
 */
export function authorizeNonceInstruction(args: { nonceAccount: Address; authority: Address; newAuthority: Address }): Instruction {
  return systemIx(
    SYSTEM_IX.authorizeNonceAccount,
    [
      { address: args.nonceAccount, role: AccountRole.WRITABLE },
      { address: args.authority, role: AccountRole.READONLY_SIGNER },
    ],
    addressBytes(args.newAuthority),
  );
}

/** Slot address `createWithSeed(wallet, "zerofee-nonce-<index>", System)`: recoverable from the wallet alone. */
export async function nonceSlotAddress(wallet: Address, index: number): Promise<{ address: Address; seed: string }> {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`invalid nonce slot index ${index}`);
  const seed = `${NONCE_SLOT_SEED_PREFIX}${index}`;
  return { address: await createAddressWithSeed({ baseAddress: wallet, programAddress: SYSTEM_PROGRAM_ID, seed }), seed };
}

/** Addresses of slots `0..count-1`: the firewall context's `ownedNonceAccounts`. */
export async function nonceSlotAddresses(wallet: Address, count: number): Promise<Address[]> {
  return Promise.all(Array.from({ length: count }, async (_v, i) => (await nonceSlotAddress(wallet, i)).address));
}

/**
 * Create + initialize slot `index` of `wallet` with ONE signature (the wallet):
 * `[CreateAccountWithSeed, InitializeNonceAccount]`. If someone pre-funds the derived address the
 * create fails ("already in use"); skip to the next index in that case.
 */
export async function createNonceSlotInstructions(args: {
  wallet: Address;
  index: number;
  /** From `fetchNonceRent` (never hardcoded). */
  rentLamports: bigint;
  /** Funding cap the signer firewall enforces. Default MAX_NONCE_SLOT_LAMPORTS (0.002 SOL). */
  maxLamports?: bigint;
}): Promise<{ address: Address; seed: string; instructions: Instruction[] }> {
  const cap = args.maxLamports ?? MAX_NONCE_SLOT_LAMPORTS;
  if (args.rentLamports <= 0n || args.rentLamports > cap) {
    throw new RangeError(`nonce slot funding ${args.rentLamports} lamports must be in (0, ${cap}] (signer firewall cap)`);
  }
  const { address, seed } = await nonceSlotAddress(args.wallet, args.index);
  return {
    address,
    seed,
    instructions: [
      createAccountWithSeedInstruction({
        payer: args.wallet,
        newAccount: address,
        base: args.wallet,
        seed,
        lamports: args.rentLamports,
        space: NONCE_ACCOUNT_LENGTH,
        owner: SYSTEM_PROGRAM_ID,
      }),
      initializeNonceInstruction({ nonceAccount: address, authority: args.wallet }),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export interface NonceAccountData {
  /** `Versions::Legacy` (0) or `Versions::Current` (1, all accounts created since durable-nonce domain separation). */
  version: "legacy" | "current";
  initialized: boolean;
  /** Default pubkey when uninitialized. */
  authority: Address;
  /** The durable nonce (base58, 32 bytes) - the lifetime token of every tx signed against this slot. */
  nonce: Nonce;
  lamportsPerSignature: bigint;
}

/** Decodes an 80-byte System nonce account. */
export function decodeNonceAccount(data: Uint8Array): NonceAccountData {
  if (data.length !== NONCE_ACCOUNT_LENGTH) throw new Error(`nonce account must be ${NONCE_ACCOUNT_LENGTH} bytes, got ${data.length}`);
  const r = new Reader(data);
  const version = r.u32();
  if (version > 1) throw new Error(`unknown nonce account version ${version}`);
  const state = r.u32();
  if (state > 1) throw new Error(`unknown nonce account state ${state}`);
  if (state === 0) {
    return {
      version: version === 0 ? "legacy" : "current",
      initialized: false,
      authority: DEFAULT_PUBKEY,
      nonce: "" as Nonce,
      lamportsPerSignature: 0n,
    };
  }
  const authority = r.pubkey();
  const nonce = base58.decode(r.bytes(32)) as Nonce;
  return { version: version === 0 ? "legacy" : "current", initialized: true, authority, nonce, lamportsPerSignature: r.u64() };
}

/** Live view of a slot, as the browser reads it before arming and the server before submitting. */
export interface NonceSlotSnapshot {
  account: Address;
  authority: Address;
  /** Current durable nonce. */
  value: Nonce;
  lamports: bigint;
}

type AccountsRpc = Rpc<Pick<SolanaRpcApi, "getMultipleAccounts">>;

/** Fetches and decodes nonce slots (null = missing, not a System-owned 80-byte account, or uninitialized). */
export async function fetchNonceSlots(rpc: AccountsRpc, accounts: readonly Address[]): Promise<(NonceSlotSnapshot | null)[]> {
  const raw = await fetchRawAccounts(rpc, accounts);
  return raw.map((acc) => {
    if (!acc || acc.owner !== SYSTEM_PROGRAM_ID || acc.data.length !== NONCE_ACCOUNT_LENGTH) return null;
    const d = decodeNonceAccount(acc.data);
    return d.initialized ? { account: acc.address, authority: d.authority, value: d.nonce, lamports: acc.lamports } : null;
  });
}

/** Rent-exempt minimum for a nonce slot, read from the cluster (mainnet ≈ 0.00106 SOL after the 2026 rent cut). */
export async function fetchNonceRent(rpc: Rpc<Pick<SolanaRpcApi, "getMinimumBalanceForRentExemption">>): Promise<bigint> {
  return BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(NONCE_ACCOUNT_LENGTH)).send());
}
