/**
 * Token-2022 extension parsing and transfer-fee math vs the official @solana/spl-token client
 * (devDependency) on live mainnet mints, plus edge cases from the token-2022 interface tests.
 */
import { describe, expect, test } from "bun:test";
import {
  calculateEpochFee,
  ExtensionType,
  getExtensionTypes,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID as SPL_T22,
  unpackMint,
} from "@solana/spl-token";
import { type AccountInfo, PublicKey } from "@solana/web3.js";
import {
  assertSwappableMint,
  calculateInverseTransferFee,
  calculatePreFeeAmount,
  calculateTransferFee,
  decodeMint,
  decodeToken2022MintExtensions,
  getEpochFee,
  parseTlv,
  TOKEN_2022_EXTENSIONS,
  type TransferFee,
  type TransferFeeConfig,
  transferFeeFor,
  transferInverseFeeFor,
} from "../src";
import { CURVE_MINT, fixture } from "./fixtures";
import { rfixture } from "./raydium-fixtures";

const STONK_MINT = "9RAPesjvcxKjGXn7QXvRaNPQ9HhhTZoqBqeZmqEuN1fK"; // 300 bps transfer fee
const METAX = "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"; // xStock: permanent delegate, pausable, scaled UI, unset hook

function splMint(addr: string, data: Uint8Array) {
  const info: AccountInfo<Buffer> = { data: Buffer.from(data), owner: SPL_T22, lamports: 1, executable: false, rentEpoch: 0 };
  return unpackMint(new PublicKey(addr), info, SPL_T22);
}

describe("extension parsing vs @solana/spl-token", () => {
  test.each([[STONK_MINT], [METAX]])("%s: extension types and TransferFeeConfig agree", (addr) => {
    const data = rfixture(addr).data;
    const ours = decodeToken2022MintExtensions(data);
    const spl = splMint(addr, data);
    expect(ours.types).toEqual(getExtensionTypes(spl.tlvData));
    const cfg = getTransferFeeConfig(spl);
    if (!cfg) {
      expect(ours.transferFeeConfig).toBeNull();
      return;
    }
    const tf = ours.transferFeeConfig as TransferFeeConfig;
    expect(tf.withheldAmount).toBe(cfg.withheldAmount);
    for (const k of ["olderTransferFee", "newerTransferFee"] as const) {
      expect(tf[k]).toEqual({
        epoch: cfg[k].epoch,
        maximumFee: cfg[k].maximumFee,
        transferFeeBasisPoints: BigInt(cfg[k].transferFeeBasisPoints),
      });
    }
    for (const epoch of [0n, 1047n, 1048n, 2000n]) {
      for (const amount of [0n, 1n, 33n, 34n, 3_685_556_792_291n, 10n ** 18n]) {
        expect(transferFeeFor(tf, epoch, amount)).toBe(calculateEpochFee(cfg, epoch, amount));
      }
    }
  });

  test("enum values match spl-token's ExtensionType", () => {
    expect(TOKEN_2022_EXTENSIONS.transferFeeConfig).toBe(ExtensionType.TransferFeeConfig);
    expect(TOKEN_2022_EXTENSIONS.transferFeeAmount).toBe(ExtensionType.TransferFeeAmount);
    expect(TOKEN_2022_EXTENSIONS.nonTransferable).toBe(ExtensionType.NonTransferable);
    expect(TOKEN_2022_EXTENSIONS.permanentDelegate).toBe(ExtensionType.PermanentDelegate);
    expect(TOKEN_2022_EXTENSIONS.transferHook).toBe(ExtensionType.TransferHook);
    expect(TOKEN_2022_EXTENSIONS.pausable).toBe(ExtensionType.PausableConfig);
    expect(TOKEN_2022_EXTENSIONS.mintCloseAuthority).toBe(ExtensionType.MintCloseAuthority);
    expect(TOKEN_2022_EXTENSIONS.defaultAccountState).toBe(ExtensionType.DefaultAccountState);
    expect(TOKEN_2022_EXTENSIONS.interestBearingConfig).toBe(ExtensionType.InterestBearingConfig);
    expect(TOKEN_2022_EXTENSIONS.metadataPointer).toBe(ExtensionType.MetadataPointer);
    expect(TOKEN_2022_EXTENSIONS.tokenMetadata).toBe(ExtensionType.TokenMetadata);
    expect(TOKEN_2022_EXTENSIONS.scaledUiAmount).toBe(ExtensionType.ScaledUiAmountConfig);
  });

  test("pump create_v2 mints (metadata only) decode with no fee / hook; SPL mints have no TLV", () => {
    const pump = fixture(CURVE_MINT);
    const info = decodeMint(pump.data, pump.owner);
    expect(info.extensions.transferFeeConfig).toBeNull();
    expect(info.extensions.types).toEqual([18, 19]); // MetadataPointer, TokenMetadata
    expect(() => assertSwappableMint(CURVE_MINT, info)).not.toThrow();
    expect(parseTlv(new Uint8Array(82)).size).toBe(0);
  });

  test("active hooks, paused and non-transferable mints are refused", () => {
    const base = decodeToken2022MintExtensions(rfixture(METAX).data);
    const hook = "HooK111111111111111111111111111111111111111";
    expect(() => assertSwappableMint(METAX, { extensions: { ...base, transferHookProgramId: hook as never } })).toThrow("transfer hook");
    expect(() => assertSwappableMint(METAX, { extensions: { ...base, paused: true } })).toThrow("paused");
    expect(() => assertSwappableMint(METAX, { extensions: { ...base, nonTransferable: true } })).toThrow("non-transferable");
  });
});

