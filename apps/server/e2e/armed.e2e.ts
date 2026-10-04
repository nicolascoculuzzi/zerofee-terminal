/**
 * The server's armed-orders engine fires a REAL armed take-profit on the local mainnet fork
 * (`bun run fork:start`, then `bun run e2e:orders`). Real pump program code and cloned mainnet state,
 * real landed transactions, no real money, nothing sent anywhere but 127.0.0.1:
 *
 *   1. a trading wallet buys the fork's Token-2022 curve coin (the CLI path) and creates a durable-nonce
 *      slot; an operator creates and extends the armed-orders lookup table;
 *   2. the full server starts against the fork: RPC-logs ingest -> MarketState, program accounts, the
 *      accounts layer (PGlite), and the order engine with DRY_RUN=false whose protected lane is an RpcLane
 *      to the fork (loopback-only fetch; Jito does not exist there);
 *   3. the browser side signs in (SIWS), registers the trading wallet and POSTs a full-exit take-profit
 *      armed with @zerofee/core (min-out grid on one nonce, Jito tip + jitodontfront, the operator table);
 *   4. another wallet pumps the price; the engine sees the trade on the logs stream, quotes the order,
 *      submits the chosen variant, sees the nonce advance and resolves the fill.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSignerFromKeyPair,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { InMemoryNonceStore } from "@zerofee/auth";
import {
  type ArmedOrder,
  armedOrderToJson,
  armedStaticAccounts,
  armOrder,
  createLookupTableInstruction,
  createNonceSlotInstructions,
  decodeAmmGlobalConfig,
  extendLookupTableInstruction,
  fetchLookupTables,
  fetchNonceRent,
  fetchNonceSlots,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  jitoTipLevels,
  LAMPORTS_PER_SOL,
  type Lane,
  type LaneAck,
  liveQuoteOut,
  loadTokenState,
  nonceSlotAddress,
  PUMP_AMM_GLOBAL_CONFIG,
  type PumpCurveState,
  planLookupTableExtension,
  pumpSellTemplate,
  RpcLane,
  toAddressesByLookupTable,
} from "@zerofee/core";
import type { ArmOrdersResponse, OrderDetailResponse } from "@zerofee/protocol";
import { connectFork, type Fork, newWallet, runTrade, type Wallet, waitConfirmed } from "../../../packages/core/e2e/harness";
import { loopbackOnlyFetch } from "../../../packages/core/scripts/fork/env";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { setLogLevel } from "../src/log";
import { LiveSubmitter } from "../src/orders/lanes";
import { createUserLayer, type UserLayer } from "../src/user";
import { waitFor } from "../test/helpers";
import { pgliteDb, type TestDb } from "../test/pgHelpers";
import { Browser, type UserTestEnv } from "../test/userHelpers";

const ORIGIN = "https://zerofee.test";
const pct = (v: bigint, p: number) => (v * BigInt(Math.round(p * 100))) / 10_000n;

/** An ordinary blockhash transaction signed by `signers` (first = fee payer), landed on the fork. */
async function sendNow(fork: Fork, signers: Wallet[], instructions: Instruction[]): Promise<Signature> {
  const { value: bh } = await fork.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer((signers[0] as Wallet).address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const tx = await signTransaction(
    signers.map((s) => s.keyPair),
    compileTransaction(msg),
  );
  const wire = getBase64EncodedWireTransaction(tx);
  const lane = new RpcLane({ url: fork.rpcUrl, fetchFn: loopbackOnlyFetch });
  const ack = await lane.sendTransaction(wire);
  if (!ack.ok) throw new Error(`send failed: ${ack.error}`);
  const sig = getSignatureFromTransaction(tx);
  await waitConfirmed(fork.rpc, sig);
  return sig;
}

/** The fork's RPC as the protected lane, able to drop chosen transactions ("accepted, never landed"). */
class ForkProtectedLane implements Lane {
  readonly name = "fork-protected";
  readonly dropped = new Set<string>();
  readonly sent: string[] = [];
  private readonly inner: RpcLane;

  constructor(url: string) {
    this.inner = new RpcLane({ url, name: this.name, fetchFn: loopbackOnlyFetch });
  }

  async sendTransaction(wire: string): Promise<LaneAck> {
    this.sent.push(wire);
    if (this.dropped.has(wire)) return { lane: this.name, ok: true, sentAt: performance.now(), ackAt: performance.now() };
    return this.inner.sendTransaction(wire);
  }
}

/** Polls an async check until it returns a value. */
async function poll<T>(fn: () => Promise<T | null | undefined>, timeoutMs: number, stepMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await Bun.sleep(stepMs);
  }
}

