/**
 * Venue rules for pump.fun's bonding curve and PumpSwap. Program IDs are injected (the shipped
 * policy passes the signer's embedded PUMP_PROGRAM / PUMP_AMM_PROGRAM, see policy.ts); layouts come
 * from the official IDLs (pump-idl.ts).
 *
 * For each instruction:
 *   - only buy / buy_exact_sol_in / buy_v2 / buy_exact_quote_in_v2 / sell / sell_v2 (curve) and
 *     buy / buy_exact_quote_in / sell (PumpSwap), selected by discriminator; everything else refused;
 *   - exact data length and account count (trailing read-only jitodontfront markers excepted);
 *   - `user` is the signer, and the signer appears nowhere else in the instruction;
 *   - the user's base and quote token accounts are the signer's ATAs (static keys), so bought tokens
 *     and sale proceeds cannot be redirected; the mints are static keys too, because they select the
 *     cap and the expected token accounts;
 *   - the token programs it may CPI into (with the user's signature) are SPL Token / Token-2022, static;
 *   - the quote asset is wSOL or has a configured per-trade cap, and the base asset is not a quote
 *     asset (a "sell" of wSOL would be an uncapped buy of something else);
 *   - PumpSwap only: the pool is the coin's canonical pool (static key). Anyone can create_pool a
 *     second pool for the same pair with themselves as LP; selling into it at min_quote_amount_out = 0
 *     would hand the user's tokens to that LP, and sells are not capped. The canonical pool is created
 *     only by pump's migrate, with the LP burned:
 *       pool = PDA(["pool", u16 0, pool_authority, base_mint, quote_mint], pump_amm)
 *       pool_authority = PDA(["pool-authority", base_mint], pump)        (idl/pump.json migrate, migrate_v2)
 *   - the buy amount argument is reported for the central per-trade and daily caps, and the minimum
 *     output for the central min-out floor.
 * PumpSwap extend_account (core and pump-swap-sdk prepend it for pools shorter than 300 bytes) is the
 * one non-trade instruction allowed: only on the canonical pool of a PumpSwap trade in the same
 * transaction, at most once, with the trading wallet as the rent payer and the real System program
 * as the CPI target (see poolExtension below).
 * Venue-internal accounts (global, fee recipients, PDAs, remaining accounts) are validated by the
 * programs themselves; a wrong one makes the transaction fail, it cannot move the user's funds.
 * The bonding curve needs no pool check: the program enforces bonding_curve = PDA(["bonding-curve", mint]).
 */
import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { readU64LE, startsWith, toHex } from "../../bytes";
import { SYSTEM_PROGRAM, TOKEN_PROGRAMS, WSOL_MINT } from "../programs";
import type { AccountRef, DecodedInstruction, DecodedTransaction, RuleEnv, TradeAction, VenueCheck, VenueRule } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";
import {
  PUMP_AMM_EXTEND_ACCOUNT,
  PUMP_AMM_INSTRUCTION_NAMES,
  PUMP_AMM_INSTRUCTIONS,
  PUMP_CURVE_INSTRUCTIONS,
  PUMP_INSTRUCTION_NAMES,
  type VenueInstruction,
} from "./pump-idl";

/** A non-trade instruction a venue also accepts, with its own check. */
export interface AuxiliaryInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  /** `label` is "#<index> <venue> <name>", for violations. */
  check(ix: DecodedInstruction, env: RuleEnv, label: string): Promise<VenueCheck>;
}

export interface IdlVenueRuleOptions {
  readonly programId: Address;
  readonly name: string;
  readonly instructions: readonly VenueInstruction[];
  readonly instructionNames: Readonly<Record<string, string>>;
  /** If set (and the layout has a pool), the pool account must equal this address for the pair. */
  readonly requiredPool?: (baseMint: Address, quoteMint: Address) => Promise<Address>;
  /** Non-trade instructions to accept (selected by discriminator before the trade layouts). */
  readonly auxiliary?: readonly AuxiliaryInstruction[];
}

const addressEncoder = getAddressEncoder();
const utf8 = (text: string) => new TextEncoder().encode(text);

