/**
 * pump-fees program semantics shared by the bonding curve and PumpSwap: FeeConfig decoding and
 * fee-schedule selection by quote mint and market cap.
 *
 * - FEE_PROGRAM_README: https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md
 * - pump-sdk 2.0.0 src/fees.ts / pump-swap-sdk 1.20.0 src/sdk/fees.ts (mirrors of the Rust code)
 */
import type { Address } from "@solana/kit";
import { ACCOUNT_DISCRIMINATORS, SOL_LIKE_QUOTE_MINTS, STABLE_QUOTE_MINTS } from "./constants";
import { Reader, startsWith } from "./util/bytes";

export interface Fees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  creatorFeeBps: bigint;
}

export interface FeeTier {
  /** Market cap threshold in quote base units (lamports for SOL, USDC base units for stable tiers). */
  marketCapThreshold: bigint;
  fees: Fees;
}

export interface FeeConfig {
  admin: Address;
  flatFees: Fees;
  feeTiers: FeeTier[];
  stableFeeTiers: FeeTier[];
  exoticFlatFees: Fees;
}

const ZERO_FEES: Fees = { lpFeeBps: 0n, protocolFeeBps: 0n, creatorFeeBps: 0n };

function readFees(r: Reader): Fees {
  return { lpFeeBps: r.u64(), protocolFeeBps: r.u64(), creatorFeeBps: r.u64() };
}

function readTiers(r: Reader): FeeTier[] {
  if (!r.has(4)) return [];
  const n = r.u32();
  if (n > 256) throw new Error(`implausible fee tier count ${n}`);
  const tiers: FeeTier[] = [];
  for (let i = 0; i < n; i++) tiers.push({ marketCapThreshold: r.u128(), fees: readFees(r) });
  return tiers;
}

/**
 * Decodes a pump-fees `FeeConfig` (used for both the curve config 8Wf5… and the AMM config 5PHirr…).
 * Layout (idl/pump_fees.json): bump u8, admin pubkey, flat_fees Fees, fee_tiers Vec<FeeTier>,
 * stable_fee_tiers Vec<FeeTier>, exotic_flat_fees Fees. Older accounts lack the trailing fields,
 * which then decode as empty/zero (the SDK does the same).
 */
export function decodeFeeConfig(data: Uint8Array): FeeConfig {
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS.feeConfig)) throw new Error("not a FeeConfig account");
  const r = new Reader(data, 8);
  r.u8(); // bump
  const admin = r.pubkey();
  const flatFees = readFees(r);
  const feeTiers = readTiers(r);
  const stableFeeTiers = readTiers(r);
  const exoticFlatFees = r.has(24) ? readFees(r) : ZERO_FEES;
  return { admin, flatFees, feeTiers, stableFeeTiers, exoticFlatFees };
}

export function isSolLikeQuoteMint(mint: Address): boolean {
  return SOL_LIKE_QUOTE_MINTS.includes(mint);
}

export function isStableQuoteMint(mint: Address): boolean {
  return STABLE_QUOTE_MINTS.includes(mint);
}

function isZeroFees(f: Fees): boolean {
  return f.lpFeeBps === 0n && f.protocolFeeBps === 0n && f.creatorFeeBps === 0n;
}

/**
 * pump-fees-math::calculate_fee_tier: first tier if below its threshold, else the highest tier whose
 * threshold <= marketCap.
 */
export function calculateFeeTier(tiers: readonly FeeTier[], marketCap: bigint): Fees {
  const first = tiers[0];
  if (!first) throw new Error("fee tiers cannot be empty");
  if (marketCap < first.marketCapThreshold) return first.fees;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i] as FeeTier;
    if (marketCap >= t.marketCapThreshold) return t.fees;
  }
  return first.fees;
}

/**
 * FeeConfig::fees_for_quote_mint. Non-canonical AMM pools pay `flat_fees`; canonical pools and all
 * bonding curves pay `fee_tiers` (SOL-like), `stable_fee_tiers` (USDC) or `exotic_flat_fees`
 * (falling back to `flat_fees` while unset).
 */
export function feesForQuoteMint(args: { feeConfig: FeeConfig; quoteMint: Address; marketCap: bigint; isPumpPool: boolean }): Fees {
  const { feeConfig, quoteMint, marketCap, isPumpPool } = args;
  if (!isPumpPool) return feeConfig.flatFees;
  if (isSolLikeQuoteMint(quoteMint)) return calculateFeeTier(feeConfig.feeTiers, marketCap);
  if (isStableQuoteMint(quoteMint)) {
    return calculateFeeTier(feeConfig.stableFeeTiers.length > 0 ? feeConfig.stableFeeTiers : feeConfig.feeTiers, marketCap);
  }
  return isZeroFees(feeConfig.exoticFlatFees) ? feeConfig.flatFees : feeConfig.exoticFlatFees;
}

/**
 * Applies a per-coin/per-pool `creator_fee_bps` override: replaces the schedule's creator rate only
 * when the global `creator_fee_configurable` gate is on and the value is non-zero (notes §2, §4).
 */
export function applyCreatorFeeOverride(fees: Fees, creatorFeeConfigurable: boolean, creatorFeeBps: bigint): Fees {
  if (!creatorFeeConfigurable || creatorFeeBps === 0n) return fees;
  return { ...fees, creatorFeeBps };
}