describe("transfer fee math (token-2022 transfer_fee/mod.rs semantics)", () => {
  const fee = (bps: bigint, max: bigint, epoch = 0n): TransferFee => ({ epoch, maximumFee: max, transferFeeBasisPoints: bps });

  test("calculate_fee: ceil, capped at maximum_fee, zero cases", () => {
    expect(calculateTransferFee(fee(300n, 10n ** 15n), 3_685_556_792_291n)).toBe(110_566_703_769n);
    expect(calculateTransferFee(fee(100n, 10n), 10_000n)).toBe(10n);
    expect(calculateTransferFee(fee(1n, 5_000n), 1n)).toBe(1n);
    expect(calculateTransferFee(fee(0n, 5_000n), 1_000n)).toBe(0n);
    expect(calculateTransferFee(fee(500n, 5_000n), 0n)).toBe(0n);
  });

  test("pre-fee amount picks the smaller of the two candidates (10%: 9 net <- 10, not 11)", () => {
    expect(calculatePreFeeAmount(fee(1_000n, 1_000n), 9n)).toBe(10n);
    expect(calculatePreFeeAmount(fee(10_000n, 7n), 100n)).toBe(107n);
    expect(calculatePreFeeAmount(fee(300n, 50n), 1_000_000n)).toBe(1_000_050n); // capped by maximum_fee
    for (const post of [1n, 97n, 1_000n, 123_456_789n]) {
      const f = fee(300n, 10n ** 15n);
      const pre = calculatePreFeeAmount(f, post);
      expect(pre - calculateTransferFee(f, pre)).toBe(post);
      expect(calculateInverseTransferFee(f, post)).toBe(pre - post);
      expect(transferInverseFeeFor({ olderTransferFee: f, newerTransferFee: f } as TransferFeeConfig, 0n, post)).toBe(pre - post);
    }
  });

  test("epoch selection: newer fee from its epoch on", () => {
    const cfg = { olderTransferFee: fee(100n, 10n, 1n), newerTransferFee: fee(1n, 5_000n, 100n) } as TransferFeeConfig;
    expect(getEpochFee(cfg, 99n).transferFeeBasisPoints).toBe(100n);
    expect(getEpochFee(cfg, 100n).transferFeeBasisPoints).toBe(1n);
    expect(transferFeeFor(null, 5n, 1_000n)).toBe(0n);
  });
});