/** The pool pump's `migrate` / `migrate_v2` creates for a graduated coin (LP burned). */
export async function findCanonicalPumpPool(
  pumpProgramId: Address,
  pumpAmmProgramId: Address,
  baseMint: Address,
  quoteMint: Address,
): Promise<Address> {
  const [poolAuthority] = await getProgramDerivedAddress({
    programAddress: pumpProgramId,
    seeds: [utf8("pool-authority"), addressEncoder.encode(baseMint)],
  });
  const [pool] = await getProgramDerivedAddress({
    programAddress: pumpAmmProgramId,
    seeds: [
      utf8("pool"),
      Uint8Array.of(0, 0),
      addressEncoder.encode(poolAuthority),
      addressEncoder.encode(baseMint),
      addressEncoder.encode(quoteMint),
    ],
  });
  return pool;
}

const hasCap = (caps: Readonly<Record<string, bigint>>, mint: string) => Object.hasOwn(caps, mint);

export function createIdlVenueRule(options: IdlVenueRuleOptions): VenueRule {
  const { programId, name, instructions, instructionNames, requiredPool } = options;
  const auxiliary = (options.auxiliary ?? []).map((a) => ({ aux: a, bytes: Uint8Array.from(a.discriminator) }));
  const allowedNames = [...instructions.map((d) => d.name), ...auxiliary.map((a) => a.aux.name)].join(", ");
  const discriminators = instructions.map((d) => ({ def: d, bytes: Uint8Array.from(d.discriminator) }));

  return {
    programId,
    name,
    async check(ix: DecodedInstruction, env: RuleEnv): Promise<VenueCheck> {
      const refuse = (...violations: string[]): VenueCheck => ({ ok: false, violations });
      const base = where(ix, name);
      if (ix.programAddress !== programId) return refuse(`${base}: rule applied to the wrong program`);
      if (ix.data.length < 8) return refuse(`${base}: instruction data too short`);
      const aux = auxiliary.find((a) => startsWith(ix.data, a.bytes))?.aux;
      if (aux) return aux.check(ix, env, `${base} ${aux.name}`);
      const def = discriminators.find((d) => startsWith(ix.data, d.bytes))?.def;
      if (!def) {
        const hex = toHex(ix.data.subarray(0, 8));
        return refuse(`${base}: instruction "${instructionNames[hex] ?? `unknown ${hex}`}" is not allowed (only ${allowedNames})`);
      }
      const label = `${base} ${def.name}`;
      const violations: string[] = [];
      if (!def.dataLengths.includes(ix.data.length)) violations.push(`${label}: data must be ${def.dataLengths.join(" or ")} bytes`);
      if (ix.data.length === 25 && ix.data[24]! > 1) violations.push(`${label}: invalid track_volume flag`);

      const { core, violations: extra } = splitTrailingDontFront(ix, label);
      violations.push(...extra);
      const L = def.layout;
      if (!L.accountCounts.includes(core.length)) return refuse(...violations, countMismatch(label, L.accountCounts, core.length));

      const { signer, caps } = env.ctx;
      const user = core[L.user]!;
      if (user.address !== signer || !user.isSigner) violations.push(`${label}: user must be the trading wallet`);
      core.forEach((account, i) => {
        if (i !== L.user && account.address === signer) violations.push(`${label}: trading wallet used in an unexpected position (${i})`);
      });

      // The mints decide which cap applies and which token accounts are "the user's", so their
      // identity must not come from caller-supplied lookup-table data.
      const baseMintRef = core[L.baseMint]!;
      const quoteMintRef = L.quoteMint === undefined ? undefined : core[L.quoteMint]!;
      for (const [what, ref] of [
        ["base mint", baseMintRef],
        ["quote mint", quoteMintRef],
      ] as const) {
        if (ref && !ref.isStatic) violations.push(`${label}: ${what} must be a static account key, not loaded from a lookup table`);
      }
      const baseMint = baseMintRef.address;
      const quoteMint = quoteMintRef?.address ?? WSOL_MINT;
      const quoteAssets = new Set<string>([WSOL_MINT, ...Object.keys(caps.maxBuyQuote)]);
      if (quoteAssets.has(baseMint)) violations.push(`${label}: base mint ${baseMint} is a quote asset; refusing to trade it as the token`);
      if (quoteMint !== WSOL_MINT && !hasCap(caps.maxBuyQuote, quoteMint)) {
        violations.push(`${label}: no per-trade cap is configured for quote mint ${quoteMint}`);
      }
      if (L.pool !== undefined && requiredPool) {
        const pool = core[L.pool]!;
        const canonical = await requiredPool(baseMint, quoteMint);
        if (!pool.isStatic || pool.address !== canonical) {
          violations.push(
            `${label}: pool ${pool.address} is not the canonical pool for ${baseMint} / ${quoteMint} (static key ${canonical} required)`,
          );
        }
      }

      const tokenAccounts: [number, Address, number][] = [[L.userBaseTokenAccount, baseMint, L.baseTokenProgram]];
      if (L.userQuoteTokenAccount !== undefined && L.quoteTokenProgram !== undefined) {
        tokenAccounts.push([L.userQuoteTokenAccount, quoteMint, L.quoteTokenProgram]);
      }
      for (const [accountIndex, mint, programIndex] of tokenAccounts) {
        const tokenProgram = core[programIndex]!;
        if (!tokenProgram.isStatic || !TOKEN_PROGRAMS.includes(tokenProgram.address)) {
          violations.push(`${label}: token program at position ${programIndex} must be SPL Token or Token-2022 (static key)`);
          continue;
        }
        const account = core[accountIndex]!;
        const expected = await env.ata(signer, mint, tokenProgram.address);
        if (!account.isStatic || account.address !== expected) {
          violations.push(
            `${label}: token account at position ${accountIndex} must be the trading wallet's associated token account for ${mint}`,
          );
        }
      }
      if (violations.length) return refuse(...violations);

      const action: TradeAction =
        def.side === "buy"
          ? {
              kind: "trade",
              venue: name,
              instruction: def.name,
              side: "buy",
              baseMint,
              quoteMint,
              maxQuoteIn: readU64LE(ix.data, def.capOffset!),
              baseAmount: readU64LE(ix.data, def.baseOffset),
              baseAmountIs: def.baseAmountIs,
            }
          : {
              kind: "trade",
              venue: name,
              instruction: def.name,
              side: "sell",
              baseMint,
              quoteMint,
              baseAmount: readU64LE(ix.data, def.baseOffset),
              baseAmountIs: def.baseAmountIs,
              minQuoteOut: readU64LE(ix.data, def.minOutOffset!),
            };
      return { ok: true, action };
    },
  };
}

