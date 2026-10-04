/**
 * Raydium CPMM: PDAs, decoders, the LaunchLab -> CPMM graduation link, and exact replays of real
 * mainnet swaps (graduated BONK.fun and StonkFun coins: creator fee on input/output, 3% Token-2022
 * transfer fees on both legs, swap_base_output). Fixtures: test/fixtures/raydium-mainnet.json.
 */
import { describe, expect, test } from "bun:test";
import { type Address, address } from "@solana/kit";
import {
  CPMM_CREATOR_FEE_ON,
  type CpmmSwapEvent,
  cpmmAmmConfigPda,
  cpmmAuthorityPda,
  cpmmFeeRates,
  cpmmIsCreatorFeeOnInput,
  cpmmObservationPda,
  cpmmPoolPda,
  cpmmSwapAccountMetas,
  cpmmSwapBaseInput,
  cpmmSwapBaseOutput,
  cpmmVaultAmountsWithoutFees,
  cpmmVaultPda,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeEventsFromLogs,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeMint,
  decodeTokenAccount,
  isCpmmSwapEnabled,
  quoteCpmmSwapBaseInput,
  quoteCpmmSwapBaseOutput,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_IX,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  resolveCpmmSwapAccounts,
  sortCpmmMints,
  transferFeeFor,
  WSOL_MINT,
} from "../src";
import { findIx, rfixture, rtx, type TxLabel, tokenDelta, u64Arg } from "./raydium-fixtures";

const POOLS = {
  bonk: "92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh",
  stonk: "F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z",
  baseOut: "9nxAnMD7K78a9RMd2L3w8kQT5u9i7gsvV5aHiZ78sCC2",
} as const;

const pool = (p: string) => decodeCpmmPool(rfixture(p).data);
const config = (p: string) => decodeCpmmAmmConfig(rfixture(pool(p).ammConfig).data);
const transferCfg = (mint: string) => decodeMint(rfixture(mint).data, rfixture(mint).owner).extensions.transferFeeConfig;

describe("CPMM PDAs and decoders on live accounts", () => {
  test("authority, AmmConfig (big-endian index), pool, vault and observation PDAs", async () => {
    expect(await cpmmAuthorityPda()).toBe(RAYDIUM_CPMM_AUTHORITY);
    for (const p of Object.values(POOLS)) {
      const s = pool(p);
      const cfg = decodeCpmmAmmConfig(rfixture(s.ammConfig).data);
      expect(await cpmmAmmConfigPda(cfg.index)).toBe(s.ammConfig);
      expect(await cpmmPoolPda(s.ammConfig, s.token1Mint, s.token0Mint)).toBe(address(p));
      expect(await cpmmVaultPda(address(p), s.token0Mint)).toBe(s.token0Vault);
      expect(await cpmmVaultPda(address(p), s.token1Mint)).toBe(s.token1Vault);
      expect(await cpmmObservationPda(address(p))).toBe(s.observationKey);
      expect(sortCpmmMints(s.token1Mint, s.token0Mint)).toEqual([s.token0Mint, s.token1Mint]);
    }
  });

  test("decoded pool and config fields", () => {
    const b = pool(POOLS.bonk);
    expect(b.dataLength).toBe(637);
    expect(b.token0Mint).toBe(WSOL_MINT);
    expect(b.creatorFeeOn).toBe(CPMM_CREATOR_FEE_ON.onlyToken0);
    expect(b.enableCreatorFee).toBe(true);
    expect(isCpmmSwapEnabled(b)).toBe(true);
    expect(decodeTokenAccount(rfixture(b.token0Vault).data).mint).toBe(b.token0Mint);
    expect(config(POOLS.bonk)).toMatchObject({
      index: 15,
      tradeFeeRate: 5_000n,
      protocolFeeRate: 120_000n,
      fundFeeRate: 40_000n,
      creatorFeeRate: 7_500n,
    });
    expect(config(POOLS.bonk).creatorFeeShareRate).toBe(50_000n);
    expect(config(POOLS.stonk)).toMatchObject({ index: 11, tradeFeeRate: 2_500n, creatorFeeRate: 10_000n });
    expect(config(POOLS.baseOut)).toMatchObject({ index: 0, tradeFeeRate: 2_500n, creatorFeeRate: 500n });
    expect(pool(POOLS.baseOut).enableCreatorFee).toBe(false);
    expect(cpmmFeeRates(config(POOLS.baseOut), pool(POOLS.baseOut)).creatorFeeRate).toBe(0n);
  });

  test("graduation: a LaunchLab coin's CPMM pool is the canonical PDA on PlatformConfig.cpswap_config", async () => {
    const ll = decodeLaunchLabPool(rfixture("yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S").data);
    const platform = decodeLaunchLabPlatformConfig(rfixture(ll.platformConfig).data);
    expect(await cpmmPoolPda(platform.cpswapConfig, ll.baseMint, ll.quoteMint)).toBe(address(POOLS.bonk));
    // The real migrate_to_cpswap (signed by the migration wallet) used exactly that pool and config.
    const migrate = rtx("migrate");
    const ix = findIx(migrate, RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_LAUNCHLAB_IX.migrateToCpswap);
    expect(ix.accounts[5]).toBe(address(POOLS.bonk));
    expect(ix.accounts[10]).toBe(platform.cpswapConfig);
    expect(ix.accounts[0]).toBe(address("RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw"));
  });

  test("vault reserves are net of protocol, fund and creator fees owed", () => {
    const s = pool(POOLS.bonk);
    const v0 = decodeTokenAccount(rfixture(s.token0Vault).data).amount;
    const v1 = decodeTokenAccount(rfixture(s.token1Vault).data).amount;
    const net = cpmmVaultAmountsWithoutFees(s, v0, v1);
    expect(net.token0).toBe(v0 - s.protocolFeesToken0 - s.fundFeesToken0 - s.creatorFeesToken0);
    expect(net.token1).toBe(v1 - s.protocolFeesToken1 - s.fundFeesToken1 - s.creatorFeesToken1);
    expect(() => cpmmVaultAmountsWithoutFees(s, 0n, v1)).toThrow("InsufficientVault");
  });
});

