import { describe, expect, test } from "bun:test";
import {
  AccountRole,
  address,
  type Blockhash,
  generateKeyPair,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  verifySignature,
} from "@solana/kit";
import {
  assembleTransaction,
  COMPUTE_BUDGET_PROGRAM_ID,
  capCuPrice,
  cuPriceFromSamples,
  FeeCapError,
  feePayerSignature,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_DONT_FRONT,
  JITO_TIP_ACCOUNTS_FALLBACK,
  parseJitoTipFloor,
  planFees,
  priorityFeeLamports,
  SYSTEM_PROGRAM_ID,
  setComputeUnitLimitInstruction,
  setComputeUnitPriceInstruction,
  signAssembled,
  tipInstruction,
  toWireBase64,
  transactionSize,
  withBudgetAndTips,
} from "../src";

const PAYER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const BLOCKHASH = { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Blockhash, lastValidBlockHeight: 1_000n };

// Live tip_floor snapshot quoted in tx_landing_and_mev.md §2 (values in SOL).
const TIP_FLOOR_JSON = [
  {
    time: "2026-10-03T15:34:59+00:00",
    landed_tips_25th_percentile: 1.0000000000000002e-6,
    landed_tips_50th_percentile: 6.145500000000001e-6,
    landed_tips_75th_percentile: 0.000067913,
    landed_tips_95th_percentile: 0.0001287499999999998,
    landed_tips_99th_percentile: 0.0002643690299999999,
    ema_landed_tips_50th_percentile: 5.021080713564013e-6,
  },
];

describe("compute budget", () => {
  test("encodings", () => {
    expect([...setComputeUnitLimitInstruction(140_000).data!]).toEqual([2, 0xe0, 0x22, 0x02, 0x00]);
    expect([...setComputeUnitPriceInstruction(100_000n).data!]).toEqual([3, 0xa0, 0x86, 0x01, 0, 0, 0, 0, 0]);
    expect(() => setComputeUnitLimitInstruction(1_400_001)).toThrow();
    // ceil(price * limit / 1e6)
    expect(priorityFeeLamports(100_000n, 140_000)).toBe(14_000n);
    expect(priorityFeeLamports(1n, 1)).toBe(1n);
  });
});

describe("fee/tip policy", () => {
  const floor = parseJitoTipFloor(TIP_FLOOR_JSON);
  const caps = { maxPriorityFeeLamports: 500_000n, maxTipLamports: 500_000n };

  test("tip floor parsed from SOL to lamports", () => {
    expect(floor).toMatchObject({ p25: 1_000n, p50: 6_146n, p75: 67_913n, p95: 128_750n, p99: 264_369n, emaP50: 5_021n });
  });

  test("percentile CU price and user cap", () => {
    expect(cuPriceFromSamples([0, 10, 20, 30, 40], "eco")).toBe(20n);
    expect(cuPriceFromSamples([0, 10, 20, 30, 40], "fast")).toBe(30n);
    expect(cuPriceFromSamples([], "turbo")).toBe(0n);
    // 100,000 lamports max over 200k CU => 500,000 µL/CU ceiling
    expect(capCuPrice(10_000n, 200_000, 100_000n)).toBe(10_000n);
    expect(capCuPrice(1_000_000n, 200_000, 100_000n)).toBe(500_000n);
  });

  test("standard: Helius SWQoS 5,000 + Jito at the preset percentile, both in the tx", () => {
    const p = planFees({ mode: "standard", preset: "fast", cuLimit: 140_000, prioritySamples: [50_000], tipFloor: floor, caps });
    expect(p.tips).toEqual([
      { lane: "helius", lamports: 5_000n },
      { lane: "jito", lamports: 67_913n },
    ]);
    expect(p).toMatchObject({ heliusMode: "swqos", sendToJito: true, jitoBundleOnly: false, jitoDontFront: false });
    expect(p.cuPriceMicroLamports).toBe(50_000n);
  });

  test("standard: tip budget caps the Jito tip; too-small caps throw", () => {
    const p = planFees({
      mode: "standard",
      preset: "turbo",
      cuLimit: 140_000,
      prioritySamples: [],
      tipFloor: floor,
      caps: { ...caps, maxTipLamports: 30_000n },
    });
    expect(p.tips[1]?.lamports).toBe(25_000n);
    expect(p.warnings.join()).toContain("capped");
    expect(() =>
      planFees({ mode: "standard", preset: "eco", cuLimit: 1, prioritySamples: [], caps: { ...caps, maxTipLamports: 5_500n } }),
    ).toThrow(FeeCapError);
  });

  test("turbo (Sender Max): >= 0.001 SOL, no direct Jito", () => {
    const p = planFees({
      mode: "turbo",
      preset: "turbo",
      cuLimit: 140_000,
      prioritySamples: [],
      tipFloor: floor,
      caps: { ...caps, maxTipLamports: 2_000_000n },
    });
    expect(p.tips).toEqual([{ lane: "helius", lamports: 1_000_000n }]);
    expect(p).toMatchObject({ heliusMode: "max", sendToJito: false });
    expect(() => planFees({ mode: "turbo", preset: "eco", cuLimit: 1, prioritySamples: [], caps })).toThrow(FeeCapError);
  });

  test("protected: Jito-only bundleOnly + jitodontfront, tip >= p75", () => {
    const p = planFees({ mode: "protected", preset: "eco", cuLimit: 140_000, prioritySamples: [], tipFloor: floor, caps });
    expect(p.tips).toEqual([{ lane: "jito", lamports: 67_913n }]);
    expect(p).toMatchObject({ heliusMode: null, sendToJito: true, jitoBundleOnly: true, jitoDontFront: true });
  });

  test("priority floor and cap", () => {
    const p = planFees({
      mode: "standard",
      preset: "fast",
      cuLimit: 100_000,
      prioritySamples: [0, 0, 0],
      tipFloor: floor,
      caps: { maxPriorityFeeLamports: 5_000n, maxTipLamports: 500_000n },
      minCuPriceMicroLamports: 100_000n,
    });
    expect(p.cuPriceMicroLamports).toBe(50_000n); // floor 100k µL capped to 5,000 lamports / 100k CU
    expect(p.priorityFeeLamports).toBe(5_000n);
  });
});

