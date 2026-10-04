/**
 * Armed orders from the browser (SPEC "Armed orders"): limit, take-profit / stop-loss (OCO pairs share a
 * nonce) and migration snipes, pre-signed on the trading wallet's durable-nonce slots and handed to the
 * server, which fires them when the trigger crosses (the tab can close).
 *
 *   1. slots: the wallet's derived slots read from chain through GET /api/orders/nonce-probe; missing ones
 *      are created (CreateAccountWithSeed + InitializeNonceAccount, signed by the signer, POST /api/tx) and
 *      polled until they are live. DRY_RUN never lands anything, so arming stops there with the reason;
 *   2. build with @zerofee/core: the same TokenState the instant trades use (tradeState.ts: pump.fun, PumpSwap,
 *      Raydium LaunchLab and Raydium CPMM coins quoted in SOL), the trigger engine's market view of it
 *      (liveMarketFromState, what the server quotes with), the venue's templates (Raydium: core's
 *      armed/raydium.ts, which signs what the firewall's Raydium rules accept), the trigger as a quote-out
 *      threshold at the target market cap (quoteOutAtMarketCap), a min-out grid under the
 *      server's grid-depth limit, Jito bundle-only tip levels within its tip and priority caps, the
 *      operator lookup tables (GET /api/orders/limits, contents from GET /api/lookup-tables);
 *   3. sign every variant and the cancel in the signer worker (armOrders through a kit signer over the
 *      worker RPC: each transaction passes the firewall with the wallet's own nonce slots), then
 *      POST /api/orders/armed. Cancel and Panic go to the server, which fires the stored pre-signed cancels.
 */
import {
  type Address,
  type AddressesByLookupTableAddress,
  getTransactionEncoder,
  type Nonce,
  type SignatureBytes,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  type ArmedOrder,
  type ArmedOrderKind,
  type ArmedOrderSpec,
  type ArmedTrigger,
  ArmedTxTooLargeError,
  ArmingError,
  ammBuyTemplate,
  ammSellTemplate,
  armedOrderToJson,
  armOrders,
  assembleTransaction,
  cpmmBuyTemplate,
  cpmmSellTemplate,
  createNonceSlotInstructions,
  type DurableNonceRef,
  estimateMigrationPoolReserves,
  jitoTipLevels,
  type LiveMarketState,
  type LocalTokenState,
  launchLabBuyTemplate,
  launchLabSellTemplate,
  liveMarketFromState,
  liveQuoteOut,
  MAX_NONCE_SLOT_LAMPORTS,
  migrationPoolContext,
  pumpBuyTemplate,
  pumpSellTemplate,
  quoteOutAtMarketCap,
  type TradeTemplate,
} from "@zerofee/core";
import type {
  ArmOrdersResponse,
  CancelOrderResponse,
  LookupTablesResponse,
  NonceProbeResponse,
  OrderDetailResponse,
  OrderLimits,
  PanicResponse,
  TxSubmitResponse,
  Order as WireOrder,
} from "@zerofee/protocol";
import type { Order } from "../../protocol";
import type { ExecutionSettings, LimitOrderRequest, MigrationOrderRequest, TpSlRequest } from "../tradeService";
import { ApiError, api } from "./api";
import type { LiveDataSource } from "./LiveDataSource";
import { planLanding } from "./landingFees";
import type { ProgramAccounts } from "./programs";
import type { TradeContexts } from "./tradeContexts";
import { hasLocalBuilder, tokenStateFromContext } from "./tradeState";
import { recentBlockhash, simulationError, submitSigned } from "./transfers";

export class ArmingRefused extends Error {}

/** Slots probed per wallet (the server allows 32). */
const PROBE_COUNT = 16;
/** Created per transaction (two System instructions each). */
const SLOTS_PER_TX = 4;
const SLOT_POLL_MS = 1_500;
const SLOT_WAIT_MS = 45_000;
/** Rent the first buy may pay: the base token account and, on PumpSwap / LaunchLab / CPMM, the temporary wSOL account. */
const ATA_RENT_LAMPORTS = 2_039_280n;
/** Jito's minimum tip; armed variants go bundle-only. */
const JITO_MIN_TIP = 1_000n;
const LIMITS_TTL_MS = 60_000;

type SignCall = (
  method: "sign",
  params: {
    walletId: string;
    transaction: Uint8Array;
    ownedNonceAccounts?: readonly string[];
    addressLookupTables?: Readonly<Record<string, readonly string[]>>;
  },
) => Promise<{ signedTransaction: Uint8Array; signature: string }>;

