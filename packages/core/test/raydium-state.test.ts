/**
 * Venue resolution and trade building for LaunchLab / CPMM through loadTokenState + buildTrade,
 * against an offline RPC served from the mainnet snapshots (no network).
 */
import { describe, expect, test } from "bun:test";
import { type Address, address, getBase64Decoder } from "@solana/kit";
import {
  addressBytes,
  buildTrade,
  type CpmmState,
  cpmmFeeRates,
  findAssociatedTokenAddress,
  type LaunchLabState,
  launchLabTradeParams,
  loadTokenState,
  quoteCpmmSwapBaseInput,
  quoteLaunchLabBuyExactIn,
  quoteLaunchLabSellExactIn,
  RAYDIUM_CPMM_IX,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  type StateRpc,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "../src";
import { fixture } from "./fixtures";
import { rfixture } from "./raydium-fixtures";

const USER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
const BONK_MINT = address("5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk");
const STONK_MINT = address("9RAPesjvcxKjGXn7QXvRaNPQ9HhhTZoqBqeZmqEuN1fK"); // Token-2022, 3% transfer fee
const GRADUATED_MINT = address("7dmcQ9TyPDcfTTjfCfcZhuwK79FThVuKqmzVM9uKpRhK");
const STONK_GRAD_MINT = address("9RcvjFss6ePC2gtnmCZ84nCbWydTF7Dux2oJk5gCck8N");
const b64d = getBase64Decoder();

/** A token account: 165-byte base (+ Token-2022 TransferFeeAmount extension when `withheld` is given). */
function tokenAccount(mint: Address, owner: Address, amount: bigint, withheld?: bigint): Uint8Array {
  const data = new Uint8Array(withheld === undefined ? 165 : 165 + 1 + 4 + 8);
  data.set(addressBytes(mint), 0);
  data.set(addressBytes(owner), 32);
  const v = new DataView(data.buffer);
  v.setBigUint64(64, amount, true);
  data[108] = 1; // state: initialized
  if (withheld !== undefined) {
    data[165] = 2; // AccountType::Account
    v.setUint16(166, 2, true); // ExtensionType::TransferFeeAmount
    v.setUint16(168, 8, true);
    v.setBigUint64(170, withheld, true);
  }
  return data;
}

function mockRpc(extra: Record<string, { owner: Address; data: Uint8Array; lamports?: bigint }> = {}): StateRpc {
  const lookup = (a: string) => {
    if (extra[a]) return { owner: extra[a].owner, lamports: extra[a].lamports ?? 2_039_280n, data: extra[a].data };
    for (const src of [rfixture, fixture]) {
      try {
        const f = src(a);
        return { owner: f.owner, lamports: f.lamports, data: f.data };
      } catch {
        /* try the next snapshot */
      }
    }
    return null;
  };
  return {
    getMultipleAccounts: (addrs: readonly Address[]) => ({
      send: async () => ({
        context: { slot: 0n },
        value: addrs.map((a) => {
          const acc = lookup(a);
          return acc ? { owner: acc.owner, lamports: acc.lamports, data: [b64d.decode(acc.data), "base64"], executable: false } : null;
        }),
      }),
    }),
    getRecentPrioritizationFees: () => ({ send: async () => [] }),
  } as unknown as StateRpc;
}

const discOf = (ixData: Uint8Array | undefined) => Array.from((ixData ?? new Uint8Array()).subarray(0, 8));

describe("loadTokenState resolves Raydium venues", () => {
  test("BONK.fun coin on its curve -> LaunchLab (SOL pair found from the mint alone)", async () => {
    const s = (await loadTokenState(mockRpc(), { mint: BONK_MINT, user: USER })) as LaunchLabState;
    expect(s.venue).toBe("launchlab");
    expect(s.poolAddress).toBe(address("6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo"));
    expect(s.platformConfig.name).toBe("letsbonk.fun");
    expect([s.quoteMint, s.quoteDecimals, s.quoteTokenProgram]).toEqual([WSOL_MINT, 9, TOKEN_PROGRAM_ID]);
    expect(s.clock.epoch).toBeGreaterThan(1_000n);
    expect(s.userBaseBalance).toBe(0n);
  });

  test("graduated BONK.fun coin -> its CPMM pool via PlatformConfig.cpswap_config", async () => {
    const s = (await loadTokenState(mockRpc(), { mint: GRADUATED_MINT, user: USER })) as CpmmState;
    expect(s.venue).toBe("cpmm");
    expect(s.poolAddress).toBe(address("92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh"));
    expect(s.launchLabPool).toBe(address("yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S"));
    expect(s.quoteMint).toBe(WSOL_MINT);
    expect(s.vault0Amount).toBeGreaterThan(0n);
  });

  test("explicit pools are dispatched by owner program (CPMM, LaunchLab)", async () => {
    const cp = await loadTokenState(mockRpc(), {
      mint: STONK_GRAD_MINT,
      user: USER,
      poolAddress: address("F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z"),
    });
    expect(cp.venue).toBe("cpmm");
    const ll = await loadTokenState(mockRpc(), {
      mint: address("GY5YxnQxPB6pPSryEEy9n6vUjJEow341edR5VVj8L2Pd"),
      user: USER,
      poolAddress: address("EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS"),
    });
    expect(ll.venue).toBe("launchlab");
    expect((ll as LaunchLabState).quoteMintInfo.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    await expect(
      loadTokenState(mockRpc(), { mint: BONK_MINT, user: USER, poolAddress: address("F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z") }),
    ).rejects.toThrow("does not trade");
  });
});

describe("buildTrade on Raydium venues", () => {
  test("LaunchLab buy: wrap SOL, ATA, buy_exact_in with the slippage-bounded received amount, unwrap", async () => {
    const s = (await loadTokenState(mockRpc(), { mint: BONK_MINT, user: USER })) as LaunchLabState;
    const t = await buildTrade(s, { side: "buy", amount: 10_000_000n, slippageBps: 1_500 });
    const params = launchLabTradeParams({ globalConfig: s.globalConfig, platformConfig: s.platformConfig });
    const q = quoteLaunchLabBuyExactIn(s.pool, 10_000_000n, params);
    expect(t.quote.expectedOut).toBe(q.baseReceived);
    expect(t.quote.minOut).toBe((q.baseReceived * 8_500n) / 10_000n);
    expect(t.quote.expectedEvent).toEqual({ amountIn: q.quoteToVault, amountOut: q.baseOut });
    expect(t.quote.feePpm).toMatchObject({ protocol: 2_500n, platform: 12_500n, creator: 0n });
    expect(t.instructions.map((i) => i.programAddress)).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "11111111111111111111111111111111",
      TOKEN_PROGRAM_ID,
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      RAYDIUM_LAUNCHLAB_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
    ]);
    const swap = t.instructions[4];
    expect(discOf(swap?.data)).toEqual(Array.from(RAYDIUM_LAUNCHLAB_IX.buyExactIn));
    expect(swap?.accounts?.length).toBe(18);
    expect(t.hotAccount).toBe(s.poolAddress);
  });

  test("LaunchLab sell of a Token-2022 transfer-fee coin: full exit closes the ATA only without withheld fees", async () => {
    const ata = await findAssociatedTokenAddress(USER, STONK_MINT, TOKEN_2022_PROGRAM_ID);
    for (const [withheld, closes] of [
      [0n, true],
      [42n, false],
    ] as const) {
      const rpc = mockRpc({ [ata]: { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(STONK_MINT, USER, 5_000_000_000n, withheld) } });
      const s = (await loadTokenState(rpc, { mint: STONK_MINT, user: USER })) as LaunchLabState;
      expect([s.userBaseBalance, s.userBaseWithheld]).toEqual([5_000_000_000n, withheld]);
      const t = await buildTrade(s, { side: "sell", amount: 5_000_000_000n, slippageBps: 500 });
      const params = launchLabTradeParams({ globalConfig: s.globalConfig, platformConfig: s.platformConfig });
      const q = quoteLaunchLabSellExactIn(s.pool, 5_000_000_000n, params, {
        base: s.mintInfo.extensions.transferFeeConfig,
        epoch: s.clock.epoch,
      });
      expect(q.baseTransferFee).toBeGreaterThan(0n);
      expect(t.quote.expectedOut).toBe(q.quoteReceived);
      expect(t.quote.feesBase.transfer).toBe(q.baseTransferFee);
      const closesBase = t.instructions.some((i) => i.programAddress === TOKEN_2022_PROGRAM_ID && i.data?.[0] === 9);
      expect(closesBase).toBe(closes);
    }
  });

  test("CPMM buy and sell of a graduated coin", async () => {
    const ata = await findAssociatedTokenAddress(USER, GRADUATED_MINT, TOKEN_PROGRAM_ID);
    const rpc = mockRpc({ [ata]: { owner: TOKEN_PROGRAM_ID, data: tokenAccount(GRADUATED_MINT, USER, 1_000_000_000_000n) } });
    const s = (await loadTokenState(rpc, { mint: GRADUATED_MINT, user: USER })) as CpmmState;
    const buy = await buildTrade(s, { side: "buy", amount: 20_000_000n, slippageBps: 1_000 });
    const q = quoteCpmmSwapBaseInput({
      pool: s.pool,
      vault0Amount: s.vault0Amount,
      vault1Amount: s.vault1Amount,
      inputMint: WSOL_MINT,
      rates: cpmmFeeRates(s.ammConfig, s.pool),
      amountIn: 20_000_000n,
    });
    expect(buy.quote.expectedOut).toBe(q.amountReceived);
    expect(buy.quote.feesQuote.creator).toBe(q.creatorFee); // creator fee on token0 = wSOL input
    const swap = buy.instructions.find((i) => i.programAddress === RAYDIUM_CPMM_PROGRAM_ID);
    expect(discOf(swap?.data)).toEqual(Array.from(RAYDIUM_CPMM_IX.swapBaseInput));
    expect(swap?.accounts?.length).toBe(13);

    const sell = await buildTrade(s, { side: "sell", amount: 1_000_000_000_000n, slippageBps: 1_000 });
    expect(sell.quote.feesBase.trade).toBeGreaterThan(0n); // trade fee is taken in the base input
    expect(sell.quote.feesQuote.creator).toBeGreaterThan(0n); // creator fee on the wSOL output
    // swap, unwrap the wSOL output, close the emptied base ATA
    expect(sell.instructions.slice(-3).map((i) => i.programAddress)).toEqual([RAYDIUM_CPMM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID]);
    await expect(buildTrade(s, { side: "sell", amount: 1_000_000_000_001n, slippageBps: 0 })).rejects.toThrow("exceeds balance");
  });
});
