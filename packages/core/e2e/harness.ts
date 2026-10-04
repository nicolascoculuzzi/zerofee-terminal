/**
 * Mainnet-fork e2e harness. Builds every trade the way apps/cli/src/index.ts does - loadTokenState ->
 * buildTrade -> planFees -> assembleTransaction -> signAssembled -> simulateTransaction -> SubmitRouter ->
 * confirmSignature with a LatencyTracker - with the CLI's default settings (.env.example), then reads the
 * landed transaction back so tests can assert balances against the local quote to the lamport.
 *
 * Differences from the CLI, all forced by the fork being local:
 *  - Lanes: one RpcLane to the fork (loopback-only fetch). Helius Sender / Jito lanes are never constructed,
 *    yet the standard-mode tip transfers stay inside the transaction and land in the cloned tip accounts.
 *  - Tip accounts / tip floor: the CLI's own fallbacks when the Jito API is unreachable (documented tip
 *    accounts, lane-minimum tips). The fork has no Jito block engine to ask.
 *  - Signer: a fresh in-memory WebCrypto keypair per suite, funded by the local faucet. No key touches disk.
 */
import { appendFileSync, existsSync } from "node:fs";
import {
  type Address,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPair,
  getAddressFromPublicKey,
  lamports,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  assertLoopbackUrl,
  type ForkManifest,
  type ForkPaths,
  type ForkTarget,
  forkPaths,
  isHealthy,
  loopbackOnlyFetch,
  readManifest,
  sleep,
  type TargetKind,
  toJson,
} from "../scripts/fork/env";
import {
  assembleTransaction,
  type BuiltTrade,
  buildTrade,
  type ConfirmResult,
  confirmSignature,
  type DecodedEvent,
  decodeEventsFromLogs,
  type FeePlan,
  feePayerSignature,
  fetchPriorityFeeSamples,
  JITO_TIP_ACCOUNTS_FALLBACK,
  LAMPORTS_PER_SOL,
  type LandingMode,
  type LatencyRecord,
  LatencyTracker,
  loadTokenState,
  parseUiAmount,
  planFees,
  RpcLane,
  type SpeedPreset,
  SubmitRouter,
  signAssembled,
  type TokenState,
  toWireBase64,
  transactionSize,
  WSOL_MINT,
} from "../src";

/** The CLI defaults from .env.example (apps/cli/src/config.ts). */
export const CLI_DEFAULTS = {
  slippageBps: 1500,
  landingMode: "standard" as LandingMode,
  speedPreset: "fast" as SpeedPreset,
  maxBuyLamports: 50_000_000n, // MAX_BUY_SOL=0.05
  maxPriorityFeeLamports: 500_000n, // MAX_PRIORITY_FEE_SOL=0.0005
  maxTipLamports: 500_000n, // MAX_TIP_SOL=0.0005
  heliusSwqosTipLamports: 5_000n, // HELIUS_SWQOS_TIP_SOL=0.000005
  minCuPriceMicroLamports: 100_000n, // PRIORITY_FEE_FLOOR_MICROLAMPORTS
  cuLimitOverride: undefined as number | undefined,
};
export type CliSettings = typeof CLI_DEFAULTS;

/** The fork is a test cluster, so the full API (incl. requestAirdrop) applies. */
export type ForkRpc = Rpc<SolanaRpcApi>;

export interface Fork {
  manifest: ForkManifest;
  paths: ForkPaths;
  rpcUrl: string;
  wsUrl: string;
  rpc: ForkRpc;
  rpcSubscriptions: ReturnType<typeof createSolanaRpcSubscriptions>;
}

/** Synchronous manifest read for test.skipIf decisions at module load. */
export function manifestTargets(): ForkTarget[] {
  try {
    return readManifest()?.targets ?? [];
  } catch {
    return [];
  }
}

export function targetOf(kind: TargetKind): ForkTarget | undefined {
  return manifestTargets().find((t) => t.kind === kind);
}

const HINTS: Record<TargetKind, string> = {
  curve2022: "pass a Token-2022 curve mint to fork:start",
  curveSpl: "pass a legacy SPL Token curve mint to fork:start",
  mayhem: "pass a mayhem-mode curve mint to fork:start",
  migration: "pass two Token-2022 curve mints to fork:start",
  pumpswap: "pass a migrated (PumpSwap) mint to fork:start",
};
const announced = new Set<string>();

