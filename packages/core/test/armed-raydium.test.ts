/**
 * Armed orders on Raydium LaunchLab and Raydium CPMM, from the offline mainnet snapshot:
 *  - the firewall's static positions (mirrored from @zerofee/signer) and the operator table's Raydium contents;
 *  - templates, OCO / ladders / dual-venue (curve + graduation pool) orders, and their refusals;
 *  - the LaunchLab -> CPMM graduation pool, verified against the real letsbonk migration, and the snipe;
 *  - trigger quoting, market-cap targets, staleness and market events for both venues;
 *  - every signed variant and cancel passes the signer firewall (checkTransaction + createSignerPolicy)
 *    and the server's signed-bytes verification (assertArmable).
 */
import { describe, expect, test } from "bun:test";
import { type Address, address, getBase64Encoder, getCompiledTransactionMessageDecoder, type KeyPairSigner } from "@solana/kit";
import {
  CPMM_STATIC_POSITIONS,
  checkTransaction,
  createSignerPolicy,
  type FirewallContext,
  LAUNCHLAB_STATIC_POSITIONS,
  RAYDIUM_CPMM_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
  USDC_MINT as SIGNER_USDC_MINT,
} from "@zerofee/signer";
import {
  type ArmedOrder,
  type ArmedOrderSpec,
  ArmingError,
  armedOrderFromJson,
  armedOrderToJson,
  armedRaydiumSharedAccounts,
  armedStaticAccounts,
  armLaunchLabMigrationSnipe,
  armOcoPair,
  armOrder,
  assertArmable,
  assertShareableLookupTableContents,
  CPMM_FIREWALL_STATIC_POSITIONS,
  type CpmmArmedContext,
  compileArmedTransaction,
  cpmmAtMarketCap,
  cpmmBuyTemplate,
  cpmmLpMintPda,
  cpmmSellTemplate,
  cpmmVaultAmountsWithoutFees,
  DEFAULT_CU_LIMITS,
  decodeLaunchLabPlatformConfig,
  detectStaleness,
  estimateLaunchLabGraduationReserves,
  evaluateTrigger,
  FIREWALL_STATIC_VENUE_POSITIONS,
  graduationVaultAmounts,
  inspectArmedTransaction,
  JITO_DONT_FRONT,
  LAUNCHLAB_FIREWALL_STATIC_POSITIONS,
  LAUNCHLAB_POOL_STATUS,
  type LaunchLabTradeEvent,
  launchLabAtMarketCap,
  launchLabBuyTemplate,
  launchLabCreatorFeeVaultPda,
  launchLabGraduationPoolContext,
  launchLabMarketCap,
  launchLabPlatformFeeVaultPda,
  launchLabSellTemplate,
  liveMarketFromState,
  liveQuoteOut,
  marketAtMarketCap,
  marketEventFromDecoded,
  marketEventFromLaunchLabGraduation,
  minOutGrid,
  NEVER_LOOKED_UP,
  quoteCpmmSwapBaseInput,
  quoteLaunchLabBuyExactIn,
  quoteLaunchLabSellExactIn,
  quoteOutAtMarketCap,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_AUTHORITY,
  RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG,
  type TokenState,
  type TradeTemplate,
  verifyArmedOrderTransactions,
  WSOL_MINT,
} from "../src";
import {
  CPMM_POOLS,
  cpmmArmedContext,
  cpmmMarket,
  cpmmPool,
  LL_POOLS,
  launchLabArmedContext,
  launchLabMarket,
  launchLabPool,
  SNAPSHOT_EPOCH,
} from "./armedRaydiumKit";
import { ARMED_TIPS_JITO, armedRaydiumTradeShapes, SIZE_NONCE, SIZE_USER } from "./armedSizeCases";
import { armedWallet, nonceRefs, operatorTables, TIP_LEVELS } from "./armedTestKit";
import { findIx, rfixture, rtx } from "./raydium-fixtures";

const CONNECTED = address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c");
const XSTOCK = launchLabPool(LL_POOLS.stonkXstock).quoteMint;
const bytes = (wireBase64: string) => new Uint8Array(getBase64Encoder().encode(wireBase64));

function platformConfigOf(pool: Address) {
  return decodeLaunchLabPlatformConfig(rfixture(launchLabPool(pool).platformConfig).data);
}

async function graduation(user: Address, pool: Address = LL_POOLS.bonk): Promise<CpmmArmedContext> {
  return launchLabGraduationPoolContext({ pool: launchLabPool(pool), platformConfig: platformConfigOf(pool), user });
}

/** The shipped signer policy (with a cap for the xStock quote mint, which the shipped defaults refuse). */
function firewallContext(wallet: Address, tables: Record<Address, Address[]>, slots: readonly Address[]): FirewallContext {
  const policy = createSignerPolicy({ caps: { maxBuyQuote: { [SIGNER_USDC_MINT]: 100_000_000n, [XSTOCK]: 1_000_000_000_000n } } });
  return {
    signer: wallet,
    connectedWallet: CONNECTED,
    ownedNonceAccounts: slots,
    allowedPrograms: policy.allowedPrograms,
    tipAccounts: policy.tipAccounts,
    caps: policy.caps,
    venueRules: policy.venueRules,
    addressLookupTables: tables,
  };
}

