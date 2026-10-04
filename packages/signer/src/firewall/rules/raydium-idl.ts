/**
 * Instruction layouts the firewall accepts on Raydium LaunchLab and Raydium CPMM, transcribed from the
 * official Anchor IDLs pinned in packages/core/idl/RAYDIUM_SOURCE.json (raydium-io/raydium-idl e7e0c96):
 *   https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_launchpad/raydium_launchpad.json
 *     sha256 963189409945069409f32e345d4adf2892e0b3ca1be504372577fe34a23c6cdb
 *   https://github.com/raydium-io/raydium-idl/blob/e7e0c96fe77bcf6a020b84a44c47a722aac8e359/raydium_cpmm/raydium_cp_swap.json
 *     sha256 1202f6dc8e1c3216598f2ad5c620b9aa8c64ac584563fafed68125c27fb6df81
 * The IDL repo lags the deployed LaunchLab program in two places. Both match every LaunchLab swap in
 * core's mainnet snapshot (packages/core/test/fixtures/raydium-mainnet.json, 2026-10-03) and the
 * official SDK (raydium-sdk-V2 cc33ec2 src/raydium/launchpad/instrument.ts):
 *   - three remaining accounts are mandatory since the fee-vault upgrade: system_program,
 *     platform_fee_vault = PDA[platform_config, quote_mint] and creator_fee_vault = PDA[creator,
 *     quote_mint]. A share_fee_receiver goes before them when share_fee_rate > 0, which the firewall
 *     refuses;
 *   - quote_token_program is not pinned to SPL Token: pairs quoted in Token-2022 xStocks pass Token-2022.
 * test/idl-layout.test.ts checks every discriminator, argument offset and account index below against
 * a trimmed copy of those IDLs (test/fixtures/raydium-idl-subset.json); test/constants-crosscheck.test.ts
 * checks them against core's builders, seeds and vendored IDLs.
 *
 * Instruction data is Anchor/Borsh: 8-byte discriminator, then u64 arguments in order. Account
 * indices are 0-based.
 */
import type { TradeAction } from "../types";

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab, LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
// ---------------------------------------------------------------------------------------------

/**
 * buy_exact_in / buy_exact_out / sell_exact_in / sell_exact_out share one account list: 15 IDL accounts
 *   0 payer (s,w), 1 authority, 2 global_config, 3 platform_config, 4 pool_state (w),
 *   5 user_base_token (w), 6 user_quote_token (w), 7 base_vault (w), 8 quote_vault (w),
 *   9 base_token_mint, 10 quote_token_mint, 11 base_token_program, 12 quote_token_program,
 *   13 event_authority, 14 program
 * + remaining (share_fee_rate = 0): 15 system_program, 16 platform_fee_vault (w), 17 creator_fee_vault (w)  => 18
 */
export const LAUNCHLAB_SWAP_LAYOUT = {
  accountCount: 18,
  payer: 0,
  /** Vault authority PDA ["vault_auth_seed"] (mainnet WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh). */
  authority: 1,
  globalConfig: 2,
  platformConfig: 3,
  /** PDA ["pool", base_mint, quote_mint]. */
  pool: 4,
  userBaseToken: 5,
  userQuoteToken: 6,
  baseVault: 7,
  quoteVault: 8,
  baseMint: 9,
  quoteMint: 10,
  baseTokenProgram: 11,
  quoteTokenProgram: 12,
  /** Anchor event-CPI authority PDA ["__event_authority"] (mainnet 2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr). */
  eventAuthority: 13,
  program: 14,
  /** Invoked with the payer's signature to create a missing fee vault. */
  systemProgram: 15,
  /** PDA [platform_config, quote_mint] (no string seed). */
  platformFeeVault: 16,
  /** PDA [pool.creator, quote_mint]; the creator is pool state, so only the program can check it. */
  creatorFeeVault: 17,
} as const;

/** All four swaps: discriminator + amount (u64) + limit (u64) + share_fee_rate (u64). */
export const LAUNCHLAB_DATA_LENGTH = 32;
/**
 * share_fee_rate, the third u64: a referral fee paid to a share_fee_receiver account, up to
 * GlobalConfig.max_share_fee_rate (10,000 ppm = 1% on the SOL GlobalConfig in core's snapshot).
 */
export const LAUNCHLAB_SHARE_FEE_RATE_OFFSET = 24;

