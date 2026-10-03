/**
 * Signer firewall: decode a transaction and refuse it unless every rule holds.
 *
 *  1. Decodes canonically (decode.ts); every referenced ALT must be supplied.
 *  2. Fee payer = signer, and the signer is the only required signature.
 *  3. Every top-level program is in ctx.allowedPrograms AND has a rule: built-in rules for
 *     System, ComputeBudget, SPL Token, Token-2022 and the ATA program, or a VenueRule. An
 *     allowlisted program without a rule is refused (fail closed).
 *  4. Caps: tips (sum) <= maxTipLamports, priority fee <= maxPriorityFeeLamports, compute unit
 *     limit <= maxComputeUnitLimit, and buys <= maxBuyLamports / maxBuyQuote[mint], both per buy
 *     instruction and summed over the transaction.
 *
 * Returns a plain-language summary of what the transaction does when it passes.
 */
import { type Address, isAddress } from "@solana/kit";
import { readU32LE } from "../bytes";
import { createAtaResolver } from "./ata";
import { decodeTransaction } from "./decode";
import { formatQuote, formatSol, shortAddress } from "./format";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  BASE_FEE_LAMPORTS_PER_SIGNATURE,
  BUILTIN_PROGRAMS,
  COMPUTE_BUDGET_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  WSOL_MINT,
} from "./programs";
import { checkAssociatedTokenInstruction } from "./rules/associated-token";
import { checkComputeBudget } from "./rules/compute-budget";
import { checkSystemInstruction } from "./rules/system";
import { checkTokenInstruction } from "./rules/token";
import { describeAction } from "./summary";
import type {
  DecodedInstruction,
  DecodedTransaction,
  FirewallContext,
  FirewallResult,
  RuleEnv,
  SummaryAction,
  TransactionSummary,
  VenueRule,
} from "./types";

export type InspectionResult = { ok: true; summary: TransactionSummary; tx: DecodedTransaction } | { ok: false; violations: string[] };

/** Own-property lookup: caps objects cross the RPC boundary, never trust their prototype chain. */
function quoteCap(caps: FirewallContext["caps"], mint: string): bigint | undefined {
  return Object.hasOwn(caps.maxBuyQuote, mint) ? caps.maxBuyQuote[mint] : undefined;
}

export async function checkTransaction(txBytes: Uint8Array, ctx: FirewallContext): Promise<FirewallResult> {
  const result = await inspectTransaction(txBytes, ctx);
  return result.ok ? { ok: true, summary: result.summary } : { ok: false, violations: result.violations };
}