/** Every signed tx (variants and cancels, deduplicated) passes checkTransaction; returns how many. */
async function expectFirewallAllows(orders: readonly ArmedOrder[], ctx: FirewallContext): Promise<number> {
  const seen = new Set<string>();
  for (const o of orders) {
    for (const a of o.attempts) {
      for (const tx of [...a.variants.map((v) => v.tx), a.nonce.cancel]) {
        if (seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        const r = await checkTransaction(bytes(tx.wireBase64), ctx);
        if (!r.ok) throw new Error(`firewall refused ${o.id} attempt ${a.index}:\n  ${r.violations.join("\n  ")}`);
        expect(r.summary.durableNonce).toEqual({ nonceAccount: a.nonce.account, nonceValue: a.nonce.value });
      }
    }
  }
  return seen.size;
}

function spec(
  wallet: Address,
  o: Pick<ArmedOrderSpec, "id" | "kind" | "mint" | "amount" | "trigger" | "templates" | "minOuts" | "nonces" | "armingQuoteOut"> &
    Partial<ArmedOrderSpec>,
  tables: Record<Address, Address[]>,
): ArmedOrderSpec {
  return { wallet, tipLevels: TIP_LEVELS, lookupTables: tables, ...o };
}

// ---------------------------------------------------------------------------------------------
// Static positions and the operator table
// ---------------------------------------------------------------------------------------------

describe("firewall static positions and the operator lookup table", async () => {
  const table = await armedStaticAccounts();

  test("the static positions are exactly @zerofee/signer's LAUNCHLAB_STATIC_POSITIONS / CPMM_STATIC_POSITIONS", () => {
    expect(RAYDIUM_LAUNCHLAB_PROGRAM_ID).toBe(RAYDIUM_LAUNCHLAB_PROGRAM);
    expect(RAYDIUM_CPMM_PROGRAM_ID).toBe(RAYDIUM_CPMM_PROGRAM);
    expect([...LAUNCHLAB_FIREWALL_STATIC_POSITIONS]).toEqual([...LAUNCHLAB_STATIC_POSITIONS]);
    expect([...CPMM_FIREWALL_STATIC_POSITIONS]).toEqual([...CPMM_STATIC_POSITIONS]);
    expect(FIREWALL_STATIC_VENUE_POSITIONS.get(RAYDIUM_LAUNCHLAB_PROGRAM)).toEqual(LAUNCHLAB_STATIC_POSITIONS);
    expect(FIREWALL_STATIC_VENUE_POSITIONS.get(RAYDIUM_CPMM_PROGRAM)).toEqual(CPMM_STATIC_POSITIONS);
  });

  test("the table holds the SOL LaunchLab GlobalConfig and the graduation AmmConfigs, nothing per coin", async () => {
    expect(table).toContain(RAYDIUM_LAUNCHLAB_SOL_GLOBAL_CONFIG);
    for (const c of RAYDIUM_CPMM_GRADUATION_AMM_CONFIGS) expect(table).toContain(c);
    expect(armedRaydiumSharedAccounts(false)).toEqual([]);
    expect(armedRaydiumSharedAccounts({ launchLabGlobalConfigs: [], cpmmAmmConfigs: [CPMM_POOLS.bonk] })).toEqual([CPMM_POOLS.bonk]);
    // Authorities the firewall pins are refused outright.
    for (const a of [RAYDIUM_LAUNCHLAB_AUTHORITY, RAYDIUM_LAUNCHLAB_EVENT_AUTHORITY, RAYDIUM_CPMM_AUTHORITY]) {
      expect(NEVER_LOOKED_UP.has(a)).toBe(true);
      expect(table).not.toContain(a);
      expect(() => assertShareableLookupTableContents([...table, a])).toThrow("static keys");
    }
    expect(() => armedStaticAccounts({ raydium: { cpmmAmmConfigs: [RAYDIUM_CPMM_AUTHORITY] } })).toThrow("static keys");
    // No pool, vault, observation, platform config, fee vault or mint of any snapshot pool.
    for (const p of Object.values(LL_POOLS)) {
      const s = launchLabPool(p);
      for (const a of [
        p,
        s.baseVault,
        s.quoteVault,
        s.platformConfig,
        s.baseMint,
        s.quoteMint,
        await launchLabPlatformFeeVaultPda(s.platformConfig, s.quoteMint),
        await launchLabCreatorFeeVaultPda(s.creator, s.quoteMint),
      ]) {
        expect(table).not.toContain(a);
      }
    }
    for (const p of Object.values(CPMM_POOLS)) {
      const s = cpmmPool(p);
      for (const a of [p, s.token0Vault, s.token1Vault, s.observationKey, s.token0Mint, s.token1Mint, s.lpMint])
        expect(table).not.toContain(a);
      // The graduated pools' AmmConfigs are shared and in the table.
      expect(table).toContain(s.ammConfig);
    }
  });

  test("whatever the table holds, every account the firewall pins stays a static key", async () => {
    const tables = await operatorTables();
    const [t] = Object.keys(tables) as Address[];
    for (const shape of await armedRaydiumTradeShapes()) {
      const everything = [...new Set(shape.instructions.flatMap((ix) => (ix.accounts ?? []).map((a) => a.address)))];
      const poisoned = { [t as Address]: [...(tables[t as Address] as Address[]), ...everything, SIZE_NONCE.account, JITO_DONT_FRONT] };
      const { transaction } = compileArmedTransaction({
        feePayer: SIZE_USER,
        nonce: SIZE_NONCE,
        instructions: shape.instructions,
        fees: ARMED_TIPS_JITO,
        lookupTables: poisoned,
      });
      const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      for (const ix of shape.instructions) {
        const pinned = FIREWALL_STATIC_VENUE_POSITIONS.get(ix.programAddress) ?? [];
        for (const i of pinned) expect(compiled.staticAccounts).toContain(ix.accounts?.[i]?.address as Address);
      }
      expect(compiled.staticAccounts).toContain(SIZE_NONCE.account);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Graduation pool (verified against the real migrate_to_cpswap)
// ---------------------------------------------------------------------------------------------

describe("LaunchLab -> CPMM graduation pool", () => {
  test("derived before graduation = the pool migrate_to_cpswap created (letsbonk coin 7dmcQ9Ty…)", async () => {
    const ctx = await graduation(SIZE_USER, LL_POOLS.graduated);
    const live = cpmmPool(CPMM_POOLS.bonk);
    expect(ctx.poolAddress).toBe(CPMM_POOLS.bonk);
    expect(ctx.baseMint).toBe(launchLabPool(LL_POOLS.graduated).baseMint);
    expect(ctx.pool).toEqual({
      ammConfig: live.ammConfig,
      token0Mint: live.token0Mint,
      token1Mint: live.token1Mint,
      token0Vault: live.token0Vault,
      token1Vault: live.token1Vault,
      token0Program: live.token0Program,
      token1Program: live.token1Program,
      observationKey: live.observationKey,
      poolCreator: live.poolCreator,
    });
    // The real migration (signed by Raydium's migration wallet) touched exactly these accounts.
    const ix = findIx(rtx("migrate"), RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_LAUNCHLAB_IX.migrateToCpswap);
    expect(ix.accounts[5]).toBe(ctx.poolAddress);
    expect(ix.accounts[6]).toBe(RAYDIUM_CPMM_AUTHORITY);
    expect(ix.accounts[7]).toBe(await cpmmLpMintPda(ctx.poolAddress));
    const baseVault = ctx.pool.token0Mint === ctx.baseMint ? ctx.pool.token0Vault : ctx.pool.token1Vault;
    const quoteVault = ctx.pool.token0Mint === ctx.baseMint ? ctx.pool.token1Vault : ctx.pool.token0Vault;
    expect([ix.accounts[8], ix.accounts[9], ix.accounts[10], ix.accounts[12]]).toEqual([
      baseVault,
      quoteVault,
      ctx.pool.ammConfig,
      ctx.pool.observationKey,
    ]);
  });

  test("opening reserves: the estimate equals what the migration put into the CPMM vaults", async () => {
    const ll = launchLabPool(LL_POOLS.graduated);
    const est = estimateLaunchLabGraduationReserves(ll);
    const post = rtx("migrate").postTokenBalances;
    const ctx = await graduation(SIZE_USER, LL_POOLS.graduated);
    const amountOf = (a: Address) => BigInt(post.find((b) => b.account === a)?.amount ?? "-1");
    const baseVault = ctx.pool.token0Mint === ctx.baseMint ? ctx.pool.token0Vault : ctx.pool.token1Vault;
    const quoteVault = ctx.pool.token0Mint === ctx.baseMint ? ctx.pool.token1Vault : ctx.pool.token0Vault;
    expect(est).toEqual({ base: amountOf(baseVault), quote: amountOf(quoteVault) });
    expect(graduationVaultAmounts(ctx, est)).toEqual(
      ctx.pool.token0Mint === WSOL_MINT
        ? { vault0Amount: est.quote, vault1Amount: est.base }
        : { vault0Amount: est.base, vault1Amount: est.quote },
    );
    // A funding curve's estimate uses the graduation target until the curve completes.
    const bonk = launchLabPool(LL_POOLS.bonk);
    expect(estimateLaunchLabGraduationReserves(bonk).quote).toBe(bonk.totalQuoteFundRaising - bonk.migrateFee);
  });

  test("coins that graduate to AMM v4 are refused", async () => {
    const pool = { ...launchLabPool(LL_POOLS.bonk), migrateType: 0 };
    await expect(
      launchLabGraduationPoolContext({ pool, platformConfig: platformConfigOf(LL_POOLS.bonk), user: SIZE_USER }),
    ).rejects.toThrow("AMM v4");
  });
});

// ---------------------------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------------------------

describe("arming on Raydium (every tx through the signer firewall and assertArmable)", async () => {
  const signer: KeyPairSigner = await armedWallet();
  const wallet = signer.address;
  const tables = (await operatorTables()) as Record<Address, Address[]>;
  const slots = (await nonceRefs(wallet, 16)).map((n) => n.account);
  const fw = firewallContext(wallet, tables, slots);
  let nonceIndex = 0;
  const nonces = (n = 1) => {
    const out = nonceRefs(wallet, n, nonceIndex);
    nonceIndex += n;
    return out;
  };
  const bonk = launchLabArmedContext(wallet, LL_POOLS.bonk);
  const accepted = async (orders: ArmedOrder[]) => {
    for (const o of orders) {
      await assertArmable(o, { lookupTables: tables });
      expect(armedOrderFromJson(armedOrderToJson(o))).toEqual(o);
    }
    return expectFirewallAllows(orders, fw);
  };

  test("LaunchLab OCO: take-profit + full-exit stop-loss ladder; the TP shares the SL's first nonce", async () => {
    const amount = 5_000_000_000n;
    const market = launchLabMarket(LL_POOLS.bonk);
    const live = liveQuoteOut("sell", amount, market) as bigint;
    expect(live).toBeGreaterThan(0n);
    const [n0, n1] = await nonces(2);
    const tp = await launchLabSellTemplate(bonk, { amount, closeBaseAccount: true });
    const sl = await launchLabSellTemplate(bonk, { amount, closeBaseAccount: true });
    const common = {
      wallet,
      mint: bonk.pool.baseMint,
      amount,
      fullExit: true,
      tipLevels: TIP_LEVELS,
      armingQuoteOut: live,
      lookupTables: tables,
    };
    const [takeProfit, stopLoss] = await armOcoPair(
      {
        group: "ll-oco",
        nonce: n0 as never,
        extraStopLossNonces: [n1] as never,
        takeProfit: {
          ...common,
          id: "ll-tp",
          kind: "take-profit",
          trigger: { type: "quote-at-least", threshold: (live * 12n) / 10n },
          templates: [tp],
          minOuts: minOutGrid((live * 12n) / 10n, [0, 200]),
        },
        stopLoss: {
          ...common,
          id: "ll-sl",
          kind: "stop-loss",
          trigger: { type: "quote-at-most", threshold: (live * 8n) / 10n },
          templates: [sl],
          minOuts: minOutGrid((live * 8n) / 10n, [0, 300]),
        },
      },
      signer,
    );
    // 4 TP variants + 8 SL variants + 2 cancels.
    expect(await accepted([takeProfit, stopLoss])).toBe(14);
    expect(stopLoss.frozen.venues).toEqual([
      { venue: "launchlab", creator: bonk.pool.creator, market: LL_POOLS.bonk, config: bonk.pool.platformConfig },
    ]);
    expect(stopLoss.frozen.quoteMint).toBe(WSOL_MINT);
    const v = stopLoss.attempts[0]?.variants[0];
    expect(v?.id).toMatch(/^ll-sl\/0\/launchlab\/0\/0$/);
    expect(v?.priorityFeeLamports).toBe(
      ((TIP_LEVELS[0]?.cuPriceMicroLamports ?? 0n) * BigInt(DEFAULT_CU_LIMITS.launchLabSell)) / 1_000_000n,
    );
    // The variant is sell_exact_in(amount, min-out, share_fee_rate 0) and closes the base ATA after it.
    const insp = inspectArmedTransaction(v?.tx.wireBase64 ?? "", tables);
    const trade = insp.instructions.find((i) => i.program === RAYDIUM_LAUNCHLAB_PROGRAM_ID);
    expect(trade?.data.subarray(0, 8)).toEqual(RAYDIUM_LAUNCHLAB_IX.sellExactIn);
    expect(trade?.data.length).toBe(32);
    expect(new DataView(trade?.data.buffer as ArrayBuffer, trade?.data.byteOffset).getBigUint64(24, true)).toBe(0n);
    expect(insp.instructions.at(-2)?.data).toEqual(new Uint8Array([9]));
  });

  test("LaunchLab limit buys: SOL pair (wrap), Token-2022 transfer-fee coin, and an xStock-quoted pair (cap in the quote mint)", async () => {
    const spend = 50_000_000n;
    const orders: ArmedOrder[] = [];
    for (const p of [LL_POOLS.bonk, LL_POOLS.stonkFee, LL_POOLS.stonkXstock]) {
      const ctx = launchLabArmedContext(wallet, p);
      const market = launchLabMarket(p);
      const amount = p === LL_POOLS.stonkXstock ? 1_000_000n : spend;
      const live = liveQuoteOut("buy", amount, market) as bigint;
      orders.push(
        await armOrder(
          spec(
            wallet,
            {
              id: `ll-buy-${p.slice(0, 4)}`,
              kind: "limit-buy",
              mint: ctx.pool.baseMint,
              amount,
              trigger: { type: "quote-at-least", threshold: (live * 11n) / 10n },
              templates: [await launchLabBuyTemplate(ctx, { spend: amount })],
              minOuts: minOutGrid((live * 11n) / 10n, [0, 200, 400]),
              tipLevels: TIP_LEVELS.slice(0, 1),
              nonces: await nonces(),
              armingQuoteOut: live,
            },
            tables,
          ),
          signer,
        ),
      );
    }
    expect(await accepted(orders)).toBe(3 * 4);
    expect(orders[0]?.capCost.buyLamports).toBe(3n * spend);
    expect(orders[2]?.capCost).toMatchObject({ buyLamports: 0n, buyQuote: { [XSTOCK]: 3n * 1_000_000n } });
    expect(orders[2]?.frozen.quoteMint).toBe(XSTOCK);
  });

  test("CPMM limit buy and full-exit stop-loss on graduated pools (SPL and Token-2022 coins)", async () => {
    const orders: ArmedOrder[] = [];
    for (const p of [CPMM_POOLS.bonk, CPMM_POOLS.stonk]) {
      const ctx = cpmmArmedContext(wallet, p);
      const market = cpmmMarket(p);
      const spend = 100_000_000n;
      const buyLive = liveQuoteOut("buy", spend, market) as bigint;
      orders.push(
        await armOrder(
          spec(
            wallet,
            {
              id: `cp-buy-${p.slice(0, 4)}`,
              kind: "limit-buy",
              mint: ctx.baseMint,
              amount: spend,
              trigger: { type: "quote-at-least", threshold: buyLive },
              templates: [await cpmmBuyTemplate(ctx, { spend })],
              minOuts: minOutGrid(buyLive, [0, 300]),
              tipLevels: TIP_LEVELS.slice(0, 1),
              nonces: await nonces(),
              armingQuoteOut: buyLive,
            },
            tables,
          ),
          signer,
        ),
      );
      const position = buyLive;
      const sellLive = liveQuoteOut("sell", position, market) as bigint;
      orders.push(
        await armOrder(
          spec(
            wallet,
            {
              id: `cp-sl-${p.slice(0, 4)}`,
              kind: "stop-loss",
              mint: ctx.baseMint,
              amount: position,
              fullExit: true,
              trigger: { type: "quote-at-most", threshold: (sellLive * 9n) / 10n },
              templates: [await cpmmSellTemplate(ctx, { amount: position, closeBaseAccount: true })],
              minOuts: minOutGrid((sellLive * 9n) / 10n, [0, 300]),
              nonces: await nonces(),
              armingQuoteOut: sellLive,
            },
            tables,
          ),
          signer,
        ),
      );
    }
    expect(await accepted(orders)).toBe(2 * (2 + 1) + 2 * (4 + 1));
    const cp = orders[1]?.frozen.venues[0];
    expect(cp).toMatchObject({ venue: "cpmm", market: CPMM_POOLS.bonk, config: cpmmPool(CPMM_POOLS.bonk).ammConfig });
  });

  test("a stop-loss that survives graduation: LaunchLab and CPMM variants on one nonce, each venue its own CU limit", async () => {
    const amount = 2_000_000_000n;
    const live = liveQuoteOut("sell", amount, launchLabMarket(LL_POOLS.bonk)) as bigint;
    const order = await armOrder(
      spec(
        wallet,
        {
          id: "ll-grad-sl",
          kind: "stop-loss",
          mint: bonk.pool.baseMint,
          amount,
          fullExit: true,
          trigger: { type: "quote-at-most", threshold: (live * 9n) / 10n },
          templates: [
            await launchLabSellTemplate(bonk, { amount, closeBaseAccount: true }),
            await cpmmSellTemplate(await graduation(wallet), { amount, closeBaseAccount: true }),
          ],
          minOuts: minOutGrid((live * 9n) / 10n, [0, 500]),
          nonces: await nonces(),
          armingQuoteOut: live,
        },
        tables,
      ),
      signer,
    );
    expect(await accepted([order])).toBe(2 * 2 * 2 + 1);
    expect(order.frozen.venues.map((v) => v.venue)).toEqual(["launchlab", "cpmm"]);
    const byVenue = (venue: string) => order.attempts[0]?.variants.filter((v) => v.venue === venue) ?? [];
    expect(byVenue("launchlab")).toHaveLength(4);
    expect(byVenue("cpmm")).toHaveLength(4);
    const fee = (cu: number) => ((TIP_LEVELS[0]?.cuPriceMicroLamports ?? 0n) * BigInt(cu)) / 1_000_000n;
    expect(byVenue("cpmm").find((v) => v.tipLevel === 0)?.priorityFeeLamports).toBe(fee(DEFAULT_CU_LIMITS.cpmmSell));

    // Trigger: on the curve it quotes LaunchLab, after graduation the CPMM pool.
    const decision = evaluateTrigger(order, {}, { liveQuoteOut: (live * 88n) / 100n, venue: "cpmm", nowMs: 0 });
    expect(decision.fire && decision.variant.venue).toBe("cpmm");
    // Staleness: graduation does not strand it, a different graduation pool does.
    expect(detectStaleness(order, { launchLabPool: { creator: bonk.pool.creator, status: LAUNCHLAB_POOL_STATUS.trade } })).toEqual([]);
    expect(detectStaleness(order, { launchLabGraduationPool: CPMM_POOLS.stonk }).map((f) => f.reason)).toEqual(["graduation-pool-changed"]);
  });

  test("migration snipe: a CPMM buy pre-signed against the not-yet-existing graduation pool", async () => {
    const pool = launchLabPool(LL_POOLS.bonk);
    const ctx = await graduation(wallet);
    const spend = 100_000_000n;
    const est = estimateLaunchLabGraduationReserves(pool);
    const quote = quoteCpmmSwapBaseInput({
      pool: { ...cpmmPool(CPMM_POOLS.bonk), token0Mint: ctx.pool.token0Mint, token1Mint: ctx.pool.token1Mint, ...zeroFees },
      ...graduationVaultAmounts(ctx, est),
      inputMint: WSOL_MINT,
      rates: { tradeFeeRate: 2_500n, protocolFeeRate: 0n, fundFeeRate: 0n, creatorFeeRate: 0n },
      amountIn: spend,
    }).amountReceived;
    const snipe = await armLaunchLabMigrationSnipe(
      {
        id: "ll-snipe",
        wallet,
        mint: pool.baseMint,
        amount: spend,
        minOuts: minOutGrid(quote, [500, 1_000]),
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonces(),
        armingQuoteOut: quote,
        lookupTables: tables,
        launchLab: { pool, platformConfig: platformConfigOf(LL_POOLS.bonk) },
      },
      signer,
    );
    expect(await accepted([snipe])).toBe(2 + 1);
    expect(snipe.kind).toBe("migration-snipe");
    expect(snipe.trigger).toEqual({ type: "migration" });
    expect(snipe.frozen.venues).toEqual([
      { venue: "cpmm", creator: platformConfigOf(LL_POOLS.bonk).platformCpCreator, market: ctx.poolAddress, config: ctx.pool.ammConfig },
    ]);
    // Trigger: holds until the coin migrated and only fires on the CPMM venue.
    expect(evaluateTrigger(snipe, {}, { liveQuoteOut: quote, venue: "cpmm", nowMs: 0 })).toMatchObject({
      fire: false,
      reason: "condition-not-met",
    });
    const events = [marketEventFromLaunchLabGraduation(pool.baseMint, ctx.poolAddress, 1n)];
    expect(evaluateTrigger(snipe, {}, { liveQuoteOut: null, venue: "cpmm", nowMs: 0, events })).toMatchObject({
      fire: false,
      reason: "no-quote",
    });
    const fired = evaluateTrigger(snipe, {}, { liveQuoteOut: quote, venue: "cpmm", nowMs: 0, events });
    expect(fired.fire).toBe(true);
    expect(fired.state.migrated).toBe(true);
    expect(evaluateTrigger(snipe, { migrated: true }, { liveQuoteOut: quote, venue: "launchlab", nowMs: 0 })).toMatchObject({
      fire: false,
      reason: "venue-not-armed",
    });
    // Refusals.
    const base = {
      id: "x",
      wallet,
      mint: pool.baseMint,
      amount: spend,
      minOuts: [quote],
      tipLevels: TIP_LEVELS.slice(0, 1),
      armingQuoteOut: quote,
      lookupTables: tables,
    };
    const launchLab = { pool, platformConfig: platformConfigOf(LL_POOLS.bonk) };
    await expect(armLaunchLabMigrationSnipe({ ...base, nonces: await nonceRefs(wallet, 2, 8), launchLab }, signer)).rejects.toThrow(
      "exactly one nonce",
    );
    const graduated = { pool: launchLabPool(LL_POOLS.graduated), platformConfig: platformConfigOf(LL_POOLS.graduated) };
    await expect(
      armLaunchLabMigrationSnipe(
        { ...base, mint: graduated.pool.baseMint, nonces: await nonceRefs(wallet, 1, 8), launchLab: graduated },
        signer,
      ),
    ).rejects.toThrow("already graduated");
    await expect(
      armLaunchLabMigrationSnipe({ ...base, mint: CONNECTED, nonces: await nonceRefs(wallet, 1, 8), launchLab }, signer),
    ).rejects.toThrow("base mint");
  });

  test("refusals: wrong pool, finished curve, withheld transfer fees on a full exit, foreign mint, non-PDA vaults, mixed quotes", async () => {
    const amount = 1_000n;
    await expect(launchLabSellTemplate({ ...bonk, poolAddress: LL_POOLS.trix }, { amount })).rejects.toThrow(ArmingError);
    await expect(
      launchLabBuyTemplate({ ...bonk, pool: { ...bonk.pool, status: LAUNCHLAB_POOL_STATUS.migrate } }, { spend: amount }),
    ).rejects.toThrow("not funding");
    await expect(
      launchLabSellTemplate(launchLabArmedContext(wallet, LL_POOLS.stonkFee), { amount, closeBaseAccount: true, userBaseWithheld: 3n }),
    ).rejects.toThrow("withheld");
    // Without close, withheld fees do not matter.
    expect(
      (await launchLabSellTemplate(launchLabArmedContext(wallet, LL_POOLS.stonkFee), { amount, userBaseWithheld: 3n })).closesBaseAccount,
    ).toBe(false);
    const cp = cpmmArmedContext(wallet, CPMM_POOLS.bonk);
    await expect(cpmmSellTemplate({ ...cp, baseMint: CONNECTED }, { amount })).rejects.toThrow("not in CPMM pool");
    await expect(cpmmBuyTemplate({ ...cp, pool: { ...cp.pool, token0Vault: cp.pool.token1Vault } }, { spend: amount })).rejects.toThrow(
      "PDAs",
    );
    await expect(cpmmSellTemplate(cp, { amount, closeBaseAccount: true, userBaseWithheld: 1n })).rejects.toThrow("withheld");
    // Two templates must agree on the quote mint (an xStock-quoted curve cannot share an order with a SOL pool).
    const xs = launchLabArmedContext(wallet, LL_POOLS.stonkXstock);
    const mixed: TradeTemplate = { ...(await launchLabSellTemplate(xs, { amount })), mint: cp.baseMint };
    await expect(
      armOrder(
        spec(
          wallet,
          {
            id: "mixed",
            kind: "limit-sell",
            mint: cp.baseMint,
            amount,
            trigger: { type: "quote-at-least", threshold: 1n },
            templates: [await cpmmSellTemplate(cp, { amount }), mixed],
            minOuts: [1n],
            nonces: await nonceRefs(wallet, 1, 9),
            armingQuoteOut: 1n,
          },
          tables,
        ),
        signer,
      ),
    ).rejects.toThrow("quote mint");
  });

  test("server verification catches metadata that does not match the signed Raydium bytes", async () => {
    const amount = 1_000_000_000n;
    const live = liveQuoteOut("sell", amount, launchLabMarket(LL_POOLS.bonk)) as bigint;
    const order = await armOrder(
      spec(
        wallet,
        {
          id: "ll-verify",
          kind: "limit-sell",
          mint: bonk.pool.baseMint,
          amount,
          trigger: { type: "quote-at-least", threshold: live },
          templates: [await launchLabSellTemplate(bonk, { amount })],
          minOuts: [live],
          tipLevels: TIP_LEVELS.slice(0, 1),
          nonces: await nonceRefs(wallet, 1, 9),
          armingQuoteOut: live,
        },
        tables,
      ),
      signer,
    );
    expect(await verifyArmedOrderTransactions(order, { lookupTables: tables })).toEqual([]);
    const codes = async (o: ArmedOrder) => (await verifyArmedOrderTransactions(o, { lookupTables: tables })).map((v) => v.code);
    const tamper = (f: (o: ArmedOrder) => void): ArmedOrder => {
      const o = armedOrderFromJson(armedOrderToJson(order));
      f(o);
      return o;
    };
    expect(
      await codes(
        tamper((o) => {
          (o.attempts[0]?.variants[0] as { minOut: bigint }).minOut = live - 1n;
        }),
      ),
    ).toContain("trade-mismatch");
    const venue = (o: ArmedOrder) => o.frozen.venues[0] as { config?: Address; creator: Address; market: Address };
    const setVenue = (patch: Partial<{ config: Address; creator: Address; market: Address }>) =>
      tamper((o) => {
        Object.assign(venue(o), patch);
      });
    // A wrong platform config breaks the config and the platform fee vault it seeds.
    expect(await codes(setVenue({ config: CONNECTED }))).toEqual(["account-mismatch", "account-mismatch"]);
    const noConfig = tamper((o) => {
      delete venue(o).config;
    });
    expect(await codes(noConfig)).toEqual(["account-mismatch", "account-mismatch"]);
    expect(await codes(setVenue({ creator: CONNECTED }))).toEqual(["account-mismatch"]);
    expect(await codes(setVenue({ market: CONNECTED }))).toEqual(["account-mismatch"]);
    const otherQuote = tamper((o) => {
      o.frozen.quoteMint = CONNECTED;
    });
    expect(await codes(otherQuote)).toContain("trade-mismatch");
    // Without the table contents the shared GlobalConfig cannot be resolved, but nothing the order relies on is in it.
    expect(await verifyArmedOrderTransactions(order)).toEqual([]);
  });
});

const zeroFees = {
  protocolFeesToken0: 0n,
  protocolFeesToken1: 0n,
  fundFeesToken0: 0n,
  fundFeesToken1: 0n,
  creatorFeesToken0: 0n,
  creatorFeesToken1: 0n,
};

// ---------------------------------------------------------------------------------------------
// Trigger quoting, targets, staleness, events
// ---------------------------------------------------------------------------------------------

describe("trigger engine on Raydium markets", () => {
  test("LaunchLab live quote = the venue math (what the user receives), null once the curve stops funding", () => {
    for (const p of [LL_POOLS.bonk, LL_POOLS.stonkFee, LL_POOLS.trix, LL_POOLS.stonkXstock]) {
      const m = launchLabMarket(p);
      const spend = p === LL_POOLS.stonkXstock ? 1_000_000n : 100_000_000n;
      expect(liveQuoteOut("buy", spend, m)).toBe(quoteLaunchLabBuyExactIn(m.pool, spend, m.params, m.transferFees).baseReceived);
      expect(liveQuoteOut("sell", 1_000_000_000n, m)).toBe(
        quoteLaunchLabSellExactIn(m.pool, 1_000_000_000n, m.params, m.transferFees).quoteReceived,
      );
    }
    const stonk = launchLabMarket(LL_POOLS.stonkFee);
    const gross = quoteLaunchLabBuyExactIn(stonk.pool, 100_000_000n, stonk.params, stonk.transferFees);
    expect(gross.baseTransferFee).toBeGreaterThan(0n);
    expect(launchLabMarket(LL_POOLS.graduated).pool.status).toBe(LAUNCHLAB_POOL_STATUS.trade);
    expect(liveQuoteOut("buy", 1_000_000n, launchLabMarket(LL_POOLS.graduated))).toBeNull();
    // A buy past the curve's end is capped by the program logic: no quote for the signed spend.
    expect(liveQuoteOut("buy", 1_000_000n * 1_000_000_000n, launchLabMarket(LL_POOLS.bonk))).toBeNull();
    expect(liveQuoteOut("sell", 10n ** 30n, launchLabMarket(LL_POOLS.bonk))).toBeNull();
  });

  test("CPMM live quote = swap_base_input amount_received; null before open_time, with swaps disabled or for a foreign mint", () => {
    for (const p of [CPMM_POOLS.bonk, CPMM_POOLS.stonk]) {
      const m = cpmmMarket(p);
      const quoteMint = m.pool.token0Mint === m.baseMint ? m.pool.token1Mint : m.pool.token0Mint;
      const fees = m.transferFees;
      expect(liveQuoteOut("buy", 100_000_000n, m)).toBe(
        quoteCpmmSwapBaseInput({
          ...m,
          inputMint: quoteMint,
          transferFees: { input: fees?.quote, output: fees?.base, epoch: SNAPSHOT_EPOCH },
          amountIn: 100_000_000n,
        }).amountReceived,
      );
      expect(liveQuoteOut("sell", 1_000_000_000n, m)).toBe(
        quoteCpmmSwapBaseInput({
          ...m,
          inputMint: m.baseMint,
          transferFees: { input: fees?.base, output: fees?.quote, epoch: SNAPSHOT_EPOCH },
          amountIn: 1_000_000_000n,
        }).amountReceived,
      );
      expect(liveQuoteOut("sell", 1_000_000_000n, { ...m, unixTimestamp: m.pool.openTime - 1n })).toBeNull();
      expect(liveQuoteOut("sell", 1_000_000_000n, { ...m, unixTimestamp: m.pool.openTime })).not.toBeNull();
      expect(liveQuoteOut("sell", 1_000_000_000n, { ...m, pool: { ...m.pool, status: 4 } })).toBeNull();
      expect(liveQuoteOut("sell", 1_000_000_000n, { ...m, baseMint: CONNECTED })).toBeNull();
    }
  });

  test("liveMarketFromState builds the same views from loadTokenState results", () => {
    const ll = launchLabMarket(LL_POOLS.bonk);
    const pool = launchLabPool(LL_POOLS.bonk);
    const mintOf = (a: Address) => ({ supply: a === pool.baseMint ? ll.mintSupply : 0n, extensions: { transferFeeConfig: null } });
    const state = {
      venue: "launchlab",
      pool,
      globalConfig: { curveType: 0, tradeFeeRate: ll.params.protocolFeeRate, maxShareFeeRate: 10_000n },
      platformConfig: { feeRate: ll.params.platformFeeRate, creatorFeeRate: ll.params.creatorFeeRate },
      mintInfo: mintOf(pool.baseMint),
      quoteMintInfo: mintOf(pool.quoteMint),
      clock: { epoch: SNAPSHOT_EPOCH, unixTimestamp: 0n },
    } as unknown as TokenState;
    expect(liveMarketFromState(state)).toEqual(ll);
    // Jupiter fallback states are not armable (a /build route is a live quote).
    const jupiter = { venue: "jupiter", mint: pool.baseMint } as unknown as TokenState;
    expect(() => liveMarketFromState(jupiter)).toThrow(ArmingError);
    expect(() => liveMarketFromState(jupiter)).toThrow("Jupiter routes");
    expect(() => liveMarketFromState({ venue: "meteora" } as unknown as TokenState)).toThrow("venue meteora");
  });

  test("market-cap targets: LaunchLab curve and CPMM reserves move along their constant product", () => {
    const m = launchLabMarket(LL_POOLS.bonk);
    const mc = launchLabMarketCap(m.pool, m.mintSupply);
    const at = launchLabAtMarketCap(m.pool, mc * 2n, m.mintSupply);
    const mc2 = launchLabMarketCap(at, m.mintSupply);
    expect(Number(mc2 - mc * 2n) / Number(mc)).toBeLessThan(1e-6);
    expect(at.realQuote).toBeGreaterThan(m.pool.realQuote);
    const sell = 1_000_000_000n;
    expect(quoteOutAtMarketCap("sell", sell, m, mc * 2n) as bigint).toBeGreaterThan(liveQuoteOut("sell", sell, m) as bigint);
    expect(quoteOutAtMarketCap("sell", sell, m, mc * 1_000n)).toBeNull(); // past completion
    expect(quoteOutAtMarketCap("sell", sell, m, 1n)).toBeNull(); // below the starting price

    const c = cpmmMarket(CPMM_POOLS.bonk);
    const net = cpmmVaultAmountsWithoutFees(c.pool, c.vault0Amount, c.vault1Amount);
    const baseIs0 = c.pool.token0Mint === c.baseMint;
    const [b, q] = baseIs0 ? [net.token0, net.token1] : [net.token1, net.token0];
    const cmc = (c.baseMintSupply * q) / b;
    const moved = cpmmAtMarketCap(c.pool, c, c.baseMint, cmc * 3n, c.baseMintSupply);
    const net2 = cpmmVaultAmountsWithoutFees(c.pool, moved.vault0Amount, moved.vault1Amount);
    const [b2, q2] = baseIs0 ? [net2.token0, net2.token1] : [net2.token1, net2.token0];
    expect(Number((c.baseMintSupply * q2) / b2 - cmc * 3n) / Number(cmc)).toBeLessThan(1e-6);
    // Fees owed stay in the vaults on top of the reserves.
    expect(moved.vault0Amount - net2.token0).toBe(c.vault0Amount - net.token0);
    const shifted = marketAtMarketCap(c, cmc * 3n) as typeof c;
    expect([shifted.vault0Amount, shifted.vault1Amount]).toEqual([moved.vault0Amount, moved.vault1Amount]);
    expect(quoteOutAtMarketCap("sell", sell, c, cmc * 3n) as bigint).toBeGreaterThan(liveQuoteOut("sell", sell, c) as bigint);
  });

  test("staleness: LaunchLab pool gone, curve finished without a CPMM leg, creator change", async () => {
    const signer = await armedWallet();
    const ctx = launchLabArmedContext(signer.address, LL_POOLS.bonk);
    const order = await armOrder(
      {
        id: "st",
        kind: "limit-sell",
        wallet: signer.address,
        mint: ctx.pool.baseMint,
        amount: 1_000n,
        trigger: { type: "quote-at-least", threshold: 10n },
        templates: [await launchLabSellTemplate(ctx, { amount: 1_000n })],
        minOuts: [10n],
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(signer.address, 1),
        armingQuoteOut: 10n,
      },
      signer,
    );
    const reasons = (obs: Parameters<typeof detectStaleness>[1]) => detectStaleness(order, obs).map((f) => `${f.reason}:${f.definitive}`);
    expect(reasons({ launchLabPool: { creator: ctx.pool.creator, status: LAUNCHLAB_POOL_STATUS.fund } })).toEqual([]);
    expect(reasons({ launchLabPool: null })).toEqual(["curve-missing:true"]);
    expect(reasons({ launchLabPool: { creator: ctx.pool.creator, status: LAUNCHLAB_POOL_STATUS.migrate } })).toEqual(["migrated:true"]);
    expect(reasons({ launchLabPool: { creator: CONNECTED, status: LAUNCHLAB_POOL_STATUS.fund } })).toEqual(["creator-changed:true"]);
    // pump fee recipient lists do not apply to Raydium venues (they have no frozen recipients).
    expect(reasons({ feeRecipients: { launchlab: [CONNECTED] }, buybackFeeRecipients: { launchlab: [CONNECTED] } })).toEqual([]);
  });

  test("dev-sell exits on LaunchLab: TradeEvents adapt with the pool's mint and the transaction's signer", async () => {
    const pool = launchLabPool(LL_POOLS.bonk);
    const ev: LaunchLabTradeEvent = {
      kind: "launchlabTrade",
      pool: LL_POOLS.bonk,
      totalBaseSell: 0n,
      virtualBase: 0n,
      virtualQuote: 0n,
      realBaseBefore: 0n,
      realQuoteBefore: 0n,
      realBaseAfter: 0n,
      realQuoteAfter: 0n,
      amountIn: 7_000n,
      amountOut: 1n,
      protocolFee: 0n,
      platformFee: 0n,
      creatorFee: 0n,
      shareFee: 0n,
      isBuy: false,
      poolStatus: 0,
      exactIn: true,
    };
    const baseMintOfPool = (p: Address) => (p === LL_POOLS.bonk ? pool.baseMint : undefined);
    expect(marketEventFromDecoded(ev, { baseMintOfPool })).toBeNull();
    const m = marketEventFromDecoded(ev, { baseMintOfPool, trader: pool.creator, slot: 5n });
    expect(m).toEqual({ type: "trade", mint: pool.baseMint, trader: pool.creator, side: "sell", tokenAmount: 7_000n, slot: 5n });
    const signer = await armedWallet();
    const ctx = launchLabArmedContext(signer.address, LL_POOLS.bonk);
    const order = await armOrder(
      {
        id: "dev",
        kind: "dev-sell-exit",
        wallet: signer.address,
        mint: pool.baseMint,
        amount: 1_000n,
        trigger: { type: "dev-sell", creator: pool.creator, minTokenAmount: 5_000n },
        templates: [await launchLabSellTemplate(ctx, { amount: 1_000n })],
        minOuts: [10n],
        tipLevels: TIP_LEVELS.slice(0, 1),
        nonces: await nonceRefs(signer.address, 1),
        armingQuoteOut: 10n,
      },
      signer,
    );
    const d = evaluateTrigger(order, {}, { liveQuoteOut: 100n, venue: "launchlab", nowMs: 0, events: [m as never] });
    expect(d.fire).toBe(true);
  });
});
