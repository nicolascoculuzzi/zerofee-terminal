/**
 * Golden tests: our hand-written Raydium LaunchLab / CPMM decoders, quotes, PDAs and instruction
 * encoders vs the official web3.js-v1 SDK (@raydium-io/raydium-sdk-v2 0.2.73-alpha, devDependency
 * only), on live mainnet account snapshots.
 *
 * Known, intended divergence: CPMM swap_base_input with the creator fee on the input. The program
 * (and mainnet, tx j6GMrm…) takes one combined ceil split by rate; the SDK takes two ceils and can
 * charge one unit more creator fee. We follow the program; see raydium-cpmm.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  buyExactInInstruction,
  buyExactOutInstruction,
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  Curve,
  CurveCalculator,
  getCpmmPdaAmmConfigId,
  getCpmmPdaPoolId,
  getPdaCpiEvent,
  getPdaCreatorVault,
  getPdaLaunchpadAuth,
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaObservationId,
  getPdaPlatformVault,
  getPdaPoolAuthority,
  getPdaVault,
  LaunchpadConfig,
  LaunchpadPool,
  makeSwapCpmmBaseInInstruction,
  makeSwapCpmmBaseOutInstruction,
  PlatformConfig,
  sellExactInInstruction,
  sellExactOut,
} from "@raydium-io/raydium-sdk-v2";
import { address, type Instruction, isSignerRole, isWritableRole } from "@solana/kit";
import { getTransferFeeConfig, TOKEN_2022_PROGRAM_ID as SPL_T22, unpackMint } from "@solana/spl-token";
import { type AccountInfo, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  cpmmAmmConfigPda,
  cpmmAuthorityPda,
  cpmmFeeRates,
  cpmmObservationPda,
  cpmmPoolPda,
  cpmmSwapBaseInput,
  cpmmSwapBaseInputInstruction,
  cpmmSwapBaseOutput,
  cpmmSwapBaseOutputInstruction,
  cpmmVaultPda,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeMint,
  type LaunchLabPool,
  launchLabAuthorityPda,
  launchLabBuyExactInInstruction,
  launchLabBuyExactOutInstruction,
  launchLabCreatorFeeVaultPda,
  launchLabEventAuthorityPda,
  launchLabGlobalConfigPda,
  launchLabPlatformFeeVaultPda,
  launchLabPoolPda,
  launchLabSellExactInInstruction,
  launchLabSellExactOutInstruction,
  launchLabTradeParams,
  launchLabVaultPda,
  quoteLaunchLabBuyExactIn,
  quoteLaunchLabBuyExactOut,
  quoteLaunchLabSellExactIn,
  quoteLaunchLabSellExactOut,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  resolveCpmmSwapAccounts,
  resolveLaunchLabSwapAccounts,
} from "../src";
import { rfixture } from "./raydium-fixtures";

const pk = (a: string) => new PublicKey(a);
const bn = (x: bigint) => new BN(x.toString());
const big = (x: BN | undefined) => (x === undefined ? 0n : BigInt(x.toString()));
const LL = pk(RAYDIUM_LAUNCHLAB_PROGRAM_ID);
const CP = pk(RAYDIUM_CPMM_PROGRAM_ID);
const USER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const EPOCH = 1048n;
/** The SDK derives the transfer-fee epoch as floor(slot / 432,000). */
const SLOT = Number(EPOCH * 432_000n);

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

function splTransferFeeConfig(mint: string) {
  const acc = rfixture(mint);
  if (acc.owner !== SPL_T22.toBase58()) return undefined;
  const info: AccountInfo<Buffer> = { data: Buffer.from(acc.data), owner: SPL_T22, lamports: 1, executable: false, rentEpoch: 0 };
  return getTransferFeeConfig(unpackMint(pk(mint), info, SPL_T22)) ?? undefined;
}

// ---------------------------------------------------------------------------------------------
// LaunchLab
// ---------------------------------------------------------------------------------------------

const LL_POOLS = [
  "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo", // BONK.fun
  "2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2", // StonkFun, 3% transfer-fee base
  "G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY", // TRiX, creator fee
  "EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS", // StonkFun, Token-2022 METAx quote
];

