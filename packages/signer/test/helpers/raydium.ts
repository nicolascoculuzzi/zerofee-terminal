/**
 * Realistic Raydium LaunchLab / CPMM instructions built from the trimmed official IDL
 * (test/fixtures/raydium-idl-subset.json): account order, flags, discriminators and arguments come from
 * the IDL; every PDA is derived here from the programs' seeds (not with the firewall's helpers);
 * LaunchLab gets the three remaining accounts it requires since its fee-vault upgrade; configs are
 * mainnet accounts from core's snapshot. `overrides` replaces named IDL accounts and `remaining` the
 * remaining accounts, to model a malicious backend.
 */
import {
  type AccountMeta,
  AccountRole,
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { findAssociatedTokenAddress as ata } from "../../src/firewall/ata";
import { SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../../src/firewall/programs";
import { HELIUS_TIP_ACCOUNTS, JITO_TIP_ACCOUNTS, LAMPORTS_PER_SOL, PROGRAMS, RAYDIUM, randomAddress, type TestActors } from "./fixtures";
import { buildIdlInstruction } from "./idl";
import { closeAta } from "./scenarios";
import { computeBudget, createAtaIdempotent, tipWithDontFront, transferSol, unwrapSol, wrapSol } from "./tx";

const te = new TextEncoder();
const enc = getAddressEncoder();
const text = (s: string) => te.encode(s);
const key = (a: Address) => enc.encode(a);

async function pda(program: Address, ...seeds: ReadonlyUint8Array[]): Promise<Address> {
  const [address] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return address;
}

const ro = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const w = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });

/** A LaunchLab coin creator (seeds the creator fee vault). */
export const LAUNCHLAB_CREATOR = randomAddress();
/** A BONK.fun-style SPL Token coin on a SOL-quoted LaunchLab curve. */
export const LAUNCHLAB_COIN = randomAddress();
/** A StonkFun-style Token-2022 coin (the 3% transfer fee does not change the instruction). */
export const STONK_COIN = randomAddress();
/** A graduated coin trading on CPMM against wSOL. */
export const CPMM_COIN = randomAddress();

export type LaunchLabInstructionName = "buy_exact_in" | "buy_exact_out" | "sell_exact_in" | "sell_exact_out";

export interface LaunchLabTradeParams {
  user: Address;
  baseMint: Address;
  baseTokenProgram: Address;
  /** Default wSOL. */
  quoteMint?: Address;
  /** Default SPL Token. */
  quoteTokenProgram?: Address;
  /** Default the SOL / constant-product GlobalConfig. */
  globalConfig?: Address;
  /** Default letsbonk.fun's PlatformConfig. */
  platformConfig?: Address;
  /** pool.creator, default LAUNCHLAB_CREATOR. */
  creator?: Address;
  /** Replace named IDL accounts (attack modelling). */
  overrides?: Record<string, Address>;
  /** Replace remaining accounts (attack modelling). */
  remaining?: { systemProgram?: Address; platformFeeVault?: Address; creatorFeeVault?: Address };
  /** Insert a share_fee_receiver before the remaining accounts (what a non-zero share_fee_rate needs). */
  shareFeeReceiver?: Address;
}

/** LaunchLab pool ["pool", base, quote]. */
export const launchLabPool = (baseMint: Address, quoteMint: Address = WSOL_MINT) =>
  pda(PROGRAMS.raydiumLaunchLab, text("pool"), key(baseMint), key(quoteMint));

