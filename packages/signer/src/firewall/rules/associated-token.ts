/**
 * Associated Token Account program. https://github.com/solana-program/associated-token-account
 * Data: empty or [0] = Create, [1] = CreateIdempotent, [2] = RecoverNested (refused).
 * Accounts: [funder (s,w), ata (w), owner, mint, system_program, token_program].
 * Allowed when funder = signer, owner = signer or connected wallet, and the ATA is the correct
 * derivation. Owner and both program accounts must be static keys: the ATA program CPIs into the
 * token program it is given, so that account's identity must not come from untrusted ALT data.
 */
import { SYSTEM_PROGRAM, TOKEN_PROGRAMS } from "../programs";
import type { AccountRef, DecodedInstruction, RuleEnv, RuleOutcome, SummaryAction } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";

export async function checkAssociatedTokenInstruction(ix: DecodedInstruction, env: RuleEnv): Promise<RuleOutcome> {
  const { ctx } = env;
  const base = where(ix, "AssociatedTokenAccount");
  const { core, violations } = splitTrailingDontFront(ix, base);
  const actions: SummaryAction[] = [];
  const done = (): RuleOutcome => ({ violations, actions });
  const kind = ix.data.length === 0 ? 0 : ix.data.length === 1 ? ix.data[0] : undefined;
  if (kind !== 0 && kind !== 1) {
    violations.push(`${base}: only Create and CreateIdempotent are allowed`);
    return done();
  }
  const label = `${base} ${kind === 1 ? "CreateIdempotent" : "Create"}`;
  if (core.length !== 6) {
    violations.push(countMismatch(label, [6], core.length));
    return done();
  }
  const [funder, ata, owner, mint, systemProgram, tokenProgram] = core as [
    AccountRef,
    AccountRef,
    AccountRef,
    AccountRef,
    AccountRef,
    AccountRef,
  ];
  if (funder.address !== ctx.signer || !funder.isSigner) violations.push(`${label}: funder must be the trading wallet`);
  if (!owner.isStatic || (owner.address !== ctx.signer && owner.address !== ctx.connectedWallet)) {
    violations.push(`${label}: owner must be the trading wallet or the connected wallet, not ${owner.address}`);
  }
  if (!mint.isStatic) violations.push(`${label}: mint must be a static account key, not loaded from a lookup table`);
  if (!systemProgram.isStatic || systemProgram.address !== SYSTEM_PROGRAM) violations.push(`${label}: unexpected system program account`);
  if (!tokenProgram.isStatic || !TOKEN_PROGRAMS.includes(tokenProgram.address)) {
    violations.push(`${label}: token program must be SPL Token or Token-2022`);
    return done();
  }
  if (ata.address !== (await env.ata(owner.address, mint.address, tokenProgram.address))) {
    violations.push(`${label}: ${ata.address} is not the associated token account of ${owner.address} for ${mint.address}`);
  }
  actions.push({ kind: "create_ata", ata: ata.address, owner: owner.address, mint: mint.address, idempotent: kind === 1 });
  return done();
}
