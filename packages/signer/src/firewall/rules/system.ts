/**
 * System program (u32 LE discriminator + bincode arguments).
 * https://github.com/solana-program/system (SystemInstruction)
 *
 * Allowed:
 *   Transfer                 from the signer to (a) a tip account (<= maxTipLamports; the sum of all
 *                            tips is capped again per transaction), (b) the signer's own wSOL ATA
 *                            (wrapping), or (c) the connected wallet (withdrawal).
 *   AdvanceNonceAccount      on an owned nonce account, authority = signer.
 *   WithdrawNonceAccount     on an owned nonce account, authority = signer, to the signer or the
 *                            connected wallet.
 *   CreateAccount[WithSeed]  only to create a nonce account: owner = System, space = 80, funded with at
 *                            most caps.maxNonceAccountLamports, immediately followed by
 *                            InitializeNonceAccount with authority = signer.
 *   InitializeNonceAccount   only as the second half of that pair.
 * Everything else (Assign, Allocate, TransferWithSeed, AuthorizeNonceAccount, ...) is refused.
 */
import { type Address, createAddressWithSeed, getAddressDecoder } from "@solana/kit";
import { readU32LE, readU64LE } from "../../bytes";
import {
  DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS,
  SYSTEM_PROGRAM,
  SYSVAR_RECENT_BLOCKHASHES,
  SYSVAR_RENT,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from "../programs";
import type { AccountRef, DecodedInstruction, RuleEnv, RuleOutcome, SummaryAction } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";

const CREATE_ACCOUNT = 0;
const TRANSFER = 2;
const CREATE_ACCOUNT_WITH_SEED = 3;
const ADVANCE_NONCE_ACCOUNT = 4;
const WITHDRAW_NONCE_ACCOUNT = 5;
const INITIALIZE_NONCE_ACCOUNT = 6;

/** Size of a nonce account (nonce::state::State::size()). */
export const NONCE_ACCOUNT_SPACE = 80n;
const MAX_SEED_LEN = 32;

const NAMES: Readonly<Record<number, string>> = {
  0: "CreateAccount",
  1: "Assign",
  2: "Transfer",
  3: "CreateAccountWithSeed",
  4: "AdvanceNonceAccount",
  5: "WithdrawNonceAccount",
  6: "InitializeNonceAccount",
  7: "AuthorizeNonceAccount",
  8: "Allocate",
  9: "AllocateWithSeed",
  10: "AssignWithSeed",
  11: "TransferWithSeed",
  12: "UpgradeNonceAccount",
};

const addressDecoder = getAddressDecoder();

function kindOf(ix: DecodedInstruction | undefined): number | undefined {
  if (!ix || ix.programAddress !== SYSTEM_PROGRAM || ix.data.length < 4) return undefined;
  return readU32LE(ix.data, 0);
}

/** The new account of a CreateAccount / CreateAccountWithSeed instruction (account index 1). */
function createdAccount(ix: DecodedInstruction | undefined): Address | undefined {
  const kind = kindOf(ix);
  return kind === CREATE_ACCOUNT || kind === CREATE_ACCOUNT_WITH_SEED ? ix?.accounts[1]?.address : undefined;
}

/** True if `ix` is InitializeNonceAccount(nonce = `account`, authority = `signer`). */
function initializesNonce(ix: DecodedInstruction | undefined, account: Address, signer: Address): boolean {
  if (!ix || kindOf(ix) !== INITIALIZE_NONCE_ACCOUNT || ix.data.length !== 36) return false;
  return ix.accounts[0]?.address === account && addressDecoder.decode(ix.data.subarray(4, 36)) === signer;
}

export async function checkSystemInstruction(ix: DecodedInstruction, env: RuleEnv): Promise<RuleOutcome> {
  const { ctx, tx } = env;
  const signer = ctx.signer;
  const base = where(ix, "System");
  const { core, violations } = splitTrailingDontFront(ix, base);
  const actions: SummaryAction[] = [];
  const done = (): RuleOutcome => ({ violations, actions });
  const kind = kindOf(ix);
  if (kind === undefined) {
    violations.push(`${base}: malformed instruction data`);
    return done();
  }
  const label = `${base} ${NAMES[kind] ?? `instruction ${kind}`}`;
  const data = ix.data;
  const expect = (count: number, length: number): boolean => {
    if (data.length !== length) violations.push(`${label}: data must be ${length} bytes`);
    if (core.length !== count) violations.push(countMismatch(label, [count], core.length));
    return data.length === length && core.length === count;
  };
  const isSigner = (ref: AccountRef | undefined) => ref?.address === signer && ref.isSigner;
  const isOwnedNonce = (ref: AccountRef) => ctx.ownedNonceAccounts.includes(ref.address) && ref.isStatic;

  switch (kind) {
    case TRANSFER: {
      if (!expect(2, 12)) return done();
      const [from, to] = core as [AccountRef, AccountRef];
      const lamports = readU64LE(data, 4);
      if (!isSigner(from)) violations.push(`${label}: funds may only be sent from the trading wallet`);
      if (!to.isStatic) {
        violations.push(`${label}: destination must be a static account key, not loaded from a lookup table`);
        return done();
      }
      if (ctx.tipAccounts.includes(to.address)) {
        if (lamports > ctx.caps.maxTipLamports)
          violations.push(`${label}: tip of ${lamports} lamports exceeds the cap of ${ctx.caps.maxTipLamports}`);
        actions.push({ kind: "tip", to: to.address, lamports });
      } else if (to.address === (await env.ata(signer, WSOL_MINT, TOKEN_PROGRAM))) {
        actions.push({ kind: "sol_transfer", to: to.address, lamports, destination: "own_wsol_account" });
      } else if (to.address === ctx.connectedWallet) {
        actions.push({ kind: "sol_transfer", to: to.address, lamports, destination: "connected_wallet" });
      } else {
        violations.push(
          `${label}: destination ${to.address} is not a tip account, the trading wallet's wSOL account or the connected wallet`,
        );
      }
      return done();
    }

    case ADVANCE_NONCE_ACCOUNT: {
      if (!expect(3, 4)) return done();
      const [nonce, sysvar, authority] = core as [AccountRef, AccountRef, AccountRef];
      if (!isOwnedNonce(nonce)) violations.push(`${label}: ${nonce.address} is not one of the trading wallet's nonce accounts`);
      if (sysvar.address !== SYSVAR_RECENT_BLOCKHASHES) violations.push(`${label}: expected the RecentBlockhashes sysvar`);
      if (!isSigner(authority)) violations.push(`${label}: nonce authority must be the trading wallet`);
      actions.push({ kind: "nonce_advance", nonceAccount: nonce.address });
      return done();
    }

    case WITHDRAW_NONCE_ACCOUNT: {
      if (!expect(5, 12)) return done();
      const [nonce, to, blockhashes, rent, authority] = core as [AccountRef, AccountRef, AccountRef, AccountRef, AccountRef];
      const lamports = readU64LE(data, 4);
      if (!isOwnedNonce(nonce)) violations.push(`${label}: ${nonce.address} is not one of the trading wallet's nonce accounts`);
      if (!to.isStatic || (to.address !== signer && to.address !== ctx.connectedWallet)) {
        violations.push(`${label}: withdrawals may only go to the trading wallet or the connected wallet`);
      }
      if (blockhashes.address !== SYSVAR_RECENT_BLOCKHASHES || rent.address !== SYSVAR_RENT)
        violations.push(`${label}: unexpected sysvar accounts`);
      if (!isSigner(authority)) violations.push(`${label}: nonce authority must be the trading wallet`);
      actions.push({ kind: "nonce_withdraw", nonceAccount: nonce.address, to: to.address, lamports });
      return done();
    }

    case CREATE_ACCOUNT: {
      // [funder (s,w), new account (s,w)]; data: lamports u64, space u64, owner pubkey.
      if (!expect(2, 52)) return done();
      const [from, created] = core as [AccountRef, AccountRef];
      const lamports = readU64LE(data, 4);
      const space = readU64LE(data, 12);
      const owner = addressDecoder.decode(data.subarray(20, 52));
      checkNonceCreation(
        label,
        from,
        created,
        owner,
        space,
        lamports,
        ctx.caps.maxNonceAccountLamports ?? DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS,
        tx.instructions[ix.index + 1],
        signer,
        violations,
      );
      actions.push({ kind: "nonce_create", nonceAccount: created.address, lamports });
      return done();
    }

    case CREATE_ACCOUNT_WITH_SEED: {
      // data: base pubkey, seed (u64 length + utf8), lamports u64, space u64, owner pubkey.
      if (data.length < 44) {
        violations.push(`${label}: malformed data`);
        return done();
      }
      const seedLength = readU64LE(data, 36);
      if (seedLength > BigInt(MAX_SEED_LEN) || data.length !== 92 + Number(seedLength)) {
        violations.push(`${label}: malformed data`);
        return done();
      }
      const n = Number(seedLength);
      let seed: string;
      try {
        seed = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(44, 44 + n));
      } catch {
        violations.push(`${label}: seed is not UTF-8`);
        return done();
      }
      const baseAddress = addressDecoder.decode(data.subarray(4, 36));
      const lamports = readU64LE(data, 44 + n);
      const space = readU64LE(data, 52 + n);
      const owner = addressDecoder.decode(data.subarray(60 + n, 92 + n));
      if (core.length !== 2 && core.length !== 3) {
        violations.push(countMismatch(label, [2, 3], core.length));
        return done();
      }
      const [from, created, baseAccount] = core as [AccountRef, AccountRef, AccountRef | undefined];
      if (baseAddress !== signer || (baseAccount && !isSigner(baseAccount))) violations.push(`${label}: base must be the trading wallet`);
      if (owner === SYSTEM_PROGRAM) {
        const derived = await createAddressWithSeed({ baseAddress, programAddress: SYSTEM_PROGRAM, seed });
        if (derived !== created.address) violations.push(`${label}: new account does not match its seed derivation`);
      }
      checkNonceCreation(
        label,
        from,
        created,
        owner,
        space,
        lamports,
        ctx.caps.maxNonceAccountLamports ?? DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS,
        tx.instructions[ix.index + 1],
        signer,
        violations,
      );
      actions.push({ kind: "nonce_create", nonceAccount: created.address, lamports });
      return done();
    }

    case INITIALIZE_NONCE_ACCOUNT: {
      // [nonce (w), RecentBlockhashes sysvar, Rent sysvar]; data: authority pubkey.
      if (!expect(3, 36)) return done();
      const [nonce, blockhashes, rent] = core as [AccountRef, AccountRef, AccountRef];
      if (createdAccount(tx.instructions[ix.index - 1]) !== nonce.address) {
        violations.push(`${label}: only allowed right after the instruction that creates this nonce account`);
      }
      if (addressDecoder.decode(data.subarray(4, 36)) !== signer) violations.push(`${label}: nonce authority must be the trading wallet`);
      if (blockhashes.address !== SYSVAR_RECENT_BLOCKHASHES || rent.address !== SYSVAR_RENT)
        violations.push(`${label}: unexpected sysvar accounts`);
      return done();
    }

    default:
      violations.push(`${label} is not allowed`);
      return done();
  }
}

function checkNonceCreation(
  label: string,
  from: AccountRef,
  created: AccountRef,
  owner: Address,
  space: bigint,
  lamports: bigint,
  maxLamports: bigint,
  next: DecodedInstruction | undefined,
  signer: Address,
  violations: string[],
): void {
  if (from.address !== signer || !from.isSigner) violations.push(`${label}: must be funded by the trading wallet`);
  if (owner !== SYSTEM_PROGRAM || space !== NONCE_ACCOUNT_SPACE) {
    violations.push(`${label}: accounts may only be created as nonce accounts (owner System, space ${NONCE_ACCOUNT_SPACE})`);
  }
  if (!created.isStatic) violations.push(`${label}: new account must be a static account key`);
  if (lamports > maxLamports)
    violations.push(`${label}: funds the nonce account with ${lamports} lamports, above the cap of ${maxLamports}`);
  if (!initializesNonce(next, created.address, signer)) {
    violations.push(`${label}: must be followed by InitializeNonceAccount for ${created.address} with the trading wallet as authority`);
  }
}
