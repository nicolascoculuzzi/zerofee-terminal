/**
 * Venue rules for Raydium LaunchLab (the bonding curves behind BONK.fun, StonkFun and TRiX) and Raydium
 * CPMM (where LaunchLab coins graduate). Program IDs are injected (the shipped policy passes the
 * signer's embedded RAYDIUM_LAUNCHLAB_PROGRAM / RAYDIUM_CPMM_PROGRAM, see policy.ts); layouts come from
 * the official IDLs (raydium-idl.ts), and the fixed authority PDAs are derived from the injected
 * program ID with the IDL seeds.
 *
 * Neither program checks who owns the user token accounts it pays out to, so the firewall does. For
 * each instruction:
 *   - only the swaps, selected by discriminator: LaunchLab buy_exact_in / buy_exact_out /
 *     sell_exact_in / sell_exact_out and CPMM swap_base_input / swap_base_output. Everything else
 *     (claims, migrations, pool creation, deposits, withdrawals, admin) is refused by name;
 *   - exact data length and account count (trailing read-only jitodontfront markers excepted).
 *     LaunchLab also requires share_fee_rate = 0 and exactly 18 accounts, so no share_fee_receiver can
 *     take a referral cut of the trade;
 *   - the payer is the trading wallet, and the trading wallet appears nowhere else;
 *   - the user's token accounts are the trading wallet's ATAs for the instruction's mints under its
 *     token programs (SPL Token or Token-2022), so bought tokens and sale proceeds cannot be redirected;
 *   - fixed accounts: LaunchLab vault authority (1), event authority (13) and System program (15,
 *     invoked with the payer's signature when the program creates a fee vault); CPMM authority (1);
 *   - derived accounts: LaunchLab pool (4) = PDA["pool", base, quote] and platform fee vault (16) =
 *     PDA[platform_config (3), quote]; CPMM vaults (6, 7) = PDA["pool_vault", pool, mint] and
 *     observation (12) = PDA["observation", pool]. These bind the mints the firewall reads (which pick
 *     the cap and the user's token accounts) to the pool and vaults that actually move the funds;
 *   - every account above is a static key (raydium-idl.ts *_STATIC_POSITIONS), because lookup-table
 *     contents are caller-supplied;
 *   - the quote asset is wSOL or has a configured per-trade cap, and the token is not a quote asset.
 *     LaunchLab names its quote mint (10). A CPMM pool is just two mints: a swap that spends wSOL (or a
 *     quote mint with a cap) buys the other mint, and a swap that receives it sells. A swap between two
 *     quote assets, or between two mints without a cap (e.g. an xStock or USD1 pair with no configured
 *     cap), is refused;
 *   - the amount spent is reported for the central per-trade and daily caps (LaunchLab buy_exact_in
 *     arg 1 / buy_exact_out arg 2; CPMM arg 1 of either swap when it spends the quote asset), and the
 *     guaranteed output for the central min-out floor and the caller's own quote (expectations).
 * Accounts the firewall does not pin (LaunchLab global_config, vaults, program and creator_fee_vault;
 * CPMM amm_config) are checked by the programs against the pool state, so a wrong one makes the
 * transaction fail. LaunchLab creates a missing platform or creator fee vault inside the swap with the
 * payer paying the rent, so its trades are flagged (mayPayVenueRent) and the summary says so.
 *
 * Residual risk (CPMM): anyone can create another CPMM pool for the same pair (for example on another
 * AmmConfig), and unlike PumpSwap there is no canonical pool the firewall can require offline. A trade
 * into such a pool is still bounded by its minimum output (never 0) and, with expectations, by the
 * browser's own quote, which is only as honest as the reserves in the trade context.
 */