/** Like checkTransaction, but also returns the decoded transaction (SignerService signs its message bytes). */
export async function inspectTransaction(txBytes: Uint8Array, ctx: FirewallContext): Promise<InspectionResult> {
  const contextProblems = validateContext(ctx);
  if (contextProblems.length) return { ok: false, violations: contextProblems.map((p) => `invalid firewall context: ${p}`) };

  const decoded = decodeTransaction(txBytes, ctx.addressLookupTables);
  if (!decoded.ok) return decoded;
  const tx = decoded.tx;
  const violations: string[] = [];

  if (tx.feePayer !== ctx.signer) violations.push(`fee payer ${tx.feePayer} is not the trading wallet ${ctx.signer}`);
  const signers = tx.accounts.filter((a) => a.isSigner);
  if (signers.length !== 1) {
    violations.push(
      `transaction requires ${signers.length} signatures (${signers.map((s) => s.address).join(", ")}); only the trading wallet may sign`,
    );
  }
  if (tx.instructions.length === 0) violations.push("transaction has no instructions");

  const venueRules = new Map<Address, VenueRule>();
  for (const rule of ctx.venueRules ?? []) {
    if (BUILTIN_PROGRAMS.includes(rule.programId))
      violations.push(`venue rule "${rule.name}" may not override built-in program ${rule.programId}`);
    else if (venueRules.has(rule.programId)) violations.push(`more than one venue rule for program ${rule.programId}`);
    else venueRules.set(rule.programId, rule);
  }

  const env: RuleEnv = { ctx, tx, ata: createAtaResolver() };
  const actions: { ixIndex: number; action: SummaryAction }[] = [];
  const budgetInstructions: DecodedInstruction[] = [];

  for (const ix of tx.instructions) {
    if (!ctx.allowedPrograms.includes(ix.programAddress)) {
      violations.push(`#${ix.index}: program ${ix.programAddress} is not allowlisted`);
      continue;
    }
    let outcome: { violations: string[]; actions: SummaryAction[] };
    switch (ix.programAddress) {
      case COMPUTE_BUDGET_PROGRAM:
        budgetInstructions.push(ix);
        continue;
      case SYSTEM_PROGRAM:
        outcome = await checkSystemInstruction(ix, env);
        break;
      case TOKEN_PROGRAM:
        outcome = await checkTokenInstruction(ix, env, "Token");
        break;
      case TOKEN_2022_PROGRAM:
        outcome = await checkTokenInstruction(ix, env, "Token-2022");
        break;
      case ASSOCIATED_TOKEN_PROGRAM:
        outcome = await checkAssociatedTokenInstruction(ix, env);
        break;
      default: {
        const rule = venueRules.get(ix.programAddress);
        if (!rule) {
          violations.push(`#${ix.index}: no firewall rule for program ${ix.programAddress}`);
          continue;
        }
        try {
          const result = await rule.check(ix, env);
          outcome = result.ok ? { violations: [], actions: [result.action] } : { violations: result.violations, actions: [] };
        } catch (e) {
          outcome = { violations: [`#${ix.index} ${rule.name}: rule failed (${(e as Error).message})`], actions: [] };
        }
      }
    }
    violations.push(...outcome.violations);
    for (const action of outcome.actions) actions.push({ ixIndex: ix.index, action });
  }

  const budget = checkComputeBudget(budgetInstructions, ctx.caps);
  violations.push(...budget.violations);

  const { caps } = ctx;
  let tipLamports = 0n;
  let maxBuyLamports = 0n;
  const maxBuyQuote: Record<string, bigint> = {};
  for (const { ixIndex, action } of actions) {
    if (action.kind === "tip") tipLamports += action.lamports;
    if (action.kind !== "trade" || action.side !== "buy") continue;
    const spend = action.maxQuoteIn;
    if (spend === undefined) {
      violations.push(`#${ixIndex}: buy without a spend amount`);
      continue;
    }
    if (action.quoteMint === WSOL_MINT) {
      if (spend > caps.maxBuyLamports) {
        violations.push(
          `#${ixIndex} ${action.venue} ${action.instruction}: spends up to ${formatSol(spend)}, above the per-trade cap of ${formatSol(caps.maxBuyLamports)}`,
        );
      }
      maxBuyLamports += spend;
    } else {
      const cap = quoteCap(caps, action.quoteMint);
      if (cap === undefined) violations.push(`#${ixIndex}: no per-trade cap is configured for quote mint ${action.quoteMint}`);
      else if (spend > cap) {
        violations.push(
          `#${ixIndex} ${action.venue} ${action.instruction}: spends up to ${formatQuote(spend, action.quoteMint)}, above the per-trade cap of ${formatQuote(cap, action.quoteMint)}`,
        );
      }
      maxBuyQuote[action.quoteMint] = (maxBuyQuote[action.quoteMint] ?? 0n) + spend;
    }
  }
  if (tipLamports > caps.maxTipLamports) violations.push(`tips total ${tipLamports} lamports, above the cap of ${caps.maxTipLamports}`);
  if (maxBuyLamports > caps.maxBuyLamports) {
    violations.push(
      `buys in this transaction commit ${formatSol(maxBuyLamports)} in total, above the per-trade cap of ${formatSol(caps.maxBuyLamports)}`,
    );
  }
  for (const [mint, total] of Object.entries(maxBuyQuote)) {
    const cap = quoteCap(caps, mint);
    if (cap !== undefined && total > cap)
      violations.push(`buys in this transaction commit ${total} units of ${mint} in total, above the per-trade cap of ${cap}`);
  }

  // Token-account rent is refundable but uncapped, so creation is limited to mints the transaction
  // actually trades or transfers (plus wSOL for wrapping): no rent griefing with arbitrary mints.
  const usedMints = new Set<string>([WSOL_MINT]);
  for (const { action } of actions) {
    if (action.kind === "trade") usedMints.add(action.baseMint).add(action.quoteMint);
    if (action.kind === "token_transfer") usedMints.add(action.mint);
  }
  for (const { ixIndex, action } of actions) {
    if (action.kind === "create_ata" && !usedMints.has(action.mint)) {
      violations.push(`#${ixIndex}: creates a token account for ${action.mint}, a mint this transaction neither trades nor transfers`);
    }
  }

  if (violations.length) return { ok: false, violations };

  // Durable-nonce transaction: the first instruction advances a nonce (already validated above).
  const first = tx.instructions[0];
  const durableNonce =
    first && first.programAddress === SYSTEM_PROGRAM && first.data.length === 4 && readU32LE(first.data, 0) === 4 && first.accounts[0]
      ? { nonceAccount: first.accounts[0].address, nonceValue: tx.lifetimeToken }
      : undefined;

  const lines = actions.map(({ action }) => describeAction(action, ctx.signer, ctx.connectedWallet));
  if (budget.computeUnitPriceMicroLamports !== undefined && budget.priorityFeeLamports > 0n) {
    lines.push(
      `Priority fee up to ${formatSol(budget.priorityFeeLamports)} (${budget.computeUnitLimit ?? "default"} CU limit at ${budget.computeUnitPriceMicroLamports} micro-lamports per CU).`,
    );
  } else {
    lines.push("No priority fee.");
  }
  if (durableNonce) {
    lines.push(
      `Advances durable nonce ${shortAddress(durableNonce.nonceAccount)} first: if signed against its nonce value it stays valid until that nonce advances.`,
    );
  }
  const networkFeeLamports = BASE_FEE_LAMPORTS_PER_SIGNATURE; // exactly one signature (checked above)
  const maxSolOutLamports = maxBuyLamports + tipLamports + budget.priorityFeeLamports + networkFeeLamports;
  const deposits = actions.some(({ action }) => action.kind === "create_ata" || action.kind === "nonce_create");
  const extension = actions.some(({ action }) => action.kind === "extend_account");
  lines.push(
    `At most ${formatSol(maxSolOutLamports)} leaves the trading wallet for buys, tips and fees${
      deposits ? "; refundable deposits are listed above" : ""
    }${extension ? "; plus the pool extension rent above" : ""}.`,
  );

  const summary: TransactionSummary = {
    text: lines.join("\n"),
    lines,
    actions: actions.map((a) => a.action),
    version: tx.version,
    feePayer: tx.feePayer,
    ...(budget.computeUnitLimit !== undefined ? { computeUnitLimit: budget.computeUnitLimit } : {}),
    ...(budget.computeUnitPriceMicroLamports !== undefined ? { computeUnitPriceMicroLamports: budget.computeUnitPriceMicroLamports } : {}),
    priorityFeeLamports: budget.priorityFeeLamports,
    networkFeeLamports,
    tipLamports,
    maxBuyLamports,
    maxBuyQuote,
    maxSolOutLamports,
    ...(durableNonce ? { durableNonce } : {}),
  };
  return { ok: true, summary, tx };
}