/**
 * Why a suite cannot run on this fork (it has no `kind` target), or null when it can. Used as
 * `describe.skipIf(reason !== null)(withSkipReason(name, reason), ...)`, so a missing target is one explicit,
 * explained skip instead of a cascade of failures. The reason is also printed once.
 */
export function missingTarget(kind: TargetKind): string | null {
  if (targetOf(kind)) return null;
  const reason = `the fork has no ${kind} target (${HINTS[kind]})`;
  if (!announced.has(reason)) {
    announced.add(reason);
    console.warn(`skipping: ${reason}`);
  }
  return reason;
}

/** Test / describe name carrying the skip reason, so it shows in the runner's output. */
export function withSkipReason(name: string, reason: string | null | undefined): string {
  return reason ? `${name} [skipped: ${reason}]` : name;
}

export async function connectFork(): Promise<Fork> {
  const paths = forkPaths();
  const manifest = readManifest(paths);
  if (!manifest) throw new Error(`no fork manifest in ${paths.dir}: run \`bun run fork:start\` first`);
  const rpcUrl = process.env.FORK_RPC_URL?.trim() || manifest.rpcUrl;
  const wsUrl = process.env.FORK_WS_URL?.trim() || manifest.wsUrl;
  assertLoopbackUrl(rpcUrl, "FORK_RPC_URL");
  assertLoopbackUrl(wsUrl, "FORK_WS_URL");
  if (!manifest.pid || !(await isHealthy(rpcUrl))) {
    throw new Error(`the fork at ${rpcUrl} is not running: run \`bun run fork:start\` first`);
  }
  return { manifest, paths, rpcUrl, wsUrl, rpc: createSolanaRpc(rpcUrl), rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl) };
}