// ---------------------------------------------------------------------------------------------
// Mainnet replays
// ---------------------------------------------------------------------------------------------

function load(label: TxLabel, poolAddr: string) {
  const tx = rtx(label);
  const ix = tx.instructions.find((i) => i.programId === RAYDIUM_CPMM_PROGRAM_ID && i.accounts[3] === address(poolAddr));
  if (!ix) throw new Error(`${label}: no CPMM swap on ${poolAddr}`);
  const events = decodeEventsFromLogs(tx.logs).filter((e): e is CpmmSwapEvent => e.kind === "cpmmSwap");
  expect(events.length).toBe(1);
  const ev = events[0] as CpmmSwapEvent;
  expect(ev.pool).toBe(address(poolAddr));
  const s = pool(poolAddr);
  const direction = ev.inputMint === s.token0Mint ? ("zeroForOne" as const) : ("oneForZero" as const);
  const isBaseInput = RAYDIUM_CPMM_IX.swapBaseInput.every((b, k) => ix.data[k] === b);
  expect(ev.baseInput).toBe(isBaseInput);
  expect(ev.creatorFeeOnInput).toBe(cpmmIsCreatorFeeOnInput(s.creatorFeeOn, direction));
  return { tx, ix, ev, s, rates: cpmmFeeRates(config(poolAddr), s), direction };
}

/** Full quote path with a pool whose owed fees are zero and vaults equal the event's pre-state. */
function quoteFromEvent(l: ReturnType<typeof load>, amount: bigint, side: "in" | "out") {
  const zeroFees = {
    ...l.s,
    protocolFeesToken0: 0n,
    protocolFeesToken1: 0n,
    fundFeesToken0: 0n,
    fundFeesToken1: 0n,
    creatorFeesToken0: 0n,
    creatorFeesToken1: 0n,
  };
  const [vault0Amount, vault1Amount] =
    l.direction === "zeroForOne" ? [l.ev.inputVaultBefore, l.ev.outputVaultBefore] : [l.ev.outputVaultBefore, l.ev.inputVaultBefore];
  const args = {
    pool: zeroFees,
    vault0Amount,
    vault1Amount,
    inputMint: l.ev.inputMint,
    rates: l.rates,
    transferFees: { input: transferCfg(l.ev.inputMint), output: transferCfg(l.ev.outputMint), epoch: l.tx.epoch },
  };
  return side === "in" ? quoteCpmmSwapBaseInput({ ...args, amountIn: amount }) : quoteCpmmSwapBaseOutput({ ...args, amountOut: amount });
}