import { type Address, getAddressEncoder, getProgramDerivedAddress, type ReadonlyUint8Array } from "@solana/kit";
import { readU64LE, startsWith, toHex } from "../../bytes";
import { SYSTEM_PROGRAM, TOKEN_PROGRAMS, WSOL_MINT } from "../programs";
import type { AccountRef, DecodedInstruction, FirewallCaps, RuleEnv, TradeAction, VenueCheck, VenueRule } from "../types";
import { countMismatch, splitTrailingDontFront, where } from "./common";
import {
  CPMM_DATA_LENGTH,
  CPMM_INSTRUCTION_NAMES,
  CPMM_SWAP_INSTRUCTIONS,
  CPMM_SWAP_LAYOUT,
  type CpmmSwapInstruction,
  LAUNCHLAB_DATA_LENGTH,
  LAUNCHLAB_INSTRUCTION_NAMES,
  LAUNCHLAB_SHARE_FEE_RATE_OFFSET,
  LAUNCHLAB_SWAP_INSTRUCTIONS,
  LAUNCHLAB_SWAP_LAYOUT,
  type LaunchLabSwapInstruction,
  RAYDIUM_SEEDS,
} from "./raydium-idl";

const addressEncoder = getAddressEncoder();
const utf8 = (text: string) => new TextEncoder().encode(text);
const key = (address: Address) => addressEncoder.encode(address);

async function findPda(programAddress: Address, seeds: ReadonlyUint8Array[]): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds });
  return pda;
}

/** LaunchLab vault authority ["vault_auth_seed"] (mainnet WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh). */
export const findLaunchLabAuthority = (programId: Address) => findPda(programId, [utf8(RAYDIUM_SEEDS.launchLabAuthority)]);
/** LaunchLab event-CPI authority ["__event_authority"] (mainnet 2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr). */
export const findLaunchLabEventAuthority = (programId: Address) => findPda(programId, [utf8(RAYDIUM_SEEDS.launchLabEventAuthority)]);
/** LaunchLab pool ["pool", base_mint, quote_mint]: one pool per pair. */
export const findLaunchLabPool = (programId: Address, baseMint: Address, quoteMint: Address) =>
  findPda(programId, [utf8(RAYDIUM_SEEDS.launchLabPool), key(baseMint), key(quoteMint)]);
/** LaunchLab platform fee vault [platform_config, quote_mint]. */
export const findLaunchLabPlatformFeeVault = (programId: Address, platformConfig: Address, quoteMint: Address) =>
  findPda(programId, [key(platformConfig), key(quoteMint)]);
/** CPMM vault and LP-mint authority ["vault_and_lp_mint_auth_seed"] (mainnet GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL). */
export const findCpmmAuthority = (programId: Address) => findPda(programId, [utf8(RAYDIUM_SEEDS.cpmmAuthority)]);
/** CPMM pool vault ["pool_vault", pool, mint]. */
export const findCpmmVault = (programId: Address, pool: Address, mint: Address) =>
  findPda(programId, [utf8(RAYDIUM_SEEDS.cpmmVault), key(pool), key(mint)]);
/** CPMM oracle observation ["observation", pool]. */
export const findCpmmObservation = (programId: Address, pool: Address) =>
  findPda(programId, [utf8(RAYDIUM_SEEDS.cpmmObservation), key(pool)]);

const hasCap = (caps: FirewallCaps, mint: string) => Object.hasOwn(caps.maxBuyQuote, mint);
/** wSOL, or a mint the user configured a per-trade cap for: what a buy may spend. */
const isQuoteAsset = (caps: FirewallCaps, mint: Address) => mint === WSOL_MINT || hasCap(caps, mint);

/** One instruction under check: its label for violations, its accounts and the violations so far. */
interface Check {
  readonly label: string;
  readonly core: readonly AccountRef[];
  readonly env: RuleEnv;
  readonly violations: string[];
}

/** The payer is the trading wallet (signing), and the trading wallet appears in no other position. */
function checkPayer(c: Check, payerIndex: number): void {
  const { signer } = c.env.ctx;
  const payer = c.core[payerIndex]!;
  if (payer.address !== signer || !payer.isSigner) c.violations.push(`${c.label}: user must be the trading wallet`);
  c.core.forEach((account, i) => {
    if (i !== payerIndex && account.address === signer)
      c.violations.push(`${c.label}: trading wallet used in an unexpected position (${i})`);
  });
}

