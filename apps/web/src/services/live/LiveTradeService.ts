/**
 * The trade engine against the real stack (instant and direct mode):
 *
 *   1. inputs: `tradectx:<mint>` (tradeContexts.ts), the program-wide accounts (programs.ts), the wallet's
 *      balance from `wallet:<address>` and the `chain` topic (blockhash, priority fees, kill switch);
 *   2. build in this browser with @zerofee/core: TokenState (tradeState.ts) -> buildTrade with the preset's
 *      slippage -> compute budget and tips for the landing preset (landingFees.ts) -> assembleTransaction.
 *      Coins with no local venue (or not quoted in SOL) go through core's Jupiter fallback: `/build` from
 *      the browser, and the route's lookup tables checked against a chain read (GET /api/lookup-tables);
 *   3. sign: instant mode in the signer worker, whose firewall gets the browser's own quote as
 *      expectations (and the lookup tables); direct mode with the connected wallet (its popup);
 *   4. POST /api/tx with the signed bytes and the preset. DRY_RUN=true (the server default) simulates and
 *      sends nothing: the receipt is marked simulated. A real send is reconciled on the trade stream (or,
 *      for Jupiter routes the server does not decode, on the wallet's balance).
 *
 * Every stage reports real elapsed time since the click. Failures settle as failed receipts with the reason.
 */
import { type Address, type AddressesByLookupTableAddress, getTransactionEncoder, type Instruction } from "@solana/kit";
import {
  assembleTransaction,
  type BuiltTrade,
  buildTrade,
  JUPITER_PROGRAM_ID,
  JupiterApiError,
  JupiterRouteError,
  type JupiterTradeOptions,
  PUMP_AMM_IX,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  startsWith,
  type TokenState,
  type TradeQuote,
} from "@zerofee/core";
import type {
  LookupTablesResponse,
  TradesCorrection,
  TradesDelta,
  TradesSnapshot,
  TxSubmitResponse,
  Trade as WireTrade,
} from "@zerofee/protocol";
import type { TradeExpectation } from "@zerofee/signer";
import type { LandingPreset, LatencyBreakdown, Order, TradeRoute } from "../../protocol";
import { useSettings } from "../../state/settings";
import type {
  BuyRequest,
  LimitOrderRequest,
  MigrationOrderRequest,
  SellRequest,
  TpSlRequest,
  TradeProgress,
  TradeReceipt,
  TradeService,
  TradeStage,
} from "../tradeService";
import { ApiError, api } from "./api";
import { type ArmedDeps, ArmingRefused, LiveArmedOrders } from "./armed";
import { firstSignature } from "./bytes";
import type { LiveDataSource } from "./LiveDataSource";
import { walletErrorMessage } from "./LiveWalletService";
import { BASE_FEE_LAMPORTS, type LandingPlan, planLanding } from "./landingFees";
import { ProgramAccounts } from "./programs";
import { TradeContexts } from "./tradeContexts";
import { isSolQuoted, jupiterStateFor, TradeStateError, tokenStateFromContext, venueFeeBps } from "./tradeState";
import { recentBlockhash, simulationError, submitSigned, TransferError } from "./transfers";
import type { ConnectedSession } from "./walletStandard";

/** Two compute-budget instructions precede the trade instructions (assembleTransaction). */
const BUDGET_IXS = 2;
/** A blockhash stays valid for ~150 blocks (60-90 s); past this the trade cannot land any more. */
const LAND_TIMEOUT_MS = 75_000;
/** Jupiter refuses slippage_bps >= 10,000 and so does the firewall. */
const MAX_SLIPPAGE_BPS = 9_900;
const SIM_LANE = "Simulated (dry run, not sent)";

export interface LiveTradeDeps {
  data: LiveDataSource;
  signer: { readonly rpc: { call: LiveSignerCall } };
  wallet: { connectedSession(): ConnectedSession | null; touch(): void };
  programs?: ProgramAccounts;
  contexts?: TradeContexts;
  submit?: (wire: Uint8Array, preset: LandingPreset, clientSentAt: number) => Promise<TxSubmitResponse>;
  lookupTables?: (addresses: string[]) => Promise<LookupTablesResponse>;
  /** Jupiter `/build` client options (fetch, optional API key). */
  jupiter?: JupiterTradeOptions;
  /** REST transport for the armed-order endpoints (tests stub it). */
  rest?: ArmedDeps["rest"];
  now?: () => number;
  landTimeoutMs?: number;
}

