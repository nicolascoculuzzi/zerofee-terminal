/**
 * Realistic pump.fun / PumpSwap instructions: every PDA derived from the IDL seeds, mainnet Global /
 * FeeConfig / fee recipients from the research note, remaining accounts in pump-swap-sdk order.
 * `overrides` replaces named IDL accounts to model a malicious backend.
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
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from "../../src/firewall/programs";
import { findCanonicalPumpPool } from "../../src/firewall/rules/pump";
import { MAINNET, PROGRAMS } from "./fixtures";
import { buildIdlInstruction } from "./idl";

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

export interface CurveTradeParams {
  user: Address;
  mint: Address;
  baseTokenProgram: Address;
  /** Live bonding_curve.creator. */
  creator: Address;
  quoteMint?: Address;
  quoteTokenProgram?: Address;
  feeRecipient?: Address;
  buybackFeeRecipient?: Address;
  /** Replace named IDL accounts (attack modelling). */
  overrides?: Record<string, Address>;
}

export type CurveInstructionName = "buy" | "buy_exact_sol_in" | "buy_v2" | "buy_exact_quote_in_v2" | "sell" | "sell_v2";

async function curveV2Accounts(p: CurveTradeParams): Promise<Record<string, Address>> {
  const quoteMint = p.quoteMint ?? WSOL_MINT;
  const qtp = p.quoteTokenProgram ?? TOKEN_PROGRAM;
  const feeRecipient = p.feeRecipient ?? MAINNET.pumpFeeRecipient;
  const buyback = p.buybackFeeRecipient ?? MAINNET.buybackFeeRecipient;
  const bondingCurve = await pda(PROGRAMS.pump, text("bonding-curve"), key(p.mint));
  const creatorVault = await pda(PROGRAMS.pump, text("creator-vault"), key(p.creator));
  const uva = await pda(PROGRAMS.pump, text("user_volume_accumulator"), key(p.user));
  return {
    global: MAINNET.pumpGlobal,
    base_mint: p.mint,
    quote_mint: quoteMint,
    base_token_program: p.baseTokenProgram,
    quote_token_program: qtp,
    fee_recipient: feeRecipient,
    associated_quote_fee_recipient: await ata(feeRecipient, quoteMint, qtp),
    buyback_fee_recipient: buyback,
    associated_quote_buyback_fee_recipient: await ata(buyback, quoteMint, qtp),
    bonding_curve: bondingCurve,
    associated_base_bonding_curve: await ata(bondingCurve, p.mint, p.baseTokenProgram),
    associated_quote_bonding_curve: await ata(bondingCurve, quoteMint, qtp),
    user: p.user,
    associated_base_user: await ata(p.user, p.mint, p.baseTokenProgram),
    associated_quote_user: await ata(p.user, quoteMint, qtp),
    creator_vault: creatorVault,
    associated_creator_vault: await ata(creatorVault, quoteMint, qtp),
    sharing_config: await pda(PROGRAMS.pumpFees, text("sharing-config"), key(p.mint)),
    global_volume_accumulator: await pda(PROGRAMS.pump, text("global_volume_accumulator")),
    user_volume_accumulator: uva,
    associated_user_volume_accumulator: await ata(uva, quoteMint, qtp),
    fee_config: MAINNET.pumpFeeConfig,
    fee_program: PROGRAMS.pumpFees,
    system_program: SYSTEM_PROGRAM,
    event_authority: await pda(PROGRAMS.pump, text("__event_authority")),
    program: PROGRAMS.pump,
    ...p.overrides,
  };
}

async function curveLegacyAccounts(p: CurveTradeParams): Promise<Record<string, Address>> {
  const bondingCurve = await pda(PROGRAMS.pump, text("bonding-curve"), key(p.mint));
  return {
    global: MAINNET.pumpGlobal,
    fee_recipient: p.feeRecipient ?? MAINNET.pumpFeeRecipient,
    mint: p.mint,
    bonding_curve: bondingCurve,
    associated_bonding_curve: await ata(bondingCurve, p.mint, p.baseTokenProgram),
    associated_user: await ata(p.user, p.mint, p.baseTokenProgram),
    user: p.user,
    system_program: SYSTEM_PROGRAM,
    token_program: p.baseTokenProgram,
    creator_vault: await pda(PROGRAMS.pump, text("creator-vault"), key(p.creator)),
    event_authority: await pda(PROGRAMS.pump, text("__event_authority")),
    program: PROGRAMS.pump,
    global_volume_accumulator: await pda(PROGRAMS.pump, text("global_volume_accumulator")),
    user_volume_accumulator: await pda(PROGRAMS.pump, text("user_volume_accumulator"), key(p.user)),
    fee_config: MAINNET.pumpFeeConfig,
    fee_program: PROGRAMS.pumpFees,
    ...p.overrides,
  };
}

