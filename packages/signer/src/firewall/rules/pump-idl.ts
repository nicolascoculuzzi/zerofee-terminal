/**
 * Instruction layouts the firewall accepts on pump.fun's bonding curve and PumpSwap, transcribed
 * from the official Anchor IDLs (fetched 2026-10-03):
 *   https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json
 *     sha256 ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b
 *   https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json
 *     sha256 2091433899b07d003d98118ae6cd3c628960fd393b40710b6e15bce6d0e7f2d1
 * Required remaining accounts (not in the IDLs) follow BREAKING_FEE_RECIPIENT.md (2026-04-28) and
 * pump-swap-sdk 1.20.0 offlinePumpAmm.ts, as summarized in
 * docs/research_notes/Solana trading terminal teardown/pumpfun_and_launchpad_programs.md.
 * test/idl-layout.test.ts checks every discriminator, argument offset and account index below
 * against a trimmed copy of those IDLs (test/fixtures/pump-idl-subset.json).
 *
 * Instruction data is Anchor/Borsh: 8-byte discriminator, then arguments in order. OptionBool
 * (`track_volume`) is a 1-byte struct; clients may omit it, so those instructions accept 24 or 25 bytes.
 * Account indices below are 0-based.
 */

/** Positions of the accounts the firewall must check in one instruction family. */
export interface VenueLayout {
  /** Allowed account counts after stripping trailing jitodontfront markers (IDL accounts + required remaining accounts). */
  readonly accountCounts: readonly number[];
  readonly user: number;
  readonly baseMint: number;
  /** Absent for legacy curve instructions, which are always SOL-quoted. */
  readonly quoteMint?: number;
  readonly baseTokenProgram: number;
  readonly quoteTokenProgram?: number;
  readonly userBaseTokenAccount: number;
  readonly userQuoteTokenAccount?: number;
  /** PumpSwap: the pool account (checked against the canonical pool). */
  readonly pool?: number;
}

export interface VenueInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly side: "buy" | "sell";
  readonly layout: VenueLayout;
  readonly dataLengths: readonly number[];
  /** Buys: offset of the u64 cap argument (max quote in, fees included). */
  readonly capOffset?: number;
  /** Offset of the u64 token-amount argument. */
  readonly baseOffset: number;
  readonly baseAmountIs: "exact_out" | "min_out" | "exact_in";
  /** Sells: offset of the u64 minimum quote out. */
  readonly minOutOffset?: number;
}

// ---------------------------------------------------------------------------------------------
// pump.fun bonding curve, 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
// ---------------------------------------------------------------------------------------------

/**
 * buy / buy_exact_sol_in: 16 IDL accounts
 *   0 global, 1 fee_recipient, 2 mint, 3 bonding_curve, 4 associated_bonding_curve, 5 associated_user,
 *   6 user (s,w), 7 system_program, 8 token_program, 9 creator_vault, 10 event_authority, 11 program,
 *   12 global_volume_accumulator, 13 user_volume_accumulator, 14 fee_config, 15 fee_program
 * + required since 2026-04-28: 16 bonding_curve_v2 (r), 17 buyback_fee_recipient (w)  => 18
 */
const CURVE_LEGACY_BUY: VenueLayout = { accountCounts: [18], user: 6, baseMint: 2, baseTokenProgram: 8, userBaseTokenAccount: 5 };

/**
 * sell: 14 IDL accounts
 *   0 global, 1 fee_recipient, 2 mint, 3 bonding_curve, 4 associated_bonding_curve, 5 associated_user,
 *   6 user (s,w), 7 system_program, 8 creator_vault, 9 token_program (after creator_vault, unlike buy),
 *   10 event_authority, 11 program, 12 fee_config, 13 fee_program
 * + [user_volume_accumulator (w), cashback coins only], bonding_curve_v2 (r), buyback_fee_recipient (w)  => 16 or 17
 */
const CURVE_LEGACY_SELL: VenueLayout = { accountCounts: [16, 17], user: 6, baseMint: 2, baseTokenProgram: 9, userBaseTokenAccount: 5 };