/** pump.fun bonding curve (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P on mainnet). */
export function createPumpBondingCurveRule(options: { programId: Address }): VenueRule {
  return createIdlVenueRule({
    programId: options.programId,
    name: "pump.fun bonding curve",
    instructions: PUMP_CURVE_INSTRUCTIONS,
    instructionNames: PUMP_INSTRUCTION_NAMES,
  });
}

export interface PumpSwapRuleOptions {
  /** PumpSwap program (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA on mainnet). */
  readonly programId: Address;
  /** pump.fun bonding-curve program, which owns the canonical pools' pool_authority PDA. */
  readonly pumpProgramId: Address;
  /**
   * DANGEROUS: also accept non-canonical pools. A compromised caller could then sell the user's
   * tokens into a pool it owns at any price. Leave false unless the UI confirms each such trade.
   */
  readonly allowNonCanonicalPools?: boolean;
}

/**
 * PumpSwap AMM, restricted to canonical (migrated, LP-burned) pools by default. extend_account is
 * accepted only for the canonical pool, even with allowNonCanonicalPools.
 */
export function createPumpSwapRule(options: PumpSwapRuleOptions): VenueRule {
  const { programId, pumpProgramId } = options;
  const name = "PumpSwap";
  const canonicalPool = (base: Address, quote: Address) => findCanonicalPumpPool(pumpProgramId, programId, base, quote);
  return createIdlVenueRule({
    programId,
    name,
    instructions: PUMP_AMM_INSTRUCTIONS,
    instructionNames: PUMP_AMM_INSTRUCTION_NAMES,
    ...(options.allowNonCanonicalPools ? {} : { requiredPool: canonicalPool }),
    auxiliary: [poolExtension(programId, name, canonicalPool)],
  });
}