/** Mints pick the cap and the user's token accounts, so their identity must not come from lookup-table data. */
function staticMint(c: Check, index: number, what: string): Address {
  const ref = c.core[index]!;
  if (!ref.isStatic) c.violations.push(`${c.label}: ${what} must be a static account key, not loaded from a lookup table`);
  return ref.address;
}

/**
 * The token program at `programIndex` is SPL Token or Token-2022 (static: the venue CPIs into it with
 * the user's signature), and the account at `accountIndex` is the trading wallet's ATA for `mint` under it.
 */
async function checkUserTokenAccount(c: Check, accountIndex: number, mint: Address, programIndex: number): Promise<void> {
  const tokenProgram = c.core[programIndex]!;
  if (!tokenProgram.isStatic || !TOKEN_PROGRAMS.includes(tokenProgram.address)) {
    c.violations.push(`${c.label}: token program at position ${programIndex} must be SPL Token or Token-2022 (static key)`);
    return;
  }
  const account = c.core[accountIndex]!;
  const expected = await c.env.ata(c.env.ctx.signer, mint, tokenProgram.address);
  if (!account.isStatic || account.address !== expected) {
    c.violations.push(
      `${c.label}: token account at position ${accountIndex} must be the trading wallet's associated token account for ${mint}`,
    );
  }
}

const NOT_STATIC = "must be a static account key, not loaded from a lookup table";

/** The account at `index` is exactly `expected`, as a static key. `what` names it in the violation. */
function checkFixed(c: Check, index: number, expected: Address, what: string, why = ""): void {
  const ref = c.core[index]!;
  const reason = why ? ` (${why})` : "";
  if (ref.address !== expected) c.violations.push(`${c.label}: position ${index} must be ${what}, not ${ref.address}${reason}`);
  else if (!ref.isStatic) c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC}${reason}`);
}

/** The account at `index` is the derivation `expected` (described by `pda`), as a static key. */
function checkDerived(c: Check, index: number, expected: Address, what: string, pda: string): void {
  const ref = c.core[index]!;
  if (ref.address !== expected) {
    c.violations.push(`${c.label}: ${what} ${ref.address} at position ${index} is not ${pda} (expected ${expected})`);
  } else if (!ref.isStatic) {
    c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC}`);
  }
}

/** An account used as a derivation seed must be the account the program will actually load. */
function checkStaticSeed(c: Check, index: number, what: string, seeds: string): void {
  if (!c.core[index]!.isStatic) c.violations.push(`${c.label}: ${what} at position ${index} ${NOT_STATIC} (it seeds ${seeds})`);
}