/** A LaunchLab swap: 15 IDL accounts + system_program, platform_fee_vault, creator_fee_vault. share_fee_rate defaults to 0. */
export async function launchLabInstruction(
  name: LaunchLabInstructionName,
  p: LaunchLabTradeParams,
  args: Record<string, bigint>,
  options: { extraAccounts?: AccountMeta[] } = {},
): Promise<Instruction> {
  const program = PROGRAMS.raydiumLaunchLab;
  const quoteMint = p.quoteMint ?? WSOL_MINT;
  const qtp = p.quoteTokenProgram ?? TOKEN_PROGRAM;
  const platformConfig = p.platformConfig ?? RAYDIUM.letsbonkPlatform;
  const pool = await launchLabPool(p.baseMint, quoteMint);
  const accounts: Record<string, Address> = {
    payer: p.user,
    authority: await pda(program, text("vault_auth_seed")),
    global_config: p.globalConfig ?? RAYDIUM.solGlobalConfig,
    platform_config: platformConfig,
    pool_state: pool,
    user_base_token: await ata(p.user, p.baseMint, p.baseTokenProgram),
    user_quote_token: await ata(p.user, quoteMint, qtp),
    base_vault: await pda(program, text("pool_vault"), key(pool), key(p.baseMint)),
    quote_vault: await pda(program, text("pool_vault"), key(pool), key(quoteMint)),
    base_token_mint: p.baseMint,
    quote_token_mint: quoteMint,
    base_token_program: p.baseTokenProgram,
    quote_token_program: qtp,
    event_authority: await pda(program, text("__event_authority")),
    program,
    ...p.overrides,
  };
  const r = p.remaining ?? {};
  const remaining: AccountMeta[] = [
    ...(p.shareFeeReceiver ? [w(p.shareFeeReceiver)] : []),
    ro(r.systemProgram ?? SYSTEM_PROGRAM),
    w(r.platformFeeVault ?? (await pda(program, key(platformConfig), key(quoteMint)))),
    w(r.creatorFeeVault ?? (await pda(program, key(p.creator ?? LAUNCHLAB_CREATOR), key(quoteMint)))),
    ...(options.extraAccounts ?? []),
  ];
  return buildIdlInstruction({
    programAddress: program,
    program: "raydium_launchpad",
    name,
    accounts,
    args: { share_fee_rate: 0n, ...args },
    remaining,
  });
}

export type CpmmInstructionName = "swap_base_input" | "swap_base_output";

export interface CpmmTradeParams {
  user: Address;
  inputMint: Address;
  outputMint: Address;
  /** Default SPL Token. */
  inputTokenProgram?: Address;
  /** Default SPL Token. */
  outputTokenProgram?: Address;
  /** Default the AmmConfig of core's graduated BONK.fun pool. */
  ammConfig?: Address;
  /** Default the canonical pool ["pool", amm_config, token_0, token_1]. */
  pool?: Address;
  overrides?: Record<string, Address>;
}

/** Sorts two mints by raw bytes into (token_0, token_1), as CPMM's initialize requires. */
function sortMints(a: Address, b: Address): [Address, Address] {
  const x = key(a);
  const y = key(b);
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? [a, b] : [b, a];
  return [a, b];
}

/** CPMM pool ["pool", amm_config, token_0, token_1]. */
export async function cpmmPool(mintA: Address, mintB: Address, ammConfig: Address = RAYDIUM.ammConfig): Promise<Address> {
  const [m0, m1] = sortMints(mintA, mintB);
  return pda(PROGRAMS.raydiumCpmm, text("pool"), key(ammConfig), key(m0), key(m1));
}

/** A CPMM swap: 13 IDL accounts, no remaining accounts. */
export async function cpmmInstruction(
  name: CpmmInstructionName,
  p: CpmmTradeParams,
  args: Record<string, bigint>,
  options: { extraAccounts?: AccountMeta[] } = {},
): Promise<Instruction> {
  const program = PROGRAMS.raydiumCpmm;
  const itp = p.inputTokenProgram ?? TOKEN_PROGRAM;
  const otp = p.outputTokenProgram ?? TOKEN_PROGRAM;
  const ammConfig = p.ammConfig ?? RAYDIUM.ammConfig;
  const pool = p.pool ?? (await cpmmPool(p.inputMint, p.outputMint, ammConfig));
  const accounts: Record<string, Address> = {
    payer: p.user,
    authority: await pda(program, text("vault_and_lp_mint_auth_seed")),
    amm_config: ammConfig,
    pool_state: pool,
    input_token_account: await ata(p.user, p.inputMint, itp),
    output_token_account: await ata(p.user, p.outputMint, otp),
    input_vault: await pda(program, text("pool_vault"), key(pool), key(p.inputMint)),
    output_vault: await pda(program, text("pool_vault"), key(pool), key(p.outputMint)),
    input_token_program: itp,
    output_token_program: otp,
    input_token_mint: p.inputMint,
    output_token_mint: p.outputMint,
    observation_state: await pda(program, text("observation"), key(pool)),
    ...p.overrides,
  };
  return buildIdlInstruction({
    programAddress: program,
    program: "raydium_cp_swap",
    name,
    accounts,
    args,
    remaining: options.extraAccounts ?? [],
  });
}

// ---- parameter shortcuts ----