export interface LaunchLabSwapInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly side: "buy" | "sell";
  /** Buys: offset of the u64 cap argument (the quote debited from the user, fees included). */
  readonly capOffset?: number;
  /** Offset of the u64 base-token amount. */
  readonly baseOffset: number;
  readonly baseAmountIs: TradeAction["baseAmountIs"];
  /** Sells: offset of the u64 minimum (sell_exact_in) or exact (sell_exact_out) quote received. */
  readonly minOutOffset?: number;
}

export const LAUNCHLAB_SWAP_INSTRUCTIONS: readonly LaunchLabSwapInstruction[] = [
  // buy_exact_in(amount_in: u64, minimum_amount_out: u64, share_fee_rate: u64)
  {
    name: "buy_exact_in",
    discriminator: [250, 234, 13, 123, 213, 156, 19, 236],
    side: "buy",
    capOffset: 8,
    baseOffset: 16,
    baseAmountIs: "min_out",
  },
  // buy_exact_out(amount_out: u64, maximum_amount_in: u64, share_fee_rate: u64)
  {
    name: "buy_exact_out",
    discriminator: [24, 211, 116, 40, 105, 3, 153, 56],
    side: "buy",
    baseOffset: 8,
    baseAmountIs: "exact_out",
    capOffset: 16,
  },
  // sell_exact_in(amount_in: u64, minimum_amount_out: u64, share_fee_rate: u64)
  {
    name: "sell_exact_in",
    discriminator: [149, 39, 222, 155, 211, 124, 152, 26],
    side: "sell",
    baseOffset: 8,
    baseAmountIs: "exact_in",
    minOutOffset: 16,
  },
  // sell_exact_out(amount_out: u64, maximum_amount_in: u64, share_fee_rate: u64)
  {
    name: "sell_exact_out",
    discriminator: [95, 200, 71, 34, 8, 9, 11, 166],
    side: "sell",
    minOutOffset: 8,
    baseOffset: 16,
    baseAmountIs: "max_in",
  },
];

// ---------------------------------------------------------------------------------------------
// Raydium CPMM (cp-swap), CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
// ---------------------------------------------------------------------------------------------

/**
 * swap_base_input / swap_base_output: 13 IDL accounts, no remaining accounts
 *   0 payer (s), 1 authority, 2 amm_config, 3 pool_state (w), 4 input_token_account (w),
 *   5 output_token_account (w), 6 input_vault (w), 7 output_vault (w), 8 input_token_program,
 *   9 output_token_program, 10 input_token_mint, 11 output_token_mint, 12 observation_state (w)
 */
export const CPMM_SWAP_LAYOUT = {
  accountCount: 13,
  payer: 0,
  /** Vault and LP-mint authority PDA ["vault_and_lp_mint_auth_seed"] (mainnet GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL). */
  authority: 1,
  ammConfig: 2,
  pool: 3,
  inputTokenAccount: 4,
  outputTokenAccount: 5,
  /** PDA ["pool_vault", pool, input_mint]. */
  inputVault: 6,
  /** PDA ["pool_vault", pool, output_mint]. */
  outputVault: 7,
  inputTokenProgram: 8,
  outputTokenProgram: 9,
  inputMint: 10,
  outputMint: 11,
  /** PDA ["observation", pool]. */
  observation: 12,
} as const;

/** Both swaps: discriminator + two u64 arguments. */
export const CPMM_DATA_LENGTH = 24;

export interface CpmmSwapInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  /** Offset of the u64 input-mint amount: exactly sent (amount_in) or at most (max_amount_in). */
  readonly inputOffset: number;
  readonly inputIs: "exact" | "max";
  /** Offset of the u64 output-mint amount: at least received (minimum_amount_out) or exactly (amount_out). */
  readonly outputOffset: number;
  readonly outputIs: "min" | "exact";
}

export const CPMM_SWAP_INSTRUCTIONS: readonly CpmmSwapInstruction[] = [
  // swap_base_input(amount_in: u64, minimum_amount_out: u64)
  {
    name: "swap_base_input",
    discriminator: [143, 190, 90, 218, 196, 30, 51, 222],
    inputOffset: 8,
    inputIs: "exact",
    outputOffset: 16,
    outputIs: "min",
  },
  // swap_base_output(max_amount_in: u64, amount_out: u64): note the order, the limit comes first
  {
    name: "swap_base_output",
    discriminator: [55, 217, 98, 86, 163, 74, 180, 173],
    inputOffset: 8,
    inputIs: "max",
    outputOffset: 16,
    outputIs: "exact",
  },
];