type LiveSignerCall = (
  method: "sign",
  params: {
    walletId: string;
    transaction: Uint8Array;
    ownedNonceAccounts?: readonly string[];
    addressLookupTables?: Readonly<Record<string, readonly string[]>>;
    expectations?: readonly TradeExpectation[];
  },
) => Promise<{ signedTransaction: Uint8Array; signature: string }>;

export class TradeError extends Error {}

const TRADE_PROGRAMS = new Set<string>([
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  JUPITER_PROGRAM_ID,
]);

/** Instructions the firewall reports as trades (PumpSwap's extend_account is a venue ix but not a trade). */
export function tradeInstructionIndexes(instructions: readonly Instruction[]): number[] {
  return instructions.flatMap((ix, i) => {
    if (!TRADE_PROGRAMS.has(ix.programAddress)) return [];
    if (ix.programAddress === PUMP_AMM_PROGRAM_ID && ix.data && startsWith(new Uint8Array(ix.data), PUMP_AMM_IX.extendAccount)) return [];
    return [i];
  });
}

/**
 * The route's lookup tables as read from chain, after checking Jupiter's claimed contents against them
 * entry by entry (tables only grow, so the claim must be a prefix of the chain's list).
 */
export function verifiedLookupTables(claimed: AddressesByLookupTableAddress, chain: LookupTablesResponse): Record<string, Address[]> {
  const out: Record<string, Address[]> = {};
  for (const [table, entries] of Object.entries(claimed)) {
    const onChain = chain.tables[table];
    if (!onChain) throw new TradeError(`The route's lookup table ${short(table)} is not on chain`);
    entries.forEach((a, i) => {
      if (onChain.addresses[i] !== a) throw new TradeError(`Jupiter's lookup table ${short(table)} doesn't match the chain (entry ${i})`);
    });
    out[table] = onChain.addresses as Address[];
  }
  return out;
}

