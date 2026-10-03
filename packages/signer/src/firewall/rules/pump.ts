/**
 * Venue rules for pump.fun's bonding curve and PumpSwap. Program IDs are injected (they live in
 * @zerofee/core's constants); layouts come from the official IDLs (pump-idl.ts).
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
 *   - the buy amount argument is reported for the central per-trade and daily caps.
 * Venue-internal accounts (global, fee recipients, PDAs, remaining accounts) are validated by the
 * programs themselves; a wrong one makes the transaction fail, it cannot move the user's funds.
 * The bonding curve needs no pool check: the program enforces bonding_curve = PDA(["bonding-curve", mint]).
 */
import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { readU64LE, startsWith, toHex } from "../../bytes";
import { TOKEN_PROGRAMS, WSOL_MINT } from "../programs";
import type { DecodedInstruction, RuleEnv, TradeAction, VenueCheck, VenueRule } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";
import {
  PUMP_AMM_INSTRUCTION_NAMES,
  PUMP_AMM_INSTRUCTIONS,
  PUMP_CURVE_INSTRUCTIONS,
  PUMP_INSTRUCTION_NAMES,
  type VenueInstruction,
} from "./pump-idl";

export interface IdlVenueRuleOptions {
  readonly programId: Address;
  readonly name: string;
  readonly instructions: readonly VenueInstruction[];
  readonly instructionNames: Readonly<Record<string, string>>;
  /** If set (and the layout has a pool), the pool account must equal this address for the pair. */
  readonly requiredPool?: (baseMint: Address, quoteMint: Address) => Promise<Address>;
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
  const allowedNames = instructions.map((d) => d.name).join(", ");
  const discriminators = instructions.map((d) => ({ def: d, bytes: Uint8Array.from(d.discriminator) }));

  return {
    programId,
    name,
    async check(ix: DecodedInstruction, env: RuleEnv): Promise<VenueCheck> {
      const refuse = (...violations: string[]): VenueCheck => ({ ok: false, violations });
      const base = where(ix, name);
      if (ix.programAddress !== programId) return refuse(`${base}: rule applied to the wrong program`);
      if (ix.data.length < 8) return refuse(`${base}: instruction data too short`);
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

/** PumpSwap AMM, restricted to canonical (migrated, LP-burned) pools by default. */
export function createPumpSwapRule(options: PumpSwapRuleOptions): VenueRule {
  const { programId, pumpProgramId } = options;
  return createIdlVenueRule({
    programId,
    name: "PumpSwap",
    instructions: PUMP_AMM_INSTRUCTIONS,
    instructionNames: PUMP_AMM_INSTRUCTION_NAMES,
    ...(options.allowNonCanonicalPools
      ? {}
      : { requiredPool: (base, quote) => findCanonicalPumpPool(pumpProgramId, programId, base, quote) }),
  });
}
