/**
 * PumpSwap (pump AMM) account decoders and PDAs.
 * https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
 * https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md
 */
import { type Address, getProgramDerivedAddress } from "@solana/kit";
import { ACCOUNT_DISCRIMINATORS, DEFAULT_PUBKEY, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, SEEDS } from "../constants";
import { poolAuthorityPda } from "../pump/accounts";
import { addressBytes, Reader, startsWith, u16le, utf8 } from "../util/bytes";

export interface Pool {
  poolBump: number;
  index: number;
  /** Pool creator; canonical pump pools have creator == pool_authority PDA(base_mint). */
  creator: Address;
  baseMint: Address;
  quoteMint: Address;
  lpMint: Address;
  poolBaseTokenAccount: Address;
  poolQuoteTokenAccount: Address;
  lpSupply: bigint;
  /** LIVE coin creator - derive coin_creator_vault_authority from this. */
  coinCreator: Address;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  /**
   * SIGNED i128 (offset 245). Non-zero on "boost" pools (≈17.58 SOL observed 2026-10-03) and may be
   * negative since 2026-09-30. Pricing MUST use vault + virtual (NEGATIVE_VIRTUAL_QUOTE_RESERVES.md).
   */
  virtualQuoteReserves: bigint;
  creatorFeeBps: bigint;
  canEditCreatorFee: boolean;
  isHolderReward: boolean;
  dataLength: number;
}

export function decodePool(data: Uint8Array): Pool {
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS.pool)) throw new Error("not a PumpSwap Pool account");
  const r = new Reader(data, 8);
  const poolBump = r.u8();
  const index = r.u16();
  const creator = r.pubkey();
  const baseMint = r.pubkey();
  const quoteMint = r.pubkey();
  const lpMint = r.pubkey();
  const poolBaseTokenAccount = r.pubkey();
  const poolQuoteTokenAccount = r.pubkey();
  const lpSupply = r.u64();
  const coinCreator = r.pubkey();
  const isMayhemMode = r.bool();
  const isCashbackCoin = r.bool();
  // r.offset === 245 here (verified against the notes' raw-byte decode).
  const virtualQuoteReserves = r.i128();
  return {
    poolBump,
    index,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
    coinCreator,
    isMayhemMode,
    isCashbackCoin,
    virtualQuoteReserves,
    creatorFeeBps: r.u64(),
    canEditCreatorFee: r.bool(),
    isHolderReward: r.bool(),
    dataLength: data.length,
  };
}

export interface AmmGlobalConfig {
  admin: Address;
  /** Fallback rates only (the fees program is mandatory on-chain). */
  lpFeeBasisPoints: bigint;
  protocolFeeBasisPoints: bigint;
  disableFlags: number;
  protocolFeeRecipients: Address[];
  coinCreatorFeeBasisPoints: bigint;
  reservedFeeRecipient: Address;
  mayhemModeEnabled: boolean;
  reservedFeeRecipients: Address[];
  isCashbackEnabled: boolean;
  buybackFeeRecipients: Address[];
  buybackBasisPoints: bigint;
  boostAuthority: Address;
  boostEnabled: boolean;
  creatorFeeConfigurable: boolean;
  maxConfigurableCreatorFeeBps: bigint;
}

function readPubkeys(r: Reader, n: number): Address[] {
  const out: Address[] = [];
  for (let i = 0; i < n; i++) out.push(r.pubkey());
  return out;
}

export function decodeAmmGlobalConfig(data: Uint8Array): AmmGlobalConfig {
  if (!startsWith(data, ACCOUNT_DISCRIMINATORS.ammGlobalConfig)) throw new Error("not a PumpSwap GlobalConfig account");
  const r = new Reader(data, 8);
  const admin = r.pubkey();
  const lpFeeBasisPoints = r.u64();
  const protocolFeeBasisPoints = r.u64();
  const disableFlags = r.u8();
  const protocolFeeRecipients = readPubkeys(r, 8);
  const coinCreatorFeeBasisPoints = r.u64();
  r.pubkey(); // admin_set_coin_creator_authority
  r.pubkey(); // whitelist_pda
  const reservedFeeRecipient = r.pubkey();
  const mayhemModeEnabled = r.bool();
  const reservedFeeRecipients = readPubkeys(r, 7);
  const isCashbackEnabled = r.bool();
  const buybackFeeRecipients = readPubkeys(r, 8);
  const buybackBasisPoints = r.u64();
  const boostAuthority = r.pubkey();
  const boostEnabled = r.bool();
  const creatorFeeConfigurable = r.bool();
  const maxConfigurableCreatorFeeBps = r.u64();
  const nonDefault = (l: Address[]) => l.filter((a) => a !== DEFAULT_PUBKEY);
  return {
    admin,
    lpFeeBasisPoints,
    protocolFeeBasisPoints,
    disableFlags,
    protocolFeeRecipients: nonDefault(protocolFeeRecipients),
    coinCreatorFeeBasisPoints,
    reservedFeeRecipient,
    mayhemModeEnabled,
    reservedFeeRecipients: nonDefault(reservedFeeRecipients),
    isCashbackEnabled,
    buybackFeeRecipients: nonDefault(buybackFeeRecipients),
    buybackBasisPoints,
    boostAuthority,
    boostEnabled,
    creatorFeeConfigurable,
    maxConfigurableCreatorFeeBps,
  };
}

async function pda(seeds: Uint8Array[], program: Address = PUMP_AMM_PROGRAM_ID): Promise<Address> {
  const [a] = await getProgramDerivedAddress({ programAddress: program, seeds });
  return a;
}

export const ammGlobalConfigPda = () => pda([utf8(SEEDS.ammGlobalConfig)]);
export const ammEventAuthorityPda = () => pda([utf8(SEEDS.eventAuthority)]);
export const ammGlobalVolumeAccumulatorPda = () => pda([utf8(SEEDS.globalVolumeAccumulator)]);
export const ammFeeConfigPda = () => pda([utf8(SEEDS.feeConfig), addressBytes(PUMP_AMM_PROGRAM_ID)], PUMP_FEE_PROGRAM_ID);
/** AMM UVA - a DIFFERENT PDA from pump's (same seed, different program). */
export const ammUserVolumeAccumulatorPda = (user: Address) => pda([utf8(SEEDS.userVolumeAccumulator), addressBytes(user)]);
/** ["creator_vault", pool.coin_creator] (underscore, unlike pump's "creator-vault"). */
export const coinCreatorVaultAuthorityPda = (coinCreator: Address) => pda([utf8(SEEDS.ammCreatorVault), addressBytes(coinCreator)]);
export const poolV2Pda = (baseMint: Address) => pda([utf8(SEEDS.poolV2), addressBytes(baseMint)]);

export async function ammPoolPda(index: number, creator: Address, baseMint: Address, quoteMint: Address): Promise<Address> {
  return pda([utf8(SEEDS.pool), u16le(index), addressBytes(creator), addressBytes(baseMint), addressBytes(quoteMint)]);
}

/** Canonical pump pool: pool.creator == pool_authority PDA(base_mint) (NOT coin_creator). FEE_PROGRAM_README */
export async function isCanonicalPumpPool(pool: Pick<Pool, "baseMint" | "creator">): Promise<boolean> {
  return (await poolAuthorityPda(pool.baseMint)) === pool.creator;
}