/** BONK.fun-style SOL pair with an SPL Token coin. */
export function launchLabParams(a: TestActors, extra: Partial<LaunchLabTradeParams> = {}): LaunchLabTradeParams {
  return { user: a.signer, baseMint: LAUNCHLAB_COIN, baseTokenProgram: TOKEN_PROGRAM, ...extra };
}

/** StonkFun-style SOL pair with a Token-2022 coin. */
export function stonkParams(a: TestActors, extra: Partial<LaunchLabTradeParams> = {}): LaunchLabTradeParams {
  return {
    user: a.signer,
    baseMint: STONK_COIN,
    baseTokenProgram: TOKEN_2022_PROGRAM,
    platformConfig: RAYDIUM.stonkPlatform,
    ...extra,
  };
}

/** CPMM buy of CPMM_COIN with wSOL (or a sell when `side` is "sell"). */
export function cpmmParams(a: TestActors, side: "buy" | "sell", extra: Partial<CpmmTradeParams> = {}): CpmmTradeParams {
  const [inputMint, outputMint] = side === "buy" ? [WSOL_MINT, CPMM_COIN] : [CPMM_COIN, WSOL_MINT];
  return { user: a.signer, inputMint, outputMint, ...extra };
}

// ---- transactions shaped like @zerofee/core's ----

/** LaunchLab buy_exact_in for `spend` lamports: wrap, coin ATA, buy, unwrap, Jito tip with jitodontfront. */
export async function launchLabBuy(a: TestActors, spend = LAMPORTS_PER_SOL / 5n): Promise<Instruction[]> {
  return [
    ...computeBudget(120_000, 50_000n),
    ...(await wrapSol(a.signer, spend)),
    await createAtaIdempotent(a.signer, a.signer, LAUNCHLAB_COIN, TOKEN_PROGRAM),
    await launchLabInstruction("buy_exact_in", launchLabParams(a), { amount_in: spend, minimum_amount_out: 1_000_000_000n }),
    await unwrapSol(a.signer),
    tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[0]!, 10_000n),
  ];
}

/** Full exit of a Token-2022 StonkFun coin: wSOL ATA for the proceeds, sell_exact_in, unwrap, close the coin ATA, Helius tip. */
export async function launchLabSellAll(a: TestActors, amount = 5_000_000_000_000n): Promise<Instruction[]> {
  return [
    ...computeBudget(100_000, 20_000n),
    await createAtaIdempotent(a.signer, a.signer, WSOL_MINT, TOKEN_PROGRAM),
    await launchLabInstruction("sell_exact_in", stonkParams(a), { amount_in: amount, minimum_amount_out: 300_000_000n }),
    await unwrapSol(a.signer),
    await closeAta(a.signer, STONK_COIN, TOKEN_2022_PROGRAM),
    transferSol(a.signer, HELIUS_TIP_ACCOUNTS[2]!, 5_000n),
  ];
}

/** CPMM swap_base_input buy for `spend` lamports: wrap, coin ATA, swap, unwrap, Jito tip with jitodontfront. */
export async function cpmmBuy(a: TestActors, spend = LAMPORTS_PER_SOL / 4n, outputTokenProgram = TOKEN_PROGRAM): Promise<Instruction[]> {
  return [
    ...computeBudget(85_000, 30_000n),
    ...(await wrapSol(a.signer, spend)),
    await createAtaIdempotent(a.signer, a.signer, CPMM_COIN, outputTokenProgram),
    await cpmmInstruction("swap_base_input", cpmmParams(a, "buy", { outputTokenProgram }), { amount_in: spend, minimum_amount_out: 7n }),
    await unwrapSol(a.signer),
    tipWithDontFront(a.signer, JITO_TIP_ACCOUNTS[3]!, 10_000n),
  ];
}

/** CPMM swap_base_input sell: wSOL ATA for the proceeds, swap, unwrap, Helius tip. */
export async function cpmmSell(a: TestActors, amount = 1_000_000_000n): Promise<Instruction[]> {
  return [
    ...computeBudget(70_000, 30_000n),
    await createAtaIdempotent(a.signer, a.signer, WSOL_MINT, TOKEN_PROGRAM),
    await cpmmInstruction("swap_base_input", cpmmParams(a, "sell"), { amount_in: amount, minimum_amount_out: 50_000_000n }),
    await unwrapSol(a.signer),
    transferSol(a.signer, HELIUS_TIP_ACCOUNTS[4]!, 5_000n),
  ];
}
