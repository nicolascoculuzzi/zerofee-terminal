/**
 * Raydium ingest from real mainnet transactions (core's offline snapshot): instruction accounts paired with
 * LaunchLab / CPMM events, graduations without events, attribution next to pump's identical TradeEvent
 * discriminator, and the RPC logs source's getTransaction path (fetch, retry, fallback, hint).
 */
import { describe, expect, test } from "bun:test";
import {
  decodeLogEvents,
  PUMP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "@zerofee/core";
import { ingestFromJsonTx, type RpcJsonTx } from "../src/ingest/jsonTx";
import { extractRaydium } from "../src/ingest/raydium";
import { isLaunchLabMigrationLog, RpcLogsSource } from "../src/ingest/rpcLogs";
import type { IngestHint, IngestTx } from "../src/ingest/types";
import { setLogLevel } from "../src/log";
import { fixture } from "./helpers";
import { CPMM, LL, llPool, raydiumGrpc, raydiumJsonTx, raydiumTxInput, rtx, type TxLabel } from "./raydiumFixtures";

setLogLevel("error");

describe("instruction accounts of Raydium events", () => {
  test("LaunchLab buy: the pool's mints, configs, vaults and the payer (the TradeEvent has none of them)", () => {
    const tx = raydiumGrpc("bonkBuy");
    expect(tx.events.map((e) => e.kind)).toEqual(["launchlabTrade"]);
    const pool = llPool(LL.bonk);
    expect(tx.raydium?.accounts[0]).toEqual({
      kind: "launchlabSwap",
      payer: rtx("bonkBuy").feePayer,
      pool: LL.bonk,
      globalConfig: pool.globalConfig,
      platformConfig: pool.platformConfig,
      userBaseToken: expect.any(String),
      userQuoteToken: expect.any(String),
      baseVault: pool.baseVault,
      quoteVault: pool.quoteVault,
      baseMint: pool.baseMint,
      quoteMint: WSOL_MINT,
      baseTokenProgram: TOKEN_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
    });
  });

  test("swaps routed through another program (inner instructions) pair the same way", () => {
    for (const label of ["bonkChainBuy", "stonkFeeSell", "trixSell", "stonkXstockSell"] as TxLabel[]) {
      const tx = raydiumGrpc(label);
      const ev = tx.events[0];
      expect(ev?.kind).toBe("launchlabTrade");
      const acc = tx.raydium?.accounts[0];
      expect(acc?.kind).toBe("launchlabSwap");
      if (ev?.kind === "launchlabTrade" && acc?.kind === "launchlabSwap") {
        expect(acc.pool).toBe(ev.pool);
        expect(acc.baseMint).toBe(llPool(ev.pool).baseMint);
        expect(acc.quoteMint).toBe(llPool(ev.pool).quoteMint);
      }
    }
    // StonkFun coins are Token-2022; the xStock quote too.
    const x = raydiumGrpc("stonkXstockSell").raydium?.accounts[0];
    expect(x).toMatchObject({ baseTokenProgram: TOKEN_2022_PROGRAM_ID, quoteTokenProgram: TOKEN_2022_PROGRAM_ID });
  });

  test("launch: initialize_with_token_2022 + the dev buy in one transaction", () => {
    const tx = raydiumGrpc("create");
    expect(tx.events.map((e) => e.kind)).toEqual(["launchlabPoolCreate", "launchlabTrade"]);
    const create = tx.raydium?.accounts[0];
    expect(create).toMatchObject({
      kind: "launchlabCreate",
      payer: "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM",
      creator: "GxArAcmevRQ9xCPL7adUPXdm5LtNuhdSUhvDSHra9FmM",
      pool: "3CKWpKJnutMhH8QtJFd3hP9hWMmMX7HzMBgzbpC1adL5",
      platformConfig: "4E876qZTE9FJMrBzgVtBrSrzz2TLivB5Y5QXPjB4gZL7",
      baseMint: "GMoT4hnb9g4QkaStKSFgmfwxxZ1iucH3odHv6emC3nLr",
      // quoted in a pump.fun coin
      quoteMint: "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump",
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    expect(tx.raydium?.accounts[1]).toMatchObject({ kind: "launchlabSwap", pool: "3CKWpKJnutMhH8QtJFd3hP9hWMmMX7HzMBgzbpC1adL5" });
  });

  test("graduation: migrate_to_cpswap has no event; its accounts and the new vault balances are recovered", () => {
    const tx = raydiumGrpc("migrate");
    expect(tx.events).toEqual([]);
    expect(tx.raydium?.accounts).toEqual([]);
    expect(tx.raydium?.migrations).toEqual([
      {
        payer: "RAYpQbFNq9i3mu6cKpTKKRwwHFDeK5AuZz8xvxUrCgw",
        pool: LL.graduated,
        baseMint: llPool(LL.graduated).baseMint,
        quoteMint: WSOL_MINT,
        platformConfig: llPool(LL.graduated).platformConfig,
        globalConfig: llPool(LL.graduated).globalConfig,
        cpmmPool: CPMM.bonk,
        cpmmConfig: "GtdipqAcw8eAYxGcANs3vpN7UaN7UH7u89Kd8wPqLThd",
        cpmmLpMint: "Eu2tqxwJ3ekS2qMmzeoQacwWXkb492HQL3SNr2QYVuXm",
        cpmmBaseVault: "5SouwqndgUQEWPSUQu4hiKDfJs4y33MRRCwCYJ8izGDG",
        cpmmQuoteVault: "GQgDpx3oXHMYzFra3jYMzMj92WgNkBshXDFLhZZ7uj6j",
        cpmmObservation: "Bb6cjfjDk2n3ggrFP3PwK1d9prRNvpe21hyY5XBynXj",
        baseVaultAmount: 267_478_890_000_000n,
        quoteVaultAmount: 85_000_000_066n,
      },
    ]);
  });

  test("CPMM swap: payer, vaults and mints", () => {
    const tx = raydiumGrpc("cpmmBonkSell");
    expect(tx.events.map((e) => e.kind)).toEqual(["cpmmSwap"]);
    expect(tx.raydium?.accounts[0]).toMatchObject({ kind: "cpmmSwap", payer: rtx("cpmmBonkSell").feePayer, pool: CPMM.bonk });
  });

  test("transactions without Raydium programs yield null; unmatched events stay undefined", () => {
    const { input } = raydiumTxInput("bonkBuy");
    expect(extractRaydium({ ...input, accountKeys: input.accountKeys.map(() => PUMP_PROGRAM_ID) }, [])).toBeNull();
    // A TradeEvent on a pool no instruction names is left unpaired rather than paired with the wrong pool.
    const ev = raydiumGrpc("bonkBuy").events[0];
    if (ev?.kind !== "launchlabTrade") throw new Error("fixture");
    const other = { ...ev, pool: LL.trix as typeof ev.pool };
    expect(extractRaydium(input, [other])).toBeNull();
  });

  test("attribution: LaunchLab's TradeEvent (pump's discriminator) decodes as LaunchLab, never as pump", () => {
    for (const label of ["bonkBuy", "stonkFeeBuy", "trixSell"] as TxLabel[]) {
      expect(decodeLogEvents(rtx(label).logs).events.map((e) => e.kind)).toEqual(["launchlabTrade"]);
      expect(raydiumGrpc(label).events.map((e) => e.kind)).toEqual(["launchlabTrade"]);
    }
  });

  test("the migrate log line is recognized only under a LaunchLab invoke", () => {
    expect(isLaunchLabMigrationLog(rtx("migrate").logs)).toBe(true);
    expect(isLaunchLabMigrationLog(rtx("bonkBuy").logs)).toBe(false);
    expect(isLaunchLabMigrationLog([`Program ${PUMP_PROGRAM_ID} invoke [1]`, "Program log: Instruction: MigrateToCpswap"])).toBe(false);
  });

  test("getTransaction json -> the same record a gRPC source builds", () => {
    for (const label of ["bonkBuy", "create", "migrate", "cpmmStonkBuy"] as TxLabel[]) {
      const built = ingestFromJsonTx({ signature: rtx(label).signature, tx: raydiumJsonTx(label), receivedAt: 1, source: "rpc-logs" });
      const grpc = raydiumGrpc(label);
      expect(built?.tx.events).toEqual(grpc.events);
      expect(built?.tx.raydium).toEqual(grpc.raydium);
      expect(built?.tx.signers).toEqual(grpc.signers);
      expect(built?.tx.blockTime).toBe(1_791_000_000);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// RpcLogsSource: the getTransaction path
// ---------------------------------------------------------------------------------------------

function notification(signature: string, logs: string[], slot = 1, sub = 13): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: { subscription: sub, result: { context: { slot }, value: { signature, err: null, logs } } },
  });
}

function source(
  fetch: (sig: string) => Promise<RpcJsonTx | null>,
  o: { perSec?: number; wants?: () => boolean; maxQueue?: number; paused?: () => boolean; maxAgeMs?: number } = {},
) {
  const txs: IngestTx[] = [];
  const hints: IngestHint[] = [];
  const src = new RpcLogsSource({
    wsUrl: "ws://unused",
    programs: [PUMP_PROGRAM_ID, RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID],
    commitment: "processed",
    queueMax: 100,
    raydiumTx: {
      fetch,
      perSec: o.perSec ?? 1_000,
      firstDelayMs: 0,
      retryDelayMs: 0,
      maxAttempts: 3,
      maxAgeMs: o.maxAgeMs ?? 1e12,
      ...(o.paused ? { paused: o.paused } : {}),
      ...(o.maxQueue !== undefined ? { maxQueue: o.maxQueue } : {}),
      ...(o.wants ? { wants: o.wants } : {}),
    },
  });
  (src as unknown as { sink: unknown }).sink = { tx: (t: IngestTx) => txs.push(t), hint: (h: IngestHint) => hints.push(h) };
  return { src, txs, hints };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

async function pump(src: RpcLogsSource, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    src.fetchTick(Date.now() + 10_000 * (i + 1));
    await settle();
  }
}

describe("RpcLogsSource: Raydium transactions are re-read", () => {
  test("a LaunchLab trade is replaced by its fetched transaction (wallet, mints, token balances)", async () => {
    const t = rtx("bonkBuy");
    const { src, txs } = source(async (sig) => (sig === t.signature ? raydiumJsonTx("bonkBuy") : null));
    src.onMessage(notification(t.signature, t.logs, t.slot));
    src.drain();
    expect(txs).toHaveLength(0); // waiting for the fetch
    await pump(src);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.raydium?.accounts[0]).toMatchObject({ kind: "launchlabSwap", payer: t.feePayer });
    expect(txs[0]?.slot).toBe(t.slot);
    expect(txs[0]?.tokenBalances?.length).toBeGreaterThan(0);
    expect(src.fetchStats).toMatchObject({ queued: 1, fetched: 1, fallbacks: 0 });
  });

  test("a graduation (no Program data line) is not dropped: fetched for its accounts", async () => {
    const t = rtx("migrate");
    const { src, txs } = source(async () => raydiumJsonTx("migrate"));
    src.onMessage(notification(t.signature, t.logs, t.slot));
    src.drain();
    await pump(src);
    expect(txs).toHaveLength(1);
    expect(txs[0]?.raydium?.migrations[0]?.cpmmPool).toBe(CPMM.bonk);
    expect(src.stats.migrations).toBe(1);
  });

  test("not found after the retries: the logs-only record goes out; a graduation becomes a hint", async () => {
    let calls = 0;
    const { src, txs, hints } = source(async () => {
      calls++;
      return null;
    });
    const buy = rtx("bonkBuy");
    const mig = rtx("migrate");
    src.onMessage(notification(buy.signature, buy.logs, buy.slot));
    src.onMessage(notification(mig.signature, mig.logs, mig.slot));
    src.drain();
    await pump(src, 10);
    expect(calls).toBe(6);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ signature: buy.signature, accountKeys: null });
    expect(txs[0]?.raydium).toBeUndefined();
    expect(hints).toEqual([{ kind: "launchlabMigration", signature: mig.signature, slot: mig.slot }]);
    expect(src.fetchStats).toMatchObject({ notFound: 6, fallbacks: 2 });
  });

  test("errors retry too; `wants` and a full queue keep the logs-only record; pump events never wait", async () => {
    let n = 0;
    const flaky = source(async () => {
      n++;
      if (n === 1) throw new Error("HTTP 429");
      return raydiumJsonTx("cpmmBonkSell");
    });
    const c = rtx("cpmmBonkSell");
    flaky.src.onMessage(notification(c.signature, c.logs, c.slot));
    flaky.src.drain();
    await pump(flaky.src);
    expect(flaky.txs[0]?.raydium?.accounts[0]?.kind).toBe("cpmmSwap");
    expect(flaky.src.fetchStats.errors).toBe(1);

    const unwanted = source(async () => raydiumJsonTx("cpmmBonkSell"), { wants: () => false });
    unwanted.src.onMessage(notification(c.signature, c.logs, c.slot));
    unwanted.src.drain();
    expect(unwanted.txs).toHaveLength(1);
    expect(unwanted.txs[0]?.accountKeys).toBeNull();
    expect(unwanted.src.fetchStats.skipped).toBe(1);

    const full = source(async () => null, { maxQueue: 0 });
    full.src.onMessage(notification(c.signature, c.logs, c.slot));
    full.src.onMessage(notification("pumpsig", fixture("pump-buy").tx.meta.logMessages, 2, 11));
    full.src.drain();
    expect(full.txs.map((t) => t.events[0]?.kind)).toEqual(["cpmmSwap", "pumpTrade"]);
    expect(full.src.fetchStats.overflow).toBe(1);
  });

  test("a cooling-down RPC pauses the calls without using up tries; a transaction left waiting too long goes out logs-only", async () => {
    let calls = 0;
    let paused = true;
    const { src, txs } = source(
      async () => {
        calls++;
        return raydiumJsonTx("bonkBuy");
      },
      { paused: () => paused, maxAgeMs: 20_000 },
    );
    const t = rtx("bonkBuy");
    src.onMessage(notification(t.signature, t.logs, t.slot));
    src.drain();
    const now = Date.now();
    src.fetchTick(now + 1_000);
    src.fetchTick(now + 5_000);
    await settle();
    expect(calls).toBe(0);
    expect(txs).toHaveLength(0);
    paused = false;
    src.fetchTick(now + 6_000);
    await settle();
    expect(calls).toBe(1);
    expect(txs[0]?.raydium?.accounts[0]?.kind).toBe("launchlabSwap");

    // never answered in time: expires to its logs-only record
    paused = true;
    src.onMessage(notification(`${t.signature.slice(0, -2)}zz`, t.logs, t.slot + 1));
    src.drain();
    src.fetchTick(Date.now() + 21_000);
    expect(txs).toHaveLength(2);
    expect(txs[1]?.accountKeys).toBeNull();
    expect(src.fetchStats).toMatchObject({ expired: 1, fallbacks: 1 });
  });

  test("the calls-per-second cap holds", async () => {
    let calls = 0;
    const { src } = source(
      async () => {
        calls++;
        return raydiumJsonTx("bonkBuy");
      },
      { perSec: 2 },
    );
    const t = rtx("bonkBuy");
    for (let i = 0; i < 10; i++) src.onMessage(notification(`${t.signature.slice(0, -2)}${i}x`, t.logs, t.slot + i));
    src.drain();
    const t0 = Date.now();
    for (let ms = 0; ms <= 1_000; ms += 50) src.fetchTick(t0 + ms);
    await settle();
    expect(calls).toBeLessThanOrEqual(3); // 1 token at start + 2 per second
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
