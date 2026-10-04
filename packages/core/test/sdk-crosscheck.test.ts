/**
 * Golden tests: our hand-written decoders, quotes and instruction encoders vs the official
 * web3.js-v1 SDKs (@pump-fun/pump-sdk 2.0.0, @pump-fun/pump-swap-sdk 1.20.0), on live mainnet
 * account snapshots. The SDKs are devDependencies used only here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  getBuySolAmountFromTokenAmount,
  getBuyTokenAmountFromSolAmount,
  getPumpProgram,
  getSellSolAmountFromTokenAmount,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";
import { buyBaseInput, buyQuoteInput, PUMP_AMM_SDK, type SwapSolanaState, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import { address, type Instruction, isSignerRole, isWritableRole } from "@solana/kit";
import {
  getAssociatedTokenAddressSync,
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID as SPL_T,
  TOKEN_2022_PROGRAM_ID as SPL_T22,
} from "@solana/spl-token";
import { type AccountInfo, Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  ammBuyExactQuoteInInstruction,
  ammBuyInstruction,
  ammFeeRates,
  ammSellInstruction,
  bondingCurvePda,
  buildAmmBuyInstructions,
  buildAmmSellInstructions,
  buyExactQuoteInV2Instruction,
  buyV2Instruction,
  curveFeeRates,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeFeeConfig,
  decodeMint,
  decodePool,
  decodePumpGlobal,
  decodeTokenAccount,
  isCanonicalPumpPool,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
  quoteAmmBuyExactBase,
  quoteAmmBuyExactQuoteIn,
  quoteAmmSell,
  quoteBuyExactQuoteIn,
  quoteBuyExactTokens,
  quoteSell,
  resolveAmmSwapAccounts,
  resolvePumpTradeAccounts,
  sellV2Instruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src";
import { CURVE_MINT, type FixtureAccount, fixture, POOL } from "./fixtures";

const USER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const pk = (a: string) => new PublicKey(a);

function info(a: FixtureAccount): AccountInfo<Buffer> {
  return { data: Buffer.from(a.data), owner: pk(a.owner), lamports: Number(a.lamports), executable: false, rentEpoch: 0 };
}

type Meta = [string, boolean, boolean];
const ours = (ix: Instruction) => ({
  program: ix.programAddress as string,
  metas: (ix.accounts ?? []).map((m): Meta => [m.address, isSignerRole(m.role), isWritableRole(m.role)]),
  data: Buffer.from(ix.data ?? new Uint8Array()).toString("hex"),
});
const theirs = (ix: TransactionInstruction) => ({
  program: ix.programId.toBase58(),
  metas: ix.keys.map((k): Meta => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
  data: ix.data.toString("hex"),
});

// Deterministic SDK recipient picks (index 0); our builders get the same recipients explicitly.
const realRandom = Math.random;
beforeAll(() => {
  Math.random = () => 0;
});
afterAll(() => {
  Math.random = realRandom;
});

// ---------------------------------------------------------------------------------------------
// Bonding curve
// ---------------------------------------------------------------------------------------------

describe("pump bonding curve vs @pump-fun/pump-sdk", async () => {
  const curveAddr = await bondingCurvePda(CURVE_MINT);
  const globalAcc = fixture(PUMP_GLOBAL);
  const feeAcc = fixture(PUMP_FEE_CONFIG);
  const curveAcc = fixture(curveAddr);
  const mintAcc = fixture(CURVE_MINT);
  const global = decodePumpGlobal(globalAcc.data);
  const feeConfig = decodeFeeConfig(feeAcc.data);
  const curve = decodeBondingCurve(curveAcc.data);
  const mint = decodeMint(mintAcc.data, mintAcc.owner);
  const sdkGlobal = PUMP_SDK.decodeGlobal(info(globalAcc));
  const sdkFee = PUMP_SDK.decodeFeeConfig(info(feeAcc));
  const sdkCurve = PUMP_SDK.decodeBondingCurve(info(curveAcc));
  const rates = curveFeeRates({ curve, global, feeConfig, mintSupply: mint.supply });

  test("decoders agree (Global, FeeConfig, BondingCurve)", () => {
    expect(global.initialVirtualTokenReserves.toString()).toBe(sdkGlobal.initialVirtualTokenReserves.toString());
    expect(global.initialVirtualSolReserves.toString()).toBe(sdkGlobal.initialVirtualSolReserves.toString());
    expect(global.initialRealTokenReserves.toString()).toBe(sdkGlobal.initialRealTokenReserves.toString());
    expect(global.initialVirtualQuoteReserves.toString()).toBe(sdkGlobal.initialVirtualQuoteReserves.toString());
    expect(global.buybackBasisPoints.toString()).toBe(sdkGlobal.buybackBasisPoints.toString());
    expect(global.feeRecipients).toEqual(sdkGlobal.feeRecipients.map((p) => address(p.toBase58())));
    expect(global.buybackFeeRecipients).toEqual(sdkGlobal.buybackFeeRecipients.map((p) => address(p.toBase58())));
    expect(global.reservedFeeRecipients).toEqual(sdkGlobal.reservedFeeRecipients.map((p) => address(p.toBase58())));
    expect(global.creatorFeeConfigurable).toBe(Boolean(sdkGlobal.creatorFeeConfigurable));
    expect(
      feeConfig.feeTiers.map((t) => [t.marketCapThreshold.toString(), t.fees.protocolFeeBps.toString(), t.fees.creatorFeeBps.toString()]),
    ).toEqual(
      sdkFee.feeTiers.map((t) => [
        t.marketCapLamportsThreshold.toString(),
        t.fees.protocolFeeBps.toString(),
        t.fees.creatorFeeBps.toString(),
      ]),
    );
    expect(feeConfig.stableFeeTiers.length).toBe(sdkFee.stableFeeTiers.length);
    expect(curve.virtualQuoteReserves.toString()).toBe(sdkCurve.virtualQuoteReserves.toString());
    expect(curve.virtualTokenReserves.toString()).toBe(sdkCurve.virtualTokenReserves.toString());
    expect(curve.realTokenReserves.toString()).toBe(sdkCurve.realTokenReserves.toString());
    expect(curve.creator).toBe(address(sdkCurve.creator.toBase58()));
    expect(curve.quoteMint).toBe(address(sdkCurve.quoteMint.toBase58()));
  });

  const sdkArgs = {
    global: sdkGlobal,
    feeConfig: sdkFee,
    mintSupply: new BN(mint.supply.toString()),
    bondingCurve: sdkCurve,
    quoteMint: NATIVE_MINT,
  };

  test("buy exact tokens: total cost identical", () => {
    for (const amount of [1_000_000n, 123_456_789_012n, 10_000_000_000_000n]) {
      const sdk = getBuySolAmountFromTokenAmount({ ...sdkArgs, amount: new BN(amount.toString()) });
      expect(quoteBuyExactTokens(curve, amount, rates).totalQuote.toString()).toBe(sdk.toString());
    }
  });

  test("sell: net proceeds identical", () => {
    for (const amount of [1_000_000n, 123_456_789_012n, 10_000_000_000_000n]) {
      const sdk = getSellSolAmountFromTokenAmount({ ...sdkArgs, amount: new BN(amount.toString()) });
      expect(quoteSell(curve, amount, rates).quoteNet.toString()).toBe(sdk.toString());
    }
  });

  test("buy exact quote in: SDK over-quotes slightly (uses net instead of the on-chain net-1)", () => {
    for (const spend of [10_000_000n, 100_000_000n, 1_000_000_000n]) {
      const sdk = BigInt(getBuyTokenAmountFromSolAmount({ ...sdkArgs, amount: new BN(spend.toString()) }).toString());
      const mine = quoteBuyExactQuoteIn(curve, spend, rates).tokenAmount;
      expect(mine).toBeLessThanOrEqual(sdk);
      expect(Number(sdk - mine) / Number(sdk)).toBeLessThan(1e-6);
    }
  });

  const feeRecipient = global.feeRecipient;
  const buybackFeeRecipient = global.buybackFeeRecipients[0]!;
  const sdkV2Args = {
    user: pk(USER),
    mint: pk(CURVE_MINT),
    creator: pk(curve.creator),
    feeRecipient: pk(feeRecipient),
    buybackFeeRecipient: pk(buybackFeeRecipient),
    tokenProgram: SPL_T22,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: SPL_T,
  };
  const accountsP = resolvePumpTradeAccounts({
    mint: CURVE_MINT,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    user: USER,
    curve,
    feeRecipient,
    buybackFeeRecipient,
  });

  test("buy_v2: 27 account metas + data identical to SDK getBuyV2InstructionRaw", async () => {
    const accounts = await accountsP;
    const sdk = await PUMP_SDK.getBuyV2InstructionRaw({ ...sdkV2Args, amount: new BN(123_456_789), quoteAmount: new BN(987_654) });
    const mine = buyV2Instruction(accounts, 123_456_789n, 987_654n);
    expect(ours(mine)).toEqual(theirs(sdk));
    expect(mine.accounts?.length).toBe(27);
  });

  test("sell_v2: 26 account metas + data identical to SDK getSellV2InstructionRaw", async () => {
    const accounts = await accountsP;
    const sdk = await PUMP_SDK.getSellV2InstructionRaw({ ...sdkV2Args, amount: new BN(5_000_000), quoteAmount: new BN(4_321) });
    const mine = sellV2Instruction(accounts, 5_000_000n, 4_321n);
    expect(ours(mine)).toEqual(theirs(sdk));
    expect(mine.accounts?.length).toBe(26);
  });

  test("buy_exact_quote_in_v2: identical to Anchor-built ix from the official IDL (SDK has no builder)", async () => {
    const accounts = await accountsP;
    const program = getPumpProgram(new Connection("http://127.0.0.1:8899"));
    const sdk = await program.methods
      .buyExactQuoteInV2(new BN(10_000_000), new BN(115_658_903_890))
      .accountsPartial({
        baseMint: pk(CURVE_MINT),
        quoteMint: NATIVE_MINT,
        baseTokenProgram: SPL_T22,
        quoteTokenProgram: SPL_T,
        feeRecipient: pk(feeRecipient),
        associatedQuoteFeeRecipient: pk(accounts.associatedQuoteFeeRecipient),
        buybackFeeRecipient: pk(buybackFeeRecipient),
        associatedQuoteBuybackFeeRecipient: pk(accounts.associatedQuoteBuybackFeeRecipient),
        associatedBaseBondingCurve: getAssociatedTokenAddressSync(pk(CURVE_MINT), pk(curveAddr), true, SPL_T22),
        associatedQuoteBondingCurve: getAssociatedTokenAddressSync(NATIVE_MINT, pk(curveAddr), true, SPL_T),
        user: pk(USER),
        associatedBaseUser: getAssociatedTokenAddressSync(pk(CURVE_MINT), pk(USER), true, SPL_T22),
        associatedQuoteUser: getAssociatedTokenAddressSync(NATIVE_MINT, pk(USER), true, SPL_T),
        creatorVault: pk(accounts.creatorVault),
        associatedCreatorVault: pk(accounts.associatedCreatorVault),
        associatedUserVolumeAccumulator: pk(accounts.associatedUserVolumeAccumulator),
      })
      .instruction();
    expect(ours(buyExactQuoteInV2Instruction(accounts, 10_000_000n, 115_658_903_890n))).toEqual(theirs(sdk));
  });
});

// ---------------------------------------------------------------------------------------------
// PumpSwap
// ---------------------------------------------------------------------------------------------

describe("PumpSwap vs @pump-fun/pump-swap-sdk", async () => {
  const gcAcc = fixture(PUMP_AMM_GLOBAL_CONFIG);
  const feeAcc = fixture(PUMP_AMM_FEE_CONFIG);
  const poolAcc = fixture(POOL);
  const pool = decodePool(poolAcc.data);
  const baseMintAcc = fixture(pool.baseMint);
  const gc = decodeAmmGlobalConfig(gcAcc.data);
  const feeConfig = decodeFeeConfig(feeAcc.data);
  const mint = decodeMint(baseMintAcc.data, baseMintAcc.owner);
  const reserves = {
    baseReserve: decodeTokenAccount(fixture(pool.poolBaseTokenAccount).data).amount,
    quoteVaultReserve: decodeTokenAccount(fixture(pool.poolQuoteTokenAccount).data).amount,
    virtualQuoteReserves: pool.virtualQuoteReserves,
  };
  const sdkPool = PUMP_AMM_SDK.decodePool(info(poolAcc));
  const sdkGc = PUMP_AMM_SDK.decodeGlobalConfig(info(gcAcc));
  const sdkFee = PUMP_AMM_SDK.decodeFeeConfig(info(feeAcc));
  const baseMintRaw = MintLayout.decode(Buffer.from(baseMintAcc.data));
  const isCanonical = await isCanonicalPumpPool(pool);
  const rates = ammFeeRates({ pool, isCanonical, reserves, baseMintSupply: mint.supply, feeConfig, globalConfig: gc });

  test("decoders agree (Pool incl. signed virtual_quote_reserves, GlobalConfig, FeeConfig)", () => {
    expect(pool.virtualQuoteReserves.toString()).toBe(sdkPool.virtualQuoteReserves.toString());
    expect(pool.coinCreator).toBe(address(sdkPool.coinCreator.toBase58()));
    expect(pool.creator).toBe(address(sdkPool.creator.toBase58()));
    expect(pool.poolQuoteTokenAccount).toBe(address(sdkPool.poolQuoteTokenAccount.toBase58()));
    expect(pool.isCashbackCoin).toBe(sdkPool.isCashbackCoin);
    expect(gc.protocolFeeRecipients).toEqual(sdkGc.protocolFeeRecipients.map((p) => address(p.toBase58())));
    expect(gc.buybackFeeRecipients).toEqual(sdkGc.buybackFeeRecipients.map((p) => address(p.toBase58())));
    expect(feeConfig.feeTiers.length).toBe(sdkFee.feeTiers.length);
    expect(feeConfig.feeTiers.at(-1)?.marketCapThreshold.toString()).toBe(sdkFee.feeTiers.at(-1)?.marketCapLamportsThreshold.toString());
    expect(feeConfig.flatFees.lpFeeBps.toString()).toBe(sdkFee.flatFees.lpFeeBps.toString());
  });

  const sdkQuoteArgs = {
    slippage: 1,
    baseReserve: new BN(reserves.baseReserve.toString()),
    quoteReserve: new BN(reserves.quoteVaultReserve.toString()),
    virtualQuoteReserves: sdkPool.virtualQuoteReserves,
    globalConfig: sdkGc,
    baseMintAccount: baseMintRaw,
    baseMint: sdkPool.baseMint,
    coinCreator: sdkPool.coinCreator,
    creator: sdkPool.creator,
    feeConfig: sdkFee,
    quoteMint: sdkPool.quoteMint,
    isMayhemMode: sdkPool.isMayhemMode,
    creatorFeeBps: sdkPool.creatorFeeBps,
  };

  test("buyBaseInput / buyQuoteInput / sellBaseInput quotes identical", () => {
    for (const base of [1_000_000n, 2_299_467_152_525n, 50_000_000_000_000n]) {
      const sdk = buyBaseInput({ ...sdkQuoteArgs, base: new BN(base.toString()) });
      const mine = quoteAmmBuyExactBase(reserves, base, rates);
      expect(mine.quoteIn.toString()).toBe(sdk.internalQuoteAmount.toString());
      expect(mine.totalQuote.toString()).toBe(sdk.uiQuote.toString());
      const s = sellBaseInput({ ...sdkQuoteArgs, base: new BN(base.toString()) });
      const ms = quoteAmmSell(reserves, base, rates);
      expect(ms.quoteOutNet.toString()).toBe(s.uiQuote.toString());
      expect(ms.quoteOutGross.toString()).toBe(s.internalQuoteAmountOut.toString());
    }
    for (const quote of [10_000_000n, 1_000_000_000n]) {
      const sdk = buyQuoteInput({ ...sdkQuoteArgs, quote: new BN(quote.toString()) });
      const mine = quoteAmmBuyExactQuoteIn(reserves, quote, rates);
      expect(mine.baseOut.toString()).toBe(sdk.base.toString());
      expect(mine.quoteIn.toString()).toBe(sdk.internalQuoteWithoutFees.toString());
    }
  });

  const userPk = pk(USER);
  const sdkState: SwapSolanaState = {
    globalConfig: sdkGc,
    feeConfig: sdkFee,
    poolKey: pk(POOL),
    poolAccountInfo: info(poolAcc),
    pool: sdkPool,
    poolBaseAmount: new BN(reserves.baseReserve.toString()),
    poolQuoteAmount: new BN(reserves.quoteVaultReserve.toString()),
    baseTokenProgram: SPL_T22,
    quoteTokenProgram: SPL_T,
    baseMint: sdkPool.baseMint,
    baseMintAccount: baseMintRaw,
    user: userPk,
    userBaseTokenAccount: getAssociatedTokenAddressSync(sdkPool.baseMint, userPk, true, SPL_T22),
    userQuoteTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, userPk, true, SPL_T),
    userBaseAccountInfo: null,
    userQuoteAccountInfo: null,
  };
  const ctx = {
    poolAddress: POOL,
    pool,
    user: USER,
    baseTokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    protocolFeeRecipient: gc.protocolFeeRecipients[0]!,
    buybackFeeRecipient: gc.buybackFeeRecipients[0]!,
  };

  test("buy: full instruction sequence (wrap, ATA, buy + remaining accounts, unwrap) identical", async () => {
    const sdkIxs = await PUMP_AMM_SDK.buyInstructions(sdkState, new BN(1_000_000_000), new BN(50_000_000));
    const { instructions } = await buildAmmBuyInstructions(ctx, { mode: "exactBase", amount: 1_000_000_000n, limit: 50_000_000n });
    expect(instructions.map(ours)).toEqual(sdkIxs.map(theirs));
    const swap = instructions.find((i) => i.programAddress === "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    expect(swap?.accounts?.length).toBe(26); // 23 + pool-v2 + buyback + buyback ATA
  });

  test("sell: full instruction sequence identical", async () => {
    const sdkIxs = await PUMP_AMM_SDK.sellInstructions({ ...sdkState }, new BN(2_299_467_152_525), new BN(43_504_643));
    const { instructions } = await buildAmmSellInstructions(ctx, { baseAmountIn: 2_299_467_152_525n, minQuoteOut: 43_504_643n });
    expect(instructions.map(ours)).toEqual(sdkIxs.map(theirs));
    const swap = instructions.find((i) => i.programAddress === "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
    expect(swap?.accounts?.length).toBe(24); // 21 + pool-v2 + buyback + buyback ATA
  });

  test("buy_exact_quote_in: same metas as buy, data matches the Anchor coder", async () => {
    const a = await resolveAmmSwapAccounts(ctx);
    const mine = ammBuyExactQuoteInInstruction(a, pool, 10_000_000n, 421_083_857_926n);
    expect(mine.accounts).toEqual(ammBuyInstruction(a, pool, 1n, 1n).accounts);
    const coder = (await import("@pump-fun/pump-swap-sdk")).OFFLINE_PUMP_AMM_PROGRAM.coder.instruction;
    const data = coder.encode("buyExactQuoteIn", {
      spendableQuoteIn: new BN(10_000_000),
      minBaseAmountOut: new BN(421_083_857_926),
      trackVolume: { 0: true },
    });
    expect(Buffer.from(mine.data!).toString("hex")).toBe(data.toString("hex"));
    expect(ammSellInstruction(a, pool, 1n, 1n).accounts?.length).toBe(24);
  });
});