const AMM_TRADES = PUMP_AMM_INSTRUCTIONS.map((d) => ({ def: d, bytes: Uint8Array.from(d.discriminator) }));

/** Pool, base mint and quote mint of every well-formed PumpSwap trade instruction in the transaction. */
function pumpSwapTrades(tx: DecodedTransaction, programId: Address): { pool: AccountRef; baseMint: AccountRef; quoteMint: AccountRef }[] {
  const out: { pool: AccountRef; baseMint: AccountRef; quoteMint: AccountRef }[] = [];
  for (const ix of tx.instructions) {
    if (ix.programAddress !== programId) continue;
    const L = AMM_TRADES.find((d) => startsWith(ix.data, d.bytes))?.def.layout;
    if (!L || L.pool === undefined || L.quoteMint === undefined) continue;
    const { core } = splitTrailingDontFront(ix, "");
    if (L.accountCounts.includes(core.length))
      out.push({ pool: core[L.pool]!, baseMint: core[L.baseMint]!, quoteMint: core[L.quoteMint]! });
  }
  return out;
}

/**
 * PumpSwap extend_account: the trading wallet pays the rent to grow a pump_amm-owned account. Allowed
 * only as core emits it for a short pool: once per transaction, on the canonical pool of a PumpSwap
 * trade in the same transaction (that trade is checked on its own), paid by the trading wallet, with
 * the real System program as the CPI target. Any other account would be someone else's rent bill.
 */
function poolExtension(
  programId: Address,
  name: string,
  canonicalPool: (base: Address, quote: Address) => Promise<Address>,
): AuxiliaryInstruction {
  const X = PUMP_AMM_EXTEND_ACCOUNT;
  const bytes = Uint8Array.from(X.discriminator);
  return {
    name: X.name,
    discriminator: X.discriminator,
    async check(ix, env, label) {
      const violations: string[] = [];
      if (ix.data.length !== X.dataLength) violations.push(`${label}: data must be ${X.dataLength} bytes`);
      const { core, violations: extra } = splitTrailingDontFront(ix, label);
      violations.push(...extra);
      if (core.length !== X.accountCount)
        return { ok: false, violations: [...violations, countMismatch(label, [X.accountCount], core.length)] };

      const { signer } = env.ctx;
      const account = core[X.account]!;
      const user = core[X.user]!;
      const systemProgram = core[X.systemProgram]!;
      if (user.address !== signer || !user.isSigner) violations.push(`${label}: the rent payer (user) must be the trading wallet`);
      core.forEach((acc, i) => {
        if (i !== X.user && acc.address === signer) violations.push(`${label}: trading wallet used in an unexpected position (${i})`);
      });
      if (!systemProgram.isStatic || systemProgram.address !== SYSTEM_PROGRAM) {
        violations.push(
          `${label}: position ${X.systemProgram} must be the System program (static key); it is invoked with the trading wallet's signature`,
        );
      }
      const extensions = env.tx.instructions.filter((other) => other.programAddress === programId && startsWith(other.data, bytes));
      if (extensions.length > 1) violations.push(`${label}: only one ${X.name} per transaction`);

      if (!account.isStatic) violations.push(`${label}: the extended account must be a static account key, not loaded from a lookup table`);
      const trade = pumpSwapTrades(env.tx, programId).find((t) => t.pool.address === account.address);
      if (!trade) {
        violations.push(`${label}: ${account.address} is not the pool of a ${name} trade in this transaction`);
      } else {
        const canonical =
          trade.baseMint.isStatic && trade.quoteMint.isStatic
            ? await canonicalPool(trade.baseMint.address, trade.quoteMint.address)
            : undefined;
        if (account.address !== canonical) {
          violations.push(
            `${label}: ${account.address} is not the canonical pool for ${trade.baseMint.address} / ${trade.quoteMint.address}; only that pool may be extended`,
          );
        }
      }
      if (violations.length) return { ok: false, violations };
      return { ok: true, action: { kind: "extend_account", venue: name, account: account.address } };
    },
  };
}