/** A pump.fun bonding-curve instruction. Legacy instructions get the required 2026-04-28 remaining accounts. */
export async function curveInstruction(
  name: CurveInstructionName,
  p: CurveTradeParams,
  args: Record<string, bigint | boolean | undefined>,
  options: { cashback?: boolean; extraAccounts?: AccountMeta[] } = {},
): Promise<Instruction> {
  const isV2 = name.endsWith("_v2");
  const accounts = isV2 ? await curveV2Accounts(p) : await curveLegacyAccounts(p);
  const remaining: AccountMeta[] = [];
  if (!isV2) {
    if (name === "sell" && options.cashback) remaining.push(w(accounts.user_volume_accumulator!));
    remaining.push(
      ro(await pda(PROGRAMS.pump, text("bonding-curve-v2"), key(p.mint))),
      w(p.buybackFeeRecipient ?? MAINNET.buybackFeeRecipient),
    );
  }
  remaining.push(...(options.extraAccounts ?? []));
  return buildIdlInstruction({ programAddress: PROGRAMS.pump, program: "pump", name, accounts, args, remaining });
}

export interface AmmTradeParams {
  user: Address;
  baseMint: Address;
  baseTokenProgram: Address;
  /** Defaults to the coin's canonical pool. */
  pool?: Address;
  quoteMint?: Address;
  quoteTokenProgram?: Address;
  /** pool.coin_creator; undefined models a pool without a coin creator (no pool-v2 account). */
  coinCreator?: Address;
  protocolFeeRecipient?: Address;
  buybackFeeRecipient?: Address;
  cashback?: boolean;
  overrides?: Record<string, Address>;
}

export type AmmInstructionName = "buy" | "buy_exact_quote_in" | "sell";

/** A PumpSwap instruction with remaining accounts in pump-swap-sdk 1.20.0 order. */
export async function ammInstruction(
  name: AmmInstructionName,
  p: AmmTradeParams,
  args: Record<string, bigint | boolean | undefined>,
  options: { extraAccounts?: AccountMeta[] } = {},
): Promise<Instruction> {
  const quoteMint = p.quoteMint ?? WSOL_MINT;
  const pool = p.pool ?? (await findCanonicalPumpPool(PROGRAMS.pump, PROGRAMS.pumpAmm, p.baseMint, quoteMint));
  const qtp = p.quoteTokenProgram ?? TOKEN_PROGRAM;
  const protocolFeeRecipient = p.protocolFeeRecipient ?? MAINNET.ammProtocolFeeRecipient;
  const buyback = p.buybackFeeRecipient ?? MAINNET.buybackFeeRecipient;
  const coinCreatorVaultAuthority = await pda(PROGRAMS.pumpAmm, text("creator_vault"), key(p.coinCreator ?? SYSTEM_PROGRAM));
  const uva = await pda(PROGRAMS.pumpAmm, text("user_volume_accumulator"), key(p.user));
  const accounts: Record<string, Address> = {
    pool,
    user: p.user,
    global_config: MAINNET.ammGlobalConfig,
    base_mint: p.baseMint,
    quote_mint: quoteMint,
    user_base_token_account: await ata(p.user, p.baseMint, p.baseTokenProgram),
    user_quote_token_account: await ata(p.user, quoteMint, qtp),
    pool_base_token_account: await ata(pool, p.baseMint, p.baseTokenProgram),
    pool_quote_token_account: await ata(pool, quoteMint, qtp),
    protocol_fee_recipient: protocolFeeRecipient,
    protocol_fee_recipient_token_account: await ata(protocolFeeRecipient, quoteMint, qtp),
    base_token_program: p.baseTokenProgram,
    quote_token_program: qtp,
    system_program: SYSTEM_PROGRAM,
    event_authority: await pda(PROGRAMS.pumpAmm, text("__event_authority")),
    program: PROGRAMS.pumpAmm,
    coin_creator_vault_ata: await ata(coinCreatorVaultAuthority, quoteMint, qtp),
    coin_creator_vault_authority: coinCreatorVaultAuthority,
    global_volume_accumulator: await pda(PROGRAMS.pumpAmm, text("global_volume_accumulator")),
    user_volume_accumulator: uva,
    fee_config: MAINNET.ammFeeConfig,
    fee_program: PROGRAMS.pumpFees,
    ...p.overrides,
  };
  const remaining: AccountMeta[] = [];
  if (p.cashback) {
    remaining.push(w(await ata(uva, quoteMint, qtp)));
    if (name === "sell") remaining.push(w(uva));
  }
  if (p.coinCreator !== undefined) remaining.push(ro(await pda(PROGRAMS.pumpAmm, text("pool-v2"), key(p.baseMint))));
  remaining.push(ro(buyback), w(await ata(buyback, quoteMint, qtp)), ...(options.extraAccounts ?? []));
  return buildIdlInstruction({ programAddress: PROGRAMS.pumpAmm, program: "pump_amm", name, accounts, args, remaining });
}

/** PumpSwap extend_account(account, user), as pump-swap-sdk prepends it for pools shorter than 300 bytes. */
export async function ammExtendInstruction(
  p: { user: Address; account: Address; overrides?: Record<string, Address> },
  options: { extraAccounts?: AccountMeta[] } = {},
): Promise<Instruction> {
  return buildIdlInstruction({
    programAddress: PROGRAMS.pumpAmm,
    program: "pump_amm",
    name: "extend_account",
    accounts: {
      account: p.account,
      user: p.user,
      event_authority: await pda(PROGRAMS.pumpAmm, text("__event_authority")),
      program: PROGRAMS.pumpAmm,
      ...p.overrides,
    },
    args: {},
    remaining: options.extraAccounts ?? [],
  });
}