/**
 * PDA seeds (IDL `pda.seeds` consts for the authorities; launch-cpi states.rs and cp-swap states/*.rs
 * for the rest). The platform fee vault has no string seed: [platform_config, quote_mint].
 */
export const RAYDIUM_SEEDS = {
  launchLabAuthority: "vault_auth_seed",
  launchLabEventAuthority: "__event_authority",
  launchLabPool: "pool",
  cpmmAuthority: "vault_and_lp_mint_auth_seed",
  cpmmVault: "pool_vault",
  cpmmObservation: "observation",
} as const;

/**
 * Positions the firewall requires as static account keys (never loaded from a lookup table, whose
 * contents are caller-supplied): the signer, everything that decides where funds go or which cap
 * applies (user token accounts, mints, token programs), programs invoked with the user's signature
 * (token programs, System), and every account checked against a fixed address or a derivation,
 * including the derivation seeds. The rest are validated by the venue program itself.
 */
export const LAUNCHLAB_STATIC_POSITIONS: readonly number[] = [0, 1, 3, 4, 5, 6, 9, 10, 11, 12, 13, 15, 16];
export const CPMM_STATIC_POSITIONS: readonly number[] = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

// Generated from the IDLs above: every instruction name keyed by hex discriminator, so refusals can
// name what was attempted (e.g. "claim_creator_fee", "withdraw").

/** Every instruction in raydium_launchpad.json (25), keyed by hex discriminator. */
export const LAUNCHLAB_INSTRUCTION_NAMES: Readonly<Record<string, string>> = {
  faea0d7bd59c13ec: "buy_exact_in",
  "18d3742869039938": "buy_exact_out",
  "1a618acb84ab8dfc": "claim_creator_fee",
  "9c27d0874ced3d48": "claim_platform_fee",
  "75f1c6a8f8da501d": "claim_platform_fee_from_vault",
  "3121681ebd9d4f23": "claim_vested_token",
  "7bb4b8816fb9bb3b": "close_platform_global_access",
  "3cadf767045d8230": "collect_fee",
  ffba96dfeb76c9ba: "collect_migrate_fee",
  c9cff3724b6f2fbd: "create_config",
  b05ac4affd71dc14: "create_platform_config",
  a25b92c75d85eaed: "create_platform_global_access",
  "9247ad4562130f6a": "create_platform_vesting_account",
  "81b2020dd9ace6da": "create_vesting_account",
  afaf6d1f0d989bed: "initialize",
  "4399af27da102620": "initialize_v2",
  "25be7ede2c9aab11": "initialize_with_token_2022",
  cf52c091fecf91df: "migrate_to_amm",
  "885cc8671cda908c": "migrate_to_cpswap",
  "1b1e3ea95de01891": "remove_platform_curve_param",
  "9527de9bd37c981a": "sell_exact_in",
  "5fc8472208090ba6": "sell_exact_out",
  "1d9efcbf0a53db63": "update_config",
  c33c4c81922d438f: "update_platform_config",
  "8a908afadc800439": "update_platform_curve_param",
};

/** Every instruction in raydium_cp_swap.json (14), keyed by hex discriminator. */
export const CPMM_INSTRUCTION_NAMES: Readonly<Record<string, string>> = {
  "9c5420764587467b": "close_permission_pda",
  "1416567bc61cdb84": "collect_creator_fee",
  a78a4e95dfc2067e: "collect_fund_fee",
  "8888fcddc2427e59": "collect_protocol_fee",
  "8934edd4d7756c68": "create_amm_config",
  "878802d889a9b5ca": "create_permission_pda",
  f223c68952e1f2b6: "deposit",
  afaf6d1f0d989bed: "initialize",
  "3f37fe4131b25979": "initialize_with_permission",
  "8fbe5adac41e33de": "swap_base_input",
  "37d96256a34ab4ad": "swap_base_output",
  "313cae889a1c74c8": "update_amm_config",
  "82576c062ee0757b": "update_pool_status",
  b712469c946da122: "withdraw",
};