/**
 * buy_v2 / buy_exact_quote_in_v2: 27 IDL accounts, no remaining accounts
 *   0 global, 1 base_mint, 2 quote_mint, 3 base_token_program, 4 quote_token_program,
 *   5 associated_token_program, 6 fee_recipient, 7 associated_quote_fee_recipient,
 *   8 buyback_fee_recipient, 9 associated_quote_buyback_fee_recipient, 10 bonding_curve,
 *   11 associated_base_bonding_curve, 12 associated_quote_bonding_curve, 13 user (s,w),
 *   14 associated_base_user, 15 associated_quote_user, 16 creator_vault, 17 associated_creator_vault,
 *   18 sharing_config, 19 global_volume_accumulator, 20 user_volume_accumulator,
 *   21 associated_user_volume_accumulator, 22 fee_config, 23 fee_program, 24 system_program,
 *   25 event_authority, 26 program
 * sell_v2: the same minus global_volume_accumulator => 26 (indices 0..18 unchanged).
 */
const CURVE_V2_BUY: VenueLayout = {
  accountCounts: [27],
  user: 13,
  baseMint: 1,
  quoteMint: 2,
  baseTokenProgram: 3,
  quoteTokenProgram: 4,
  userBaseTokenAccount: 14,
  userQuoteTokenAccount: 15,
};
const CURVE_V2_SELL: VenueLayout = { ...CURVE_V2_BUY, accountCounts: [26] };

export const PUMP_CURVE_INSTRUCTIONS: readonly VenueInstruction[] = [
  // buy(amount: u64, max_sol_cost: u64, track_volume: OptionBool)
  {
    name: "buy",
    discriminator: [102, 6, 61, 18, 1, 218, 235, 234],
    side: "buy",
    layout: CURVE_LEGACY_BUY,
    dataLengths: [24, 25],
    baseOffset: 8,
    baseAmountIs: "exact_out",
    capOffset: 16,
  },
  // buy_exact_sol_in(spendable_sol_in: u64, min_tokens_out: u64, track_volume: OptionBool)
  {
    name: "buy_exact_sol_in",
    discriminator: [56, 252, 116, 8, 158, 223, 205, 95],
    side: "buy",
    layout: CURVE_LEGACY_BUY,
    dataLengths: [24, 25],
    capOffset: 8,
    baseOffset: 16,
    baseAmountIs: "min_out",
  },
  // buy_v2(amount: u64, max_sol_cost: u64)
  {
    name: "buy_v2",
    discriminator: [184, 23, 238, 97, 103, 197, 211, 61],
    side: "buy",
    layout: CURVE_V2_BUY,
    dataLengths: [24],
    baseOffset: 8,
    baseAmountIs: "exact_out",
    capOffset: 16,
  },
  // buy_exact_quote_in_v2(spendable_quote_in: u64, min_tokens_out: u64)
  {
    name: "buy_exact_quote_in_v2",
    discriminator: [194, 171, 28, 70, 104, 77, 91, 47],
    side: "buy",
    layout: CURVE_V2_BUY,
    dataLengths: [24],
    capOffset: 8,
    baseOffset: 16,
    baseAmountIs: "min_out",
  },
  // sell(amount: u64, min_sol_output: u64)
  {
    name: "sell",
    discriminator: [51, 230, 133, 164, 1, 127, 131, 173],
    side: "sell",
    layout: CURVE_LEGACY_SELL,
    dataLengths: [24],
    baseOffset: 8,
    baseAmountIs: "exact_in",
    minOutOffset: 16,
  },
  // sell_v2(amount: u64, min_sol_output: u64)
  {
    name: "sell_v2",
    discriminator: [93, 246, 130, 60, 231, 233, 64, 178],
    side: "sell",
    layout: CURVE_V2_SELL,
    dataLengths: [24],
    baseOffset: 8,
    baseAmountIs: "exact_in",
    minOutOffset: 16,
  },
];

// ---------------------------------------------------------------------------------------------
// PumpSwap (pump_amm), pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
// ---------------------------------------------------------------------------------------------

/**
 * buy / buy_exact_quote_in: 23 IDL accounts
 *   0 pool, 1 user (s,w), 2 global_config, 3 base_mint, 4 quote_mint, 5 user_base_token_account,
 *   6 user_quote_token_account, 7 pool_base_token_account, 8 pool_quote_token_account,
 *   9 protocol_fee_recipient, 10 protocol_fee_recipient_token_account, 11 base_token_program,
 *   12 quote_token_program, 13 system_program, 14 associated_token_program, 15 event_authority,
 *   16 program, 17 coin_creator_vault_ata, 18 coin_creator_vault_authority,
 *   19 global_volume_accumulator, 20 user_volume_accumulator, 21 fee_config, 22 fee_program
 * + remaining: [UVA quote ATA (w), cashback only], [pool-v2 (r), if coin_creator is set],
 *   buyback_fee_recipient (r), its quote ATA (w)  => 25, 26 or 27
 */