function expectBaseInputReplay(label: TxLabel, poolAddr: string) {
  const l = load(label, poolAddr);
  const amountIn = u64Arg(l.ix.data, 0);
  const minOut = u64Arg(l.ix.data, 1);
  const q = quoteFromEvent(l, amountIn, "in");
  expect(q.inputTransferFee).toBe(l.ev.inputTransferFee);
  expect(amountIn - q.inputTransferFee).toBe(l.ev.inputAmount);
  expect([q.inputVaultBefore, q.outputVaultBefore]).toEqual([l.ev.inputVaultBefore, l.ev.outputVaultBefore]);
  expect(q.outputAmount).toBe(l.ev.outputAmount);
  expect(q.outputTransferFee).toBe(l.ev.outputTransferFee);
  expect([q.tradeFee, q.creatorFee]).toEqual([l.ev.tradeFee, l.ev.creatorFee]);
  expect(q.isCreatorFeeOnInput).toBe(l.ev.creatorFeeOnInput);
  expect(q.amountReceived).toBeGreaterThanOrEqual(minOut);
  // The raw curve function agrees with the full quote path.
  const raw = cpmmSwapBaseInput(l.ev.inputAmount, l.ev.inputVaultBefore, l.ev.outputVaultBefore, l.rates, l.ev.creatorFeeOnInput);
  expect(raw.outputAmount).toBe(l.ev.outputAmount);
  return { l, q, amountIn };
}

describe("mainnet replays (exact to the unit)", () => {
  test("graduated BONK.fun coin, sell (creator fee on the wSOL output) - tx jQywLECj…", () => {
    const { q } = expectBaseInputReplay("cpmmBonkSell", POOLS.bonk);
    expect([q.outputAmount, q.tradeFee, q.creatorFee]).toEqual([647_070n, 138_302_704n, 4_890n]);
  });

  test("graduated BONK.fun coin, buy (creator fee on the wSOL input) - tx 5z9gG5fV…", () => {
    const { q } = expectBaseInputReplay("cpmmBonkBuy", POOLS.bonk);
    expect([q.tradeFee, q.creatorFee]).toEqual([1_298_700n, 1_948_050n]);
  });

  test("graduated StonkFun coin (3% Token-2022 fee), sell: fee withheld before the curve - tx 3aMQjR9u…", () => {
    const { q, amountIn } = expectBaseInputReplay("cpmmStonkSell", POOLS.stonk);
    expect(amountIn).toBe(4_687_109_153_600n);
    expect(q.inputTransferFee).toBe(140_613_274_608n);
  });

  test("graduated StonkFun coin, buy: 3% withheld from the output - tx 3S2SA2VL…", () => {
    const { l, q } = expectBaseInputReplay("cpmmStonkBuy", POOLS.stonk);
    expect(q.outputTransferFee).toBe(transferFeeFor(transferCfg(l.ev.outputMint), l.tx.epoch, l.ev.outputAmount));
    expect(tokenDelta(l.tx, l.ix.accounts[5] as string)).toBe(q.amountReceived);
  });

  test("creator fee on input uses the program's combined ceil, not the SDK's two ceils - tx j6GMrmzN…", () => {
    const { l, q } = expectBaseInputReplay("cpmmStonkBuySplit", POOLS.stonk);
    expect([q.tradeFee, q.creatorFee]).toEqual([558_537n, 2_234_146n]);
    // SDK 0.2.73-alpha CurveCalculator.swapBaseInput: ceil(in*trade) + ceil(in*creator) = one unit more creator fee.
    const ceil = (a: bigint, r: bigint) => (a * r + 999_999n) / 1_000_000n;
    expect(ceil(l.ev.inputAmount, l.rates.creatorFeeRate)).toBe(2_234_147n);
  });

  test("swap_base_output (creator fee disabled) - tx 2Zc8orCa…", () => {
    const l = load("cpmmBaseOutput", POOLS.baseOut);
    const maxIn = u64Arg(l.ix.data, 0);
    const amountOut = u64Arg(l.ix.data, 1);
    const q = quoteFromEvent(l, amountOut, "out");
    expect(q.outputAmount).toBe(l.ev.outputAmount);
    expect(q.inputAmount).toBe(l.ev.inputAmount);
    expect([q.tradeFee, q.creatorFee]).toEqual([l.ev.tradeFee, l.ev.creatorFee]);
    expect(q.amountIn).toBeLessThanOrEqual(maxIn);
    const raw = cpmmSwapBaseOutput(amountOut, l.ev.inputVaultBefore, l.ev.outputVaultBefore, l.rates, l.ev.creatorFeeOnInput);
    expect(raw.inputAmount).toBe(l.ev.inputAmount);
  });
});

