/**
 * Raydium LaunchLab: constants vs the official IDL, PDAs, decoders, and exact replays of real
 * mainnet trades (BONK.fun, StonkFun with a 3% Token-2022 transfer fee, TRiX with a creator fee,
 * StonkFun quoted in a Token-2022 xStock). Fixtures: test/fixtures/raydium-mainnet.json.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, address } from "@solana/kit";
import {
  applyLaunchLabBuy,
  applyLaunchLabSell,
  CPMM_POOL_STATUS_BIT,
  decodeEventsFromLogs,
  decodeLaunchLabEventPayload,
  decodeLaunchLabGlobalConfig,
  decodeLaunchLabPlatformConfig,
  decodeLaunchLabPool,
  decodeMint,
  EVENT_DISCRIMINATORS,
  LAUNCHLAB_POOL_STATUS,
  LaunchLabCurveCompleteError,
  type LaunchLabCurveState,
  type LaunchLabPoolCreateEvent,
  type LaunchLabTradeEvent,
  type LaunchLabTradeParams,
  launchLabAuthorityPda,
  launchLabBaseTokenProgram,
  launchLabCreatorFeeVaultAuthPda,
  launchLabCreatorFeeVaultPda,
  launchLabEventAuthorityPda,
  launchLabGlobalConfigPda,
  launchLabMarketCap,
  launchLabPlatformFeeVaultAuthPda,
  launchLabPlatformFeeVaultPda,
  launchLabPoolPda,
  launchLabProgressBps,
  launchLabQuoteTokenProgram,
  launchLabSwapAccountMetas,
  launchLabTradeParams,
  launchLabVaultPda,
  quoteLaunchLabBuyExactIn,
  quoteLaunchLabBuyExactOut,
  quoteLaunchLabSellExactIn,
  quoteLaunchLabSellExactOut,
  RAYDIUM_ACCOUNT_DISCRIMINATORS,
  RAYDIUM_CPMM_ERRORS,
  RAYDIUM_CPMM_IX,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_EVENT_DISCRIMINATORS,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_ERRORS,
  RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PLATFORMS,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG,
  resolveLaunchLabSwapAccounts,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  transferFeeFor,
  WSOL_MINT,
} from "../src";
import { eventCpiPayloads, rfixture, rtx, type TxLabel, tokenDelta, u64Arg } from "./raydium-fixtures";

const POOLS = {
  bonk: "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo",
  stonkFee: "2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2",
  trix: "G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY",
  stonkXstock: "EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS",
  graduated: "yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S",
} as const;

const idl = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "../idl", f), "utf8"));
const bytesOf = (a: Uint8Array) => Array.from(a);

describe("constants match the official Raydium IDLs (raydium-io/raydium-idl e7e0c96)", () => {
  const ll = idl("raydium_launchpad.json");
  const cp = idl("raydium_cp_swap.json");
  const disc = (doc: { instructions: { name: string; discriminator: number[] }[] }, name: string) =>
    doc.instructions.find((i) => i.name === name)?.discriminator;

  test("program addresses", () => {
    expect(ll.address).toBe(RAYDIUM_LAUNCHLAB_PROGRAM_ID);
    expect(cp.address).toBe(RAYDIUM_CPMM_PROGRAM_ID);
  });

  test("instruction discriminators", () => {
    const names: [keyof typeof RAYDIUM_LAUNCHLAB_IX, string][] = [
      ["buyExactIn", "buy_exact_in"],
      ["buyExactOut", "buy_exact_out"],
      ["sellExactIn", "sell_exact_in"],
      ["sellExactOut", "sell_exact_out"],
      ["migrateToCpswap", "migrate_to_cpswap"],
      ["migrateToAmm", "migrate_to_amm"],
      ["initialize", "initialize"],
      ["initializeV2", "initialize_v2"],
      ["initializeWithToken2022", "initialize_with_token_2022"],
    ];
    for (const [k, n] of names) expect(bytesOf(RAYDIUM_LAUNCHLAB_IX[k])).toEqual(disc(ll, n) as number[]);
    expect(bytesOf(RAYDIUM_CPMM_IX.swapBaseInput)).toEqual(disc(cp, "swap_base_input") as number[]);
    expect(bytesOf(RAYDIUM_CPMM_IX.swapBaseOutput)).toEqual(disc(cp, "swap_base_output") as number[]);
  });

  test("account and event discriminators (incl. the documented collisions)", () => {
    const acc = (doc: { accounts: { name: string; discriminator: number[] }[] }, n: string) =>
      doc.accounts.find((a) => a.name === n)?.discriminator;
    const ev = (doc: { events: { name: string; discriminator: number[] }[] }, n: string) =>
      doc.events.find((e) => e.name === n)?.discriminator;
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPoolState)).toEqual(acc(ll, "PoolState") as number[]);
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabGlobalConfig)).toEqual(acc(ll, "GlobalConfig") as number[]);
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPlatformConfig)).toEqual(acc(ll, "PlatformConfig") as number[]);
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmPoolState)).toEqual(acc(cp, "PoolState") as number[]);
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmAmmConfig)).toEqual(acc(cp, "AmmConfig") as number[]);
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmObservationState)).toEqual(acc(cp, "ObservationState") as number[]);
    expect(bytesOf(RAYDIUM_EVENT_DISCRIMINATORS.launchLabTrade)).toEqual(ev(ll, "TradeEvent") as number[]);
    expect(bytesOf(RAYDIUM_EVENT_DISCRIMINATORS.launchLabPoolCreate)).toEqual(ev(ll, "PoolCreateEvent") as number[]);
    expect(bytesOf(RAYDIUM_EVENT_DISCRIMINATORS.cpmmSwap)).toEqual(ev(cp, "SwapEvent") as number[]);
    expect(bytesOf(RAYDIUM_EVENT_DISCRIMINATORS.cpmmLpChange)).toEqual(ev(cp, "LpChangeEvent") as number[]);
    // Collisions: same type name -> same Anchor discriminator.
    expect(bytesOf(RAYDIUM_EVENT_DISCRIMINATORS.launchLabTrade)).toEqual(bytesOf(EVENT_DISCRIMINATORS.pumpTrade));
    expect(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.launchLabPoolState)).toEqual(bytesOf(RAYDIUM_ACCOUNT_DISCRIMINATORS.cpmmPoolState));
  });

  test("error names", () => {
    const names = (doc: { errors: { code: number; name: string }[] }) => new Map(doc.errors.map((e) => [e.code, e.name]));
    const llErr = names(ll);
    for (const [code, label] of Object.entries(RAYDIUM_LAUNCHLAB_ERRORS))
      expect(label.startsWith(llErr.get(Number(code)) as string)).toBe(true);
    const cpErr = names(cp);
    for (const [code, label] of Object.entries(RAYDIUM_CPMM_ERRORS)) expect(label.startsWith(cpErr.get(Number(code)) as string)).toBe(true);
    expect(CPMM_POOL_STATUS_BIT.swap).toBe(4);
  });
});

describe("LaunchLab PDAs and decoders on live accounts", () => {
  test("static PDAs derive to the SDK / observed addresses", async () => {
    expect(await launchLabAuthorityPda()).toBe(RAYDIUM_LAUNCHLAB_AUTHORITY);
    expect(await launchLabEventAuthorityPda()).toBe(RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY);
    expect(await launchLabGlobalConfigPda(WSOL_MINT, 0, 0)).toBe(RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG);
    // Owners of the fee-vault token accounts (observed via getAccountInfo jsonParsed, 2026-10-03).
    expect(await launchLabPlatformFeeVaultAuthPda()).toBe(address("56XVRVAsgWv6ADaxzoNnbL38LMoWKM5WiSAhrAWUbd2p"));
    expect(await launchLabCreatorFeeVaultAuthPda()).toBe(address("9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan"));
  });

  test("pool / vault PDAs match the live pools", async () => {
    for (const p of Object.values(POOLS)) {
      const pool = decodeLaunchLabPool(rfixture(p).data);
      expect(await launchLabPoolPda(pool.baseMint, pool.quoteMint)).toBe(address(p));
      expect(await launchLabVaultPda(address(p), pool.baseMint)).toBe(pool.baseVault);
      expect(await launchLabVaultPda(address(p), pool.quoteMint)).toBe(pool.quoteVault);
    }
  });

  test("decoded pools, configs and token-program flags", () => {
    const bonk = decodeLaunchLabPool(rfixture(POOLS.bonk).data);
    expect(bonk.dataLength).toBe(429);
    expect(bonk.status).toBe(LAUNCHLAB_POOL_STATUS.fund);
    expect(bonk.totalBaseSell).toBe(793_100_000_000_000n);
    expect(bonk.supply).toBe(1_000_000_000_000_000n);
    expect(bonk.quoteMint).toBe(WSOL_MINT);
    expect(bonk.globalConfig).toBe(RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG);
    expect(RAYDIUM_LAUNCHLAB_PLATFORMS[bonk.platformConfig]).toBe("letsbonk.fun");
    expect([launchLabBaseTokenProgram(bonk), launchLabQuoteTokenProgram(bonk)]).toEqual([TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID]);

    const stonk = decodeLaunchLabPool(rfixture(POOLS.stonkFee).data);
    expect(launchLabBaseTokenProgram(stonk)).toBe(TOKEN_2022_PROGRAM_ID);
    expect(launchLabQuoteTokenProgram(stonk)).toBe(TOKEN_PROGRAM_ID);
    const xstock = decodeLaunchLabPool(rfixture(POOLS.stonkXstock).data);
    expect([launchLabBaseTokenProgram(xstock), launchLabQuoteTokenProgram(xstock)]).toEqual([TOKEN_2022_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
    expect(xstock.quoteDecimals).toBe(8);
    expect(decodeLaunchLabPool(rfixture(POOLS.graduated).data).status).toBe(LAUNCHLAB_POOL_STATUS.trade);

    const global = decodeLaunchLabGlobalConfig(rfixture(RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG).data);
    expect(global).toMatchObject({ curveType: 0, index: 0, tradeFeeRate: 2500n, quoteMint: WSOL_MINT, maxShareFeeRate: 10_000n });
    expect(global.migrateToCpswapWallet).toBe(address("RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw"));

    const platform = (a: string) => decodeLaunchLabPlatformConfig(rfixture(a).data);
    expect(platform("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1")).toMatchObject({
      name: "letsbonk.fun",
      feeRate: 12_500n,
      creatorFeeRate: 0n,
    });
    expect(platform("6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt")).toMatchObject({
      name: "StonkFun",
      feeRate: 10_000n,
      creatorFeeRate: 0n,
    });
    expect(platform("FbqEaSHPF3kekscjqzEU5xdDAnWp5vf9w2d2oT5Bxng9")).toMatchObject({
      name: "TRiX",
      feeRate: 10_000n,
      creatorFeeRate: 5_000n,
    });
    expect(platform("4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4")).toMatchObject({
      name: "Raydium",
      feeRate: 7_500n,
      creatorFeeRate: 500n,
    });
    // The label map agrees with the on-chain names of every platform config in the snapshot.
    for (const addr of [
      "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1",
      "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt",
      "FbqEaSHPF3kekscjqzEU5xdDAnWp5vf9w2d2oT5Bxng9",
      "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4",
    ]) {
      expect(platform(addr).name).toBe(RAYDIUM_LAUNCHLAB_PLATFORMS[addr] as string);
    }
  });

  test("Token-2022 base mint of StonkFun coins carries a 300 bps transfer fee", () => {
    const pool = decodeLaunchLabPool(rfixture(POOLS.stonkFee).data);
    const acc = rfixture(pool.baseMint);
    const mint = decodeMint(acc.data, acc.owner);
    expect(mint.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    const cfg = mint.extensions.transferFeeConfig;
    expect(cfg?.newerTransferFee.transferFeeBasisPoints).toBe(300n);
    expect(cfg?.transferFeeConfigAuthority).toBe(RAYDIUM_LAUNCHLAB_AUTHORITY);
    expect(mint.extensions.transferHookProgramId).toBeNull();
    // The METAx quote: permanent delegate + scaled UI amount + an unset hook, no transfer fee.
    const metax = decodeMint(rfixture("Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu").data, TOKEN_2022_PROGRAM_ID);
    expect(metax.extensions.transferFeeConfig).toBeNull();
    expect(metax.extensions.transferHookProgramId).toBeNull();
    expect(metax.extensions.permanentDelegate).not.toBeNull();
    expect(metax.extensions.paused).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Mainnet replays
// ---------------------------------------------------------------------------------------------

interface Replay {
  ev: LaunchLabTradeEvent;
  pre: LaunchLabCurveState;
  params: LaunchLabTradeParams;
  amount: bigint;
  limit: bigint;
  accounts: Address[];
  tx: ReturnType<typeof rtx>;
}

function loadReplay(label: TxLabel, poolAddr: string): Replay {
  const tx = rtx(label);
  const pool = decodeLaunchLabPool(rfixture(poolAddr).data);
  const global = decodeLaunchLabGlobalConfig(rfixture(pool.globalConfig).data);
  const platform = decodeLaunchLabPlatformConfig(rfixture(pool.platformConfig).data);
  // The snapshot's fee rates applied at trade time only if neither config changed since.
  expect(global.epoch).toBeLessThanOrEqual(tx.epoch);
  expect(platform.epoch).toBeLessThanOrEqual(tx.epoch);
  const swap = tx.instructions.find(
    (i) =>
      i.programId === RAYDIUM_LAUNCHLAB_PROGRAM_ID &&
      [RAYDIUM_LAUNCHLAB_IX.buyExactIn, RAYDIUM_LAUNCHLAB_IX.sellExactIn].some((d) => d.every((b, k) => i.data[k] === b)),
  );
  if (!swap) throw new Error(`${label}: no LaunchLab swap`);
  const payloads = eventCpiPayloads(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID);
  expect(payloads.length).toBe(1);
  const ev = decodeLaunchLabEventPayload(payloads[0] as Uint8Array) as LaunchLabTradeEvent;
  expect(ev.kind).toBe("launchlabTrade");
  expect(ev.pool).toBe(address(poolAddr));
  const pre: LaunchLabCurveState = {
    status: LAUNCHLAB_POOL_STATUS.fund,
    virtualBase: ev.virtualBase,
    virtualQuote: ev.virtualQuote,
    realBase: ev.realBaseBefore,
    realQuote: ev.realQuoteBefore,
    totalBaseSell: ev.totalBaseSell,
    totalQuoteFundRaising: pool.totalQuoteFundRaising,
  };
  return {
    ev,
    pre,
    params: launchLabTradeParams({ globalConfig: global, platformConfig: platform, shareFeeRate: u64Arg(swap.data, 2) }),
    amount: u64Arg(swap.data, 0),
    limit: u64Arg(swap.data, 1),
    accounts: swap.accounts,
    tx,
  };
}

function transferFees(poolAddr: string, epoch: bigint) {
  const pool = decodeLaunchLabPool(rfixture(poolAddr).data);
  const mint = (a: string) => decodeMint(rfixture(a).data, rfixture(a).owner).extensions.transferFeeConfig;
  return { base: mint(pool.baseMint), quote: mint(pool.quoteMint), epoch };
}

function expectBuyReplay(r: Replay, poolAddr: string) {
  const q = quoteLaunchLabBuyExactIn(r.pre, r.amount, r.params, transferFees(poolAddr, r.tx.epoch));
  expect(r.ev.isBuy).toBe(true);
  expect(q.capped).toBe(false);
  expect(q.quoteIn).toBe(r.amount);
  expect(q.quoteToVault).toBe(r.ev.amountIn);
  expect(q.baseOut).toBe(r.ev.amountOut);
  expect([q.protocolFee, q.platformFee, q.creatorFee, q.shareFee]).toEqual([
    r.ev.protocolFee,
    r.ev.platformFee,
    r.ev.creatorFee,
    r.ev.shareFee,
  ]);
  const post = applyLaunchLabBuy(r.pre, q);
  expect([post.realBase, post.realQuote]).toEqual([r.ev.realBaseAfter, r.ev.realQuoteAfter]);
  expect(q.baseReceived).toBeGreaterThanOrEqual(r.limit);
  return { q, post };
}

function expectSellReplay(r: Replay, poolAddr: string) {
  const q = quoteLaunchLabSellExactIn(r.pre, r.amount, r.params, transferFees(poolAddr, r.tx.epoch));
  expect(r.ev.isBuy).toBe(false);
  expect(q.baseToVault).toBe(r.ev.amountIn);
  expect(q.quoteFromVault).toBe(r.ev.amountOut);
  expect([q.protocolFee, q.platformFee, q.creatorFee, q.shareFee]).toEqual([
    r.ev.protocolFee,
    r.ev.platformFee,
    r.ev.creatorFee,
    r.ev.shareFee,
  ]);
  const post = applyLaunchLabSell(r.pre, q);
  expect([post.realBase, post.realQuote]).toEqual([r.ev.realBaseAfter, r.ev.realQuoteAfter]);
  expect(q.quoteReceived).toBeGreaterThanOrEqual(r.limit);
  return { q, post };
}

describe("mainnet replays (exact to the unit)", () => {
  test("BONK.fun buy_exact_in 0.01188 SOL - tx 2KW4kPuc… (1.5% = 0.25% protocol + 1.25% letsbonk)", () => {
    const r = loadReplay("bonkBuy", POOLS.bonk);
    const { q } = expectBuyReplay(r, POOLS.bonk);
    expect(q.baseOut).toBe(115_115_036_965n);
    expect([q.protocolFee, q.platformFee, q.totalFee]).toEqual([29_700n, 148_500n, 178_200n]);
  });

  test("BONK.fun sell_exact_in - tx 2TE9q2CM…", () => {
    const r = loadReplay("bonkSell", POOLS.bonk);
    const { q } = expectSellReplay(r, POOLS.bonk);
    expect(q.quoteFromVault).toBe(40_731_463n);
  });

  test("BONK.fun consecutive buy then sell - VMYEAFYT… -> 4NBcNbhf… (post-state chains)", () => {
    const b = loadReplay("bonkChainBuy", POOLS.bonk);
    const { post } = expectBuyReplay(b, POOLS.bonk);
    const s = loadReplay("bonkChainSell", POOLS.bonk);
    expect([s.pre.realBase, s.pre.realQuote]).toEqual([post.realBase, post.realQuote]);
    expectSellReplay(s, POOLS.bonk);
  });

  test("StonkFun Token-2022 coin with a 3% transfer fee: sell 2n9RK58Y… then buy 4DPvxS1r…", () => {
    const s = loadReplay("stonkFeeSell", POOLS.stonkFee);
    const { q: sq, post } = expectSellReplay(s, POOLS.stonkFee);
    // amount_in in the event is AFTER the transfer fee: 3,685,556,792,291 sent, 3% withheld.
    expect(s.amount).toBe(3_685_556_792_291n);
    expect(sq.baseTransferFee).toBe(110_566_703_769n);
    expect(s.amount - s.ev.amountIn).toBe(sq.baseTransferFee);

    const b = loadReplay("stonkFeeBuy", POOLS.stonkFee);
    expect([b.pre.realBase, b.pre.realQuote]).toEqual([post.realBase, post.realQuote]);
    const { q: bq } = expectBuyReplay(b, POOLS.stonkFee);
    // The buyer receives amount_out minus the 3% withheld on the vault -> user transfer.
    expect(bq.baseTransferFee).toBe(transferFeeFor(transferFees(POOLS.stonkFee, b.tx.epoch).base, b.tx.epoch, bq.baseOut));
    expect(tokenDelta(b.tx, b.accounts[5] as string)).toBe(bq.baseReceived);
  });

  test("TRiX (0.5% creator fee on top of 1% platform + 0.25% protocol): buy 5bTCwETv… -> sell 4pgQxoxi…, sell 5PoTEGRJ…", () => {
    const b = loadReplay("trixBuy", POOLS.trix);
    const { q: bq, post } = expectBuyReplay(b, POOLS.trix);
    expect([bq.protocolFee, bq.platformFee, bq.creatorFee]).toEqual([300_000n, 1_200_000n, 600_000n]);
    const s = loadReplay("trixSell", POOLS.trix);
    expect([s.pre.realBase, s.pre.realQuote]).toEqual([post.realBase, post.realQuote]);
    expectSellReplay(s, POOLS.trix);
    const { q } = expectSellReplay(loadReplay("trixSell2", POOLS.trix), POOLS.trix);
    expect([q.protocolFee, q.platformFee, q.creatorFee]).toEqual([2_468_448n, 9_873_792n, 4_936_896n]);
  });

  test("StonkFun pair quoted in METAx (Token-2022 quote, 8 decimals) - tx 56DN7E9g…", () => {
    expectSellReplay(loadReplay("stonkXstockSell", POOLS.stonkXstock), POOLS.stonkXstock);
  });

  test("the logged TradeEvent equals the event-CPI one (program-attributed log decoding)", () => {
    for (const label of ["bonkBuy", "stonkFeeSell", "trixSell2", "stonkXstockSell"] as const) {
      const tx = rtx(label);
      const fromCpi = decodeLaunchLabEventPayload(eventCpiPayloads(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID)[0] as Uint8Array);
      const fromLogs = decodeEventsFromLogs(tx.logs).filter((e) => e.kind === "launchlabTrade");
      expect(fromLogs).toEqual([fromCpi as LaunchLabTradeEvent]);
      expect(decodeEventsFromLogs(tx.logs).some((e) => e.kind === "pumpTrade")).toBe(false);
    }
  });

  test("PoolCreateEvent of a real initialize_with_token_2022 (+ dev buy) - tx 5eKxf9VN…", async () => {
    const tx = rtx("create");
    const init = tx.instructions.find((i) => i.programId === RAYDIUM_LAUNCHLAB_PROGRAM_ID && i.where.startsWith("top"));
    expect(init && bytesOf(init.data.subarray(0, 8))).toEqual(bytesOf(RAYDIUM_LAUNCHLAB_IX.initializeWithToken2022));
    const events = decodeEventsFromLogs(tx.logs);
    expect(events.map((e) => e.kind)).toEqual(["launchlabPoolCreate", "launchlabTrade"]);
    const [create, trade] = events as [LaunchLabPoolCreateEvent, LaunchLabTradeEvent];
    // The event-CPI copies decode to the same events.
    const cpi = eventCpiPayloads(tx, RAYDIUM_LAUNCHLAB_PROGRAM_ID).map((p) => decodeLaunchLabEventPayload(p));
    expect(cpi).toEqual([create, trade]);
    const accounts = init?.accounts as Address[];
    expect([create.creator, create.config, create.pool]).toEqual([accounts[1], accounts[2], accounts[5]] as Address[]);
    expect(await launchLabPoolPda(accounts[6] as Address, accounts[7] as Address)).toBe(create.pool);
    expect(create).toMatchObject({
      name: "Catetober",
      symbol: "CATETOBER",
      decimals: 6,
      curveType: 0,
      supply: 1_000_000_000_000_000n,
      totalBaseSell: 793_100_000_000_000n,
      migrateType: 1,
    });
    expect(create.uri.startsWith("https://")).toBe(true);
    expect(trade.pool).toBe(create.pool);
    expect([trade.realBaseBefore, trade.realQuoteBefore]).toEqual([0n, 0n]);
  });
});

describe("account lists of real mainnet swaps", () => {
  const cases: [TxLabel, string][] = [
    ["bonkBuy", POOLS.bonk],
    ["bonkSell", POOLS.bonk],
    ["stonkFeeSell", POOLS.stonkFee],
    ["stonkFeeBuy", POOLS.stonkFee],
    ["trixBuy", POOLS.trix],
    ["stonkXstockSell", POOLS.stonkXstock],
  ];
  test.each(cases)("%s: our 18 accounts equal the on-chain instruction's", async (label, poolAddr) => {
    const r = loadReplay(label, poolAddr);
    const pool = decodeLaunchLabPool(rfixture(poolAddr).data);
    const a = await resolveLaunchLabSwapAccounts({
      poolAddress: address(poolAddr),
      pool,
      user: r.accounts[0] as Address,
      userBaseToken: r.accounts[5] as Address,
      userQuoteToken: r.accounts[6] as Address,
    });
    expect(launchLabSwapAccountMetas(a).map((m) => m.address)).toEqual(r.accounts);
    expect(a.platformFeeVault).toBe(await launchLabPlatformFeeVaultPda(pool.platformConfig, pool.quoteMint));
    expect(a.creatorFeeVault).toBe(await launchLabCreatorFeeVaultPda(pool.creator, pool.quoteMint));
  });
});

describe("quote properties", () => {
  const bonk = loadReplay("bonkBuy", POOLS.bonk);

  test("exact-out quotes invert exact-in", () => {
    for (const want of [1_000_000n, 123_456_789_012n, 5_000_000_000_000n]) {
      const out = quoteLaunchLabBuyExactOut(bonk.pre, want, bonk.params);
      expect(out.baseOut).toBe(want);
      expect(quoteLaunchLabBuyExactIn(bonk.pre, out.quoteIn, bonk.params).baseOut).toBeGreaterThanOrEqual(want);
      expect(quoteLaunchLabBuyExactIn(bonk.pre, out.quoteIn - 2n, bonk.params).baseOut).toBeLessThan(want);
    }
    const sellPre = applyLaunchLabBuy(bonk.pre, quoteLaunchLabBuyExactIn(bonk.pre, 5_000_000_000n, bonk.params));
    for (const want of [1_000_000n, 100_000_000n]) {
      const s = quoteLaunchLabSellExactOut(sellPre, want, bonk.params);
      expect(s.quoteReceived).toBe(want);
      expect(quoteLaunchLabSellExactIn(sellPre, s.baseIn, bonk.params).quoteReceived).toBeGreaterThanOrEqual(want);
    }
  });

  test("a buy past the end of the curve is capped at the remaining base (SDK semantics)", () => {
    const nearEnd = { ...bonk.pre, realBase: bonk.pre.totalBaseSell - 1_000_000_000n };
    const q = quoteLaunchLabBuyExactIn(nearEnd, 100_000_000_000n, bonk.params);
    expect(q.capped).toBe(true);
    expect(q.baseOut).toBe(1_000_000_000n);
    expect(q.quoteIn).toBeLessThan(100_000_000_000n);
    expect(applyLaunchLabBuy(nearEnd, q).status).toBe(LAUNCHLAB_POOL_STATUS.migrate);
  });

  test("completed / migrated pools and unsupported curve types are refused", () => {
    expect(() => quoteLaunchLabBuyExactIn({ ...bonk.pre, status: 1 }, 1_000n, bonk.params)).toThrow(LaunchLabCurveCompleteError);
    expect(() => quoteLaunchLabSellExactIn({ ...bonk.pre, status: 2 }, 1_000n, bonk.params)).toThrow("CPMM");
    expect(() => quoteLaunchLabBuyExactIn(bonk.pre, 1_000_000n, { ...bonk.params, curveType: 1 })).toThrow("not supported");
    expect(() =>
      launchLabTradeParams({
        globalConfig: { curveType: 0, tradeFeeRate: 2_500n, maxShareFeeRate: 10_000n },
        platformConfig: { feeRate: 0n, creatorFeeRate: 0n },
        shareFeeRate: 10_001n,
      }),
    ).toThrow("max_share_fee_rate");
  });

  test("progress and market cap", () => {
    const pool = decodeLaunchLabPool(rfixture(POOLS.bonk).data);
    const base = launchLabProgressBps(pool);
    const quote = launchLabProgressBps(pool, "quote");
    expect(base).toBe(Number((pool.realBase * 10_000n) / pool.totalBaseSell));
    expect(quote).toBe(Number((pool.realQuote * 10_000n) / pool.totalQuoteFundRaising));
    expect(launchLabProgressBps(decodeLaunchLabPool(rfixture(POOLS.graduated).data))).toBe(10_000);
    // A fresh curve at the documented 30 SOL / 1.073B virtual reserves prices ~28 SOL mcap on 1B supply.
    const fresh = { ...pool, realBase: 0n, realQuote: 0n };
    expect(Number(launchLabMarketCap(fresh, pool.supply)) / 1e9).toBeCloseTo(27.96, 1);
  });
});