export interface ArmedDeps {
  data: LiveDataSource;
  signer: { readonly rpc: { call: SignCall } };
  programs: ProgramAccounts;
  contexts: TradeContexts;
  /** REST transport (tests stub it). */
  rest?: <T>(path: string, o?: { method?: "GET" | "POST"; body?: unknown; rawBody?: string }) => Promise<T>;
  submit?: (wire: Uint8Array, preset: "reduced" | "secure" | "fast", clientSentAt: number) => Promise<TxSubmitResponse>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Kept after a cancel or a fill: called with the wallet once a signature was used up. */
  touch?: () => void;
}

/**
 * kit TransactionPartialSigner over the signer worker: armOrders signs its batch through it. Every variant
 * and cancel passes the firewall (with the wallet's nonce slots and the operator tables) before the key
 * signs, and the worker must have signed exactly the message core built.
 */
export function workerSigner(
  call: SignCall,
  wallet: Address,
  ctx: { ownedNonceAccounts: readonly string[]; tables: AddressesByLookupTableAddress | undefined },
): TransactionPartialSigner {
  const tables = ctx.tables && Object.keys(ctx.tables).length > 0 ? (ctx.tables as Record<string, readonly string[]>) : undefined;
  return {
    address: wallet,
    async signTransactions(transactions: readonly Transaction[]) {
      const out: Record<Address, SignatureBytes>[] = [];
      for (const tx of transactions) {
        const wire = new Uint8Array(getTransactionEncoder().encode(tx));
        const { signedTransaction } = await call("sign", {
          walletId: wallet,
          transaction: wire,
          ownedNonceAccounts: ctx.ownedNonceAccounts,
          ...(tables ? { addressLookupTables: tables } : {}),
        });
        const message = new Uint8Array(tx.messageBytes);
        const signedMessage = signedTransaction.subarray(1 + 64);
        if (signedTransaction[0] !== 1 || signedMessage.length !== message.length || signedMessage.some((b, i) => b !== message[i])) {
          throw new ArmingRefused("the signer signed a different message than the one built");
        }
        out.push({ [wallet]: signedTransaction.slice(1, 65) as SignatureBytes });
      }
      return out;
    },
  };
}

/** Min-out levels from `reference` down by up to `slippageBps`, none deeper than the server's grid limit. */
export function gridUnder(reference: bigint, armingQuoteOut: bigint, slippageBps: number, maxDepthBps: number, levels: number): bigint[] {
  if (reference <= 0n) throw new ArmingRefused("the target quotes to nothing");
  const floor = (armingQuoteOut * BigInt(10_000 - maxDepthBps)) / 10_000n;
  const out = new Set<bigint>();
  for (let i = 0; i < levels; i++) {
    const step = levels === 1 ? 0 : Math.round((slippageBps * i) / (levels - 1));
    const v = (reference * BigInt(10_000 - Math.min(step, 9_999))) / 10_000n;
    if (v > 0n && v >= floor) out.add(v);
  }
  if (out.size === 0) {
    throw new ArmingRefused(`the target is more than ${maxDepthBps / 100}% below the current quote, past the server's grid limit`);
  }
  return [...out].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
}

const lamportsOf = (sol: number) => BigInt(Math.round(sol * 1e9));

