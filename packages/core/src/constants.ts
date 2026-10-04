/**
 * Every on-chain address, PDA seed, discriminator, fee-recipient list, endpoint and
 * tip-account fallback used by the trade engine. Nothing of this kind may be hardcoded
 * anywhere else in the codebase.
 *
 * Sources are the verified research notes in
 * `docs/research_notes/Solana trading terminal teardown/` (pumpfun_and_launchpad_programs.md,
 * tx_landing_and_mev.md), which in turn cite the URLs repeated next to each value.
 *
 * Values that the notes say must be checked live are only FALLBACKS here:
 *  - Jito tip accounts           -> fetched with `getTipAccounts` (send/jito.ts)
 *  - fee recipients              -> read from the live `Global` / `GlobalConfig` accounts
 *  - rent                        -> `getMinimumBalanceForRentExemption` (never hardcoded)
 *  - creator / coin_creator      -> read from the live bonding curve / pool account
 *  - fee tiers                   -> read from the live `FeeConfig` accounts
 */
import { type Address, address } from "@solana/kit";

// ---------------------------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------------------------

/** pump.fun bonding-curve program. https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md */
export const PUMP_PROGRAM_ID: Address = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/** PumpSwap (pump AMM). https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json */
export const PUMP_AMM_PROGRAM_ID: Address = address("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** Pump Fees program (FeeConfig, sharing config). https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json */
export const PUMP_FEE_PROGRAM_ID: Address = address("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
/** Mayhem program. https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md */
export const MAYHEM_PROGRAM_ID: Address = address("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");

/** SPL Token. https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md */
export const TOKEN_PROGRAM_ID: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022 (create_v2 mints). https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md */
export const TOKEN_2022_PROGRAM_ID: Address = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Associated Token Account program. https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json */
export const ASSOCIATED_TOKEN_PROGRAM_ID: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** System program. https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json */
export const SYSTEM_PROGRAM_ID: Address = address("11111111111111111111111111111111");
/** Compute Budget program. https://solana.com/docs/core/fees */
export const COMPUTE_BUDGET_PROGRAM_ID: Address = address("ComputeBudget111111111111111111111111111111");
/** Metaplex Token Metadata (legacy `create` coins keep name/symbol/uri here). https://developers.metaplex.com/token-metadata */
export const MPL_TOKEN_METADATA_PROGRAM_ID: Address = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/** Address Lookup Table program. https://solana.com/developers/guides/advanced/lookup-tables */
export const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Address = address("AddressLookupTab1e1111111111111111111111111");

/** RecentBlockhashes sysvar (nonce initialize / advance / withdraw). https://docs.rs/solana-sysvar/latest/solana_sysvar/recent_blockhashes/ */
export const SYSVAR_RECENT_BLOCKHASHES_ID: Address = address("SysvarRecentB1ockHashes11111111111111111111");
/** Rent sysvar (nonce initialize / withdraw). https://docs.rs/solana-sysvar/latest/solana_sysvar/rent/ */
export const SYSVAR_RENT_ID: Address = address("SysvarRent111111111111111111111111111111111");
/**
 * Clock sysvar (slot, epoch, unix_timestamp). Read in the same getMultipleAccounts batch as the
 * venue state: Token-2022 transfer fees depend on the epoch and CPMM pools on open_time.
 * https://docs.anza.xyz/runtime/sysvars#clock
 */
export const SYSVAR_CLOCK_ID: Address = address("SysvarC1ock11111111111111111111111111111111");

// ---------------------------------------------------------------------------------------------
// Durable nonces and address lookup tables (armed orders)
// ---------------------------------------------------------------------------------------------

/**
 * System program instruction tags (bincode u32 LE).
 * https://github.com/anza-xyz/solana-sdk/blob/master/system-interface/src/instruction.rs
 */
export const SYSTEM_IX = {
  createAccount: 0,
  transfer: 2,
  createAccountWithSeed: 3,
  advanceNonceAccount: 4,
  withdrawNonceAccount: 5,
  initializeNonceAccount: 6,
  authorizeNonceAccount: 7,
} as const;

/**
 * Nonce account size: bincode `Versions<State>` = u32 version + u32 state + authority (32) +
 * durable nonce (32) + fee calculator (u64) = 80 bytes. Rent is ALWAYS read with
 * `getMinimumBalanceForRentExemption(80)` (it dropped in 2026 and differs per cluster).
 * https://github.com/anza-xyz/solana-sdk/blob/master/nonce/src/state.rs
 */
export const NONCE_ACCOUNT_LENGTH = 80;
/** Max length of a `create_with_seed` seed. https://github.com/anza-xyz/solana-sdk/blob/master/pubkey/src/lib.rs (MAX_SEED_LEN) */
export const MAX_SEED_LENGTH = 32;
/**
 * Seed prefix for nonce slots. Slots are created with `CreateAccountWithSeed` (base = trading
 * wallet) so the trading wallet stays the ONLY signer, as the signer firewall requires
 * (packages/signer/src/firewall/rules/system.ts). Ours, not a chain constant.
 */
export const NONCE_SLOT_SEED_PREFIX = "zerofee-nonce-";
/**
 * Max lamports a nonce slot may be funded with: the signer firewall's default cap
 * (packages/signer/src/firewall/programs.ts DEFAULT_MAX_NONCE_ACCOUNT_LAMPORTS, 0.002 SOL). Rent
 * itself is read live; this only rejects a funding the firewall would refuse.
 */
export const MAX_NONCE_SLOT_LAMPORTS = 2_000_000n;

/**
 * Address Lookup Table program instruction tags (bincode u32 LE) and account layout.
 * https://github.com/anza-xyz/solana-sdk/blob/master/address-lookup-table-interface/src/instruction.rs
 * https://github.com/anza-xyz/solana-sdk/blob/master/address-lookup-table-interface/src/state.rs
 */
export const ALT_IX = {
  createLookupTable: 0,
  freezeLookupTable: 1,
  extendLookupTable: 2,
  deactivateLookupTable: 3,
  closeLookupTable: 4,
} as const;
/** `LOOKUP_TABLE_META_SIZE`: addresses start at this byte offset. */
export const LOOKUP_TABLE_META_SIZE = 56;
/** `LOOKUP_TABLE_MAX_ADDRESSES`. */
export const LOOKUP_TABLE_MAX_ADDRESSES = 256;
/**
 * A deactivated table stays usable until its deactivation slot leaves the 512-entry SlotHashes
 * sysvar; only then can it be closed. Armed orders that reference a table die when it closes, so
 * operator tables are never deactivated while referenced.
 * https://github.com/anza-xyz/agave/blob/master/programs/address-lookup-table/src/processor.rs
 */
export const LOOKUP_TABLE_DEACTIVATION_COOLDOWN_SLOTS = 513;
/** Addresses per ExtendLookupTable instruction that keep the extend tx well under 1,232 bytes (25 x 32 B + overhead). */
export const LOOKUP_TABLE_EXTEND_CHUNK = 25;

// ---------------------------------------------------------------------------------------------
// Mints
// ---------------------------------------------------------------------------------------------

/** Wrapped SOL (legacy SPL). Quote mint for SOL coins in buy_v2/sell_v2. https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md */
export const WSOL_MINT: Address = address("So11111111111111111111111111111111111111112");
/** Token-2022 native mint; pump-fees treats it as SOL-like. pump-sdk 2.0.0 src/fees.ts https://www.npmjs.com/package/@pump-fun/pump-sdk?activeTab=code */
export const NATIVE_MINT_2022: Address = address("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
/** USDC; the only stable quote mint (pump_fees STABLE_QUOTE_MINTS). https://github.com/pump-fun/pump-public-docs/blob/main/README.md */
export const USDC_MINT: Address = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/** `Pubkey::default()` - stored as `quote_mint` on SOL bonding curves. https://github.com/pump-fun/pump-public-docs/blob/main/README.md */
export const DEFAULT_PUBKEY: Address = address("11111111111111111111111111111111");

/** Quote mints that pay the SOL fee tiers (pump_fees is_sol_like_quote_mint). pump-sdk src/fees.ts */
export const SOL_LIKE_QUOTE_MINTS: readonly Address[] = [DEFAULT_PUBKEY, WSOL_MINT, NATIVE_MINT_2022];
/** Quote mints that pay `stable_fee_tiers`. pump-sdk src/fees.ts / pump-swap-sdk src/sdk/fees.ts */
export const STABLE_QUOTE_MINTS: readonly Address[] = [USDC_MINT];

// ---------------------------------------------------------------------------------------------
// Well-known PDAs (derivable, listed for assertions/tests)
// https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md and notes §9
// ---------------------------------------------------------------------------------------------

/** pump `Global` PDA = ["global"]. */
export const PUMP_GLOBAL: Address = address("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
/** pump curve FeeConfig = ["fee_config", PUMP_PROGRAM_ID] under the fees program. */
export const PUMP_FEE_CONFIG: Address = address("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
/** PumpSwap GlobalConfig = ["global_config"]. https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md */
export const PUMP_AMM_GLOBAL_CONFIG: Address = address("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
/** PumpSwap FeeConfig = ["fee_config", PUMP_AMM_PROGRAM_ID] under the fees program. https://solscan.io/account/5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx */
export const PUMP_AMM_FEE_CONFIG: Address = address("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
/** Canonical PumpSwap pool index (pump-sdk src/pda.ts CANONICAL_POOL_INDEX). */
export const CANONICAL_POOL_INDEX = 0;

// ---------------------------------------------------------------------------------------------
// PDA seeds. Note the subtle differences: pump `creator-vault` vs AMM `creator_vault`.
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json , idl/pump_amm.json
// ---------------------------------------------------------------------------------------------

export const SEEDS = {
  global: "global",
  bondingCurve: "bonding-curve",
  bondingCurveV2: "bonding-curve-v2",
  /** pump program creator vault (dash). */
  creatorVault: "creator-vault",
  mintAuthority: "mint-authority",
  eventAuthority: "__event_authority",
  globalVolumeAccumulator: "global_volume_accumulator",
  userVolumeAccumulator: "user_volume_accumulator",
  poolAuthority: "pool-authority",
  holderRewards: "holder-rewards",
  quoteControl: "quote-control",
  /** fees program: ["fee_config", <program id bytes>]. */
  feeConfig: "fee_config",
  /** fees program: ["sharing-config", mint]. */
  sharingConfig: "sharing-config",
  /** AMM: ["pool", u16 index LE, creator, base_mint, quote_mint]. */
  pool: "pool",
  poolLpMint: "pool_lp_mint",
  ammGlobalConfig: "global_config",
  /** AMM coin creator vault authority (underscore). */
  ammCreatorVault: "creator_vault",
  /** AMM ["pool-v2", base_mint]; remaining account on buy/sell when coin_creator is set. */
  poolV2: "pool-v2",
  /** Metaplex ["metadata", program id, mint]. https://developers.metaplex.com/token-metadata */
  metaplexMetadata: "metadata",
} as const;

/**
 * Token-2022 extension type numbers (spl-token-2022 ExtensionType).
 * https://github.com/solana-program/token-2022/blob/main/interface/src/extension/mod.rs
 */
export const TOKEN_2022_EXTENSIONS = {
  transferFeeConfig: 1,
  /** On token accounts: transfer fees withheld there (CloseAccount fails while non-zero). */
  transferFeeAmount: 2,
  mintCloseAuthority: 3,
  defaultAccountState: 6,
  nonTransferable: 9,
  interestBearingConfig: 10,
  permanentDelegate: 12,
  transferHook: 14,
  metadataPointer: 18,
  tokenMetadata: 19,
  scaledUiAmount: 25,
  pausable: 26,
} as const;

/**
 * Token-2022 layout and transfer-fee constants (swaps must deduct transfer fees like the token program).
 * https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/interface/src/extension/mod.rs
 * https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/interface/src/extension/transfer_fee/mod.rs
 */
/** Base SPL account length; Token-2022 mints are padded to it, then 1 account-type byte, then TLV entries. */
export const TOKEN_2022_BASE_ACCOUNT_LENGTH = 165;
/** First TLV byte (after the account-type byte at offset 165). TLV entry = u16 type, u16 length, value. */
export const TOKEN_2022_TLV_START = 166;
/** `MAX_FEE_BASIS_POINTS` = 100%. */
export const TOKEN_2022_MAX_FEE_BASIS_POINTS = 10_000n;
/** Mainnet epochs are a fixed 432,000 slots (no warmup); only a fallback when the Clock sysvar is not loaded. */
export const MAINNET_SLOTS_PER_EPOCH = 432_000n;

// ---------------------------------------------------------------------------------------------
// Instruction discriminators (Anchor, 8 bytes). https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
// ---------------------------------------------------------------------------------------------

export const PUMP_IX = {
  /** buy_v2(amount: u64, max_sol_cost: u64) - 27 accounts. docs/instructions/BUY.md */
  buyV2: new Uint8Array([184, 23, 238, 97, 103, 197, 211, 61]),
  /** sell_v2(amount: u64, min_sol_output: u64) - 26 accounts. docs/instructions/SELL.md */
  sellV2: new Uint8Array([93, 246, 130, 60, 231, 233, 64, 178]),
  /** buy_exact_quote_in_v2(spendable_quote_in: u64, min_tokens_out: u64) - 27 accounts. idl/pump.json */
  buyExactQuoteInV2: new Uint8Array([194, 171, 28, 70, 104, 77, 91, 47]),
  /** legacy buy (18 accounts incl. trailing bonding-curve-v2 + buyback recipient). */
  buy: new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]),
  /** legacy sell (16/17 accounts). */
  sell: new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]),
  /** legacy buy_exact_sol_in. */
  buyExactSolIn: new Uint8Array([56, 252, 116, 8, 158, 223, 205, 95]),
} as const;

/** https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json */
export const PUMP_AMM_IX = {
  /** buy(base_amount_out: u64, max_quote_amount_in: u64, track_volume: OptionBool) */
  buy: new Uint8Array([102, 6, 61, 18, 1, 218, 235, 234]),
  /** buy_exact_quote_in(spendable_quote_in: u64, min_base_amount_out: u64, track_volume: OptionBool) */
  buyExactQuoteIn: new Uint8Array([198, 46, 21, 82, 180, 217, 232, 112]),
  /** sell(base_amount_in: u64, min_quote_amount_out: u64) */
  sell: new Uint8Array([51, 230, 133, 164, 1, 127, 131, 173]),
  /** extend_account() - grows pools shorter than POOL_ACCOUNT_NEW_SIZE (the SDK prepends it). */
  extendAccount: new Uint8Array([234, 102, 194, 203, 150, 72, 62, 229]),
} as const;

/** Account discriminators. idl/pump.json, idl/pump_fees.json, idl/pump_amm.json */
export const ACCOUNT_DISCRIMINATORS = {
  global: new Uint8Array([167, 232, 232, 177, 200, 108, 114, 127]),
  bondingCurve: new Uint8Array([23, 183, 248, 55, 96, 216, 172, 96]),
  feeConfig: new Uint8Array([143, 52, 146, 187, 219, 123, 76, 155]),
  pool: new Uint8Array([241, 154, 109, 4, 17, 177, 109, 188]),
  ammGlobalConfig: new Uint8Array([149, 8, 156, 202, 160, 252, 176, 217]),
} as const;

/**
 * Event discriminators (Anchor event-CPI; inner ix data = EVENT_IX_TAG + disc + borsh). idl/pump.json, idl/pump_amm.json
 * (pump-sdk 2.0.0 vendored IDLs). NOTE: a discriminator is sha256("event:<Name>")[..8], so generic names (TradeEvent,
 * BuyEvent, CreateEvent) collide across Anchor programs - always attribute an event to its emitting program first.
 */
export const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
export const EVENT_DISCRIMINATORS = {
  pumpTrade: new Uint8Array([189, 219, 127, 211, 78, 230, 97, 238]),
  pumpCreate: new Uint8Array([27, 114, 169, 77, 222, 235, 99, 118]),
  pumpComplete: new Uint8Array([95, 114, 97, 156, 212, 46, 152, 8]),
  pumpCompleteAmmMigration: new Uint8Array([189, 233, 93, 185, 92, 148, 234, 148]),
  ammBuy: new Uint8Array([103, 244, 82, 31, 44, 245, 119, 119]),
  ammSell: new Uint8Array([62, 47, 55, 10, 165, 3, 220, 42]),
  ammCreatePool: new Uint8Array([177, 49, 12, 210, 160, 118, 167, 116]),
} as const;

/**
 * Burn destination excluded from holder concentration metrics (the incinerator account).
 * https://docs.rs/solana-sdk/latest/solana_sdk/incinerator/index.html
 */
export const INCINERATOR: Address = address("1nc1nerator11111111111111111111111111111111");

/** Expected fixed account counts (runtime assertions). Notes §9. */
export const EXPECTED_ACCOUNT_COUNTS = {
  pumpBuyV2: 27,
  pumpSellV2: 26,
  pumpBuyExactQuoteInV2: 27,
  /** AMM buy: 23 IDL + pool-v2 (if coin_creator set) + buyback + buyback ATA (+ cashback UVA ATA). */
  ammBuyBase: 23,
  ammSellBase: 21,
  /**
   * LaunchLab swap: 15 IDL accounts + system program + platform fee vault + creator fee vault
   * (remaining accounts, mandatory since the fee-vault upgrade; +1 share_fee_receiver when
   * share_fee_rate > 0). launch-cpi context.rs `Swap`; all mainnet swaps observed 2026-10-03 carry 18.
   */
  launchLabSwap: 18,
  /** CPMM swap_base_input / swap_base_output. raydium_cp_swap.json. */
  cpmmSwap: 13,
} as const;

/** Error codes worth mapping in the UI. idl/pump.json, idl/pump_amm.json */
export const PUMP_ERRORS: Record<number, string> = {
  6002: "TooMuchSolRequired (slippage on max_sol_cost)",
  6003: "TooLittleSolReceived (slippage on min_sol_output)",
  6005: "BondingCurveComplete (coin migrated / migrating)",
  6006: "BondingCurveNotComplete",
  6042: "BuySlippageBelowMinTokensOut",
  6049: "CreatorMigratedToSharingConfig",
  6081: "BondingCurveAlreadyMigrated",
};
export const PUMP_AMM_ERRORS: Record<number, string> = {
  6004: "ExceededSlippage",
  6040: "BuySlippageBelowMinBaseAmountOut",
};

// ---------------------------------------------------------------------------------------------
// Fee recipients (fallbacks; prefer the lists decoded from live Global / GlobalConfig)
// https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_RECIPIENTS.md
// https://github.com/pump-fun/pump-public-docs/blob/main/docs/BREAKING_FEE_RECIPIENT.md
// ---------------------------------------------------------------------------------------------

/** Bonding-curve `fee_recipient` list for non-mayhem coins (8). */
export const PUMP_FEE_RECIPIENTS: readonly Address[] = [
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
].map((a) => address(a));

/** Reserved `fee_recipient` list for mayhem coins (curve and AMM) (8). */
export const MAYHEM_FEE_RECIPIENTS: readonly Address[] = [
  "GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS",
  "4budycTjhs9fD6xw62VBducVTNgMgJJ5BgtKq7mAZwn6",
  "8SBKzEQU4nLSzcwF4a74F2iaUDQyTfjGndn6qUWBnrpR",
  "4UQeTP1T39KZ9Sfxzo3WR5skgsaP6NZa87BAkuazLEKH",
  "8sNeir4QsLsJdYpc9RZacohhK1Y5FLU3nC5LXgYB4aa6",
  "Fh9HmeLNUMVCvejxCtCL2DbYaRyBFVJ5xrWkLnMH6fdk",
  "463MEnMeGyJekNZFQSTUABBEbLnvMTALbT6ZmsxAbAdq",
  "6AUH3WEHucYZyC61hqpqYUWVto5qA5hjHuNQ32GNnNxA",
].map((a) => address(a));

/** `buyback_fee_recipient` list, shared by curve and AMM (8). */
export const BUYBACK_FEE_RECIPIENTS: readonly Address[] = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
].map((a) => address(a));

/**
 * PumpSwap `protocol_fee_recipients` - differs from the curve list (has JCRGumoE…, lacks CebN5…).
 * Only the two differences are documented in the notes; the full list is ALWAYS read from the live
 * GlobalConfig account. This fallback is the curve list with that one swap applied and is verified
 * against GlobalConfig in tests. https://solscan.io/account/ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw
 */
export const PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK: readonly Address[] = PUMP_FEE_RECIPIENTS.map((a) =>
  a === "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM" ? address("JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU") : a,
);

// ---------------------------------------------------------------------------------------------
// Curve / AMM numeric constants (documentation + defaults only; live accounts are authoritative)
// ---------------------------------------------------------------------------------------------

/** Fee denominator (bps). pump-sdk src/fees.ts */
export const BPS_DENOMINATOR = 10_000n;
/** Fixed 1B-token (6 dp) supply used as the curve fee-tier market-cap basis for non-mayhem coins. pump-sdk src/fees.ts ONE_BILLION_SUPPLY */
export const ONE_BILLION_SUPPLY = 1_000_000_000_000_000n;
/** pump-amm TOTAL_TOKEN_SUPPLY: market-cap basis for MAYHEM pools. pump-swap-sdk src/sdk/util.ts */
export const PUMP_AMM_TOTAL_TOKEN_SUPPLY = 1_000_000_000_000_000n;
/** Default initial real token reserves for standard coins (793.1M tokens). Live Global is authoritative. notes §2 */
export const DEFAULT_INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
/** Pump coin decimals (create / create_v2). docs/instructions/COIN_CREATION.md */
export const PUMP_TOKEN_DECIMALS = 6;
/** Sizes. pump-sdk 2.0.0 src/sdk.ts ; pump-swap-sdk POOL_ACCOUNT_NEW_SIZE */
export const BONDING_CURVE_NEW_SIZE = 151;
export const POOL_ACCOUNT_NEW_SIZE = 300;
export const GLOBAL_SIZE = 1087;

// ---------------------------------------------------------------------------------------------
// Raydium LaunchLab (bonding curves behind BONK.fun / letsbonk, StonkFun, TRiX, Raydium's own
// launchpad) and Raydium CPMM (where LaunchLab coins graduate). Sources, pinned in idl/RAYDIUM_SOURCE.json:
//   IDLs:        https://github.com/raydium-io/raydium-idl/tree/e7e0c96fe77bcf6a020b84a44c47a722aac8e359
//   CPMM source: https://github.com/raydium-io/raydium-cp-swap/tree/b3187ae53a1b95a201f855a59024a12ca8f5b51a
//   LaunchLab account structs: https://github.com/raydium-io/raydium-cpi/tree/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/launch-cpi
//   TS SDK:      https://github.com/raydium-io/raydium-sdk-V2/tree/cc33ec28a8921a35609e83293e9e07ad830b0779 (npm 0.2.73-alpha)
// "Observed" values were read from live mainnet accounts / transactions on 2026-10-03 (slot ~453.0M).
// ---------------------------------------------------------------------------------------------

/** LaunchLab program. raydium_launchpad.json `address`; SDK LAUNCHPAD_PROGRAM; launch-cpi declare_id!. */
export const RAYDIUM_LAUNCHLAB_PROGRAM_ID: Address = address("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");
/** CPMM (cp-swap) program. raydium_cp_swap.json `address`; programs/cp-swap/src/lib.rs declare_id!. */
export const RAYDIUM_CPMM_PROGRAM_ID: Address = address("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/** LaunchLab vault authority = PDA ["vault_auth_seed"]. SDK LAUNCHPAD_AUTH (src/common/programId.ts). */
export const RAYDIUM_LAUNCHLAB_AUTHORITY: Address = address("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh");
/** LaunchLab event authority = PDA ["__event_authority"] (Anchor event-CPI). Observed in every swap. */
export const RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY: Address = address("2DPAtwB8L12vrMRExbLuyGnC7n2J5LNoZQSejeQGpwkr");
/** CPMM vault + LP-mint authority = PDA ["vault_and_lp_mint_auth_seed"]. SDK CREATE_CPMM_POOL_AUTH. */
export const RAYDIUM_CPMM_AUTHORITY: Address = address("GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL");
/**
 * LaunchLab GlobalConfig for SOL-quoted constant-product curves, index 0 = PDA
 * ["global_config", wSOL, u8 0, u16 0]. SDK LAUNCHPAD_CONFIG. Fee rates are read live from it.
 */
export const RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG: Address = address("6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX");
/**
 * Wallet that signs `migrate_to_cpswap` (GlobalConfig.migrate_to_cpswap_wallet of the SOL config; observed
 * as signer of migration tx 5sFw84yv…). Graduation is NOT permissionless. Informational: read it live.
 */
export const RAYDIUM_LAUNCHLAB_MIGRATE_TO_CPMM_WALLET: Address = address("RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw");

/**
 * Known LaunchLab PlatformConfig accounts -> launchpad label (feed / UI only; fee rates and the
 * graduation AmmConfig are always read from the live account). Observed 2026-10-03 by decoding each
 * account's `name` field; StonkFun runs several configs. https://solscan.io/account/<address>
 */
export const RAYDIUM_LAUNCHLAB_PLATFORMS: Readonly<Record<string, string>> = {
  FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1: "letsbonk.fun",
  BuM6KDpWiTcxvrpXywWFiw45R2RNH8WURdvqoTDV1BW4: "letsbonk.fun",
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt": "StonkFun",
  CUqSiwPs6C4WyntMgaFazLp7wYQfaLp5URbjUP9V7SNi: "StonkFun",
  "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7": "StonkFun",
  FbqEaSHPF3kekscjqzEU5xdDAnWp5vf9w2d2oT5Bxng9: "TRiX",
  "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4": "Raydium", // SDK LAUNCHPAD_PLATFORM
};

/**
 * CPMM AmmConfigs that LaunchLab coins graduate onto: PlatformConfig.cpswap_config of letsbonk.fun
 * (FfYek5vE…, index 15), StonkFun (6BwHHDg3…) and TRiX (both CRRS5ieQ…, index 11), and Raydium's own platform
 * (D4FPEruK…). Observed 2026-10-03 (test/fixtures/raydium-mainnet.json). Shared by every graduated coin of a
 * platform, so armed orders may load them from the operator lookup table (armedStaticAccounts); always read
 * the live PlatformConfig to know which config a coin graduates onto.
 */
export const RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS: readonly Address[] = [
  address("GtdipqAcw8eAYxGcANs3vpN7UaN7UH7u89Kd8wPqLThd"),
  address("CRRS5ieQmBrZjWhcj99JuGrT5tyuWDaGAXLXLFjbAtjQ"),
  address("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2"),
];

/** PDA seeds. LaunchLab: SDK src/raydium/launchpad/pda.ts, launch-cpi states.rs; CPMM: cp-swap states/*.rs, SDK cpmm/pda.ts. */
export const RAYDIUM_SEEDS = {
  launchLabAuth: "vault_auth_seed",
  /** ["pool", base_mint, quote_mint] */
  launchLabPool: "pool",
  /** ["pool_vault", pool, mint] */
  launchLabVault: "pool_vault",
  /** ["global_config", quote_mint, u8 curve_type, u16 index LE] */
  launchLabGlobalConfig: "global_config",
  /** ["platform_config", platform_admin] */
  launchLabPlatformConfig: "platform_config",
  launchLabPlatformFeeVaultAuth: "platform_fee_vault_auth_seed",
  launchLabCreatorFeeVaultAuth: "creator_fee_vault_auth_seed",
  // Platform fee vault = PDA [platform_config, quote_mint]; creator fee vault = PDA [creator, quote_mint] (no string seed).
  cpmmAuth: "vault_and_lp_mint_auth_seed",
  /** ["amm_config", u16 index BIG-endian] (create_config.rs `index.to_be_bytes()`) */
  cpmmAmmConfig: "amm_config",
  /** ["pool", amm_config, token_0_mint, token_1_mint], token_0 < token_1 bytewise */
  cpmmPool: "pool",
  /** ["pool_vault", pool, mint] */
  cpmmVault: "pool_vault",
  cpmmLpMint: "pool_lp_mint",
  /** ["observation", pool] */
  cpmmObservation: "observation",
} as const;

/** LaunchLab instruction discriminators. raydium_launchpad.json; SDK src/raydium/launchpad/instrument.ts anchorDataBuf. */
export const RAYDIUM_LAUNCHLAB_IX = {
  /** buy_exact_in(amount_in: u64, minimum_amount_out: u64, share_fee_rate: u64) - spend quote */
  buyExactIn: new Uint8Array([250, 234, 13, 123, 213, 156, 19, 236]),
  /** buy_exact_out(amount_out: u64, maximum_amount_in: u64, share_fee_rate: u64) */
  buyExactOut: new Uint8Array([24, 211, 116, 40, 105, 3, 153, 56]),
  /** sell_exact_in(amount_in: u64, minimum_amount_out: u64, share_fee_rate: u64) - sell base */
  sellExactIn: new Uint8Array([149, 39, 222, 155, 211, 124, 152, 26]),
  /** sell_exact_out(amount_out: u64, maximum_amount_in: u64, share_fee_rate: u64) */
  sellExactOut: new Uint8Array([95, 200, 71, 34, 8, 9, 11, 166]),
  /** Feed detection only: graduation (signed by the migration wallet) and launches. */
  migrateToCpswap: new Uint8Array([136, 92, 200, 103, 28, 218, 144, 140]),
  migrateToAmm: new Uint8Array([207, 82, 192, 145, 254, 207, 145, 223]),
  initialize: new Uint8Array([175, 175, 109, 31, 13, 152, 155, 237]),
  initializeV2: new Uint8Array([67, 153, 175, 39, 218, 16, 38, 32]),
  initializeWithToken2022: new Uint8Array([37, 190, 126, 222, 44, 154, 171, 17]),
} as const;

/** CPMM instruction discriminators. raydium_cp_swap.json; SDK src/raydium/cpmm/instruction.ts anchorDataBuf. */
export const RAYDIUM_CPMM_IX = {
  /** swap_base_input(amount_in: u64, minimum_amount_out: u64) */
  swapBaseInput: new Uint8Array([143, 190, 90, 218, 196, 30, 51, 222]),
  /** swap_base_output(max_amount_in: u64, amount_out: u64) */
  swapBaseOutput: new Uint8Array([55, 217, 98, 86, 163, 74, 180, 173]),
} as const;

/**
 * Account discriminators. NOTE the collisions (Anchor hashes the type name only): LaunchLab and CPMM
 * `PoolState` share bytes, and LaunchLab `GlobalConfig` equals PumpSwap's. Always check the owner program.
 */
export const RAYDIUM_ACCOUNT_DISCRIMINATORS = {
  launchLabPoolState: new Uint8Array([247, 237, 227, 245, 215, 195, 222, 70]),
  launchLabGlobalConfig: new Uint8Array([149, 8, 156, 202, 160, 252, 176, 217]),
  launchLabPlatformConfig: new Uint8Array([160, 78, 128, 0, 248, 83, 230, 160]),
  cpmmPoolState: new Uint8Array([247, 237, 227, 245, 215, 195, 222, 70]),
  cpmmAmmConfig: new Uint8Array([218, 244, 33, 104, 203, 203, 43, 111]),
  cpmmObservationState: new Uint8Array([122, 174, 197, 53, 129, 9, 165, 132]),
} as const;

/**
 * Event discriminators. LaunchLab `TradeEvent` has the SAME bytes as pump's TradeEvent, so decoders
 * must dispatch on the emitting program. LaunchLab emits via event-CPI AND `Program data:` logs;
 * CPMM via `Program data:` logs only (emit!). raydium_launchpad.json / raydium_cp_swap.json `events`.
 */
export const RAYDIUM_EVENT_DISCRIMINATORS = {
  launchLabTrade: new Uint8Array([189, 219, 127, 211, 78, 230, 97, 238]),
  launchLabPoolCreate: new Uint8Array([151, 215, 226, 9, 118, 161, 115, 174]),
  cpmmSwap: new Uint8Array([64, 198, 205, 232, 38, 8, 113, 226]),
  cpmmLpChange: new Uint8Array([121, 163, 205, 201, 57, 218, 117, 60]),
} as const;

/** All Raydium fee rates are parts per million ("hundredths of a bip"). cp-swap curve/fees.rs; SDK FEE_RATE_DENOMINATOR_VALUE. */
export const RAYDIUM_FEE_RATE_DENOMINATOR = 1_000_000n;

/** LaunchLab PoolState.status (states.rs PoolStatus). Trading is only possible in `fund`. */
export const LAUNCHLAB_POOL_STATUS = { fund: 0, migrate: 1, trade: 2 } as const;
/** LaunchLab GlobalConfig.curve_type. Only constant-product configs exist on mainnet (585/585 on 2026-10-03). */
export const LAUNCHLAB_CURVE_TYPE = { constantProduct: 0, fixedPrice: 1, linearPrice: 2 } as const;
/** CPMM PoolState.status bits: set = disabled (states/pool.rs PoolStatusBitIndex). */
export const CPMM_POOL_STATUS_BIT = { deposit: 1, withdraw: 2, swap: 4 } as const;
/** CPMM PoolState.creator_fee_on (states/pool.rs CreatorFeeOn). */
export const CPMM_CREATOR_FEE_ON = { bothToken: 0, onlyToken0: 1, onlyToken1: 2 } as const;

/** Error codes worth mapping in the UI. raydium_launchpad.json `errors`; cp-swap src/error.rs (6000 + index). */
export const RAYDIUM_LAUNCHLAB_ERRORS: Record<number, string> = {
  6000: "NotApproved",
  6002: "InvalidInput",
  6004: "ExceededSlippage",
  6005: "PoolFunding",
  6006: "PoolMigrated (curve complete - trade on CPMM)",
  6008: "MathOverflow",
  6017: "NoSupportExtension",
  6018: "NotEnoughRemainingAccounts (system program + platform/creator fee vaults required)",
  6019: "TransferFeeCalculateNotMatch",
};
export const RAYDIUM_CPMM_ERRORS: Record<number, string> = {
  6000: "NotApproved (swaps disabled or before open_time)",
  6005: "ExceededSlippage",
  6006: "ZeroTradingTokens",
  6007: "NotSupportMint",
  6008: "InvalidVault",
  6010: "TransferFeeCalculateNotMatch",
  6011: "MathOverflow",
  6012: "InsufficientVault",
};

// ---------------------------------------------------------------------------------------------
// Transaction landing: Helius Sender. https://www.helius.dev/docs/sending-transactions/sender
// ---------------------------------------------------------------------------------------------

/** Regional plain-HTTP endpoints (servers) + the global HTTPS endpoint (browsers / CORS). sender.md */
export const HELIUS_SENDER_ENDPOINTS = {
  global: "https://sender.helius-rpc.com",
  slc: "http://slc-sender.helius-rpc.com",
  ewr: "http://ewr-sender.helius-rpc.com",
  lon: "http://lon-sender.helius-rpc.com",
  fra: "http://fra-sender.helius-rpc.com",
  ams: "http://ams-sender.helius-rpc.com",
  sg: "http://sg-sender.helius-rpc.com",
  tyo: "http://tyo-sender.helius-rpc.com",
} as const;
export type HeliusSenderRegion = keyof typeof HELIUS_SENDER_ENDPOINTS;
export const HELIUS_SENDER_SEND_PATH = "/fast";
export const HELIUS_SENDER_PING_PATH = "/ping";
/** Warm the connection if idle longer than this (docs example pings every 5 s). sender.md */
export const HELIUS_SENDER_PING_INTERVAL_MS = 5_000;

/** Helius Sender tip accounts (no RPC lookup exists; diff against docs in CI). https://www.helius.dev/docs/sending-transactions/sender */
export const HELIUS_SENDER_TIP_ACCOUNTS: readonly Address[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
].map((a) => address(a));

/** SWQoS-only minimum tip: 0.000005 SOL. https://www.helius.dev/docs/sending-transactions/sender-swqos-only.md */
export const HELIUS_SENDER_SWQOS_MIN_TIP_LAMPORTS = 5_000n;
/** Sender Max minimum tip: 0.001 SOL (enters the priority tip buffer). https://www.helius.dev/docs/sending-transactions/sender-max.md */
export const HELIUS_SENDER_MAX_MIN_TIP_LAMPORTS = 1_000_000n;

// ---------------------------------------------------------------------------------------------
// Transaction landing: Jito block engine. https://docs.jito.wtf/lowlatencytxnsend/
// ---------------------------------------------------------------------------------------------

export const JITO_BLOCK_ENGINES = {
  global: "https://mainnet.block-engine.jito.wtf",
  amsterdam: "https://amsterdam.mainnet.block-engine.jito.wtf",
  dublin: "https://dublin.mainnet.block-engine.jito.wtf",
  frankfurt: "https://frankfurt.mainnet.block-engine.jito.wtf",
  london: "https://london.mainnet.block-engine.jito.wtf",
  ny: "https://ny.mainnet.block-engine.jito.wtf",
  slc: "https://slc.mainnet.block-engine.jito.wtf",
  singapore: "https://singapore.mainnet.block-engine.jito.wtf",
  tokyo: "https://tokyo.mainnet.block-engine.jito.wtf",
} as const;
export type JitoRegion = keyof typeof JITO_BLOCK_ENGINES;
export const JITO_TRANSACTIONS_PATH = "/api/v1/transactions";
export const JITO_BUNDLES_PATH = "/api/v1/bundles";
/** REST tip floor (values in SOL). https://bundles.jito.wtf/api/v1/bundles/tip_floor */
export const JITO_TIP_FLOOR_URL = "https://bundles.jito.wtf/api/v1/bundles/tip_floor";
export const JITO_TIP_STREAM_URL = "wss://bundles.jito.wtf/api/v1/bundles/tip_stream";
/** Minimum Jito tip (bundles). https://docs.jito.wtf/lowlatencytxnsend/ */
export const JITO_MIN_TIP_LAMPORTS = 1_000n;
/** Max transactions per Jito bundle. */
export const JITO_MAX_BUNDLE_TXS = 5;

/** Jito tip accounts FALLBACK; the live list comes from `getTipAccounts`. https://docs.jito.wtf/lowlatencytxnsend/ */
export const JITO_TIP_ACCOUNTS_FALLBACK: readonly Address[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((a) => address(a));

/**
 * Jito anti-sandwich marker: any valid pubkey starting with `jitodontfront`, added read-only to an
 * instruction's account list. Only effective when the tx goes through Jito. https://docs.jito.wtf/lowlatencytxnsend/
 */
export const JITO_DONT_FRONT: Address = address("jitodontfront111111111111111111111111111111");

// ---------------------------------------------------------------------------------------------
// Compute / fee policy defaults. https://solana.com/docs/core/fees , tx_landing_and_mev.md §6
// ---------------------------------------------------------------------------------------------

/** Per-transaction max compute units. */
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;
/** Base fee per signature (lamports). */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
/** Legacy/v0 packet limit. https://solana.com/upgrades/larger-transaction-sizes */
export const PACKET_DATA_SIZE = 1232;
/** Blockhash is valid for 150 blocks after `lastValidBlockHeight` is computed. https://solana.com/developers/guides/advanced/confirmation */
export const BLOCKHASH_VALID_BLOCKS = 150;

/**
 * Static CU limits per route, ~1.3x the worst case landed on 8 mainnet forks on 2026-10-03
 * (docs/dev/FORK_TESTING.md): curve buy 118k incl. Token-2022 ATA + volume accumulator init,
 * curve sell 86k, PumpSwap buy 132k incl. wSOL wrap, PumpSwap sell 99.5k. Earlier mainnet
 * simulations measured lower (curve buy 107k, PumpSwap buy 106k), so the forks set the bar.
 * Raydium has no fork runs yet. Its limits are ~1.4-1.6x the worst case measured by mainnet
 * simulation on 2026-10-03 (NOTES.md), enough to absorb a fork-vs-simulation gap like PumpSwap's
 * (+25%): LaunchLab buy 83,401 creating a Token-2022 (transfer-fee) ATA / 66,970 with the ATA;
 * LaunchLab full-exit sell 66,606 (Token-2022 close); CPMM buy 61,906 creating a Token-2022 ATA;
 * CPMM sell 43,636. LaunchLab gets extra headroom because the program creates a missing
 * platform/creator fee vault inside the swap.
 * The FAQ recommends static limits rather than simulate-on-send; priority fee is charged on the limit.
 * https://github.com/pump-fun/pump-public-docs/blob/main/docs/FAQ.md
 */
export const DEFAULT_CU_LIMITS = {
  pumpBuy: 155_000,
  pumpSell: 115_000,
  ammBuy: 175_000,
  ammSell: 135_000,
  launchLabBuy: 120_000,
  launchLabSell: 100_000,
  cpmmBuy: 85_000,
  cpmmSell: 70_000,
} as const;

/** Default public RPC (dev only - rate limited). */
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