describe("tips and assembly", () => {
  test("tip instruction picks lane accounts; dontfront marker is read-only on the tip ix", () => {
    const h = tipInstruction({ from: PAYER, spec: { lane: "helius", lamports: 5_000n } });
    expect(h.programAddress).toBe(SYSTEM_PROGRAM_ID);
    expect(HELIUS_SENDER_TIP_ACCOUNTS).toContain(h.accounts![1]!.address);
    const j = tipInstruction({ from: PAYER, spec: { lane: "jito", lamports: 1_000n }, jitoDontFront: true });
    expect(JITO_TIP_ACCOUNTS_FALLBACK).toContain(j.accounts![1]!.address);
    expect(j.accounts![2]).toEqual({ address: JITO_DONT_FRONT, role: AccountRole.READONLY });
  });

  test("order: CU limit, CU price, trade ixs, tips; v0 compiles under 1232 bytes", () => {
    const fees = {
      cuLimit: 100_000,
      cuPriceMicroLamports: 10n,
      tips: [
        { lane: "helius" as const, lamports: 5_000n },
        { lane: "jito" as const, lamports: 1_000n },
      ],
      jitoDontFront: false,
    };
    const trade = tipInstruction({
      from: PAYER,
      spec: { lane: "jito", lamports: 7n, tipAccount: JITO_TIP_ACCOUNTS_FALLBACK[0] as Address },
    });
    const ixs = withBudgetAndTips({ feePayer: PAYER, instructions: [trade], fees });
    expect(ixs.map((i) => i.programAddress)).toEqual([
      COMPUTE_BUDGET_PROGRAM_ID,
      COMPUTE_BUDGET_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
      SYSTEM_PROGRAM_ID,
    ]);
    const tx = assembleTransaction({ feePayer: PAYER, instructions: [trade], blockhash: BLOCKHASH, fees });
    expect(transactionSize(tx)).toBeLessThan(1232);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(msg.version).toBe(0);
    expect(msg.staticAccounts[0]).toBe(PAYER);
    expect(feePayerSignature(tx, PAYER)).toBeNull();
    expect(toWireBase64(tx).length).toBeGreaterThan(0);
  });

  test("signs with a WebCrypto Ed25519 key (browser-compatible path)", async () => {
    // Ephemeral, never-funded key used only to exercise the signing path.
    const kp = await generateKeyPair();
    const payer = await getAddressFromPublicKey(kp.publicKey);
    const fees = { cuLimit: 50_000, cuPriceMicroLamports: 1n, tips: [{ lane: "jito" as const, lamports: 1_000n }], jitoDontFront: true };
    const tx = assembleTransaction({ feePayer: payer, instructions: [], blockhash: BLOCKHASH, fees });
    const signed = await signAssembled(tx, kp);
    const sig = signed.signatures[payer];
    expect(sig).toBeTruthy();
    expect(await verifySignature(kp.publicKey, sig!, signed.messageBytes)).toBe(true);
    expect(feePayerSignature(signed, payer)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  });
});