const AMM_BUY: VenueLayout = {
  accountCounts: [25, 26, 27],
  pool: 0,
  user: 1,
  baseMint: 3,
  quoteMint: 4,
  baseTokenProgram: 11,
  quoteTokenProgram: 12,
  userBaseTokenAccount: 5,
  userQuoteTokenAccount: 6,
};

/**
 * sell: 21 IDL accounts (buy's list minus global_volume_accumulator and user_volume_accumulator;
 * 19 fee_config, 20 fee_program) + remaining: [UVA quote ATA (w), UVA (w), cashback only],
 * [pool-v2 (r)], buyback_fee_recipient (r), its quote ATA (w)  => 23, 24, 25 or 26
 */
const AMM_SELL: VenueLayout = { ...AMM_BUY, accountCounts: [23, 24, 25, 26] };

export const PUMP_AMM_INSTRUCTIONS: readonly VenueInstruction[] = [
  // buy(base_amount_out: u64, max_quote_amount_in: u64, track_volume: OptionBool)
  {
    name: "buy",
    discriminator: [102, 6, 61, 18, 1, 218, 235, 234],
    side: "buy",
    layout: AMM_BUY,
    dataLengths: [24, 25],
    baseOffset: 8,
    baseAmountIs: "exact_out",
    capOffset: 16,
  },
  // buy_exact_quote_in(spendable_quote_in: u64, min_base_amount_out: u64, track_volume: OptionBool)
  {
    name: "buy_exact_quote_in",
    discriminator: [198, 46, 21, 82, 180, 217, 232, 112],
    side: "buy",
    layout: AMM_BUY,
    dataLengths: [24, 25],
    capOffset: 8,
    baseOffset: 16,
    baseAmountIs: "min_out",
  },
  // sell(base_amount_in: u64, min_quote_amount_out: u64)
  {
    name: "sell",
    discriminator: [51, 230, 133, 164, 1, 127, 131, 173],
    side: "sell",
    layout: AMM_SELL,
    dataLengths: [24],
    baseOffset: 8,
    baseAmountIs: "exact_in",
    minOutOffset: 16,
  },
];

/** Layout of an instruction that takes no arguments and whose accounts are checked by position. */
export interface AccountExtensionInstruction {
  readonly name: string;
  readonly discriminator: readonly number[];
  readonly dataLength: number;
  readonly accountCount: number;
  /** The account being extended. */
  readonly account: number;
  /** Pays the rent for the added bytes (signer, writable). */
  readonly user: number;
  /** CPI target for the rent transfer, signed with `user`'s privilege. */
  readonly systemProgram: number;
}

/**
 * extend_account(): grows a pump_amm-owned account to the current layout; the rent for the added
 * bytes moves from `user` through a System program CPI. pump-swap-sdk 1.20.0 (withFixPoolInstructions)
 * and @zerofee/core prepend it to buy / sell when the pool is shorter than POOL_ACCOUNT_NEW_SIZE
 * (300 bytes; older pools are 211 to 270 bytes), because the program writes the whole Pool back.
 *   0 account (w), 1 user (s,w), 2 system_program, 3 event_authority, 4 program; no arguments.
 */
export const PUMP_AMM_EXTEND_ACCOUNT: AccountExtensionInstruction = {
  name: "extend_account",
  discriminator: [234, 102, 194, 203, 150, 72, 62, 229],
  dataLength: 8,
  accountCount: 5,
  account: 0,
  user: 1,
  systemProgram: 2,
};

// Generated from the IDLs above: every instruction name keyed by hex discriminator, so refusals
// can name what was attempted (e.g. "migrate", "collect_creator_fee").