/** The context crosses trust boundaries (worker RPC); check its shape before relying on it. */
function validateContext(ctx: FirewallContext): string[] {
  const problems: string[] = [];
  if (typeof ctx !== "object" || ctx === null) return ["missing"];
  const isAddr = (v: unknown) => typeof v === "string" && isAddress(v);
  if (!isAddr(ctx.signer)) problems.push("signer is not an address");
  if (!isAddr(ctx.connectedWallet)) problems.push("connectedWallet is not an address");
  for (const key of ["ownedNonceAccounts", "allowedPrograms", "tipAccounts"] as const) {
    const list = ctx[key];
    if (!Array.isArray(list) || !list.every(isAddr)) problems.push(`${key} must be an array of addresses`);
  }
  const caps = ctx.caps;
  if (typeof caps !== "object" || caps === null) return [...problems, "caps missing"];
  for (const key of ["maxTipLamports", "maxPriorityFeeLamports", "maxBuyLamports"] as const) {
    if (typeof caps[key] !== "bigint" || caps[key] < 0n) problems.push(`caps.${key} must be a non-negative bigint`);
  }
  if (
    caps.maxNonceAccountLamports !== undefined &&
    (typeof caps.maxNonceAccountLamports !== "bigint" || caps.maxNonceAccountLamports < 0n)
  ) {
    problems.push("caps.maxNonceAccountLamports must be a non-negative bigint");
  }
  if (!Number.isSafeInteger(caps.maxComputeUnitLimit) || caps.maxComputeUnitLimit < 0)
    problems.push("caps.maxComputeUnitLimit must be a non-negative integer");
  if (typeof caps.maxBuyQuote !== "object" || caps.maxBuyQuote === null) problems.push("caps.maxBuyQuote must be an object");
  else {
    for (const [mint, cap] of Object.entries(caps.maxBuyQuote)) {
      if (!isAddress(mint) || typeof cap !== "bigint" || cap < 0n) problems.push(`caps.maxBuyQuote[${mint}] is invalid`);
    }
  }
  if (ctx.venueRules !== undefined && !Array.isArray(ctx.venueRules)) problems.push("venueRules must be an array");
  return problems;
}