describe("account lists of real mainnet swaps", () => {
  const cases: [TxLabel, string][] = [
    ["cpmmBonkSell", POOLS.bonk],
    ["cpmmBonkBuy", POOLS.bonk],
    ["cpmmStonkSell", POOLS.stonk],
    ["cpmmStonkBuy", POOLS.stonk],
    ["cpmmBaseOutput", POOLS.baseOut],
  ];
  test.each(cases)("%s: our 13 accounts equal the on-chain instruction's", async (label, poolAddr) => {
    const l = load(label, poolAddr);
    const a = await resolveCpmmSwapAccounts({
      poolAddress: address(poolAddr),
      pool: l.s,
      user: l.ix.accounts[0] as Address,
      inputMint: l.ev.inputMint,
      userInputToken: l.ix.accounts[4] as Address,
      userOutputToken: l.ix.accounts[5] as Address,
    });
    expect(cpmmSwapAccountMetas(a).map((m) => m.address)).toEqual(l.ix.accounts);
  });
});

describe("quote properties", () => {
  const s = pool(POOLS.stonk);
  const v0 = decodeTokenAccount(rfixture(s.token0Vault).data).amount;
  const v1 = decodeTokenAccount(rfixture(s.token1Vault).data).amount;
  const rates = cpmmFeeRates(config(POOLS.stonk), s);
  const fees = { input: null, output: transferCfg(s.token1Mint), epoch: 1048n };

  test("base output inverts base input (buy with the output transfer fee)", () => {
    for (const want of [1_000_000n, 2_000_000_000_000n]) {
      const out = quoteCpmmSwapBaseOutput({
        pool: s,
        vault0Amount: v0,
        vault1Amount: v1,
        inputMint: WSOL_MINT,
        rates,
        transferFees: fees,
        amountOut: want,
      });
      expect(out.amountReceived).toBe(want);
      const back = quoteCpmmSwapBaseInput({
        pool: s,
        vault0Amount: v0,
        vault1Amount: v1,
        inputMint: WSOL_MINT,
        rates,
        transferFees: fees,
        amountIn: out.amountIn,
      });
      expect(back.amountReceived).toBeGreaterThanOrEqual(want);
    }
  });

  test("creator fee side follows creator_fee_on and the direction", () => {
    expect(cpmmIsCreatorFeeOnInput(CPMM_CREATOR_FEE_ON.bothToken, "oneForZero")).toBe(true);
    expect(cpmmIsCreatorFeeOnInput(CPMM_CREATOR_FEE_ON.onlyToken0, "zeroForOne")).toBe(true);
    expect(cpmmIsCreatorFeeOnInput(CPMM_CREATOR_FEE_ON.onlyToken0, "oneForZero")).toBe(false);
    expect(cpmmIsCreatorFeeOnInput(CPMM_CREATOR_FEE_ON.onlyToken1, "oneForZero")).toBe(true);
    expect(() => cpmmIsCreatorFeeOnInput(3, "zeroForOne")).toThrow("InvalidFeeModel");
  });

  test("swaps disabled, before open_time, or with a foreign mint are refused", () => {
    const base = { pool: s, vault0Amount: v0, vault1Amount: v1, inputMint: WSOL_MINT, rates, amountIn: 1_000_000n };
    expect(() => quoteCpmmSwapBaseInput({ ...base, pool: { ...s, status: 4 } })).toThrow("NotApproved");
    expect(() => quoteCpmmSwapBaseInput({ ...base, unixTimestamp: s.openTime - 1n })).toThrow("opens at");
    expect(() => quoteCpmmSwapBaseInput({ ...base, inputMint: address("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu") })).toThrow(
      "not in this",
    );
  });
});