export class LiveArmedOrders {
  private limitsCache: { at: number; value: OrderLimits } | null = null;
  private readonly rest: NonNullable<ArmedDeps["rest"]>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: ArmedDeps) {
    this.rest = d.rest ?? ((path, o) => api(path, o));
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // -------------------------------------------------------------------------------------------
  // public operations (TradeService)
  // -------------------------------------------------------------------------------------------

  async placeLimit(req: LimitOrderRequest): Promise<Order> {
    const env = await this.prepare(req.wallet, req.mint);
    const side = req.side;
    const amount = this.amountOf(side, req.size, env);
    const target = this.targetMarketCap(req.trigger, env.state);
    const threshold = quoteOutAtMarketCap(side, amount.amount, env.market, target);
    if (threshold === null || threshold <= 0n) throw new ArmingRefused("That target is outside what the curve or pool can reach");
    // Buys fire when the spend buys at least `threshold` tokens (the price fell to the target); sells below
    // the target are stop-losses, above it limit sells.
    const above = req.trigger.direction !== "below";
    const kind: ArmedOrderKind = side === "buy" ? "limit-buy" : above ? "limit-sell" : "stop-loss";
    const trigger: ArmedTrigger =
      side === "buy"
        ? above
          ? { type: "quote-at-most", threshold }
          : { type: "quote-at-least", threshold }
        : above
          ? { type: "quote-at-least", threshold }
          : { type: "quote-at-most", threshold };
    const [nonce] = await this.freeSlots(req.wallet, 1, req.settings, env);
    if (!nonce) throw new ArmingRefused("No free nonce slot");
    const spec = await this.spec(env, { kind, side, amount, trigger, reference: threshold, settings: req.settings, nonces: [nonce] });
    const [order] = await this.armAndSend(env, [spec]);
    if (!order) throw new ArmingRefused("The server returned no order");
    return order;
  }

  async armTpSl(req: TpSlRequest): Promise<Order[]> {
    const env = await this.prepare(req.wallet, req.mint);
    const supply = Number(env.state.mintInfo.supply) / 10 ** env.state.mintInfo.decimals;
    if (!(req.entryPriceSol > 0) || !(supply > 0)) throw new ArmingRefused("The entry price is unknown, so the exits can't be placed");
    const tps = req.legs.filter((l) => l.kind === "take_profit");
    const sls = req.legs.filter((l) => l.kind === "stop_loss");
    const pairs = req.oco ? Math.min(tps.length, sls.length) : 0;
    const nonceCount = req.legs.length - pairs;
    const nonces = await this.freeSlots(req.wallet, nonceCount, req.settings, env);
    const specs: ArmedOrderSpec[] = [];
    let next = 0;
    const take = () => {
      const n = nonces[next++];
      if (!n) throw new ArmingRefused("Not enough free nonce slots");
      return n;
    };
    const legSpec = async (leg: TpSlRequest["legs"][number], nonce: DurableNonceRef, ocoGroup?: string) => {
      const price =
        leg.kind === "take_profit" ? req.entryPriceSol * (1 + leg.triggerPct / 100) : req.entryPriceSol * (1 - leg.triggerPct / 100);
      if (!(price > 0)) throw new ArmingRefused("A stop-loss of 100% or more never triggers");
      const amount = this.amountOf("sell", { kind: "pct", pct: leg.sellPct }, env);
      const target = BigInt(Math.round(price * supply * 1e9));
      const threshold = quoteOutAtMarketCap("sell", amount.amount, env.market, target);
      if (threshold === null || threshold <= 0n) throw new ArmingRefused("A target is outside what the curve or pool can reach");
      const trigger: ArmedTrigger =
        leg.kind === "take_profit" ? { type: "quote-at-least", threshold } : { type: "quote-at-most", threshold };
      return this.spec(env, {
        kind: leg.kind === "take_profit" ? "take-profit" : "stop-loss",
        side: "sell",
        amount,
        trigger,
        reference: threshold,
        settings: req.settings,
        nonces: [nonce],
        ocoGroup,
      });
    };
    for (let i = 0; i < pairs; i++) {
      const tp = tps[i];
      const sl = sls[i];
      if (!tp || !sl) continue;
      const nonce = take();
      const group = crypto.randomUUID();
      specs.push(await legSpec(tp, nonce, group), await legSpec(sl, nonce, group));
    }
    for (const leg of [...tps.slice(pairs), ...sls.slice(pairs)]) specs.push(await legSpec(leg, take()));
    return this.armAndSend(env, specs);
  }

  async armMigration(req: MigrationOrderRequest): Promise<Order> {
    if (req.side !== "buy") throw new ArmingRefused("Armed migration orders are buys (a snipe on the new PumpSwap pool)");
    if (req.size.kind !== "sol") throw new ArmingRefused("Size a migration buy in SOL");
    const env = await this.prepare(req.wallet, req.mint);
    const s = env.state;
    if (s.venue === "pumpswap") throw new ArmingRefused("This coin already trades on PumpSwap");
    if (s.venue === "cpmm") throw new ArmingRefused("This coin already trades on Raydium CPMM");
    if (s.venue === "launchlab") {
      // Core can pre-sign the CPMM buy (launchLabGraduationPoolContext), but centring its grid needs the
      // graduation AmmConfig's rates, the curve's migrate_fee and vesting lock, which the trade context lacks.
      throw new ArmingRefused("Migration snipes on Raydium LaunchLab coins aren't available yet: arm a limit order on the curve instead");
    }
    const spend = lamportsOf(req.size.sol);
    if (spend <= 0n) throw new ArmingRefused("Enter an amount");
    const ctx = await migrationPoolContext({
      mint: s.mint,
      curve: s.curve,
      baseTokenProgram: s.mintInfo.tokenProgram,
      user: s.user,
      globalConfig: env.programs.ammGlobalConfig,
    });
    if (!env.programs.ammGlobalConfig) throw new ArmingRefused("PumpSwap's GlobalConfig is not loaded yet");
    // Centre the grid on the estimated opening pool (the exact one exists only after migrate).
    const reserves = estimateMigrationPoolReserves(s.curve, s.global);
    const market: LiveMarketState = {
      venue: "pumpswap",
      pool: { quoteMint: ctx.pool.quoteMint, isMayhemMode: ctx.pool.isMayhemMode, coinCreator: ctx.pool.coinCreator, creatorFeeBps: 0n },
      reserves,
      isCanonical: true,
      baseMintSupply: s.mintInfo.supply,
      feeConfig: env.programs.ammFeeConfig,
      globalConfig: env.programs.ammGlobalConfig,
    };
    const estimate = liveQuoteOut("buy", spend, market);
    if (!estimate || estimate <= 0n) throw new ArmingRefused("The migration pool can't be estimated for this coin yet");
    const template = await ammBuyTemplate(ctx, { spend });
    const [nonce] = await this.freeSlots(req.wallet, 1, req.settings, env);
    if (!nonce) throw new ArmingRefused("No free nonce slot");
    const spec = await this.spec(
      { ...env, market },
      {
        kind: "migration-snipe",
        side: "buy",
        amount: { amount: spend, fullExit: false },
        trigger: { type: "migration" },
        reference: estimate,
        armingQuoteOut: estimate,
        settings: req.settings,
        nonces: [nonce],
        templates: [template],
      },
    );
    const [order] = await this.armAndSend(env, [spec]);
    if (!order) throw new ArmingRefused("The server returned no order");
    return order;
  }

  async cancel(orderId: string): Promise<void> {
    const res = await this.rest<CancelOrderResponse>(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", body: {} });
    this.d.data.noteOrders(res.orders, [], false);
  }

  async panic(): Promise<{ cancelled: number }> {
    const res = await this.rest<PanicResponse>("/api/orders/panic", { method: "POST", body: {} });
    this.d.data.noteOrders(res.orders, [], false);
    return { cancelled: res.cancelled };
  }

  /** Arms a fresh copy of an order that went stale (or failed and consumed its nonce), on a free slot. */
  async rearm(orderId: string, settings: ExecutionSettings): Promise<Order> {
    const { order } = await this.rest<OrderDetailResponse>(`/api/orders/${encodeURIComponent(orderId)}`);
    if (order.open && order.status !== "stale") throw new ArmingRefused("This order is still armed. Cancel it first to re-arm it.");
    const env = await this.prepare(order.wallet, order.mint);
    const amount = BigInt(order.amount);
    const trigger = wireTrigger(order.trigger);
    const reference =
      trigger.type === "quote-at-least" || trigger.type === "quote-at-most"
        ? trigger.threshold
        : liveQuoteOut(order.side, amount, env.market);
    if (!reference || reference <= 0n) throw new ArmingRefused("The order can't be quoted right now");
    const [nonce] = await this.freeSlots(order.wallet, 1, settings, env);
    if (!nonce) throw new ArmingRefused("No free nonce slot");
    if (order.kind === "migration-snipe") throw new ArmingRefused("Arm a new migration order instead");
    const spec = await this.spec(env, {
      kind: order.kind,
      side: order.side,
      amount: { amount, fullExit: order.fullExit },
      trigger,
      reference,
      settings,
      nonces: [nonce],
    });
    const [armed] = await this.armAndSend(env, [spec]);
    if (!armed) throw new ArmingRefused("The server returned no order");
    return armed;
  }

  // -------------------------------------------------------------------------------------------
  // slots
  // -------------------------------------------------------------------------------------------

  async probe(wallet: string): Promise<NonceProbeResponse> {
    const res = await this.rest<NonceProbeResponse>(`/api/orders/nonce-probe?wallet=${encodeURIComponent(wallet)}&count=${PROBE_COUNT}`);
    // Slot numbers and live counts for the Armed Orders view.
    const index = new Map(res.slots.map((s) => [s.nonceAccount, s.index]));
    const totals = new Map([[wallet, res.slots.filter((s) => s.state === "ready").length]]);
    this.d.data.setNonceInfo((account) => index.get(account) ?? null, totals);
    return res;
  }

  /**
   * `count` ready slots no open order holds, creating the missing ones first. A slot an order of this
   * browser just armed counts as held even before the server's view catches up.
   */
  private async freeSlots(wallet: string, count: number, settings: ExecutionSettings, env: Env): Promise<DurableNonceRef[]> {
    const pick = (res: NonceProbeResponse) => {
      const held = new Set<string>();
      for (const o of this.d.data.orders().values()) {
        if (o.wallet !== wallet || !o.open) continue;
        for (const a of o.attempts) held.add(a.nonceAccount);
      }
      return res.slots.filter((s) => s.state === "ready" && s.orderId === null && !held.has(s.nonceAccount) && s.nonceValue);
    };
    let res = await this.probe(wallet);
    env.ownedNonceAccounts = res.slots.filter((s) => s.state === "ready").map((s) => s.nonceAccount);
    let free = pick(res);
    if (free.length < count) {
      const absent = res.slots.filter((s) => s.state === "absent").slice(0, count - free.length);
      if (absent.length < count - free.length) throw new ArmingRefused(`Only ${free.length + absent.length} nonce slots are available`);
      await this.createSlots(wallet, absent, res.rentLamports, settings);
      const deadline = this.now() + SLOT_WAIT_MS;
      while (free.length < count) {
        if (this.now() > deadline) throw new ArmingRefused("The new nonce slots did not show up on chain in time. Try again.");
        await this.sleep(SLOT_POLL_MS);
        res = await this.probe(wallet);
        free = pick(res);
      }
      env.ownedNonceAccounts = res.slots.filter((s) => s.state === "ready").map((s) => s.nonceAccount);
    }
    return free
      .slice(0, count)
      .map((s) => ({ account: s.nonceAccount as Address, authority: wallet as Address, value: s.nonceValue as Nonce }));
  }

  /** CreateAccountWithSeed + InitializeNonceAccount for each slot, signed by the signer, POSTed to /api/tx. */
  private async createSlots(
    wallet: string,
    slots: NonceProbeResponse["slots"],
    rentLamports: string | null,
    settings: ExecutionSettings,
  ): Promise<void> {
    if (rentLamports === null) throw new ArmingRefused("The server could not read the rent of a nonce slot. Try again.");
    const rent = BigInt(rentLamports);
    if (rent <= 0n || rent > MAX_NONCE_SLOT_LAMPORTS) throw new ArmingRefused(`Unexpected nonce slot rent ${rentLamports}`);
    for (let i = 0; i < slots.length; i += SLOTS_PER_TX) {
      const batch = slots.slice(i, i + SLOTS_PER_TX);
      const instructions = (
        await Promise.all(batch.map((s) => createNonceSlotInstructions({ wallet: wallet as Address, index: s.index, rentLamports: rent })))
      ).flatMap((s) => s.instructions);
      const chain = this.d.data.chain();
      const plan = planLanding({
        landing: "reduced",
        cuLimit: 4_000 * batch.length,
        chain,
        priorityFeeSol: settings.priorityFeeSol,
        tipSol: 0,
      });
      const tx = assembleTransaction({ feePayer: wallet as Address, instructions, blockhash: recentBlockhash(chain), fees: plan });
      const wire = new Uint8Array(getTransactionEncoder().encode(tx));
      const { signedTransaction } = await this.d.signer.rpc.call("sign", { walletId: wallet, transaction: wire });
      this.d.touch?.();
      const res = await (this.d.submit ?? submitSigned)(signedTransaction, "reduced", this.now());
      if (res.dryRun) {
        const sim = res.simulation;
        const outcome = !sim
          ? "no simulation result"
          : sim.err
            ? `it would fail: ${simulationError(sim.err, sim.logs)}`
            : "it would succeed";
        throw new ArmingRefused(
          `Armed orders need ${slots.length} more durable-nonce slot${slots.length === 1 ? "" : "s"} on chain. The server is in dry-run mode, so creating them was only simulated (${outcome}); nothing was armed.`,
        );
      }
      if (res.lanes.length > 0 && res.lanes.every((l) => !l.ok)) {
        throw new ArmingRefused(`Creating nonce slots was not sent: ${res.lanes.map((l) => l.error ?? l.lane).join("; ")}`);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // building
  // -------------------------------------------------------------------------------------------

  private async prepare(wallet: string, mint: string): Promise<Env> {
    const [{ ctx }, programs, limits] = await Promise.all([this.d.contexts.get(mint), this.d.programs.get(), this.limits()]);
    if (!ctx || !hasLocalBuilder(ctx)) {
      throw new ArmingRefused("Armed orders work on pump.fun, PumpSwap, Raydium LaunchLab and Raydium CPMM coins quoted in SOL");
    }
    const held = this.d.data.wallet(wallet)?.balanceOf(mint) ?? null;
    const state = await tokenStateFromContext(
      ctx,
      programs,
      { user: wallet as Address, balance: held ? { amount: held.amount, account: held.account } : null },
      { slot: this.d.data.chain()?.slot ?? null, nowMs: this.now() },
    );
    const tables = await this.operatorTables(limits);
    // The trigger engine's view of the same state (what the server's engine quotes the order with).
    const market = liveMarketFromState(state);
    return { wallet: wallet as Address, state, market, programs, limits, tables, ownedNonceAccounts: [] };
  }

  async limits(): Promise<OrderLimits> {
    if (this.limitsCache && this.now() - this.limitsCache.at < LIMITS_TTL_MS) return this.limitsCache.value;
    const value = await this.rest<OrderLimits>("/api/orders/limits");
    this.limitsCache = { at: this.now(), value };
    return value;
  }

  /** The operator's tables as read from chain (the variants may load venue accounts from them). */
  private async operatorTables(limits: OrderLimits): Promise<AddressesByLookupTableAddress | undefined> {
    if (limits.lookupTables.length === 0) return undefined;
    const res = await this.rest<LookupTablesResponse>(
      `/api/lookup-tables?addresses=${limits.lookupTables.map(encodeURIComponent).join(",")}`,
    );
    const out: AddressesByLookupTableAddress = {};
    for (const [table, t] of Object.entries(res.tables)) if (t?.active) out[table as Address] = t.addresses as Address[];
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private amountOf(side: "buy" | "sell", size: LimitOrderRequest["size"], env: Env): { amount: bigint; fullExit: boolean } {
    if (side === "buy") {
      if (size.kind !== "sol") throw new ArmingRefused("Size a limit buy in SOL");
      const amount = lamportsOf(size.sol);
      if (amount <= 0n) throw new ArmingRefused("Enter an amount");
      return { amount, fullExit: false };
    }
    const holding = env.state.userBaseBalance;
    if (holding <= 0n) throw new ArmingRefused("Nothing to sell: the wallet holds none of this coin in its token account");
    // A full exit closes the base token account; one that may hold withheld Token-2022 fees cannot be
    // closed (CloseAccount fails), so selling all of it keeps the account.
    const fullExit = env.state.userBaseWithheld === 0n;
    if (size.kind === "pct") {
      if (size.pct >= 100) return { amount: holding, fullExit };
      const amount = (holding * BigInt(Math.round(size.pct * 100))) / 10_000n;
      if (amount <= 0n) throw new ArmingRefused("Sell amount rounds to zero");
      return { amount, fullExit: false };
    }
    if (size.kind === "tokens") {
      const units = BigInt(Math.floor(size.tokens * 10 ** env.state.mintInfo.decimals));
      if (units <= 0n) throw new ArmingRefused("Sell amount rounds to zero");
      return units >= holding ? { amount: holding, fullExit } : { amount: units, fullExit: false };
    }
    throw new ArmingRefused("Size a limit sell as a share or a token amount");
  }

  /** The target market cap in lamports (price targets are SOL per token; market-cap targets are USD). */
  private targetMarketCap(trigger: LimitOrderRequest["trigger"], state: LocalTokenState): bigint {
    const value = trigger.value;
    if (value === null || !(value > 0)) throw new ArmingRefused("Enter a trigger");
    const supply = Number(state.mintInfo.supply) / 10 ** state.mintInfo.decimals;
    if (trigger.metric === "price") return BigInt(Math.round(value * supply * 1e9));
    if (trigger.metric === "mc") {
      const solUsd = this.d.data.chain()?.solUsd?.price ?? null;
      if (!solUsd || !(solUsd > 0)) throw new ArmingRefused("SOL/USD is unknown right now, so a USD market-cap target can't be placed");
      return BigInt(Math.round((value / solUsd) * 1e9));
    }
    throw new ArmingRefused(`A ${trigger.metric} trigger isn't supported for limit orders`);
  }

  private async spec(
    env: Env,
    o: {
      kind: ArmedOrderKind;
      side: "buy" | "sell";
      amount: { amount: bigint; fullExit: boolean };
      trigger: ArmedTrigger;
      reference: bigint;
      armingQuoteOut?: bigint;
      settings: ExecutionSettings;
      nonces: DurableNonceRef[];
      ocoGroup?: string;
      templates?: TradeTemplate[];
    },
  ): Promise<ArmedOrderSpec> {
    const s = env.state;
    const armingQuoteOut = o.armingQuoteOut ?? liveQuoteOut(o.side, o.amount.amount, env.market);
    if (!armingQuoteOut || armingQuoteOut <= 0n) throw new ArmingRefused("The coin can't be quoted right now");
    const templates = o.templates ?? [await this.template(s, o.side, o.amount)];
    const cuLimit = Math.max(...templates.map((t) => t.defaultCuLimit));
    const slippageBps = Math.min(9_000, Math.max(0, Math.round(o.settings.slippagePct * 100)));
    // Buys: every signed variant counts against the daily buy cap, so at most maxBuyVariants of them.
    const buyCap = Math.max(1, env.limits.maxBuyVariants);
    const tipLevels = this.tipLevels(o.settings, cuLimit, env.limits, o.side === "buy" ? 1 : 2);
    const levels = o.side === "buy" ? Math.max(1, Math.floor(buyCap / tipLevels.length)) : 3;
    const minOuts = gridUnder(o.reference, armingQuoteOut, slippageBps, env.limits.maxGridDepthBps, levels);
    const ataRent = o.side === "buy" ? ATA_RENT_LAMPORTS * (env.market.venue === "pump" ? 1n : 2n) : 0n;
    return {
      id: crypto.randomUUID(),
      kind: o.kind,
      wallet: env.wallet,
      mint: s.mint,
      amount: o.amount.amount,
      fullExit: o.amount.fullExit,
      trigger: o.trigger,
      templates,
      minOuts,
      tipLevels,
      nonces: o.nonces,
      armingQuoteOut,
      ...(o.ocoGroup ? { ocoGroup: o.ocoGroup } : {}),
      lookupTables: env.tables,
      extraReserveLamports: ataRent,
      maxBuyVariants: buyCap,
      armedAtMs: this.now(),
    };
  }

  private async template(s: LocalTokenState, side: "buy" | "sell", amount: { amount: bigint; fullExit: boolean }): Promise<TradeTemplate> {
    if (s.venue === "launchlab") {
      // Pool PDA and status checked by core (launchLabPinned); share_fee_rate 0, the wallet's own ATAs.
      const ctx = { poolAddress: s.poolAddress, pool: s.pool, user: s.user };
      return side === "buy"
        ? launchLabBuyTemplate(ctx, { spend: amount.amount })
        : launchLabSellTemplate(ctx, { amount: amount.amount, closeBaseAccount: amount.fullExit, userBaseWithheld: s.userBaseWithheld });
    }
    if (s.venue === "cpmm") {
      // Vault and observation PDAs checked by core (cpmmSides) before anything is signed.
      const ctx = { poolAddress: s.poolAddress, pool: s.pool, user: s.user, baseMint: s.mint };
      return side === "buy"
        ? cpmmBuyTemplate(ctx, { spend: amount.amount })
        : cpmmSellTemplate(ctx, { amount: amount.amount, closeBaseAccount: amount.fullExit, userBaseWithheld: s.userBaseWithheld });
    }
    if (s.venue === "pump") {
      const ctx = {
        mint: s.mint,
        baseTokenProgram: s.mintInfo.tokenProgram,
        quoteTokenProgram: s.quoteTokenProgram,
        user: s.user,
        curve: s.curve,
        global: s.global,
      };
      return side === "buy"
        ? pumpBuyTemplate(ctx, { spend: amount.amount })
        : pumpSellTemplate(ctx, { amount: amount.amount, closeBaseAccount: amount.fullExit });
    }
    const ctx = {
      poolAddress: s.poolAddress,
      pool: s.pool,
      user: s.user,
      baseTokenProgram: s.mintInfo.tokenProgram,
      quoteTokenProgram: s.quoteTokenProgram,
      globalConfig: s.globalConfig,
    };
    return side === "buy"
      ? ammBuyTemplate(ctx, { spend: amount.amount })
      : ammSellTemplate(ctx, { amount: amount.amount, closeBaseAccount: amount.fullExit });
  }

  /** Jito bundle-only levels: the preset's tip (at least Jito's minimum), then double; within the server's caps. */
  private tipLevels(settings: ExecutionSettings, cuLimit: number, limits: OrderLimits, count: number) {
    const maxTip = BigInt(limits.maxTipLamports);
    const maxPriority = BigInt(limits.maxPriorityFeeLamports);
    const base = planLanding({
      landing: "secure",
      cuLimit,
      chain: this.d.data.chain(),
      priorityFeeSol: settings.priorityFeeSol,
      tipSol: settings.tipSol,
    });
    const clampTip = (t: bigint) => (t < JITO_MIN_TIP ? JITO_MIN_TIP : t > maxTip ? maxTip : t);
    const maxPrice = (maxPriority * 1_000_000n) / BigInt(cuLimit);
    const clampPrice = (p: bigint) => (p < 1n ? 1n : p > maxPrice ? maxPrice : p);
    const tip = base.totalTipLamports;
    const price = base.cuPriceMicroLamports;
    const levels = [{ tipLamports: clampTip(tip), cuPriceMicroLamports: clampPrice(price) }];
    if (count > 1) {
      const second = { tipLamports: clampTip(tip * 2n), cuPriceMicroLamports: clampPrice(price * 2n) };
      if (second.tipLamports !== levels[0]?.tipLamports || second.cuPriceMicroLamports !== levels[0]?.cuPriceMicroLamports)
        levels.push(second);
    }
    return jitoTipLevels(levels);
  }

  private async armAndSend(env: Env, specs: ArmedOrderSpec[]): Promise<Order[]> {
    const signer = workerSigner(this.d.signer.rpc.call, env.wallet, { ownedNonceAccounts: env.ownedNonceAccounts, tables: env.tables });
    let orders: ArmedOrder[];
    try {
      orders = await armOrders(specs, signer);
    } catch (e) {
      if (e instanceof ArmedTxTooLargeError) {
        throw new ArmingRefused(
          env.tables
            ? "This order's transactions don't fit one packet even with the operator's lookup table. Use fewer tip levels."
            : "This order's transactions only fit one packet with the operator's lookup table, and the server has none configured.",
        );
      }
      if (e instanceof ArmingError) throw new ArmingRefused(e.message.replace(/^order \S+: /, ""));
      throw e;
    } finally {
      this.d.touch?.();
    }
    const body = orders.length === 1 ? armedOrderToJson(orders[0] as ArmedOrder) : `{"orders":[${orders.map(armedOrderToJson).join(",")}]}`;
    let res: ArmOrdersResponse;
    try {
      res = await this.rest<ArmOrdersResponse>("/api/orders/armed", { method: "POST", rawBody: body });
    } catch (e) {
      if (e instanceof ApiError) {
        const v = (e.body as { violations?: { message: string }[] } | null)?.violations ?? [];
        throw new ArmingRefused(v.length > 0 ? `${e.message}: ${v.map((x) => x.message).join("; ")}` : e.message);
      }
      throw e;
    }
    this.d.data.noteOrders(res.orders, [], false);
    return res.orders.map((o: WireOrder) => this.d.data.adaptOrder(o));
  }
}

interface Env {
  wallet: Address;
  state: LocalTokenState;
  market: LiveMarketState;
  programs: Awaited<ReturnType<ProgramAccounts["get"]>>;
  limits: OrderLimits;
  tables: AddressesByLookupTableAddress | undefined;
  /** The wallet's ready nonce slots (the firewall allows nonce instructions only on these). */
  ownedNonceAccounts: string[];
}

/** A wire trigger (decimal strings) as core's ArmedTrigger. */
function wireTrigger(t: WireOrder["trigger"]): ArmedTrigger {
  switch (t.type) {
    case "quote-at-least":
      return { type: "quote-at-least", threshold: BigInt(t.threshold) };
    case "quote-at-most":
      return { type: "quote-at-most", threshold: BigInt(t.threshold) };
    case "trailing":
      return {
        type: "trailing",
        trailBps: t.trailBps,
        ...(t.activationQuoteOut ? { activationQuoteOut: BigInt(t.activationQuoteOut) } : {}),
      };
    case "time":
      return { type: "time", notBeforeMs: t.notBeforeMs, ...(t.minQuoteOut ? { minQuoteOut: BigInt(t.minQuoteOut) } : {}) };
    case "migration":
      return { type: "migration" };
    case "dev-sell":
      return {
        type: "dev-sell",
        creator: t.creator as Address,
        ...(t.minTokenAmount ? { minTokenAmount: BigInt(t.minTokenAmount) } : {}),
      };
  }
}