export async function waitConfirmed(rpc: ForkRpc, sig: Signature, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const s = value[0];
    if (s?.err) throw new Error(`${sig} failed: ${toJson(s.err, 0)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    await sleep(200);
  }
  throw new Error(`${sig} not confirmed within ${timeoutMs} ms`);
}

export interface Wallet {
  address: Address;
  keyPair: CryptoKeyPair;
}

/** Fresh non-extractable in-memory keypair funded by the local faucet. */
export async function newWallet(fork: Fork, sol = 2n): Promise<Wallet> {
  const keyPair = await generateKeyPair();
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  const sig = await fork.rpc.requestAirdrop(address, lamports(sol * LAMPORTS_PER_SOL)).send();
  await waitConfirmed(fork.rpc, sig);
  return { address, keyPair };
}

export interface Delta {
  pre: bigint;
  post: bigint;
  delta: bigint;
}

/** The landed transaction as the chain recorded it (meta pre/post balances, logs, CU). */
export interface LandedTx {
  slot: bigint;
  err: unknown;
  fee: bigint;
  computeUnits: bigint;
  logs: string[];
  keys: Address[];
  /** Accounts the runtime loaded from address lookup tables (v0). */
  loaded: { writable: Address[]; readonly: Address[] };
  events: DecodedEvent[];
  lamports(a: Address): Delta;
  tokens(a: Address): Delta;
  /** Accounts that did not exist before the transaction and do after. */
  created(): Address[];
  /** Accounts that existed before the transaction and were closed by it. */
  closed(): Address[];
}

export async function fetchLandedTx(rpc: ForkRpc, signature: Signature): Promise<LandedTx> {
  for (let i = 0; i < 60; i++) {
    // Version 1: v1 transactions are live on mainnet (and on forks with its feature set); asking for 0 fails on them.
    const tx = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1, encoding: "json" }).send();
    if (tx?.meta) {
      const meta = tx.meta;
      const loaded = {
        writable: [...(meta.loadedAddresses?.writable ?? [])] as Address[],
        readonly: [...(meta.loadedAddresses?.readonly ?? [])] as Address[],
      };
      const keys = [...tx.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly] as Address[];
      const index = new Map(keys.map((k, j) => [k, j]));
      const at = (a: Address) => {
        const j = index.get(a);
        if (j === undefined) throw new Error(`${a} is not an account of ${signature}`);
        return j;
      };
      const pre = meta.preBalances.map((b) => BigInt(b));
      const post = meta.postBalances.map((b) => BigInt(b));
      const tokenAmount = (list: typeof meta.preTokenBalances, j: number) =>
        BigInt(list?.find((b) => b.accountIndex === j)?.uiTokenAmount.amount ?? "0");
      const logs = [...(meta.logMessages ?? [])];
      return {
        slot: BigInt(tx.slot),
        err: meta.err,
        fee: BigInt(meta.fee),
        computeUnits: BigInt(meta.computeUnitsConsumed ?? 0),
        logs,
        keys,
        loaded,
        events: decodeEventsFromLogs(logs),
        lamports: (a) => {
          const j = at(a);
          return { pre: pre[j] as bigint, post: post[j] as bigint, delta: (post[j] as bigint) - (pre[j] as bigint) };
        },
        tokens: (a) => {
          const j = at(a);
          const p = tokenAmount(meta.preTokenBalances, j);
          const q = tokenAmount(meta.postTokenBalances, j);
          return { pre: p, post: q, delta: q - p };
        },
        created: () => keys.filter((_, j) => pre[j] === 0n && (post[j] as bigint) > 0n),
        closed: () => keys.filter((_, j) => (pre[j] as bigint) > 0n && post[j] === 0n),
      };
    }
    await sleep(250);
  }
  throw new Error(`landed transaction ${signature} not found`);
}

export interface TradeRequest {
  /** Report label. */
  label: string;
  mint: Address;
  side: "buy" | "sell";
  /** buy: SOL to spend, as typed to `bun run trade buy <mint> <sol>`. */
  sol?: string;
  /** sell: percent of the balance, as typed to `bun run trade sell <mint> <percent>`. */
  percent?: string;
  settings?: Partial<CliSettings>;
}

export interface TradeRun {
  label: string;
  wallet: Wallet;
  /** The state the quote and instructions were built from (static fork: nothing else trades). */
  state: TokenState;
  trade: BuiltTrade;
  plan: FeePlan;
  sizeBytes: number;
  simulatedUnits: bigint | undefined;
  signature: Signature;
  confirm: ConfirmResult;
  latency: LatencyRecord;
  tx: LandedTx;
}

/** One trade, end to end, exactly like the CLI with DRY_RUN=false - but landing on the local fork. */
export async function runTrade(fork: Fork, wallet: Wallet, req: TradeRequest): Promise<TradeRun> {
  const cfg = { ...CLI_DEFAULTS, ...req.settings };
  const { rpc } = fork;
  const user = wallet.address;
  const buyLamports = req.side === "buy" ? parseUiAmount(req.sol ?? "", 9) : 0n;
  if (req.side === "buy" && (buyLamports <= 0n || buyLamports > cfg.maxBuyLamports)) {
    throw new Error(`buy amount must be in (0, MAX_BUY_SOL]`);
  }
  const tracker = new LatencyTracker({ side: req.side, venue: "pump", mint: req.mint, dryRun: false });

  const [state, blockhash] = await Promise.all([
    loadTokenState(rpc, { mint: req.mint, user }),
    rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send()
      .then((r) => r.value),
  ]);
  const tipAccounts = { jito: [...JITO_TIP_ACCOUNTS_FALLBACK] };
  tracker.record.venue = state.venue;
  tracker.mark("stateLoaded");

  let amount: bigint;
  if (req.side === "buy") {
    amount = buyLamports;
    if (state.quoteMint !== WSOL_MINT) throw new Error(`non-SOL quote ${state.quoteMint}`);
  } else {
    const hundredths = parseUiAmount(req.percent ?? "", 2);
    if (hundredths <= 0n || hundredths > 10_000n) throw new Error("percent must be in (0, 100]");
    if (state.userBaseBalance === 0n) throw new Error(`${user} holds no ${req.mint}`);
    amount = hundredths === 10_000n ? state.userBaseBalance : (state.userBaseBalance * hundredths) / 10_000n;
  }

  const trade = await buildTrade(state, { side: req.side, amount, slippageBps: cfg.slippageBps });
  tracker.mark("quoted");
  const prioritySamples = await fetchPriorityFeeSamples(rpc, [trade.hotAccount]).catch(() => [] as number[]);
  const plan = planFees({
    mode: cfg.landingMode,
    preset: cfg.speedPreset,
    cuLimit: cfg.cuLimitOverride ?? trade.defaultCuLimit,
    prioritySamples,
    tipFloor: null,
    caps: { maxPriorityFeeLamports: cfg.maxPriorityFeeLamports, maxTipLamports: cfg.maxTipLamports },
    heliusSwqosTipLamports: cfg.heliusSwqosTipLamports,
    minCuPriceMicroLamports: cfg.minCuPriceMicroLamports,
  });
  const tx = assembleTransaction({ feePayer: user, instructions: trade.instructions, blockhash, fees: plan, tipAccounts });
  tracker.mark("built");
  const signed = await signAssembled(tx, wallet.keyPair);
  tracker.mark("signed");
  const wire = toWireBase64(signed);

  const sim = await rpc.simulateTransaction(wire as never, { encoding: "base64", commitment: "confirmed", sigVerify: true }).send();
  tracker.mark("simulated");
  if (sim.value.err) {
    throw new Error(`${req.label}: simulation failed ${toJson(sim.value.err, 0)}\n${(sim.value.logs ?? []).join("\n")}`);
  }

  // LIVE send - to the local fork only (the lane's fetch refuses any non-loopback URL).
  const signature = feePayerSignature(signed, user) as Signature;
  const router = new SubmitRouter({ lanes: [new RpcLane({ url: fork.rpcUrl, fetchFn: loopbackOnlyFetch })], dryRun: false });
  tracker.record.signature = signature;
  tracker.record.slotAtSend = await rpc.getSlot({ commitment: "processed" }).send();
  const confirm = confirmSignature({
    rpc,
    rpcSubscriptions: fork.rpcSubscriptions,
    signature,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });
  tracker.mark("sent");
  const { first, all } = router.send(wire);
  const firstAck = await first;
  if (firstAck) tracker.mark("firstAck", firstAck.ackAt);
  const stopRebroadcast = new AbortController();
  void router.rebroadcast(wire, stopRebroadcast.signal).catch(() => {});
  const result = await confirm;
  stopRebroadcast.abort();
  for (const ack of await all) tracker.laneAck(ack);
  if (result.status === "confirmed" || result.status === "failed") tracker.landed(result.slot, result.observedAt);
  tracker.record.outcome = `${result.status}${result.err ? ` ${toJson(result.err, 0)}` : ""}`;

  const landed = await fetchLandedTx(rpc, signature);
  const run: TradeRun = {
    label: req.label,
    wallet,
    state,
    trade,
    plan,
    sizeBytes: transactionSize(signed),
    simulatedUnits: sim.value.unitsConsumed,
    signature,
    confirm: result,
    latency: tracker.record,
    tx: landed,
  };
  recordReport(fork, run);
  return run;
}

/** Minimum rent-exempt balance on the FORK (its rent differs from mainnet's; never hardcode). */
export async function forkRent(rpc: ForkRpc, dataLength: number): Promise<bigint> {
  return BigInt(await rpc.getMinimumBalanceForRentExemption(BigInt(dataLength)).send());
}

export async function accountDataLength(rpc: ForkRpc, a: Address): Promise<number | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: "base64" }).send();
  if (!value) return null;
  const [data] = value.data as unknown as [string, string];
  return Buffer.from(data, "base64").length;
}

export interface ReportLine {
  label: string;
  venue: string;
  side: string;
  mint: string;
  signature: string;
  slot: string;
  computeUnits: string;
  simulatedUnits: string;
  cuLimit: number;
  sizeBytes: number;
  fee: string;
  priorityFee: string;
  tips: string;
  stages: LatencyRecord["stages"];
  slotDelta: string;
  outcome: string;
}

function recordReport(fork: Fork, run: TradeRun) {
  const line: ReportLine = {
    label: run.label,
    venue: run.state.venue,
    side: run.trade.quote.side,
    mint: run.state.mint,
    signature: run.signature,
    slot: run.tx.slot.toString(),
    computeUnits: run.tx.computeUnits.toString(),
    simulatedUnits: String(run.simulatedUnits ?? ""),
    cuLimit: run.plan.cuLimit,
    sizeBytes: run.sizeBytes,
    fee: run.tx.fee.toString(),
    priorityFee: run.plan.priorityFeeLamports.toString(),
    tips: run.plan.tips.map((t) => `${t.lane}:${t.lamports}`).join(","),
    stages: run.latency.stages,
    slotDelta: String(run.latency.slotDelta ?? ""),
    outcome: run.latency.outcome ?? "",
  };
  appendReport(fork, line);
}

/** Appends one landed transaction to the run's report (`bun run e2e` prints the table). */
export function appendReport(fork: Fork, line: ReportLine): void {
  if (existsSync(fork.paths.dir)) appendFileSync(fork.paths.reportPath, `${toJson(line, 0)}\n`);
}