/** Every instruction in pump.json (47), keyed by hex discriminator. */
export const PUMP_INSTRUCTION_NAMES: Readonly<Record<string, string>> = {
  "020e3d8aaa8e0e5f": "add_quote_control_mint",
  "6f79153828185ed1": "add_quote_mint",
  "7d7ed6864de5bc59": "admin_cto",
  "08d960e79068c005": "admin_set_idl_authority",
  d10b7357d5177ccc: "admin_update_token_incentives",
  "66063d1201daebea": "buy",
  c2ab1c46684d5b2f: "buy_exact_quote_in_v2",
  "38fc74089edfcd5f": "buy_exact_sol_in",
  b817ee6167c5d33d: "buy_v2",
  "253a237ebe35e4c5": "claim_cashback",
  "7af3cc415e741d37": "claim_cashback_v2",
  "1004471ccc01281b": "claim_token_incentives",
  f945a4da9667548a: "close_user_volume_accumulator",
  "1416567bc61cdb84": "collect_creator_fee",
  cf118af204221338: "collect_creator_fee_v2",
  "181ec828051c0777": "create",
  d6904cec5f8b31b4: "create_v2",
  a572670079cef751: "distribute_creator_fees",
  ffcb134ff444089f: "distribute_creator_fees_v2",
  "623691610246ad2b": "distribute_fee_to_holders",
  ea66c2cb96483ee5: "extend_account",
  "75e17fca865f4423": "get_minimum_distributable_fee",
  "5e06ca73ff60e8b7": "init_user_volume_accumulator",
  afaf6d1f0d989bed: "initialize",
  ef49f5add1b15442: "initialize_quote_control",
  "9beae792ec9ea21e": "migrate",
  "577c34bf3426d6e8": "migrate_bonding_curve_creator",
  bbcb121fceedfe29: "migrate_v2",
  df07fd1a51a5daa6: "remove_quote_control_mint",
  b141df2658d19e9b: "remove_quote_mint",
  "33e685a4017f83ad": "sell",
  "5df6823ce7e940b2": "sell_v2",
  fe94ff70cf8eaaa5: "set_creator",
  "3da9bcbf99952a61": "set_mayhem_virtual_params",
  "8a60aed93055c5f6": "set_metaplex_creator",
  "1beab2349302bb8d": "set_params",
  "3e4fa1d3a5aad6d2": "set_quote_control_admin",
  "6faca2e87259d58e": "set_reserved_fee_recipients",
  "6587bf6809581460": "set_virtual_quote_reserves",
  "561fc057a3574fee": "sync_user_volume_accumulator",
  "7367e0ffbd5956c3": "toggle_cashback_enabled",
  "1cffe6f0ac6bcbab": "toggle_create_v2",
  "01096fd0641fffa3": "toggle_mayhem_mode",
  fbe0ab92a01a71e9: "update_buyback_config",
  "3dafa0f9424288af": "update_creator_fee_config",
  e3b54ac4d01561d5: "update_global_authority",
  e1fc4204c723ec10: "update_holder_reward_config",
};

/** Every instruction in pump_amm.json (32), keyed by hex discriminator. */
export const PUMP_AMM_INSTRUCTION_NAMES: Readonly<Record<string, string>> = {
  "2d3da597680031bd": "admin_cto_pool",
  d10b7357d5177ccc: "admin_update_token_incentives",
  "694406af000723a2": "boost_buy_and_burn",
  "66063d1201daebea": "buy",
  c62e1552b4d9e870: "buy_exact_quote_in",
  "253a237ebe35e4c5": "claim_cashback",
  "1004471ccc01281b": "claim_token_incentives",
  f945a4da9667548a: "close_user_volume_accumulator",
  a039592ab58b2b42: "collect_coin_creator_fee",
  c9cff3724b6f2fbd: "create_config",
  e992d18ecf6840bc: "create_pool",
  f223c68952e1f2b6: "deposit",
  b9adbb5ad80feee9: "disable",
  ea66c2cb96483ee5: "extend_account",
  "8ce9215e845ac28f": "init_boost",
  "5e06ca73ff60e8b7": "init_user_volume_accumulator",
  d0089f044aaf103a: "migrate_pool_coin_creator",
  "33e685a4017f83ad": "sell",
  e3954c2a8227eacd: "set_boost_authority",
  d295802dbc3a4eaf: "set_coin_creator",
  "6faca2e87259d58e": "set_reserved_fee_recipients",
  "561fc057a3574fee": "sync_user_volume_accumulator",
  "75a1a04adf897663": "toggle_boost",
  "7367e0ffbd5956c3": "toggle_cashback_enabled",
  "01096fd0641fffa3": "toggle_mayhem_mode",
  "8b348655e4e56cf1": "transfer_creator_fees_to_pump",
  "01214eb921432c5c": "transfer_creator_fees_to_pump_v2",
  a1b028d53cb8b3e4: "update_admin",
  fbe0ab92a01a71e9: "update_buyback_config",
  "3dafa0f9424288af": "update_creator_fee_config",
  "68b867f258976b14": "update_fee_config",
  b712469c946da122: "withdraw",
};