describe("LaunchLab vs @raydium-io/raydium-sdk-v2", () => {
  test.each(LL_POOLS)("decoders agree on pool %s and its configs", (p) => {
    const ourPool = decodeLaunchLabPool(rfixture(p).data);
    const sdkPool = LaunchpadPool.decode(Buffer.from(rfixture(p).data));
    expect({
      status: ourPool.status,
      migrateType: ourPool.migrateType,
      supply: ourPool.supply,
      totalBaseSell: ourPool.totalBaseSell,
      virtualBase: ourPool.virtualBase,
      virtualQuote: ourPool.virtualQuote,
      realBase: ourPool.realBase,
      realQuote: ourPool.realQuote,
      totalQuoteFundRaising: ourPool.totalQuoteFundRaising,
      quoteProtocolFee: ourPool.quoteProtocolFee,
      platformFee: ourPool.platformFee,
      baseDecimals: ourPool.baseDecimals,
      quoteDecimals: ourPool.quoteDecimals,
      tokenProgramFlag: ourPool.tokenProgramFlag,
      ammCreatorFeeOn: ourPool.ammCreatorFeeOn,
      platformVestingShare: ourPool.platformVestingShare,
      keys: [
        ourPool.globalConfig,
        ourPool.platformConfig,
        ourPool.baseMint,
        ourPool.quoteMint,
        ourPool.baseVault,
        ourPool.quoteVault,
        ourPool.creator,
      ],
    }).toEqual({
      status: sdkPool.status,
      migrateType: sdkPool.migrateType,
      supply: big(sdkPool.supply),
      totalBaseSell: big(sdkPool.totalSellA),
      virtualBase: big(sdkPool.virtualA),
      virtualQuote: big(sdkPool.virtualB),
      realBase: big(sdkPool.realA),
      realQuote: big(sdkPool.realB),
      totalQuoteFundRaising: big(sdkPool.totalFundRaisingB),
      quoteProtocolFee: big(sdkPool.protocolFee),
      platformFee: big(sdkPool.platformFee),
      baseDecimals: sdkPool.mintDecimalsA,
      quoteDecimals: sdkPool.mintDecimalsB,
      tokenProgramFlag: sdkPool.mintProgramFlag,
      ammCreatorFeeOn: sdkPool.cpmmCreatorFeeOn,
      platformVestingShare: big(sdkPool.platformVestingShare),
      keys: [sdkPool.configId, sdkPool.platformId, sdkPool.mintA, sdkPool.mintB, sdkPool.vaultA, sdkPool.vaultB, sdkPool.creator].map((k) =>
        k.toBase58(),
      ),
    });

    const g = decodeLaunchLabGlobalConfig(rfixture(ourPool.globalConfig).data);
    const sg = LaunchpadConfig.decode(Buffer.from(rfixture(ourPool.globalConfig).data));
    expect([g.curveType, g.index, g.tradeFeeRate, g.maxShareFeeRate, g.migrateFee, g.quoteMint, g.migrateToCpswapWallet]).toEqual([
      sg.curveType,
      sg.index,
      big(sg.tradeFeeRate),
      big(sg.maxShareFeeRate),
      big(sg.migrateFee),
      sg.mintB.toBase58(),
      sg.migrateToCpmmWallet.toBase58(),
    ]);

    const pc = decodeLaunchLabPlatformConfig(rfixture(ourPool.platformConfig).data);
    const spc = PlatformConfig.decode(Buffer.from(rfixture(ourPool.platformConfig).data));
    expect([pc.feeRate, pc.creatorFeeRate, pc.cpswapConfig, pc.platformFeeWallet, pc.platformCpCreator, pc.platformVestingScale]).toEqual([
      big(spc.feeRate),
      big(spc.creatorFeeRate),
      spc.cpConfigId.toBase58(),
      spc.platformClaimFeeWallet.toBase58(),
      spc.platformCpCreator.toBase58(),
      big(spc.platformVestingScale),
    ]);
  });

  test.each(LL_POOLS)("buy/sell exact in/out quotes identical on %s (incl. Token-2022 transfer fees)", (p) => {
    const pool = decodeLaunchLabPool(rfixture(p).data);
    const sdkPool = LaunchpadPool.decode(Buffer.from(rfixture(p).data));
    const g = decodeLaunchLabGlobalConfig(rfixture(pool.globalConfig).data);
    const pc = decodeLaunchLabPlatformConfig(rfixture(pool.platformConfig).data);
    const params = launchLabTradeParams({ globalConfig: g, platformConfig: pc });
    const baseMint = decodeMint(rfixture(pool.baseMint).data, rfixture(pool.baseMint).owner);
    const quoteMint = decodeMint(rfixture(pool.quoteMint).data, rfixture(pool.quoteMint).owner);
    const fees = { base: baseMint.extensions.transferFeeConfig, quote: quoteMint.extensions.transferFeeConfig, epoch: EPOCH };
    const sdkArgs = {
      poolInfo: sdkPool,
      protocolFeeRate: bn(g.tradeFeeRate),
      platformFeeRate: bn(pc.feeRate),
      creatorFeeRate: bn(pc.creatorFeeRate),
      shareFeeRate: new BN(0),
      curveType: g.curveType,
      transferFeeConfigA: splTransferFeeConfig(pool.baseMint),
      transferFeeConfigB: splTransferFeeConfig(pool.quoteMint),
      slot: SLOT,
    };
    const unit = 10n ** BigInt(pool.quoteDecimals);
    for (const quoteIn of [unit / 1000n, unit / 10n, 3n * unit, 7_777_777n]) {
      const q = quoteLaunchLabBuyExactIn(pool, quoteIn, params, fees);
      const s = Curve.buyExactIn({ ...sdkArgs, amountB: bn(quoteIn) });
      expect([q.baseOut, q.baseTransferFee, q.quoteIn]).toEqual([big(s.amountA.amount), big(s.amountA.fee), big(s.amountB)]);
      expect([q.protocolFee, q.platformFee, q.creatorFee, q.shareFee]).toEqual([
        big(s.splitFee.protocolFee),
        big(s.splitFee.platformFee),
        big(s.splitFee.creatorFee),
        big(s.splitFee.shareFee),
      ]);
    }
    for (const baseWanted of [1_000_000n, 25_000_000_000n, 12_345_678_901_234n]) {
      const q = quoteLaunchLabBuyExactOut(pool, baseWanted, params, fees);
      const s = Curve.buyExactOut({ ...sdkArgs, amountA: bn(baseWanted) });
      expect(q.baseOut).toBe(big(s.amountA.amount));
      if (fees.base) {
        // SDK bug: realAmountA = preAmountA.amount + preAmountA.fee prices the transfer fee twice, so its
        // quote (only used as max_amount_in) is the price of gross + fee. Ours prices exactly the gross
        // base the vault sends (checked against the program by mainnet simulation, NOTES.md).
        const doubleCounted = quoteLaunchLabBuyExactOut(pool, q.baseOut + q.baseTransferFee, params, { quote: fees.quote, epoch: EPOCH });
        expect(big(s.amountB)).toBe(doubleCounted.quoteIn);
        expect(big(s.amountB)).toBeGreaterThanOrEqual(q.quoteIn);
      } else {
        expect(q.quoteIn).toBe(big(s.amountB));
        expect(q.platformFee).toBe(big(s.splitFee.platformFee));
      }
    }
    for (const baseIn of [1_000_000n, 25_000_000_000n, pool.realBase / 3n]) {
      const q = quoteLaunchLabSellExactIn(pool, baseIn, params, fees);
      const s = Curve.sellExactIn({ ...sdkArgs, amountA: bn(baseIn) });
      expect([q.quoteReceived, q.baseTransferFee]).toEqual([big(s.amountB), big(s.amountA.fee)]);
      expect([q.protocolFee, q.platformFee, q.creatorFee]).toEqual([
        big(s.splitFee.protocolFee),
        big(s.splitFee.platformFee),
        big(s.splitFee.creatorFee),
      ]);
    }
    for (const quoteWanted of [pool.realQuote / 1000n, pool.realQuote / 7n]) {
      const q = quoteLaunchLabSellExactOut(pool, quoteWanted, params, fees);
      const s = Curve.sellExactOut({ ...sdkArgs, amountB: bn(quoteWanted) });
      expect(q.baseIn).toBe(big(s.amountA.amount));
      expect(q.protocolFee).toBe(big(s.splitFee.protocolFee));
    }
  });

  test("PDAs agree", async () => {
    const pool = decodeLaunchLabPool(rfixture(LL_POOLS[1] as string).data);
    expect(await launchLabAuthorityPda()).toBe(getPdaLaunchpadAuth(LL).publicKey.toBase58());
    expect(await launchLabEventAuthorityPda()).toBe(getPdaCpiEvent(LL).publicKey.toBase58());
    expect(await launchLabPoolPda(pool.baseMint, pool.quoteMint)).toBe(
      getPdaLaunchpadPoolId(LL, pk(pool.baseMint), pk(pool.quoteMint)).publicKey.toBase58(),
    );
    const poolId = await launchLabPoolPda(pool.baseMint, pool.quoteMint);
    expect(await launchLabVaultPda(poolId, pool.baseMint)).toBe(
      getPdaLaunchpadVaultId(LL, pk(poolId), pk(pool.baseMint)).publicKey.toBase58(),
    );
    expect(await launchLabPlatformFeeVaultPda(pool.platformConfig, pool.quoteMint)).toBe(
      getPdaPlatformVault(LL, pk(pool.platformConfig), pk(pool.quoteMint)).publicKey.toBase58(),
    );
    expect(await launchLabCreatorFeeVaultPda(pool.creator, pool.quoteMint)).toBe(
      getPdaCreatorVault(LL, pk(pool.creator), pk(pool.quoteMint)).publicKey.toBase58(),
    );
    for (const [curve, index] of [
      [0, 0],
      [0, 3],
      [2, 513],
    ] as const) {
      expect(await launchLabGlobalConfigPda(pool.quoteMint, curve, index)).toBe(
        getPdaLaunchpadConfigId(LL, pk(pool.quoteMint), curve, index).publicKey.toBase58(),
      );
    }
  });

  describe("instruction encoders identical to the SDK's instrument.ts", () => {
    const poolAddr = LL_POOLS[1] as string; // Token-2022 base: exercises the base token program flag
    const pool = decodeLaunchLabPool(rfixture(poolAddr).data);
    const accountsP = resolveLaunchLabSwapAccounts({ poolAddress: address(poolAddr), pool, user: USER });
    const share = address("3gZmK6sXyWtHVUFX5VLrbcN1jW8iRzDSawqAwk3uZjKt");
    const sdkPositional = async (p: LaunchLabPool) => {
      const a = await accountsP;
      return [
        LL,
        pk(USER),
        pk(a.authority),
        pk(p.globalConfig),
        pk(p.platformConfig),
        pk(poolAddr),
        pk(a.userBaseToken),
        pk(a.userQuoteToken),
        pk(p.baseVault),
        pk(p.quoteVault),
        pk(p.baseMint),
        pk(p.quoteMint),
        pk(a.baseTokenProgram),
        pk(a.quoteTokenProgram),
        pk(a.platformFeeVault),
        pk(a.creatorFeeVault),
      ] as const;
    };

    test("buy_exact_in / buy_exact_out / sell_exact_in / sell_exact_out (18 accounts)", async () => {
      const a = await accountsP;
      const k = await sdkPositional(pool);
      expect(ours(launchLabBuyExactInInstruction(a, 10_000_000n, 123n))).toEqual(
        theirs(buyExactInInstruction(...k, bn(10_000_000n), bn(123n))),
      );
      expect(ours(launchLabBuyExactOutInstruction(a, 5_000_000n, 77_000n))).toEqual(
        theirs(buyExactOutInstruction(...k, bn(5_000_000n), bn(77_000n))),
      );
      expect(ours(launchLabSellExactInInstruction(a, 9_999n, 1n))).toEqual(theirs(sellExactInInstruction(...k, bn(9_999n), bn(1n))));
      expect(ours(launchLabSellExactOutInstruction(a, 1_000n, 2_000n))).toEqual(theirs(sellExactOut(...k, bn(1_000n), bn(2_000n))));
      expect(launchLabBuyExactInInstruction(a, 1n, 1n).accounts?.length).toBe(18);
    });

    test("with a share fee receiver (19 accounts, receiver before the system program)", async () => {
      const a = { ...(await accountsP), shareFeeReceiver: share };
      const k = await sdkPositional(pool);
      expect(ours(launchLabBuyExactInInstruction(a, 10_000_000n, 1n, 1_000n))).toEqual(
        theirs(buyExactInInstruction(...k, bn(10_000_000n), bn(1n), bn(1_000n), pk(share))),
      );
      expect(ours(launchLabSellExactInInstruction(a, 10_000_000n, 1n, 1_000n))).toEqual(
        theirs(sellExactInInstruction(...k, bn(10_000_000n), bn(1n), bn(1_000n), pk(share))),
      );
      expect(() => launchLabBuyExactInInstruction({ ...a, shareFeeReceiver: undefined }, 1n, 1n, 1n)).toThrow("share fee receiver");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// CPMM
// ---------------------------------------------------------------------------------------------

const CP_POOLS = [
  "92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh",
  "F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z",
  "9nxAnMD7K78a9RMd2L3w8kQT5u9i7gsvV5aHiZ78sCC2",
];

describe("CPMM vs @raydium-io/raydium-sdk-v2", () => {
  test.each(CP_POOLS)("decoders agree on pool %s and its AmmConfig", (p) => {
    const o = decodeCpmmPool(rfixture(p).data);
    const s = CpmmPoolInfoLayout.decode(Buffer.from(rfixture(p).data));
    expect([
      o.ammConfig,
      o.poolCreator,
      o.token0Vault,
      o.token1Vault,
      o.lpMint,
      o.token0Mint,
      o.token1Mint,
      o.token0Program,
      o.token1Program,
      o.observationKey,
    ]).toEqual(
      [s.configId, s.poolCreator, s.vaultA, s.vaultB, s.mintLp, s.mintA, s.mintB, s.mintProgramA, s.mintProgramB, s.observationId].map(
        (k) => k.toBase58(),
      ),
    );
    expect([
      o.status,
      o.mint0Decimals,
      o.mint1Decimals,
      o.lpSupply,
      o.protocolFeesToken0,
      o.protocolFeesToken1,
      o.fundFeesToken0,
      o.fundFeesToken1,
      o.openTime,
      o.creatorFeeOn,
      o.enableCreatorFee,
      o.creatorFeesToken0,
      o.creatorFeesToken1,
    ]).toEqual([
      s.status,
      s.mintDecimalA,
      s.mintDecimalB,
      big(s.lpAmount),
      big(s.protocolFeesMintA),
      big(s.protocolFeesMintB),
      big(s.fundFeesMintA),
      big(s.fundFeesMintB),
      big(s.openTime),
      s.feeOn,
      s.enableCreatorFee,
      big(s.creatorFeesMintA),
      big(s.creatorFeesMintB),
    ]);
    const c = decodeCpmmAmmConfig(rfixture(o.ammConfig).data);
    const sc = CpmmConfigInfoLayout.decode(Buffer.from(rfixture(o.ammConfig).data));
    expect([c.index, c.tradeFeeRate, c.protocolFeeRate, c.fundFeeRate, c.creatorFeeRate, c.creatorFeeShareRate]).toEqual([
      sc.index,
      big(sc.tradeFeeRate),
      big(sc.protocolFeeRate),
      big(sc.fundFeeRate),
      big(sc.creatorFeeRate),
      big(sc.creatorFeeShareRate),
    ]);
  });

  test("swap math identical, except the documented creator-fee-on-input rounding", () => {
    const rateSets = [
      { tradeFeeRate: 2_500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n, creatorFeeRate: 10_000n },
      { tradeFeeRate: 5_000n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n, creatorFeeRate: 7_500n },
      { tradeFeeRate: 2_500n, protocolFeeRate: 120_000n, fundFeeRate: 40_000n, creatorFeeRate: 0n },
    ];
    const vaults: [bigint, bigint][] = [
      [40_004_561_748n, 429_068_366_400_759n],
      [995_916_980_798_703n, 23_592_425_259n],
    ];
    let onInputDivergences = 0;
    let onInputCases = 0;
    for (const r of rateSets) {
      const sdkRates = [bn(r.tradeFeeRate), bn(r.creatorFeeRate), bn(r.protocolFeeRate), bn(r.fundFeeRate)] as const;
      for (const [inV, outV] of vaults) {
        for (const amount of [1_000n, 223_414_611n, 265_171_449n, 9_876_543_210n, 4_546_495_878_992n]) {
          for (const onInput of [false, true]) {
            const o = cpmmSwapBaseInput(amount, inV, outV, r, onInput);
            const s = CurveCalculator.swapBaseInput(bn(amount), bn(inV), bn(outV), ...sdkRates, onInput);
            if (!onInput || r.creatorFeeRate === 0n) {
              expect([o.outputAmount, o.tradeFee, o.creatorFee, o.protocolFee, o.fundFee]).toEqual([
                big(s.outputAmount),
                big(s.tradeFee),
                big(s.creatorFee),
                big(s.protocolFee),
                big(s.fundFee),
              ]);
            } else {
              onInputCases++;
              // Program: total = ceil(in*(trade+creator)), creator = floor(total*creator/(trade+creator)).
              // SDK: ceil(in*trade) + ceil(in*creator) >= the program's total, by at most one unit, and the
              // split can shift a unit between the two fees. We never quote more output than the program gives.
              const oTotal = o.tradeFee + o.creatorFee;
              const sTotal = big(s.tradeFee) + big(s.creatorFee);
              expect(oTotal).toBe((amount * (r.tradeFeeRate + r.creatorFeeRate) + 999_999n) / 1_000_000n);
              expect(sTotal - oTotal === 0n || sTotal - oTotal === 1n).toBe(true);
              for (const d of [o.tradeFee - big(s.tradeFee), o.creatorFee - big(s.creatorFee)]) expect(d >= -1n && d <= 1n).toBe(true);
              expect(o.outputAmount >= big(s.outputAmount)).toBe(true);
              if (o.creatorFee !== big(s.creatorFee) || o.tradeFee !== big(s.tradeFee)) onInputDivergences++;
            }
            if (amount < outV / 2n) {
              const ob = cpmmSwapBaseOutput(amount, inV, outV, r, onInput);
              const sb = CurveCalculator.swapBaseOutput(bn(amount), bn(inV), bn(outV), ...sdkRates, onInput);
              expect([ob.inputAmount, ob.tradeFee, ob.creatorFee, ob.protocolFee]).toEqual([
                big(sb.inputAmount),
                big(sb.tradeFee),
                big(sb.creatorFee),
                big(sb.protocolFee),
              ]);
            }
          }
        }
      }
    }
    expect(onInputCases).toBeGreaterThan(0);
    expect(onInputDivergences).toBeGreaterThan(0); // the case exists (e.g. 223,414,611 in, as on mainnet)
  });

  test("PDAs agree", async () => {
    const p = CP_POOLS[1] as string;
    const s = decodeCpmmPool(rfixture(p).data);
    expect(await cpmmAuthorityPda()).toBe(getPdaPoolAuthority(CP).publicKey.toBase58());
    expect(await cpmmPoolPda(s.ammConfig, s.token0Mint, s.token1Mint)).toBe(
      getCpmmPdaPoolId(CP, pk(s.ammConfig), pk(s.token0Mint), pk(s.token1Mint)).publicKey.toBase58(),
    );
    expect(await cpmmVaultPda(address(p), s.token1Mint)).toBe(getPdaVault(CP, pk(p), pk(s.token1Mint)).publicKey.toBase58());
    expect(await cpmmObservationPda(address(p))).toBe(getPdaObservationId(CP, pk(p)).publicKey.toBase58());
    for (const i of [0, 11, 15, 300]) expect(await cpmmAmmConfigPda(i)).toBe(getCpmmPdaAmmConfigId(CP, i).publicKey.toBase58());
  });

  test.each(CP_POOLS)("swap_base_input / swap_base_output encoders identical on %s (both directions)", async (p) => {
    const s = decodeCpmmPool(rfixture(p).data);
    expect(cpmmFeeRates(decodeCpmmAmmConfig(rfixture(s.ammConfig).data), s).tradeFeeRate).toBeGreaterThan(0n);
    for (const inputMint of [s.token0Mint, s.token1Mint]) {
      const a = await resolveCpmmSwapAccounts({ poolAddress: address(p), pool: s, user: USER, inputMint });
      const k = [
        CP,
        pk(USER),
        pk(a.authority),
        pk(s.ammConfig),
        pk(p),
        pk(a.inputTokenAccount),
        pk(a.outputTokenAccount),
        pk(a.inputVault),
        pk(a.outputVault),
        pk(a.inputTokenProgram),
        pk(a.outputTokenProgram),
        pk(a.inputTokenMint),
        pk(a.outputTokenMint),
        pk(s.observationKey),
      ] as const;
      expect(ours(cpmmSwapBaseInputInstruction(a, 1_234_567n, 89n))).toEqual(
        theirs(makeSwapCpmmBaseInInstruction(...k, bn(1_234_567n), bn(89n))),
      );
      expect(ours(cpmmSwapBaseOutputInstruction(a, 5_000n, 4_000n))).toEqual(
        theirs(makeSwapCpmmBaseOutInstruction(...k, bn(5_000n), bn(4_000n))),
      );
    }
  });
});
