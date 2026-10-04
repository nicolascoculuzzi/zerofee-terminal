/**
 * pump.fun bonding-curve program: raw account decoders (no Anchor) and PDA derivation.
 * Layouts and seeds: https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
 */
import { type Address, getProgramDerivedAddress } from "@solana/kit";
import {
  ACCOUNT_DISCRIMINATORS,
  CANONICAL_POOL_INDEX,
  DEFAULT_PUBKEY,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SEEDS,
  WSOL_MINT,
} from "../constants";
import { addressBytes, Reader, startsWith, u16le, utf8 } from "../util/bytes";

// ---------------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------------

export interface PumpGlobal {
  initialized: boolean;
  authority: Address;
  feeRecipient: Address;
  initialVirtualTokenReserves: bigint;
  /** Seeds SOL curves. */
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  /** Fallback only (FeeConfig is mandatory on-chain). */
  feeBasisPoints: bigint;
  withdrawAuthority: Address;
  enableMigrate: boolean;
  poolMigrationFee: bigint;
  creatorFeeBasisPoints: bigint;
  feeRecipients: Address[];
  createV2Enabled: boolean;
  reservedFeeRecipient: Address;
  mayhemModeEnabled: boolean;
  reservedFeeRecipients: Address[];
  isCashbackEnabled: boolean;
  buybackFeeRecipients: Address[];
  buybackBasisPoints: bigint;
  /** Seeds non-SOL (e.g. USDC) curves. */
  initialVirtualQuoteReserves: bigint;
  whitelistedQuoteMints: Address[];
  creatorFeeConfigurable: boolean;
  maxConfigurableCreatorFeeBps: bigint;
  isHolderRewardEnabled: boolean;
}

function readPubkeys(r: Reader, n: number): Address[] {
  const out: Address[] = [];
  for (let i = 0; i < n; i++) out.push(r.pubkey());
  return out;
}

/** Decodes the pump `Global` account (1087 bytes on 2026-10-03; shorter accounts zero-pad). */
export function decodePumpGlobal(data: Uint8Array): PumpGlobal {
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS.global)) throw new Error("not a pump Global account");
  const r = new Reader(data, 8);
  const initialized = r.bool();
  const authority = r.pubkey();
  const feeRecipient = r.pubkey();
  const initialVirtualTokenReserves = r.u64();
  const initialVirtualSolReserves = r.u64();
  const initialRealTokenReserves = r.u64();
  const tokenTotalSupply = r.u64();
  const feeBasisPoints = r.u64();
  const withdrawAuthority = r.pubkey();
  const enableMigrate = r.bool();
  const poolMigrationFee = r.u64();
  const creatorFeeBasisPoints = r.u64();
  const feeRecipients = readPubkeys(r, 7);
  r.pubkey(); // set_creator_authority
  r.pubkey(); // admin_set_creator_authority
  const createV2Enabled = r.bool();
  r.pubkey(); // whitelist_pda
  const reservedFeeRecipient = r.pubkey();
  const mayhemModeEnabled = r.bool();
  const reservedFeeRecipients = readPubkeys(r, 7);
  const isCashbackEnabled = r.bool();
  const buybackFeeRecipients = readPubkeys(r, 8);
  const buybackBasisPoints = r.u64();
  const initialVirtualQuoteReserves = r.u64();
  const whitelistedQuoteMints = readPubkeys(r, 1).filter((m) => m !== DEFAULT_PUBKEY);
  const creatorFeeConfigurable = r.bool();
  const maxConfigurableCreatorFeeBps = r.u64();
  r.pubkey(); // holder_reward_claim_authority
  const isHolderRewardEnabled = r.bool();
  return {
    initialized,
    authority,
    feeRecipient,
    initialVirtualTokenReserves,
    initialVirtualSolReserves,
    initialRealTokenReserves,
    tokenTotalSupply,
    feeBasisPoints,
    withdrawAuthority,
    enableMigrate,
    poolMigrationFee,
    creatorFeeBasisPoints,
    feeRecipients,
    createV2Enabled,
    reservedFeeRecipient,
    mayhemModeEnabled,
    reservedFeeRecipients,
    isCashbackEnabled,
    buybackFeeRecipients,
    buybackBasisPoints,
    initialVirtualQuoteReserves,
    whitelistedQuoteMints,
    creatorFeeConfigurable,
    maxConfigurableCreatorFeeBps,
    isHolderRewardEnabled,
  };
}

