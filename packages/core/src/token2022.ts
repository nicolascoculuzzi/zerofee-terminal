/**
 * Token-2022 extension parsing and transfer-fee math, as far as swaps need it.
 *
 * StonkFun launches Token-2022 coins with a TransferFeeConfig (300 bps observed on 2026-10-03,
 * authority = the LaunchLab vault authority), so LaunchLab and CPMM quotes must deduct transfer fees
 * exactly like the programs do. Ported from the official sources:
 *   TLV layout:   https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/interface/src/extension/mod.rs
 *   fee math:     https://github.com/solana-program/token-2022/blob/bb4c841aa81282c961f617f39719faf60049f398/interface/src/extension/transfer_fee/mod.rs
 *   inverse fee:  raydium-cp-swap programs/cp-swap/src/utils/token.rs get_transfer_inverse_fee (b3187ae)
 * The epoch is the CURRENT epoch (Clock sysvar), as the token program uses at execution time.
 */
import type { Address } from "@solana/kit";
import { DEFAULT_PUBKEY, TOKEN_2022_EXTENSIONS, TOKEN_2022_MAX_FEE_BASIS_POINTS, TOKEN_2022_TLV_START } from "./constants";
import { Reader } from "./util/bytes";
import { ceilDiv, minBig } from "./util/math";

export interface TransferFee {
  /** First epoch where this fee applies. */
  epoch: bigint;
  maximumFee: bigint;
  transferFeeBasisPoints: bigint;
}

export interface TransferFeeConfig {
  transferFeeConfigAuthority: Address | null;
  withdrawWithheldAuthority: Address | null;
  withheldAmount: bigint;
  /** Used while `epoch < newerTransferFee.epoch`. */
  olderTransferFee: TransferFee;
  newerTransferFee: TransferFee;
}

export interface Token2022Extensions {
  /** Every extension type present, in TLV order. */
  types: number[];
  transferFeeConfig: TransferFeeConfig | null;
  /** Program a transfer hook would CPI into; null when there is no hook or it is unset. */
  transferHookProgramId: Address | null;
  paused: boolean;
  nonTransferable: boolean;
  permanentDelegate: Address | null;
}

const NONE: Token2022Extensions = {
  types: [],
  transferFeeConfig: null,
  transferHookProgramId: null,
  paused: false,
  nonTransferable: false,
  permanentDelegate: null,
};

