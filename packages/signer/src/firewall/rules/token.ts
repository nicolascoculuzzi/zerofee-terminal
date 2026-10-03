/**
 * SPL Token and Token-2022 (u8 discriminator). https://github.com/solana-program/token
 *
 * Allowed:
 *   SyncNative       [account] (+ optional read-only Rent sysvar)
 *   CloseAccount     [account, destination, authority]; authority = signer, destination = signer or
 *                    connected wallet (non-native accounts can only close at zero balance)
 *   TransferChecked  [source, mint, destination, authority]; authority = signer, destination = the
 *                    ATA (for this mint and token program) of the signer or the connected wallet
 *   Revoke           [source, owner]; owner = signer (removes a delegate; only reduces permissions)
 * Refused: Approve/ApproveChecked (standing delegations are the classic drain), SetAuthority,
 * unchecked Transfer, Burn*, MintTo*, Freeze/Thaw, all initializers and every extension instruction.
 * Multisig signer lists are refused because the layouts must match exactly.
 */
import { readU64LE } from "../../bytes";
import { SYSVAR_RENT } from "../programs";
import type { AccountRef, DecodedInstruction, RuleEnv, RuleOutcome, SummaryAction } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";

const TRANSFER_CHECKED = 12;
const CLOSE_ACCOUNT = 9;
const SYNC_NATIVE = 17;
const REVOKE = 5;

const NAMES: Readonly<Record<number, string>> = {
  0: "InitializeMint",
  1: "InitializeAccount",
  2: "InitializeMultisig",
  3: "Transfer (unchecked)",
  4: "Approve",
  5: "Revoke",
  6: "SetAuthority",
  7: "MintTo",
  8: "Burn",
  9: "CloseAccount",
  10: "FreezeAccount",
  11: "ThawAccount",
  12: "TransferChecked",
  13: "ApproveChecked",
  14: "MintToChecked",
  15: "BurnChecked",
  16: "InitializeAccount2",
  17: "SyncNative",
  18: "InitializeAccount3",
  19: "InitializeMultisig2",
  20: "InitializeMint2",
  21: "GetAccountDataSize",
  22: "InitializeImmutableOwner",
  23: "AmountToUiAmount",
  24: "UiAmountToAmount",
};

export async function checkTokenInstruction(ix: DecodedInstruction, env: RuleEnv, programName: string): Promise<RuleOutcome> {
  const { ctx } = env;
  const signer = ctx.signer;
  const base = where(ix, programName);
  const { core, violations } = splitTrailingDontFront(ix, base);
  const actions: SummaryAction[] = [];
  const done = (): RuleOutcome => ({ violations, actions });
  const kind = ix.data[0];
  if (kind === undefined) {
    violations.push(`${base}: empty instruction data`);
    return done();
  }
  const label = `${base} ${NAMES[kind] ?? `instruction ${kind}`}`;
  const expect = (count: number, length: number): boolean => {
    if (ix.data.length !== length) violations.push(`${label}: data must be ${length} bytes`);
    if (core.length !== count) violations.push(countMismatch(label, [count], core.length));
    return ix.data.length === length && core.length === count;
  };
  const isSigner = (ref: AccountRef) => ref.address === signer && ref.isSigner;

  switch (kind) {
    case SYNC_NATIVE: {
      // [account] or [account, Rent sysvar]: the official @solana-program/token client appends the
      // optional read-only Rent sysvar by default.
      const withRent = core.length === 2 && core[1]!.address === SYSVAR_RENT && !core[1]!.isWritable;
      if (!expect(withRent ? 2 : 1, 1)) return done();
      actions.push({ kind: "sync_native", account: core[0]!.address });
      return done();
    }
    case REVOKE: {
      if (!expect(2, 1)) return done();
      const [source, owner] = core as [AccountRef, AccountRef];
      if (!isSigner(owner)) violations.push(`${label}: owner must be the trading wallet`);
      actions.push({ kind: "revoke", account: source.address });
      return done();
    }
    case CLOSE_ACCOUNT: {
      if (!expect(3, 1)) return done();
      const [account, destination, authority] = core as [AccountRef, AccountRef, AccountRef];
      if (!isSigner(authority)) violations.push(`${label}: close authority must be the trading wallet`);
      if (!destination.isStatic || (destination.address !== signer && destination.address !== ctx.connectedWallet)) {
        violations.push(`${label}: rent may only go to the trading wallet or the connected wallet, not ${destination.address}`);
      }
      actions.push({ kind: "close_account", account: account.address, destination: destination.address });
      return done();
    }
    case TRANSFER_CHECKED: {
      if (!expect(4, 10)) return done();
      const [, mint, destination, authority] = core as [AccountRef, AccountRef, AccountRef, AccountRef];
      if (!isSigner(authority)) violations.push(`${label}: authority must be the trading wallet`);
      if (!mint.isStatic) violations.push(`${label}: mint must be a static account key, not loaded from a lookup table`);
      const ownAta = await env.ata(signer, mint.address, ix.programAddress);
      const connectedAta = await env.ata(ctx.connectedWallet, mint.address, ix.programAddress);
      if (!destination.isStatic || (destination.address !== ownAta && destination.address !== connectedAta)) {
        violations.push(
          `${label}: destination ${destination.address} is not the associated token account of the trading wallet or the connected wallet for mint ${mint.address}`,
        );
      }
      actions.push({
        kind: "token_transfer",
        mint: mint.address,
        amount: readU64LE(ix.data, 1),
        decimals: ix.data[9]!,
        to: destination.address,
        destination: destination.address === ownAta ? "own_token_account" : "connected_wallet_token_account",
      });
      return done();
    }
    default:
      violations.push(`${label} is not allowed`);
      return done();
  }
}