/** Common prologue: program, discriminator (unknown instructions are refused by name), label. */
function select<T extends { readonly name: string; readonly discriminator: readonly number[] }>(
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

const withBytes = <T extends { readonly discriminator: readonly number[] }>(defs: readonly T[]) =>
  defs.map((def) => ({ def, bytes: Uint8Array.from(def.discriminator) }));

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab
// ---------------------------------------------------------------------------------------------

export interface RaydiumRuleOptions {
  /** LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj (LaunchLab) or CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C (CPMM) on mainnet. */
  readonly programId: Address;
}

function launchLabAction(venue: string, def: LaunchLabSwapInstruction, data: ReadonlyUint8Array, baseMint: Address, quoteMint: Address) {
  const common = {
    kind: "trade",
    venue,
    instruction: def.name,
    baseMint,
    quoteMint,
    baseAmount: readU64LE(data, def.baseOffset),
    baseAmountIs: def.baseAmountIs,
    mayPayVenueRent: true,
  } as const;
  const action: TradeAction =
    def.side === "buy"
      ? { ...common, side: "buy", maxQuoteIn: readU64LE(data, def.capOffset!) }
      : { ...common, side: "sell", minQuoteOut: readU64LE(data, def.minOutOffset!) };
  return action;
}

/** Raydium LaunchLab bonding curves: the four swaps only, with share_fee_rate = 0. */
export function createRaydiumLaunchLabRule(options: RaydiumRuleOptions): VenueRule {
  const { programId } = options;
  const name = "Raydium LaunchLab";
  const L = LAUNCHLAB_SWAP_LAYOUT;
  const defs = withBytes(LAUNCHLAB_SWAP_INSTRUCTIONS);
  let fixed: Promise<[Address, Address]> | undefined;
  const fixedAccounts = () => {
    fixed ??= Promise.all([findLaunchLabAuthority(programId), findLaunchLabEventAuthority(programId)]);
    return fixed;
  };

  return {
    programId,
    name,
    async check(ix: DecodedInstruction, env: RuleEnv): Promise<VenueCheck> {
      const selected = select(ix, programId, name, defs, LAUNCHLAB_INSTRUCTION_NAMES);
      if ("refusal" in selected) return { ok: false, violations: [selected.refusal] };
      const { def, label } = selected;
      const violations: string[] = [];
      if (ix.data.length !== LAUNCHLAB_DATA_LENGTH) {
        violations.push(`${label}: data must be ${LAUNCHLAB_DATA_LENGTH} bytes`);
      } else {
        const shareFeeRate = readU64LE(ix.data, LAUNCHLAB_SHARE_FEE_RATE_OFFSET);
        if (shareFeeRate !== 0n) {
          violations.push(
            `${label}: share_fee_rate must be 0, got ${shareFeeRate} (a referral share fee pays part of the trade to a share_fee_receiver account)`,
          );
        }
      }
      const { core, violations: extra } = splitTrailingDontFront(ix, label);
      violations.push(...extra);
      if (core.length !== L.accountCount)
        return { ok: false, violations: [...violations, countMismatch(label, [L.accountCount], core.length)] };

      const c: Check = { label, core, env, violations };
      const { caps } = env.ctx;
      checkPayer(c, L.payer);
      const baseMint = staticMint(c, L.baseMint, "base mint");
      const quoteMint = staticMint(c, L.quoteMint, "quote mint");
      if (isQuoteAsset(caps, baseMint))
        violations.push(`${label}: base mint ${baseMint} is a quote asset; refusing to trade it as the token`);
      if (!isQuoteAsset(caps, quoteMint)) violations.push(`${label}: no per-trade cap is configured for quote mint ${quoteMint}`);
      await checkUserTokenAccount(c, L.userBaseToken, baseMint, L.baseTokenProgram);
      await checkUserTokenAccount(c, L.userQuoteToken, quoteMint, L.quoteTokenProgram);

      const [authority, eventAuthority] = await fixedAccounts();
      checkFixed(c, L.authority, authority, `the vault authority ${authority}`);
      checkFixed(c, L.eventAuthority, eventAuthority, `the event authority ${eventAuthority}`);
      checkFixed(c, L.systemProgram, SYSTEM_PROGRAM, "the System program", "it is invoked with the trading wallet's signature");
      checkDerived(
        c,
        L.pool,
        await findLaunchLabPool(programId, baseMint, quoteMint),
        "pool",
        `the LaunchLab pool for ${baseMint} / ${quoteMint}`,
      );
      checkStaticSeed(c, L.platformConfig, "platform config", "the platform fee vault");
      const platformConfig = core[L.platformConfig]!.address;
      checkDerived(
        c,
        L.platformFeeVault,
        await findLaunchLabPlatformFeeVault(programId, platformConfig, quoteMint),
        "platform fee vault",
        `the PDA [platform_config ${platformConfig}, quote_mint ${quoteMint}]`,
      );
      if (violations.length) return { ok: false, violations };
      return { ok: true, action: launchLabAction(name, def, ix.data, baseMint, quoteMint) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Raydium CPMM
// ---------------------------------------------------------------------------------------------

interface CpmmDirection {
  readonly side: "buy" | "sell";
  readonly baseMint: Address;
  readonly quoteMint: Address;
}

/** Spending wSOL (then a capped quote mint) is a buy of the other mint; receiving it is a sell. */
function cpmmDirection(caps: FirewallCaps, inputMint: Address, outputMint: Address): CpmmDirection | undefined {
  if (inputMint === WSOL_MINT) return { side: "buy", baseMint: outputMint, quoteMint: inputMint };
  if (outputMint === WSOL_MINT) return { side: "sell", baseMint: inputMint, quoteMint: outputMint };
  if (hasCap(caps, inputMint)) return { side: "buy", baseMint: outputMint, quoteMint: inputMint };
  if (hasCap(caps, outputMint)) return { side: "sell", baseMint: inputMint, quoteMint: outputMint };
  return undefined;
}

function cpmmAction(venue: string, def: CpmmSwapInstruction, data: ReadonlyUint8Array, d: CpmmDirection): TradeAction {
  const input = readU64LE(data, def.inputOffset);
  const output = readU64LE(data, def.outputOffset);
  const common = { kind: "trade", venue, instruction: def.name, baseMint: d.baseMint, quoteMint: d.quoteMint } as const;
  return d.side === "buy"
    ? { ...common, side: "buy", maxQuoteIn: input, baseAmount: output, baseAmountIs: def.outputIs === "min" ? "min_out" : "exact_out" }
    : { ...common, side: "sell", baseAmount: input, baseAmountIs: def.inputIs === "exact" ? "exact_in" : "max_in", minQuoteOut: output };
}

/** Raydium CPMM pools: swap_base_input / swap_base_output only, priced against wSOL or a capped quote mint. */
export function createRaydiumCpmmRule(options: RaydiumRuleOptions): VenueRule {
  const { programId } = options;
  const name = "Raydium CPMM";
  const L = CPMM_SWAP_LAYOUT;
  const defs = withBytes(CPMM_SWAP_INSTRUCTIONS);
  let fixed: Promise<Address> | undefined;
  const authorityAccount = () => {
    fixed ??= findCpmmAuthority(programId);
    return fixed;
  };

  return {
    programId,
    name,
    async check(ix: DecodedInstruction, env: RuleEnv): Promise<VenueCheck> {
      const selected = select(ix, programId, name, defs, CPMM_INSTRUCTION_NAMES);
      if ("refusal" in selected) return { ok: false, violations: [selected.refusal] };
      const { def, label } = selected;
      const violations: string[] = [];
      if (ix.data.length !== CPMM_DATA_LENGTH) violations.push(`${label}: data must be ${CPMM_DATA_LENGTH} bytes`);
      const { core, violations: extra } = splitTrailingDontFront(ix, label);
      violations.push(...extra);
      if (core.length !== L.accountCount)
        return { ok: false, violations: [...violations, countMismatch(label, [L.accountCount], core.length)] };

      const c: Check = { label, core, env, violations };
      checkPayer(c, L.payer);
      const inputMint = staticMint(c, L.inputMint, "input mint");
      const outputMint = staticMint(c, L.outputMint, "output mint");
      await checkUserTokenAccount(c, L.inputTokenAccount, inputMint, L.inputTokenProgram);
      await checkUserTokenAccount(c, L.outputTokenAccount, outputMint, L.outputTokenProgram);

      const authority = await authorityAccount();
      checkFixed(c, L.authority, authority, `the CPMM authority ${authority}`);
      checkStaticSeed(c, L.pool, "pool", "the vault and observation addresses");
      const pool = core[L.pool]!.address;
      checkDerived(
        c,
        L.inputVault,
        await findCpmmVault(programId, pool, inputMint),
        "input vault",
        `the PDA ["pool_vault", pool, ${inputMint}]`,
      );
      checkDerived(
        c,
        L.outputVault,
        await findCpmmVault(programId, pool, outputMint),
        "output vault",
        `the PDA ["pool_vault", pool, ${outputMint}]`,
      );
      checkDerived(c, L.observation, await findCpmmObservation(programId, pool), "observation", `the PDA ["observation", pool ${pool}]`);

      const direction = cpmmDirection(env.ctx.caps, inputMint, outputMint);
      if (!direction) {
        violations.push(
          `${label}: no per-trade cap is configured for either mint (${inputMint} in, ${outputMint} out); one side must be wSOL or a quote mint with a cap`,
        );
      } else if (isQuoteAsset(env.ctx.caps, direction.baseMint)) {
        violations.push(`${label}: base mint ${direction.baseMint} is a quote asset; refusing to trade it as the token`);
      }
      if (violations.length || !direction) return { ok: false, violations };
      return { ok: true, action: cpmmAction(name, def, ix.data, direction) };
    },
  };
}