/** Splits the TLV area of a Token-2022 mint or token account into (type -> value bytes). */
export function parseTlv(data: Uint8Array): Map<number, Uint8Array> {
  const out = new Map<number, Uint8Array>();
  if (data.length <= TOKEN_2022_TLV_START) return out;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = TOKEN_2022_TLV_START;
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    // Uninitialized (0) is padding; stop at the first zero type like the token program does.
    if (type === 0) break;
    if (o + 4 + len > data.length) throw new Error(`malformed Token-2022 TLV at ${o} (type ${type}, len ${len})`);
    out.set(type, data.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

const optionalPubkey = (r: Reader): Address | null => {
  const a = r.pubkey();
  return a === DEFAULT_PUBKEY ? null : a;
};

function readTransferFee(r: Reader): TransferFee {
  return { epoch: r.u64(), maximumFee: r.u64(), transferFeeBasisPoints: BigInt(r.u16()) };
}

/** Decodes the extensions swaps care about from a Token-2022 MINT account (empty for SPL Token mints). */
export function decodeToken2022MintExtensions(data: Uint8Array): Token2022Extensions {
  const tlv = parseTlv(data);
  if (tlv.size === 0) return NONE;
  let transferFeeConfig: TransferFeeConfig | null = null;
  const fee = tlv.get(TOKEN_2022_EXTENSIONS.transferFeeConfig);
  if (fee) {
    if (fee.length < 108) throw new Error(`TransferFeeConfig too short (${fee.length})`);
    const r = new Reader(fee);
    transferFeeConfig = {
      transferFeeConfigAuthority: optionalPubkey(r),
      withdrawWithheldAuthority: optionalPubkey(r),
      withheldAmount: r.u64(),
      olderTransferFee: readTransferFee(r),
      newerTransferFee: readTransferFee(r),
    };
  }
  let transferHookProgramId: Address | null = null;
  const hook = tlv.get(TOKEN_2022_EXTENSIONS.transferHook);
  if (hook) {
    const r = new Reader(hook);
    r.pubkey(); // authority
    transferHookProgramId = optionalPubkey(r);
  }
  const pausable = tlv.get(TOKEN_2022_EXTENSIONS.pausable);
  const delegate = tlv.get(TOKEN_2022_EXTENSIONS.permanentDelegate);
  return {
    types: [...tlv.keys()],
    transferFeeConfig,
    transferHookProgramId,
    paused: pausable ? pausable[32] === 1 : false,
    nonTransferable: tlv.has(TOKEN_2022_EXTENSIONS.nonTransferable),
    permanentDelegate: delegate ? optionalPubkey(new Reader(delegate)) : null,
  };
}

/** Withheld transfer fees on a Token-2022 TOKEN account; a non-zero value blocks CloseAccount. */
export function decodeToken2022AccountWithheld(data: Uint8Array): bigint {
  const v = parseTlv(data).get(TOKEN_2022_EXTENSIONS.transferFeeAmount);
  return v && v.length >= 8 ? new Reader(v).u64() : 0n;
}

/** TransferFeeConfig::get_epoch_fee. */
export function getEpochFee(cfg: TransferFeeConfig, epoch: bigint): TransferFee {
  return epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg.olderTransferFee;
}

/** TransferFee::calculate_fee: min(ceil(amount * bps / 10_000), maximum_fee); 0 for 0 bps or 0 amount. */
export function calculateTransferFee(fee: TransferFee, preFeeAmount: bigint): bigint {
  if (fee.transferFeeBasisPoints === 0n || preFeeAmount === 0n) return 0n;
  return minBig(ceilDiv(preFeeAmount * fee.transferFeeBasisPoints, TOKEN_2022_MAX_FEE_BASIS_POINTS), fee.maximumFee);
}

/** TransferFee::calculate_pre_fee_amount: the smallest gross amount that nets `postFeeAmount`. */
export function calculatePreFeeAmount(fee: TransferFee, postFeeAmount: bigint): bigint {
  const bps = fee.transferFeeBasisPoints;
  if (bps === 0n) return postFeeAmount;
  if (postFeeAmount === 0n) return 0n;
  if (bps === TOKEN_2022_MAX_FEE_BASIS_POINTS) return fee.maximumFee + postFeeAmount;
  const raw = ceilDiv(postFeeAmount * TOKEN_2022_MAX_FEE_BASIS_POINTS, TOKEN_2022_MAX_FEE_BASIS_POINTS - bps);
  return raw - postFeeAmount >= fee.maximumFee ? postFeeAmount + fee.maximumFee : raw;
}

/** TransferFee::calculate_inverse_fee = calculate_fee(calculate_pre_fee_amount(post)). */
export function calculateInverseTransferFee(fee: TransferFee, postFeeAmount: bigint): bigint {
  return calculateTransferFee(fee, calculatePreFeeAmount(fee, postFeeAmount));
}

/** Fee withheld when `preFeeAmount` is transferred in `epoch` (0 without a TransferFeeConfig). */
export function transferFeeFor(cfg: TransferFeeConfig | null | undefined, epoch: bigint, preFeeAmount: bigint): bigint {
  return cfg ? calculateTransferFee(getEpochFee(cfg, epoch), preFeeAmount) : 0n;
}

/**
 * Fee to add so the receiver nets `postFeeAmount` (raydium-cp-swap get_transfer_inverse_fee): the
 * maximum fee at 100%, else calculate_inverse_epoch_fee, checked for consistency like the program.
 */
export function transferInverseFeeFor(cfg: TransferFeeConfig | null | undefined, epoch: bigint, postFeeAmount: bigint): bigint {
  if (!cfg) return 0n;
  const fee = getEpochFee(cfg, epoch);
  if (fee.transferFeeBasisPoints === TOKEN_2022_MAX_FEE_BASIS_POINTS) return fee.maximumFee;
  const inverse = calculateInverseTransferFee(fee, postFeeAmount);
  if (calculateTransferFee(fee, postFeeAmount + inverse) !== inverse) throw new Error("TransferFeeCalculateNotMatch");
  return inverse;
}