/** All non-default curve fee recipients (main + list) for normal coins. */
export function globalFeeRecipients(g: PumpGlobal): Address[] {
  return [g.feeRecipient, ...g.feeRecipients].filter((a) => a !== DEFAULT_PUBKEY);
}

/** All non-default reserved fee recipients for mayhem coins. */
export function globalMayhemFeeRecipients(g: PumpGlobal): Address[] {
  return [g.reservedFeeRecipient, ...g.reservedFeeRecipients].filter((a) => a !== DEFAULT_PUBKEY);
}

export interface BondingCurve {
  virtualTokenReserves: bigint;
  /** Renamed from virtual_sol_reserves in May 2026. */
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  /** LIVE creator - derive creator_vault from this, never from CreateEvent (fee sharing / holder rewards rewrite it). */
  creator: Address;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /** `Pubkey::default()` for SOL curves. */
  quoteMint: Address;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  /** Raw account length (legacy curves are shorter). */
  dataLength: number;
}

/** Decodes a `BondingCurve` account; missing trailing fields read as 0/false/default. */
export function decodeBondingCurve(data: Uint8Array): BondingCurve {
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS.bondingCurve)) throw new Error("not a BondingCurve account");
  const r = new Reader(data, 8);
  return {
    virtualTokenReserves: r.u64(),
    virtualQuoteReserves: r.u64(),
    realTokenReserves: r.u64(),
    realQuoteReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    complete: r.bool(),
    creator: r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackCoin: r.bool(),
    quoteMint: r.pubkey(),
    creatorFeeBps: r.u64(),
    canEditCreatorFee: r.bool(),
    isHolderReward: r.bool(),
    dataLength: data.length,
  };
}

/** Quote mint to pass in v2 instructions: wSOL for SOL curves (stored as default pubkey). */
export function curveQuoteMint(curve: Pick<BondingCurve, "quoteMint">): Address {
  return curve.quoteMint === DEFAULT_PUBKEY || curve.quoteMint === WSOL_MINT ? WSOL_MINT : curve.quoteMint;
}

export function isSolCurve(curve: Pick<BondingCurve, "quoteMint">): boolean {
  return curveQuoteMint(curve) === WSOL_MINT;
}

// ---------------------------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------------------------

async function pda(program: Address, seeds: Uint8Array[]): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return a;
}

export const pumpGlobalPda = () => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.global)]);
export const pumpEventAuthorityPda = () => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.eventAuthority)]);
export const pumpGlobalVolumeAccumulatorPda = () => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.globalVolumeAccumulator)]);
export const pumpFeeConfigPda = () => pda(PUMP_FEE_PROGRAM_ID, [utf8(SEEDS.feeConfig), addressBytes(PUMP_PROGRAM_ID)]);

export const bondingCurvePda = (mint: Address) => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.bondingCurve), addressBytes(mint)]);
/** Passed address-only on legacy buy/sell; may not exist on-chain (notes §1). */
export const bondingCurveV2Pda = (mint: Address) => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.bondingCurveV2), addressBytes(mint)]);
/** pump creator vault: ["creator-vault", bonding_curve.creator]. */
export const creatorVaultPda = (creator: Address) => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.creatorVault), addressBytes(creator)]);
export const pumpUserVolumeAccumulatorPda = (user: Address) =>
  pda(PUMP_PROGRAM_ID, [utf8(SEEDS.userVolumeAccumulator), addressBytes(user)]);
export const holderRewardsPda = (mint: Address) => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.holderRewards), addressBytes(mint)]);
export const poolAuthorityPda = (mint: Address) => pda(PUMP_PROGRAM_ID, [utf8(SEEDS.poolAuthority), addressBytes(mint)]);
/** Fees program: ["sharing-config", mint]. */
export const sharingConfigPda = (mint: Address) => pda(PUMP_FEE_PROGRAM_ID, [utf8(SEEDS.sharingConfig), addressBytes(mint)]);

/** Canonical PumpSwap pool created by `migrate`: ["pool", u16 0, pool_authority(mint), mint, quote]. */
export async function canonicalPoolPda(mint: Address, quoteMint: Address = WSOL_MINT): Promise<Address> {
  const authority = await poolAuthorityPda(mint);
  return pda(PUMP_AMM_PROGRAM_ID, [
    utf8(SEEDS.pool),
    u16le(CANONICAL_POOL_INDEX),
    addressBytes(authority),
    addressBytes(mint),
    addressBytes(quoteMint),
  ]);
}