function short(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const lamportsToSol = (x: bigint) => Number(x) / 1e9;

/** Plain-words reason for anything the engine, the signer, Jupiter or the server threw. */
export function tradeErrorMessage(e: unknown): string {
  if (e instanceof JupiterApiError) return /no routes?/i.test(e.message) ? "No Jupiter route for this coin right now" : e.message;
  if (e instanceof JupiterRouteError) {
    // "Jupiter /build: no route the signer can verify (...)": Jupiter only offered routes the firewall refuses.
    const text = e.message.replace(/^Jupiter \/build: /, "");
    return /^no route the signer can verify/.test(text)
      ? `No Jupiter route the signer can verify for this coin right now${text.slice("no route the signer can verify".length)}`
      : `Jupiter: ${text}`;
  }
  if (e instanceof ApiError) return e.code === "halted" ? `Trading is halted: ${e.message}` : e.message;
  if (e instanceof TradeError || e instanceof TradeStateError || e instanceof TransferError) return e.message;
  if (e instanceof RangeError && /exceeds balance/.test(e.message)) return "Sell amount exceeds the wallet's balance";
  return walletErrorMessage(e);
}

function fillOf(
  side: "buy" | "sell",
  q: TradeQuote,
  decimals: number,
  plan: LandingPlan,
  landed?: WireTrade,
): NonNullable<TradeReceipt["fill"]> {
  const scale = 10 ** decimals;
  let solAmount: number;
  let tokenAmount: number;
  if (landed) {
    tokenAmount = Number(landed.tokenAmount) / scale;
    solAmount = landed.amountSol ?? Number(landed.quoteAmount) / 1e9;
  } else if (side === "buy") {
    solAmount = lamportsToSol(q.amountIn);
    tokenAmount = Number(q.expectedOut) / scale;
  } else {
    tokenAmount = Number(q.amountIn) / scale;
    solAmount = lamportsToSol(q.expectedOut);
  }
  return {
    side,
    solAmount,
    tokenAmount,
    priceSol: landed?.priceSol ?? (tokenAmount > 0 ? solAmount / tokenAmount : Number.NaN),
    fees: {
      // Venue fees in the quote (SOL here); a Jupiter route's are inside its quote and not itemized.
      venueSol: lamportsToSol(q.feesQuote.total),
      priorityFeeSol: lamportsToSol(plan.priorityFeeLamports),
      tipSol: lamportsToSol(plan.totalTipLamports),
      baseFeeSol: lamportsToSol(BASE_FEE_LAMPORTS),
    },
  };
}

interface Built {
  state: TokenState;
  trade: BuiltTrade;
  plan: LandingPlan;
  wire: Uint8Array;
  tables: Record<string, Address[]> | undefined;
  expectations: TradeExpectation[];
  heldBefore: bigint | null;
}

export class LiveTradeService implements TradeService {
  readonly programs: ProgramAccounts;
  readonly contexts: TradeContexts;
  readonly armed: LiveArmedOrders;
  private readonly now: () => number;

  constructor(private readonly d: LiveTradeDeps) {
    this.programs = d.programs ?? new ProgramAccounts();
    this.contexts = d.contexts ?? new TradeContexts(d.data);
    this.now = d.now ?? Date.now;
    this.armed = new LiveArmedOrders({
      data: d.data,
      signer: d.signer,
      programs: this.programs,
      contexts: this.contexts,
      submit: d.submit,
      rest: d.rest,
      touch: () => d.wallet.touch(),
    });
    // The venue fee the token page shows comes from the same program accounts the builds use.
    this.programs.onChange((p) => d.data.setFeeEngine((ctx) => venueFeeBps(ctx, p)));
    void this.programs.get().catch(() => undefined);
  }

  buy(request: BuyRequest, onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    return this.run(request, "buy", onProgress);
  }

  sell(request: SellRequest, onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    return this.run(request, "sell", onProgress);
  }

  // Armed orders: pre-signed in the worker on durable-nonce slots, held and fired by the server (armed.ts).
  placeLimit(request: LimitOrderRequest): Promise<Order> {
    return this.armedCall(() => this.armed.placeLimit(request));
  }
  armTpSl(request: TpSlRequest): Promise<Order[]> {
    return this.armedCall(() => this.armed.armTpSl(request));
  }
  armMigration(request: MigrationOrderRequest): Promise<Order> {
    return this.armedCall(() => this.armed.armMigration(request));
  }
  cancel(orderId: string): Promise<void> {
    return this.armedCall(() => this.armed.cancel(orderId));
  }
  rearm(orderId: string): Promise<Order> {
    const s = useSettings.getState();
    return this.armedCall(() => this.armed.rearm(orderId, s.presets[s.activePreset].sell));
  }
  panic(): Promise<{ cancelled: number }> {
    return this.armedCall(() => this.armed.panic());
  }

  /** Errors in plain words (signer refusals, server rejections, unreachable venues). */
  private async armedCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new Error(e instanceof ArmingRefused ? e.message : tradeErrorMessage(e));
    }
  }

  close(): void {
    this.contexts.close();
  }

  // -------------------------------------------------------------------------------------------

  private async run(req: BuyRequest | SellRequest, side: "buy" | "sell", onProgress?: (p: TradeProgress) => void): Promise<TradeReceipt> {
    const t0 = req.clickedAt;
    const since = () => round1(Math.max(0, this.now() - t0));
    const latency: LatencyBreakdown = { clickedAt: t0, builtMs: 0, signedMs: 0, receivedMs: 0, lanes: [], landedMs: null, slot: null };
    const stage = (s: TradeStage, atMs: number) => onProgress?.({ stage: s, atMs });
    let signature: string | null = null;
    let simulated = false;
    let route: string[] | undefined;
    const receipt = (status: TradeReceipt["status"], error: string | null, fill: TradeReceipt["fill"]): TradeReceipt => ({
      clientId: req.clientId,
      status,
      signature,
      error,
      latency,
      fill,
      ...(simulated ? { simulated: true } : {}),
      ...(route ? { route } : {}),
    });
    const fail = (error: string): TradeReceipt => {
      stage("failed", since());
      return receipt("failed", error, null);
    };

    try {
      const halt = this.d.data.chain()?.halt;
      if (halt?.halted) return fail(halt.reason ? `Trading is halted: ${halt.reason}` : "Trading is halted");
      const session = req.mode === "direct" ? this.d.wallet.connectedSession() : null;
      if (req.mode === "direct" && !session) return fail("Connect your wallet to trade in direct mode");
      const user = (session ? session.address : req.wallet) as Address;

      const b = await this.build(req, side, user);
      if (b.trade.quote.jupiter) {
        route = b.trade.quote.jupiter.labels;
        this.noteRoute(req.mint, b.state, b.trade.quote);
      }
      latency.builtMs = since();
      stage("built", latency.builtMs);

      let signed: Uint8Array;
      if (session) {
        signed = await session.signTransaction(b.wire);
        signature = firstSignature(signed);
      } else {
        const res = await this.d.signer.rpc.call("sign", {
          walletId: user,
          transaction: b.wire,
          ...(b.tables ? { addressLookupTables: b.tables } : {}),
          ...(b.expectations.length > 0 ? { expectations: b.expectations } : {}),
        });
        this.d.wallet.touch();
        signed = res.signedTransaction;
        signature = res.signature;
      }
      latency.signedMs = since();
      stage("signed", latency.signedMs);

      const postAt = this.now();
      const res = await (this.d.submit ?? submitSigned)(signed, req.settings.landing, postAt);
      const respMs = round1(this.now() - t0);
      // The server's clock may be skewed: keep its receive time inside the window the request was in flight.
      latency.receivedMs = round1(Math.min(Math.max(res.receivedAt - t0, postAt - t0), respMs));
      signature = res.signature || signature;
      stage("received", latency.receivedMs);
      const decimals = b.state.mintInfo.decimals;

      if (res.dryRun) {
        simulated = true;
        latency.lanes = [{ lane: SIM_LANE, sentMs: respMs }];
        stage("sent", respMs);
        latency.slot = res.simulation?.slot ?? null;
        if (!res.simulation) return fail("The server returned no simulation result");
        if (res.simulation.err) return fail(`Simulation failed: ${simulationError(res.simulation.err, res.simulation.logs)}`);
        latency.landedMs = since();
        stage("landed", latency.landedMs);
        return receipt("confirmed", null, fillOf(side, b.trade.quote, decimals, b.plan));
      }

      latency.lanes = res.lanes.map((l) => ({ lane: l.ok ? l.lane : `${l.lane} (refused)`, sentMs: round1(latency.receivedMs + l.ackMs) }));
      if (res.lanes.length > 0 && res.lanes.every((l) => !l.ok)) {
        return fail(`Not sent: ${res.lanes.map((l) => l.error ?? l.lane).join("; ")}`);
      }
      stage(
        "sent",
        latency.lanes.reduce((m, l) => Math.max(m, l.sentMs), latency.receivedMs),
      );
      const landed = await this.awaitLanding({
        signature: signature ?? "",
        mint: req.mint,
        user,
        heldBefore: b.state.venue === "jupiter" ? b.heldBefore : null,
        since,
      });
      if (!landed)
        return fail(
          `Not seen on chain within ${Math.round((this.d.landTimeoutMs ?? LAND_TIMEOUT_MS) / 1000)} s. It may still land: check the wallet.`,
        );
      latency.landedMs = landed.atMs;
      latency.slot = landed.slot;
      stage("landed", landed.atMs);
      return receipt("confirmed", null, fillOf(side, b.trade.quote, decimals, b.plan, landed.trade));
    } catch (e) {
      return fail(tradeErrorMessage(e));
    }
  }

  /** Inputs -> core TokenState -> BuiltTrade -> assembled, unsigned wire bytes (plus what the signer needs). */
  private async build(req: BuyRequest | SellRequest, side: "buy" | "sell", user: Address): Promise<Built> {
    const { ctx, token } = await this.contexts.get(req.mint);
    const held = this.d.data.wallet(user)?.balanceOf(req.mint) ?? null;
    const u = { user, balance: held ? { amount: held.amount, account: held.account } : null };
    let state: TokenState;
    if (ctx && isSolQuoted(ctx)) {
      state = await tokenStateFromContext(ctx, await this.programs.get(), u);
    } else {
      const reason = ctx ? "quoted in a token other than SOL" : "no pump.fun curve or PumpSwap pool the server can price";
      state = await jupiterStateFor(
        {
          mint: req.mint,
          tokenProgram: token?.tokenProgram ?? ctx?.tokenProgram ?? null,
          decimals: token?.decimals ?? ctx?.decimals ?? null,
        },
        u,
        reason,
      );
    }

    let amount: bigint;
    if (side === "buy") {
      const sol = (req as BuyRequest).solAmount;
      if (!(sol > 0) || !Number.isFinite(sol)) throw new TradeError("Enter an amount");
      amount = BigInt(Math.round(sol * 1e9));
    } else {
      const s = req as SellRequest;
      const holding = state.userBaseBalance;
      if (holding <= 0n) throw new TradeError("Nothing to sell: the wallet holds none of this coin in its token account");
      if (s.tokenAmount !== undefined) {
        const units = BigInt(Math.floor(s.tokenAmount * 10 ** state.mintInfo.decimals));
        amount = units > holding ? holding : units;
      } else {
        const pct = Math.min(100, Math.max(0, s.pct ?? 100));
        amount = pct >= 100 ? holding : (holding * BigInt(Math.round(pct * 100))) / 10_000n;
      }
      if (amount <= 0n) throw new TradeError("Sell amount rounds to zero");
    }
    let slippageBps = Math.min(MAX_SLIPPAGE_BPS, Math.max(0, Math.round(req.settings.slippagePct * 100)));
    const opts = { jupiter: { ...this.d.jupiter, forJitoBundle: req.settings.landing === "secure" } };
    let trade = await buildTrade(state, { side, amount, slippageBps }, opts);
    const maxPriceSol = side === "buy" ? ((req as BuyRequest).maxPriceSol ?? null) : null;
    if (maxPriceSol !== null && maxPriceSol > 0) {
      // Never pay more than maxPriceSol per whole token (copy trades' drift guard): the minimum out is at
      // least spend / maxPrice, in nano-lamports so tiny prices keep their precision.
      const priceNano = BigInt(Math.max(1, Math.round(maxPriceSol * 1e18)));
      const floor = (amount * 1_000_000_000n * 10n ** BigInt(state.mintInfo.decimals) + priceNano - 1n) / priceNano;
      if (trade.quote.expectedOut < floor) throw new TradeError("Price moved past the copy's limit");
      if (trade.quote.minOut < floor) {
        slippageBps = Number(((trade.quote.expectedOut - floor) * 10_000n) / trade.quote.expectedOut);
        trade = await buildTrade(state, { side, amount, slippageBps }, opts);
      }
    }

    let tables: Record<string, Address[]> | undefined;
    if (trade.lookupTables && Object.keys(trade.lookupTables).length > 0) {
      const keys = Object.keys(trade.lookupTables);
      const chain = await (this.d.lookupTables ?? fetchLookupTables)(keys);
      tables = verifiedLookupTables(trade.lookupTables, chain);
    }
    const chain = this.d.data.chain();
    const plan = planLanding({
      landing: req.settings.landing,
      cuLimit: trade.defaultCuLimit,
      chain,
      priorityFeeSol: req.settings.priorityFeeSol,
      tipSol: req.settings.tipSol,
    });
    const tx = assembleTransaction({
      feePayer: user,
      instructions: trade.instructions,
      blockhash: recentBlockhash(chain),
      fees: plan,
      lookupTables: tables,
    });
    const wire = new Uint8Array(getTransactionEncoder().encode(tx));
    // The browser's own quote for the trade instruction: the firewall refuses a minimum out below it less slippage.
    const idx = tradeInstructionIndexes(trade.instructions);
    const expectations: TradeExpectation[] =
      idx.length === 1 && trade.quote.expectedOut > 0n
        ? [{ instruction: BUDGET_IXS + (idx[0] as number), expectedOut: trade.quote.expectedOut, slippageBps }]
        : [];
    return { state, trade, plan, wire, tables, expectations, heldBefore: held?.amount ?? 0n };
  }

  private noteRoute(mint: string, state: TokenState, q: TradeQuote): void {
    if (state.venue !== "jupiter" || !q.jupiter) return;
    const impact = q.jupiter.priceImpactPct === null ? null : Number(q.jupiter.priceImpactPct) * 100;
    const route: TradeRoute = {
      via: "jupiter",
      reason: state.reason,
      labels: q.jupiter.labels,
      priceImpactPct: impact !== null && Number.isFinite(impact) ? impact : null,
    };
    this.d.data.setRoute(mint, route);
  }

  /** Our signature on the trade stream; for Jupiter routes (not decoded by the server), the balance moving. */
  private awaitLanding(a: {
    signature: string;
    mint: string;
    user: string;
    heldBefore: bigint | null;
    since: () => number;
  }): Promise<{ atMs: number; slot: number | null; trade?: WireTrade } | null> {
    return new Promise((resolve) => {
      let done = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      let off: () => void = () => {};
      const finish = (v: { atMs: number; slot: number | null; trade?: WireTrade } | null) => {
        if (done) return;
        done = true;
        off();
        if (poll) clearInterval(poll);
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(null), this.d.landTimeoutMs ?? LAND_TIMEOUT_MS);
      off = this.d.data.socket.subscribe(`trades:${a.mint}`, {
        onMessage: (m) => {
          const list =
            m.type === "snapshot"
              ? (m.data as TradesSnapshot).trades
              : m.type === "delta"
                ? (m.data as TradesDelta).trades
                : (m.data as TradesCorrection).upsert;
          const hit = list.find((t) => t.signature === a.signature);
          if (hit) finish({ atMs: a.since(), slot: hit.slot, trade: hit });
        },
      });
      if (a.heldBefore !== null) {
        const before = a.heldBefore;
        poll = setInterval(() => {
          const now = this.d.data.wallet(a.user)?.balanceOf(a.mint)?.amount ?? 0n;
          if (now !== before) finish({ atMs: a.since(), slot: null });
        }, 500);
      }
    });
  }
}

function fetchLookupTables(addresses: string[]): Promise<LookupTablesResponse> {
  return api<LookupTablesResponse>(`/api/lookup-tables?addresses=${addresses.map(encodeURIComponent).join(",")}`);
}