describe("the server engine fires a real armed take-profit on the mainnet fork", () => {
  let fork: Fork;
  let trader: Wallet;
  let signer: KeyPairSigner;
  let mint: Address;
  let table: Address;
  let order: ArmedOrder;
  let app: App;
  let user: UserLayer;
  let db: TestDb;
  let browser: Browser;
  let protectedLane: ForkProtectedLane;

  beforeAll(async () => {
    setLogLevel("error");
    fork = await connectFork();
    const target = fork.manifest.targets.find((t) => t.kind === "curve2022" || t.kind === "curveSpl");
    if (!target) throw new Error("the fork has no curve coin; pass one to fork:start");
    mint = target.mint;

    // 1. The trading wallet holds tokens and a nonce slot; the operator owns the lookup table.
    trader = await newWallet(fork, 3n);
    signer = await createSignerFromKeyPair(trader.keyPair);
    await runTrade(fork, trader, { label: "armed e2e: position", mint, side: "buy", sol: "0.02" });
    const slot = await createNonceSlotInstructions({ wallet: trader.address, index: 0, rentLamports: await fetchNonceRent(fork.rpc) });
    await sendNow(fork, [trader], slot.instructions);

    const operator = await newWallet(fork, 2n);
    const recentSlot = await fork.rpc.getSlot({ commitment: "finalized" }).send();
    const created = await createLookupTableInstruction({ authority: operator.address, payer: operator.address, recentSlot });
    table = created.address;
    await sendNow(fork, [operator], [created.instruction]);
    const state = (await loadTokenState(fork.rpc, { mint, user: trader.address })) as PumpCurveState;
    const [ammCfg] = await fetchRawAccounts(fork.rpc, [PUMP_AMM_GLOBAL_CONFIG]);
    const contents = await armedStaticAccounts({
      pumpGlobal: state.global,
      ammGlobalConfig: ammCfg ? decodeAmmGlobalConfig(ammCfg.data) : null,
    });
    for (const batch of planLookupTableExtension([], contents)) {
      await sendNow(
        fork,
        [operator],
        [extendLookupTableInstruction({ table, authority: operator.address, payer: operator.address, addresses: batch })],
      );
    }
    // Lookups resolve against the ROOT bank: wait until the extended table is finalized before arming.
    await poll(
      async () => {
        const t = (await fetchLookupTables(fork.rpc, [table]))[table];
        const fin = await fork.rpc.getAccountInfo(table, { encoding: "base64", commitment: "finalized" }).send();
        return t &&
          fin.value &&
          Buffer.from((fin.value.data as unknown as [string, string])[0], "base64").length >= 56 + 32 * contents.length
          ? t
          : null;
      },
      90_000,
      500,
    );

    // 2. The server, against the fork only.
    const cfg = loadConfig({
      SERVER_PORT: "0",
      DB_PATH: ":memory:",
      RPC_URL: fork.rpcUrl,
      RPC_WS_URL: fork.wsUrl,
      INGEST_SOURCE: "rpc",
      DRY_RUN: "false",
      PUBLIC_ORIGIN: ORIGIN,
      ARMED_LOOKUP_TABLES: table,
      ORDERS_MISS_SLOTS: "12",
      ORDERS_SWEEP_MS: "500",
      LOG_LEVEL: "error",
      RATE_LIMIT_REST_RPS: "1000",
      RATE_LIMIT_REST_BURST: "1000",
      RATE_LIMIT_AUTH_PER_MIN: "6000",
      RATE_LIMIT_USER_RPS: "1000",
      RATE_LIMIT_USER_BURST: "1000",
    });
    const local = loopbackOnlyFetch;
    protectedLane = new ForkProtectedLane(fork.rpcUrl);
    db = await pgliteDb();
    user = await createUserLayer(cfg, { db: db.db, nonceStore: new InMemoryNonceStore(), fetchFn: local, telegramPolling: false });
    app = createApp(cfg, {
      user,
      fetchFn: local,
      solUsd: null,
      orders: {
        // Jito does not exist on the fork: the protected lane is the fork's own RPC, loopback only.
        submitter: new LiveSubmitter({
          variant: [protectedLane],
          cancel: () => [new RpcLane({ url: fork.rpcUrl, name: "fork-cancel", fetchFn: local })],
        }),
      },
    });
    await app.orders?.ready;
    await waitFor(() => app.orders?.engine.lookupTables()?.[table], 60_000, 100);

    // The server learns the coin from the stream: a small trade by someone else.
    const other = await newWallet(fork, 1n);
    await runTrade(fork, other, { label: "armed e2e: warm the market", mint, side: "buy", sol: "0.001" });
    await waitFor(() => app.market.tradeContext(mint), 60_000, 100);

    // 3. Arm a full-exit take-profit 3% above the current quote, grid at +1.5% / 0% / -1.5%.
    order = await armTakeProfit({ wallet: trader, signer, nonceIndex: 0, triggerPct: 103, gridPct: [101.5, 100, 98.5] });

    browser = new Browser({ base: `http://127.0.0.1:${app.gateway.port}`, ws: `ws://127.0.0.1:${app.gateway.port}/ws` } as UserTestEnv);
    await browser.signIn();
    const reg = await browser.req("POST", "/api/trading-wallets", { publicKey: trader.address });
    expect(reg.status).toBe(200);
  }, 300_000);

  /** Arms a full-exit take-profit of the wallet's whole balance on nonce slot `nonceIndex` (browser side). */
  async function armTakeProfit(o: {
    wallet: Wallet;
    signer: KeyPairSigner;
    nonceIndex: number;
    triggerPct: number;
    gridPct: number[];
  }): Promise<ArmedOrder> {
    const live = (await loadTokenState(fork.rpc, { mint, user: o.wallet.address })) as PumpCurveState;
    const amount = live.userBaseBalance;
    const q0 = liveQuoteOut("sell", amount, {
      venue: "pump",
      curve: live.curve,
      global: live.global,
      feeConfig: live.feeConfig,
      mintSupply: live.mintInfo.supply,
    });
    if (q0 === null) throw new Error("curve not quotable");
    const account = (await nonceSlotAddress(o.wallet.address, o.nonceIndex)).address;
    const [nonce] = await fetchNonceSlots(fork.rpc, [account]);
    if (!nonce) throw new Error("nonce slot missing");
    const tables = toAddressesByLookupTable(await fetchLookupTables(fork.rpc, [table]));
    return armOrder(
      {
        id: crypto.randomUUID(),
        kind: "take-profit",
        wallet: o.wallet.address,
        mint,
        amount,
        fullExit: true,
        trigger: { type: "quote-at-least", threshold: pct(q0, o.triggerPct) },
        templates: [
          await pumpSellTemplate(
            {
              mint,
              baseTokenProgram: live.mintInfo.tokenProgram,
              quoteTokenProgram: live.quoteTokenProgram,
              user: o.wallet.address,
              curve: live.curve,
              global: live.global,
            },
            { amount, closeBaseAccount: true },
          ),
        ],
        minOuts: o.gridPct.map((p) => pct(q0, p)),
        tipLevels: jitoTipLevels([{ tipLamports: 10_000n, cuPriceMicroLamports: 100_000n }]),
        nonces: [{ account, authority: o.wallet.address, value: nonce.value }],
        armingQuoteOut: q0,
        lookupTables: tables,
      },
      o.signer,
    );
  }

  /** A second trading wallet of the same user: a position and two nonce slots. */
  async function secondWallet(): Promise<{ wallet: Wallet; signer: KeyPairSigner }> {
    const wallet = await newWallet(fork, 2n);
    await runTrade(fork, wallet, { label: "armed e2e: second position", mint, side: "buy", sol: "0.01" });
    const rent = await fetchNonceRent(fork.rpc);
    for (const index of [0, 1]) {
      const slot = await createNonceSlotInstructions({ wallet: wallet.address, index, rentLamports: rent });
      await sendNow(fork, [wallet], slot.instructions);
    }
    expect((await browser.req("POST", "/api/trading-wallets", { publicKey: wallet.address })).status).toBe(200);
    return { wallet, signer: await createSignerFromKeyPair(wallet.keyPair) };
  }

  afterAll(async () => {
    await app?.stop();
    await db?.close();
  });

  test("intake accepts the browser-armed take-profit (nonce, operator table and signatures checked against the fork)", async () => {
    const r = await browser.json<ArmOrdersResponse>("POST", "/api/orders/armed", armedOrderToJson(order));
    if (r.status !== 201) throw new Error(`intake refused: ${JSON.stringify(r.body)}`);
    expect(r.body.orders[0]).toMatchObject({ id: order.id, status: "armed", kind: "take-profit" });
  });

  test("a price pump fires it: submitted to the protected lane, landed, resolved as filled from the nonce", async () => {
    const ata = await findAssociatedTokenAddress(trader.address, mint, order.frozen.baseTokenProgram);
    const before = (await fork.rpc.getBalance(trader.address, { commitment: "confirmed" }).send()).value;
    // Enough SOL to lift the curve price comfortably past +3%.
    const live = (await loadTokenState(fork.rpc, { mint, user: trader.address })) as PumpCurveState;
    const push = (live.curve.virtualQuoteReserves * 6n) / 100n;
    const pumper = await newWallet(fork, push / LAMPORTS_PER_SOL + 2n);
    await runTrade(fork, pumper, {
      label: "armed e2e: pump",
      mint,
      side: "buy",
      sol: (Number(push) / 1e9).toFixed(9),
      settings: { maxBuyLamports: push + LAMPORTS_PER_SOL },
    });

    let last: OrderDetailResponse | null = null;
    const filled = await poll(async () => {
      const d = await browser.json<OrderDetailResponse>("GET", `/api/orders/${order.id}`);
      last = d.body;
      return d.body.order.status === "filled" ? d.body : null;
    }, 90_000).catch((e) => {
      throw new Error(`${e instanceof Error ? e.message : e}; last state: ${JSON.stringify(last, null, 1)}`);
    });
    const sig = filled.order.signature as Signature;
    expect(order.attempts[0]?.variants.map((v) => v.tx.signature)).toContain(sig);
    expect(filled.events.map((e) => e.type)).toEqual(expect.arrayContaining(["armed", "submitted", "sent", "nonce-consumed"]));
    // The landed transaction sold everything and closed the token account (the full-exit guard).
    const tx = await fork.rpc.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1, encoding: "json" }).send();
    expect(tx?.meta?.err).toBeNull();
    expect((await fork.rpc.getAccountInfo(ata, { encoding: "base64" }).send()).value).toBeNull();
    const after = (await fork.rpc.getBalance(trader.address, { commitment: "confirmed" }).send()).value;
    const variant = order.attempts[0]?.variants.find((v) => v.tx.signature === sig);
    // Received at least the variant's min-out, minus the fees and tip the variant pays.
    expect(after - before).toBeGreaterThan((variant?.minOut ?? 0n) - 200_000n);
    // The nonce advanced: every other variant (and the cancel) is dead.
    const [n] = await fetchNonceSlots(fork.rpc, [order.attempts[0]?.nonce.account as Address]);
    expect(n?.value).not.toBe(order.attempts[0]?.nonce.value);
    console.log(
      `armed take-profit filled on the fork: ${sig} (${filled.order.attempts[0]?.submittedVariantId}), wallet +${after - before} lamports`,
    );
  }, 180_000);

  test("a missed attempt: the variant never lands, its pre-signed cancel lands within the miss window and burns the nonce", async () => {
    const { wallet, signer: s2 } = await secondWallet();
    // Already above its threshold: it fires on intake. The protected lane "accepts" and drops every variant.
    const missed = await armTakeProfit({ wallet, signer: s2, nonceIndex: 0, triggerPct: 97, gridPct: [96, 95] });
    for (const v of missed.attempts[0]?.variants ?? []) protectedLane.dropped.add(v.tx.wireBase64);
    const ata = await findAssociatedTokenAddress(wallet.address, mint, missed.frozen.baseTokenProgram);
    const tokensBefore = (await fork.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send()).value.amount;

    const r = await browser.json<ArmOrdersResponse>("POST", "/api/orders/armed", armedOrderToJson(missed));
    if (r.status !== 201) throw new Error(`intake refused: ${JSON.stringify(r.body)}`);
    const done = await poll(async () => {
      const d = await browser.json<OrderDetailResponse>("GET", `/api/orders/${missed.id}`);
      return d.body.order.status === "failed-consumed" ? d.body : null;
    }, 90_000);
    const cancelSig = missed.attempts[0]?.nonce.cancel.signature;
    expect(done.order.attempts[0]).toMatchObject({ status: "burned", consumedBy: cancelSig });
    expect(done.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["submitted", "sent", "submit-missed", "cancel-fired", "nonce-consumed"]),
    );
    expect(protectedLane.sent.filter((w) => protectedLane.dropped.has(w)).length).toBeGreaterThan(0);
    // The cancel landed for real; the tokens never moved; every variant is dead now.
    const st = await fork.rpc.getSignatureStatuses([cancelSig as Signature], { searchTransactionHistory: true }).send();
    expect(st.value[0]?.err).toBeNull();
    expect((await fork.rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send()).value.amount).toBe(tokensBefore);
    const [n] = await fetchNonceSlots(fork.rpc, [missed.attempts[0]?.nonce.account as Address]);
    expect(n?.value).not.toBe(missed.attempts[0]?.nonce.value);

    // Panic: an order far from its trigger is cancelled and its cancel lands too.
    const parked = await armTakeProfit({ wallet, signer: s2, nonceIndex: 1, triggerPct: 150, gridPct: [148, 145] });
    expect((await browser.json<ArmOrdersResponse>("POST", "/api/orders/armed", armedOrderToJson(parked))).status).toBe(201);
    const panic = await browser.json<{ cancelled: number }>("POST", "/api/orders/panic");
    expect(panic.body.cancelled).toBe(1);
    const closed = await poll(async () => {
      const d = await browser.json<OrderDetailResponse>("GET", `/api/orders/${parked.id}`);
      return d.body.order.attempts[0]?.status === "burned" ? d.body : null;
    }, 60_000);
    expect(closed.order).toMatchObject({ status: "cancelled", statusReason: "panic", open: false });
    expect(closed.order.attempts[0]?.consumedBy).toBe(parked.attempts[0]?.nonce.cancel.signature);
    console.log(`missed attempt cancelled on the fork by ${cancelSig}; Panic cancel ${closed.order.attempts[0]?.consumedBy}`);
  }, 240_000);
});
