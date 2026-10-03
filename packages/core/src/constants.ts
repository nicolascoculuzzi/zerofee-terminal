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
} as const;

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
 * Static CU limits per route (~1.3x the worst case measured by mainnet simulation on 2026-10-03:
 * curve buy 107,327 incl. Token-2022 ATA + user_volume_accumulator init / 94,7xx with existing ATA;
 * curve sell 75,212; PumpSwap buy 105,816 incl. wSOL ATA create; PumpSwap full-exit sell 97,608).
 * The FAQ recommends static limits rather than simulate-on-send; priority fee is charged on the limit.
 * https://github.com/pump-fun/pump-public-docs/blob/main/docs/FAQ.md
 */
export const DEFAULT_CU_LIMITS = {
  pumpBuy: 140_000,
  pumpSell: 100_000,
  ammBuy: 150_000,
  ammSell: 130_000,
} as const;

/** Default public RPC (dev only - rate limited). */
export const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
