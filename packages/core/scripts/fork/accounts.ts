/**
 * Mainnet-fork account resolver (dev tooling; mainnet RPC is used READ-ONLY).
 *
 * Picks trade targets (or classifies the mints you pass) and resolves EVERY account a buy/sell on them
 * touches, using packages/core's own PDA/state helpers, so the local validator clones exactly that set:
 *   - programs: pump, PumpSwap, pump fees, SPL Token, Token-2022 (upgradeable: program + programdata) and
 *     the ATA program (BPFLoader2: cloned as a plain executable account), so the fork runs mainnet's binaries
 *   - globals: pump Global, FeeConfig, GlobalVolumeAccumulator; PumpSwap GlobalConfig, FeeConfig,
 *     GlobalVolumeAccumulator; the wSOL mint
 *   - every fee recipient the builders may pick at random: curve normal / mayhem-reserved / buyback lists from
 *     the live Global, PumpSwap protocol / reserved / buyback lists from the live GlobalConfig (plus the
 *     constants fallbacks), and the quote ATAs PumpSwap pays into
 *   - per coin: mint, bonding curve, its token account, creator vault, sharing config; or pool, both vaults,
 *     coin-creator vault authority + quote ATA, pool-v2
 *   - for the migration coin, also what `migrate` and the first trade on its new canonical pool touch: the
 *     Global's withdraw authority, the coin-creator vault authority the pool inherits + its quote ATA, pool-v2,
 *     and the PumpSwap protocol / buyback recipients with their quote ATAs
 *   - the 8 Jito + 10 Helius Sender tip accounts (a tip into a missing account fails the rent check)
 * Accounts that may legitimately not exist go to --maybe-clone. User-side accounts (ATAs, volume
 * accumulators) are created by the trades themselves.
 *
 * Discovery (no mints passed) reads recent program activity: getSignaturesForAddress pages spread across
 * slots, then JSON-RPC-batched getTransaction (maxSupportedTransactionVersion 1: v1 transactions are live on
 * mainnet), retried with backoff over several rounds within a time budget (FORK_DISCOVERY_TIMEOUT_MS).
 *
 *   bun run packages/core/scripts/fork/accounts.ts [mint ...]   # prints targets + clone list as JSON
 */
import {
  type Address,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getAddressDecoder,
  isSolanaError,
  type RpcTransport,
  type Signature,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ammGlobalVolumeAccumulatorPda,
  BUYBACK_FEE_RECIPIENTS,
  bondingCurvePda,
  canonicalPoolPda,
  coinCreatorVaultAuthorityPda,
  creatorVaultPda,
  DEFAULT_PUBKEY,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeEventsFromLogs,
  decodeMint,
  decodePool,
  decodePumpGlobal,
  decodeTokenAccount,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  globalFeeRecipients,
  globalMayhemFeeRecipients,
  HELIUS_SENDER_TIP_ACCOUNTS,
  isCanonicalPumpPool,
  isSolCurve,
  JITO_TIP_ACCOUNTS_FALLBACK,
  MAYHEM_FEE_RECIPIENTS,
  MAYHEM_PROGRAM_ID,
  POOL_ACCOUNT_NEW_SIZE,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK,
  PUMP_FEE_CONFIG,
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_RECIPIENTS,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  PUMP_TOKEN_DECIMALS,
  type PumpGlobal,
  poolV2Pda,
  pumpGlobalVolumeAccumulatorPda,
  type RawAccount,
  SYSTEM_PROGRAM_ID,
  sharingConfigPda,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  tokenProgramFromMintOwner,
  WSOL_MINT,
} from "../../src";
import { type CloneList, cloneSourceUrl, type ForkTarget, redactUrl, sleep, type TargetKind, toJson } from "./env";

// ---------------------------------------------------------------------------------------------
// Read-only mainnet RPC: method allowlist + polite pacing/backoff for the public endpoint
// ---------------------------------------------------------------------------------------------

/** The only methods the fork tooling may call on mainnet. Anything that writes is refused outright. */
const READ_ONLY_METHODS = new Set([
  "getAccountInfo",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getSlot",
  "getVersion",
]);
/** The public endpoint allows ~5 getTransaction calls per 10 s per IP, so discovery stays frugal. */
const MIN_SPACING_MS = 250;
const MAX_ATTEMPTS = 8;

/** ms to wait before retrying, or null if the error is not transient. Honors Retry-After. */
function retryDelayMs(e: unknown, attempt: number): number | null {
  const backoff = Math.min(1_000 * 2 ** (attempt - 1), 10_000);
  if (isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    if (![429, 500, 502, 503, 504].includes(e.context.statusCode)) return null;
    const after = Number(e.context.headers?.get?.("retry-after"));
    return Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 15_000) : backoff;
  }
  // fetch-level failures: the endpoint resets connections while rate limiting
  if (e instanceof TypeError || (e instanceof Error && /timed? ?out|ECONNRESET|socket|connection/i.test(e.message))) return backoff;
  return null;
}

/** One pacer per endpoint, shared by the kit client and the batch client. */
const pacers = new Map<string, { nextAt: number }>();
async function pace(url: string, spacingMs: number): Promise<void> {
  let p = pacers.get(url);
  if (!p) {
    p = { nextAt: 0 };
    pacers.set(url, p);
  }
  const wait = p.nextAt - Date.now();
  p.nextAt = Math.max(Date.now(), p.nextAt) + spacingMs;
  if (wait > 0) await sleep(wait);
}

function assertReadOnly(method: unknown, url: string): void {
  if (typeof method !== "string" || !READ_ONLY_METHODS.has(method)) {
    throw new Error(`refusing to call ${String(method)} on ${redactUrl(url)}: mainnet is read-only for the fork tooling`);
  }
}

export function createReadOnlyRpc(url = cloneSourceUrl()) {
  const base = createDefaultRpcTransport({ url });
  const transport: RpcTransport = async <T>(config: Parameters<RpcTransport>[0]) => {
    assertReadOnly((config.payload as { method?: unknown })?.method, url);
    for (let attempt = 1; ; attempt++) {
      await pace(url, MIN_SPACING_MS);
      try {
        const res = await base<T>(config);
        const err = (res as { error?: { code?: number; message?: string } }).error;
        if (err && (err.code === 429 || /too many requests|rate limit/i.test(err.message ?? "")) && attempt < MAX_ATTEMPTS) {
          await sleep(Math.min(1_000 * 2 ** (attempt - 1), 10_000));
          continue;
        }
        return res;
      } catch (e) {
        const delay = retryDelayMs(e, attempt);
        if (delay === null || attempt >= MAX_ATTEMPTS) throw e;
        await sleep(delay);
      }
    }
  };
  return createSolanaRpcFromTransport(transport);
}

export type ReadOnlyRpc = ReturnType<typeof createReadOnlyRpc>;

export interface BatchCall {
  method: string;
  params: unknown[];
}

/** One answer of a batch: the result, or an error that is worth retrying later (`transient`) or not. */
export type BatchItem<T> = { ok: true; value: T } | { ok: false; transient: boolean; message: string };

interface JsonRpcError {
  code?: number;
  message?: string;
}

/** Rate limits and node hiccups; not "not found", decode or version errors. */
export function isTransientRpcError(err: JsonRpcError): boolean {
  return (
    err.code === 429 ||
    err.code === -32005 || // node is behind
    err.code === -32004 || // block not available for slot
    err.code === -32014 || // block status not yet available
    /too many requests|rate limit|timed? ?out|temporarily|unavailable/i.test(err.message ?? "")
  );
}

export type ReadOnlyBatch = <T>(calls: readonly BatchCall[]) => Promise<BatchItem<T>[]>;

/**
 * JSON-RPC batch client for read-only methods: several calls in one HTTP round trip, with the same
 * allowlist and pacing as createReadOnlyRpc. HTTP 429 / 5xx and connection resets are retried with
 * backoff (honoring Retry-After); per-call rate-limit errors come back as transient items for the caller to
 * retry. An endpoint that refuses batches is used one call per request from then on.
 */
export function createReadOnlyBatch(url = cloneSourceUrl(), fetchFn: typeof fetch = fetch): ReadOnlyBatch {
  let batching = true;
  const post = async (body: unknown, calls: number): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      await pace(url, MIN_SPACING_MS * Math.max(1, calls));
      const backoff = Math.min(1_000 * 2 ** (attempt - 1), 10_000);
      let res: Response;
      try {
        res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch (e) {
        if (attempt >= MAX_ATTEMPTS) throw e;
        await sleep(backoff);
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.status)) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`${redactUrl(url)} answered HTTP ${res.status} ${MAX_ATTEMPTS} times (rate limited)`);
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 15_000) : backoff);
        continue;
      }
      if (!res.ok) throw new Error(`${redactUrl(url)} answered HTTP ${res.status}`);
      return res.json();
    }
  };
  const item = <T>(r: unknown): BatchItem<T> => {
    const o = r as { result?: T; error?: JsonRpcError } | null;
    if (!o || typeof o !== "object") return { ok: false, transient: true, message: "no response" };
    if (o.error)
      return { ok: false, transient: isTransientRpcError(o.error), message: `${o.error.code ?? ""} ${o.error.message ?? ""}`.trim() };
    return { ok: true, value: o.result as T };
  };
  return async <T>(calls: readonly BatchCall[]): Promise<BatchItem<T>[]> => {
    for (const c of calls) assertReadOnly(c.method, url);
    if (batching && calls.length > 1) {
      const res = await post(
        calls.map((c, id) => ({ jsonrpc: "2.0", id, method: c.method, params: c.params })),
        calls.length,
      );
      if (Array.isArray(res)) {
        const byId = new Map(res.map((r) => [(r as { id?: unknown })?.id, r]));
        return calls.map((_c, id) => item<T>(byId.get(id)));
      }
      // A single error object instead of an array: the endpoint does not take batches.
      batching = false;
    }
    const out: BatchItem<T>[] = [];
    for (const [id, c] of calls.entries()) out.push(item<T>(await post({ jsonrpc: "2.0", id, method: c.method, params: c.params }, 1)));
    return out;
  };
}

// ---------------------------------------------------------------------------------------------
// Target classification
// ---------------------------------------------------------------------------------------------

const fmtSol = (lamports: bigint) => `${(Number(lamports) / 1e9).toFixed(3)} SOL`;

interface CurveCandidate {
  target: ForkTarget;
  /** Why it is unsuitable for the e2e suite (undefined = eligible). */
  reject?: string;
}

function classifyCurve(mint: Address, curveAddr: Address, mintAcc: RawAccount, curveAcc: RawAccount, global: PumpGlobal): CurveCandidate {
  const curve = decodeBondingCurve(curveAcc.data);
  const mintInfo = decodeMint(mintAcc.data, mintAcc.owner);
  const kind: TargetKind = curve.isMayhemMode ? "mayhem" : mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID ? "curve2022" : "curveSpl";
  const progress = Number(((global.initialRealTokenReserves - curve.realTokenReserves) * 10_000n) / global.initialRealTokenReserves) / 100;
  const target: ForkTarget = {
    kind,
    mint,
    venue: "pump",
    tokenProgram: mintInfo.tokenProgram,
    market: curveAddr,
    note:
      `${mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022" : "SPL Token"} curve, real SOL ${fmtSol(curve.realQuoteReserves)}, ` +
      `progress ${progress.toFixed(1)}%, supply ${mintInfo.supply}${curve.isHolderReward ? ", holder rewards" : ""}`,
  };
  let reject: string | undefined;
  if (curve.complete || curve.virtualTokenReserves === 0n) reject = "curve complete";
  else if (!isSolCurve(curve)) reject = `non-SOL quote ${curve.quoteMint}`;
  else if (curve.isCashbackCoin) reject = "cashback coin (deprecated)";
  else if (mintInfo.decimals !== PUMP_TOKEN_DECIMALS) reject = `decimals ${mintInfo.decimals}`;
  else if (curve.realTokenReserves < global.initialRealTokenReserves / 10n) reject = "within 10% of completion";
  return { target, reject };
}

/** Classifies curve mints in one getMultipleAccounts round trip. */
async function classifyCurveMints(rpc: ReadOnlyRpc, mints: Address[], global: PumpGlobal): Promise<CurveCandidate[]> {
  const curves = await Promise.all(mints.map((m) => bondingCurvePda(m)));
  const accs = await fetchRawAccounts(
    rpc,
    mints.flatMap((m, i) => [m, curves[i] as Address]),
  );
  const out: CurveCandidate[] = [];
  mints.forEach((mint, i) => {
    const mintAcc = accs[2 * i];
    const curveAcc = accs[2 * i + 1];
    if (mintAcc && curveAcc) out.push(classifyCurve(mint, curves[i] as Address, mintAcc, curveAcc, global));
  });
  return out;
}

interface PoolCandidate {
  target: ForkTarget;
  reject?: string;
}

async function classifyPools(rpc: ReadOnlyRpc, pools: Address[]): Promise<PoolCandidate[]> {
  const poolAccs = await fetchRawAccounts(rpc, pools);
  const decoded = pools.flatMap((addr, i) => {
    const acc = poolAccs[i];
    if (!acc || acc.owner !== PUMP_AMM_PROGRAM_ID) return [];
    try {
      return [{ addr, pool: decodePool(acc.data) }];
    } catch {
      return [];
    }
  });
  const extra = await fetchRawAccounts(
    rpc,
    decoded.flatMap(({ pool }) => [pool.baseMint, pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount]),
  );
  const out: PoolCandidate[] = [];
  for (const [i, { addr, pool }] of decoded.entries()) {
    const [mintAcc, baseVault, quoteVault] = [extra[3 * i], extra[3 * i + 1], extra[3 * i + 2]];
    if (!mintAcc || !baseVault || !quoteVault) continue;
    const mintInfo = decodeMint(mintAcc.data, mintAcc.owner);
    const base = decodeTokenAccount(baseVault.data).amount;
    const quote = decodeTokenAccount(quoteVault.data).amount;
    const canonical = await isCanonicalPumpPool(pool);
    const target: ForkTarget = {
      kind: "pumpswap",
      mint: pool.baseMint,
      venue: "pumpswap",
      tokenProgram: mintInfo.tokenProgram,
      market: addr,
      note:
        `${canonical ? "canonical" : "non-canonical"} pool, ${mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022" : "SPL Token"} base, ` +
        `quote vault ${fmtSol(quote)}, virtual quote ${pool.virtualQuoteReserves}`,
    };
    let reject: string | undefined;
    if (!canonical) reject = "not the canonical pump pool";
    else if (pool.quoteMint !== WSOL_MINT) reject = `quote ${pool.quoteMint}`;
    else if (pool.isMayhemMode) reject = "mayhem pool";
    else if (pool.isCashbackCoin) reject = "cashback coin (deprecated)";
    else if (pool.dataLength < POOL_ACCOUNT_NEW_SIZE) reject = "needs extend_account";
    else if (mintInfo.decimals !== PUMP_TOKEN_DECIMALS) reject = `decimals ${mintInfo.decimals}`;
    else if (quote < 1_000_000_000n || base === 0n) reject = "thin liquidity";
    out.push({ target, reject });
  }
  return out;
}

/** A second eligible Token-2022 curve coin becomes the migration target (see TargetKind). */
function asMigrationTarget(t: ForkTarget): ForkTarget {
  return { ...t, kind: "migration", note: `${t.note}; the armed suite completes and migrates it` };
}

/**
 * Classifies explicitly requested mints: active SOL curve first, else the canonical PumpSwap pool. The second
 * Token-2022 curve coin becomes the migration target, so `--reuse` keeps every kind.
 */
export async function classifyMints(rpc: ReadOnlyRpc, mints: Address[]): Promise<ForkTarget[]> {
  const [globalAcc] = await fetchRawAccounts(rpc, [PUMP_GLOBAL]);
  if (!globalAcc) throw new Error("pump Global not found on the clone source");
  const global = decodePumpGlobal(globalAcc.data);
  const out: ForkTarget[] = [];
  for (const mint of mints) {
    const [curveAddr, poolAddr] = await Promise.all([bondingCurvePda(mint), canonicalPoolPda(mint)]);
    const [mintAcc, curveAcc] = await fetchRawAccounts(rpc, [mint, curveAddr]);
    if (!mintAcc) throw new Error(`mint ${mint} not found`);
    if (curveAcc) {
      const c = classifyCurve(mint, curveAddr, mintAcc, curveAcc, global);
      if (!c.reject) {
        const duplicate = c.target.kind === "curve2022" && out.some((t) => t.kind === "curve2022");
        out.push(duplicate && !out.some((t) => t.kind === "migration") ? asMigrationTarget(c.target) : c.target);
        continue;
      }
      if (c.reject !== "curve complete") throw new Error(`${mint}: unsupported curve (${c.reject})`);
    }
    const [p] = await classifyPools(rpc, [poolAddr]);
    if (!p) throw new Error(`${mint}: no active bonding curve and no canonical PumpSwap pool`);
    if (p.reject) throw new Error(`${mint}: unsupported pool ${poolAddr} (${p.reject})`);
    out.push(p.target);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Auto-pick from recent program activity
// ---------------------------------------------------------------------------------------------

type DecodedEvents = ReturnType<typeof decodeEventsFromLogs>;

/** Discovery counters, for the summary and the failure message. */
export interface DiscoveryStats {
  signatures: number;
  slots: Set<bigint>;
  /** Transactions fetched and decoded, by version. */
  fetched: Record<string, number>;
  /** Calls answered with a rate-limit / node error (retried while the budget lasts). */
  throttled: number;
  /** Calls answered with a non-retryable error (e.g. a transaction version newer than 1). */
  failed: number;
}

export function newDiscoveryStats(): DiscoveryStats {
  return { signatures: 0, slots: new Set(), fetched: {}, throttled: 0, failed: 0 };
}

export const fetchedCount = (s: DiscoveryStats) => Object.values(s.fetched).reduce((a, b) => a + b, 0);

export function describeStats(s: DiscoveryStats): string {
  const versions = Object.entries(s.fetched)
    .map(([v, n]) => `${n} ${v === "legacy" ? v : `v${v}`}`)
    .join(", ");
  return (
    `${fetchedCount(s)} transactions${versions ? ` (${versions})` : ""} from ${s.signatures} signatures across ${s.slots.size} slots` +
    `${s.throttled ? `, ${s.throttled} throttled` : ""}${s.failed ? `, ${s.failed} unreadable` : ""}`
  );
}

interface SignatureRef {
  signature: string;
  slot: bigint;
}

/**
 * Newest first, at most `perSlot` per slot, round-robin over slots: one busy slot (a bot's bundle, one
 * coin's rush) cannot use up the budget, so the picks cover several recent slots and more coins.
 */
export function spreadAcrossSlots<T extends { slot: bigint }>(refs: readonly T[], perSlot: number): T[] {
  const bySlot = new Map<bigint, T[]>();
  for (const r of refs) bySlot.set(r.slot, [...(bySlot.get(r.slot) ?? []), r]);
  const slots = [...bySlot.keys()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const out: T[] = [];
  for (let round = 0; round < perSlot; round++) {
    for (const slot of slots) {
      const r = bySlot.get(slot)?.[round];
      if (r) out.push(r);
    }
  }
  return out;
}

export interface ScanBudget {
  /** Transactions to fetch at most in this scan. */
  maxTxs: number;
  /** getSignaturesForAddress pages (newest first, `pageSize` each) to read at most. */
  pages: number;
  pageSize: number;
  /** getTransaction calls per JSON-RPC batch. */
  batchSize: number;
  perSlot: number;
  /** Epoch ms after which the scan stops. */
  deadline: number;
}

interface TxJson {
  version?: number | "legacy";
  meta: { err: unknown; logMessages?: readonly string[] | null } | null;
}

/**
 * Reads the program's recent successful transactions (skipping signatures in `seen`) and hands their decoded
 * events to `onEvents` until it returns true or the budget runs out. Returns true when `onEvents` did.
 */
export async function scanProgram(
  rpc: ReadOnlyRpc,
  batch: ReadOnlyBatch,
  program: Address,
  budget: ScanBudget,
  seen: Set<string>,
  stats: DiscoveryStats,
  onEvents: (events: DecodedEvents) => Promise<boolean>,
): Promise<boolean> {
  let fetched = 0;
  let before: Signature | undefined;
  for (let page = 0; page < budget.pages && fetched < budget.maxTxs && Date.now() < budget.deadline; page++) {
    const sigs = await rpc
      .getSignaturesForAddress(program, { limit: budget.pageSize, commitment: "confirmed", ...(before ? { before } : {}) })
      .send();
    if (sigs.length === 0) break;
    before = sigs[sigs.length - 1]?.signature;
    const fresh: SignatureRef[] = [];
    for (const x of sigs) {
      if (x.err || seen.has(x.signature)) continue;
      seen.add(x.signature);
      fresh.push({ signature: x.signature, slot: BigInt(x.slot) });
      stats.slots.add(BigInt(x.slot));
    }
    stats.signatures += fresh.length;
    // Signatures whose fetch hit a rate limit get one more try at the end of the page.
    const queue: { ref: SignatureRef; tries: number }[] = spreadAcrossSlots(fresh, budget.perSlot).map((ref) => ({ ref, tries: 0 }));
    while (queue.length && fetched < budget.maxTxs && Date.now() < budget.deadline) {
      const chunk = queue.splice(0, Math.min(budget.batchSize, budget.maxTxs - fetched));
      let items: BatchItem<TxJson | null>[];
      try {
        items = await batch<TxJson | null>(
          chunk.map(({ ref }) => ({
            method: "getTransaction",
            params: [ref.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }],
          })),
        );
      } catch {
        // The endpoint kept refusing (HTTP 429 after every retry): give this scan up, the caller backs off.
        stats.throttled += chunk.length;
        return false;
      }
      for (const [i, it] of items.entries()) {
        const entry = chunk[i] as (typeof chunk)[number];
        if (!it.ok) {
          if (it.transient) {
            stats.throttled++;
            if (entry.tries < 1) queue.push({ ref: entry.ref, tries: entry.tries + 1 });
          } else stats.failed++;
          continue;
        }
        const tx = it.value;
        if (!tx?.meta || tx.meta.err) continue;
        fetched++;
        const v = String(tx.version ?? "legacy");
        stats.fetched[v] = (stats.fetched[v] ?? 0) + 1;
        if (await onEvents(decodeEventsFromLogs([...(tx.meta.logMessages ?? [])]))) return true;
      }
    }
  }
  return false;
}

export interface DiscoverOptions {
  log?: (line: string) => void;
  /** Kinds to look for (default: all). */
  kinds?: readonly TargetKind[];
  /** Mints already taken (e.g. passed explicitly); never picked again. */
  exclude?: readonly Address[];
  /** Read-only JSON-RPC batch client (default: createReadOnlyBatch on the clone source). */
  batch?: ReadOnlyBatch;
  /** Total time budget in ms (default FORK_DISCOVERY_TIMEOUT_MS or 180 s). */
  timeoutMs?: number;
  /** Rounds per required kind; each waits a little longer and reads newer activity (default 3). */
  rounds?: number;
  /** Receives the counters once discovery ends. */
  onStats?: (stats: DiscoveryStats) => void;
}

/** The kinds the e2e suites cannot run without. */
export const REQUIRED_KINDS: readonly TargetKind[] = ["curve2022", "pumpswap"];

/**
 * Finds one coin per kind from recent on-chain activity:
 *   curve2022  Token-2022 (create_v2) coin on the curve - required; from recent pump trades
 *   migration  a second Token-2022 curve coin for the armed migration snipe - optional; from the same scan
 *   mayhem     mayhem-mode curve - optional; from recent Mayhem-program activity (its agent trades via CPI)
 *   curveSpl   legacy SPL Token curve coin - optional; only if one shows up along the way (rare since create_v2)
 *   pumpswap   canonical wSOL pool - required; an SPL-base pool is preferred so both token programs are
 *              exercised across venues
 * Required kinds get up to `rounds` scans with backoff in between (the public endpoint throttles
 * getTransaction); everything stops at the time budget. Missing kinds are simply absent from the result.
 */
export async function discoverTargets(rpc: ReadOnlyRpc, opts: DiscoverOptions = {}): Promise<ForkTarget[]> {
  const log = opts.log ?? (() => {});
  const want = new Set<TargetKind>(opts.kinds ?? ["curve2022", "curveSpl", "mayhem", "migration", "pumpswap"]);
  const batch = opts.batch ?? createReadOnlyBatch();
  const rounds = opts.rounds ?? 3;
  const deadline = Date.now() + (opts.timeoutMs ?? Number(process.env.FORK_DISCOVERY_TIMEOUT_MS ?? 180_000));
  const stats = newDiscoveryStats();
  const seen = new Set<string>();
  // pump fills a 100-signature page in a few slots, so up to 3 per slot keeps the picks spread without running dry.
  const budget = (maxTxs: number, pages: number): ScanBudget => ({ maxTxs, pages, pageSize: 100, batchSize: 5, perSlot: 3, deadline });
  const [globalAcc] = await fetchRawAccounts(rpc, [PUMP_GLOBAL]);
  if (!globalAcc) throw new Error("pump Global not found on the clone source");
  const global = decodePumpGlobal(globalAcc.data);

  const found = new Map<TargetKind, ForkTarget>();
  const seenMints = new Set<string>(opts.exclude ?? []);
  const curveRejects = new Map<string, number>();
  const takeCurves = async (events: DecodedEvents) => {
    const mints = [...new Set(events.flatMap((e) => (e.kind === "pumpTrade" && !seenMints.has(e.mint) ? [e.mint] : [])))] as Address[];
    for (const m of mints) seenMints.add(m);
    if (mints.length === 0) return;
    for (const c of await classifyCurveMints(rpc, mints, global)) {
      if (c.reject) curveRejects.set(c.reject, (curveRejects.get(c.reject) ?? 0) + 1);
      else if (want.has(c.target.kind) && !found.has(c.target.kind)) {
        found.set(c.target.kind, c.target);
        log(`  picked ${c.target.kind.padEnd(9)} ${c.target.mint} (${c.target.note})`);
      } else if (c.target.kind === "curve2022" && want.has("migration") && !found.has("migration")) {
        const t = asMigrationTarget(c.target);
        found.set("migration", t);
        log(`  picked migration ${t.mint} (${t.note})`);
      }
    }
  };
  const backoff = async (round: number, why: string) => {
    const ms = Math.min(5_000 * round, deadline - Date.now());
    if (ms <= 0) return false;
    log(`  ${why}; retrying in ${(ms / 1000).toFixed(0)} s (${describeStats(stats)})`);
    await sleep(ms);
    return true;
  };

  // Curve coins: curve2022 is required (most recent coins can be ineligible: complete, cashback, near the end);
  // the migration coin rides along for up to 20 transactions per round.
  const curveKinds = (["curve2022", "migration", "curveSpl"] as const).filter((k) => want.has(k));
  if (curveKinds.length) {
    for (let round = 1; round <= rounds && Date.now() < deadline; round++) {
      let pumpTxs = 0;
      await scanProgram(rpc, batch, PUMP_PROGRAM_ID, budget(40, 4), seen, stats, async (ev) => {
        pumpTxs++;
        await takeCurves(ev);
        const coreDone = !want.has("curve2022") || found.has("curve2022");
        return coreDone && (!want.has("migration") || found.has("migration") || pumpTxs >= 20);
      });
      if (!want.has("curve2022") || found.has("curve2022")) break;
      if (round < rounds && !(await backoff(round, "no eligible Token-2022 curve coin yet"))) break;
    }
  }
  if (want.has("mayhem") && !found.has("mayhem") && Date.now() < deadline) {
    await scanProgram(rpc, batch, MAYHEM_PROGRAM_ID, budget(8, 1), seen, stats, async (ev) => {
      await takeCurves(ev);
      return found.has("mayhem");
    });
  }
  const curveWhy = [...curveRejects].map(([reason, n]) => `${n} ${reason}`).join(", ");
  if (curveKinds.length || want.has("mayhem")) {
    log(`  ${seenMints.size - (opts.exclude?.length ?? 0)} curve mints classified${curveWhy ? ` (ineligible: ${curveWhy})` : ""}`);
  }

  // PumpSwap: stop at the first eligible SPL-base pool, or at any eligible pool once 6 transactions were spent.
  if (want.has("pumpswap")) {
    const seenPools = new Set<string>();
    const eligiblePools: ForkTarget[] = [];
    const poolRejects = new Map<string, number>();
    for (let round = 1; round <= rounds && Date.now() < deadline; round++) {
      let poolTxsSeen = 0;
      await scanProgram(rpc, batch, PUMP_AMM_PROGRAM_ID, budget(15, 2), seen, stats, async (events) => {
        poolTxsSeen++;
        const pools = [
          ...new Set(events.flatMap((e) => ((e.kind === "ammBuy" || e.kind === "ammSell") && !seenPools.has(e.pool) ? [e.pool] : []))),
        ] as Address[];
        for (const p of pools) seenPools.add(p);
        for (const c of pools.length ? await classifyPools(rpc, pools) : []) {
          if (c.reject) poolRejects.set(c.reject, (poolRejects.get(c.reject) ?? 0) + 1);
          else if (!seenMints.has(c.target.mint)) eligiblePools.push(c.target);
        }
        return eligiblePools.some((t) => t.tokenProgram === TOKEN_PROGRAM_ID) || (eligiblePools.length > 0 && poolTxsSeen >= 6);
      });
      if (eligiblePools.length) break;
      if (round < rounds && !(await backoff(round, "no eligible PumpSwap pool yet"))) break;
    }
    const pool = eligiblePools.find((t) => t.tokenProgram === TOKEN_PROGRAM_ID) ?? eligiblePools[0];
    if (pool) {
      found.set("pumpswap", pool);
      log(`  picked pumpswap  ${pool.mint} (pool ${pool.market}, ${pool.note})`);
    }
    const why = [...poolRejects].map(([reason, n]) => `${n} ${reason}`).join(", ");
    log(`  ${seenPools.size} PumpSwap pools classified${why ? ` (ineligible: ${why})` : ""}`);
  }
  log(`  discovery read ${describeStats(stats)}`);
  opts.onStats?.(stats);

  const order: TargetKind[] = ["curve2022", "curveSpl", "mayhem", "migration", "pumpswap"];
  return order.flatMap((k) => {
    const t = found.get(k);
    return t ? [t] : [];
  });
}

// ---------------------------------------------------------------------------------------------
// Clone list
// ---------------------------------------------------------------------------------------------

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_V2 = "BPFLoader2111111111111111111111111111111111";
/** Programs every trade path executes. System and Compute Budget are builtins. */
const TRADE_PROGRAMS: readonly Address[] = [
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
];

/**
 * Resolves the full clone list for `targets` from LIVE mainnet state (Global / GlobalConfig fee recipient
 * lists, live curve creator, live pool coin creator). Required accounts are verified to exist.
 */
export async function resolveCloneList(rpc: ReadOnlyRpc, targets: readonly ForkTarget[]): Promise<CloneList> {
  const why: Record<string, string> = {};
  const required = new Set<Address>();
  const maybe = new Set<Address>();
  const need = (a: Address, reason: string) => {
    required.add(a);
    why[a] ??= reason;
  };
  const opt = (a: Address, reason: string) => {
    if (a === DEFAULT_PUBKEY || a === SYSTEM_PROGRAM_ID) return;
    maybe.add(a);
    why[a] ??= reason;
  };

  // Programs: upgradeable ones are cloned with their programdata; BPFLoader2 ones as plain accounts.
  const programAccs = await fetchRawAccounts(rpc, TRADE_PROGRAMS);
  const upgradeablePrograms: Address[] = [];
  const programAccounts: Address[] = [];
  TRADE_PROGRAMS.forEach((p, i) => {
    const acc = programAccs[i];
    if (!acc) throw new Error(`program ${p} not found on the clone source`);
    if (acc.owner === UPGRADEABLE_LOADER) upgradeablePrograms.push(p);
    else if (acc.owner === LOADER_V2) programAccounts.push(p);
    else throw new Error(`program ${p} has unexpected owner ${acc.owner}`);
    why[p] = "program";
  });

  const [globalAcc, ammCfgAcc] = await fetchRawAccounts(rpc, [PUMP_GLOBAL, PUMP_AMM_GLOBAL_CONFIG]);
  if (!globalAcc || !ammCfgAcc) throw new Error("pump Global / PumpSwap GlobalConfig not found");
  const global = decodePumpGlobal(globalAcc.data);
  const gc = decodeAmmGlobalConfig(ammCfgAcc.data);

  need(PUMP_GLOBAL, "pump Global");
  need(PUMP_FEE_CONFIG, "pump FeeConfig");
  need(await pumpGlobalVolumeAccumulatorPda(), "pump GlobalVolumeAccumulator");
  need(PUMP_AMM_GLOBAL_CONFIG, "PumpSwap GlobalConfig");
  need(PUMP_AMM_FEE_CONFIG, "PumpSwap FeeConfig");
  need(await ammGlobalVolumeAccumulatorPda(), "PumpSwap GlobalVolumeAccumulator");
  need(WSOL_MINT, "wSOL mint");

  // Exactly the sets the builders pick from at random: the live list, or the constants only when the live
  // list is empty (pickPumpFeeRecipient / pickBuybackFeeRecipient / pickAmmProtocolFeeRecipient).
  const liveOr = (live: readonly Address[], fallback: readonly Address[]) => {
    const l = live.filter((a) => a !== DEFAULT_PUBKEY && a !== SYSTEM_PROGRAM_ID);
    return l.length ? l : [...fallback];
  };
  const curveFee = liveOr(globalFeeRecipients(global), PUMP_FEE_RECIPIENTS);
  const curveMayhem = liveOr(globalMayhemFeeRecipients(global), MAYHEM_FEE_RECIPIENTS);
  const curveBuyback = liveOr(global.buybackFeeRecipients, BUYBACK_FEE_RECIPIENTS);
  const ammBuyback = liveOr(gc.buybackFeeRecipients, BUYBACK_FEE_RECIPIENTS);
  const ammProtocol = liveOr(gc.protocolFeeRecipients, PUMP_AMM_PROTOCOL_FEE_RECIPIENTS_FALLBACK);
  const ammReserved = liveOr([gc.reservedFeeRecipient, ...gc.reservedFeeRecipients], MAYHEM_FEE_RECIPIENTS);
  const hasCurve = targets.some((t) => t.venue === "pump");
  // Curve trades credit SOL directly to these, so they must exist (a small credit to a missing account fails rent).
  if (hasCurve) {
    for (const a of curveFee) need(a, "pump fee recipient (credited the protocol fee in SOL)");
    for (const a of curveBuyback) need(a, "pump buyback fee recipient (credited in SOL)");
  }
  if (targets.some((t) => t.kind === "mayhem"))
    for (const a of curveMayhem) need(a, "pump mayhem reserved fee recipient (credited in SOL)");
  for (const a of JITO_TIP_ACCOUNTS_FALLBACK) need(a, "Jito tip account");
  for (const a of HELIUS_SENDER_TIP_ACCOUNTS) need(a, "Helius Sender tip account");

  for (const t of targets) {
    if (t.venue === "pump") {
      const curveAddr = await bondingCurvePda(t.mint);
      const [curveAcc] = await fetchRawAccounts(rpc, [curveAddr]);
      if (!curveAcc) throw new Error(`bonding curve ${curveAddr} missing`);
      const curve = decodeBondingCurve(curveAcc.data);
      need(t.mint, `${t.kind} mint`);
      need(curveAddr, `${t.kind} bonding curve`);
      need(await findAssociatedTokenAddress(curveAddr, t.mint, t.tokenProgram), `${t.kind} bonding-curve token account`);
      // Live creator: fee sharing / holder rewards rewrite it, so derive the vault from the account.
      opt(await creatorVaultPda(curve.creator), `${t.kind} creator vault (live bonding_curve.creator)`);
      opt(await sharingConfigPda(t.mint), `${t.kind} sharing config`);
      if (t.kind === "migration") {
        // `migrate` credits the Global's withdraw authority with what the migration fee leaves after rent, and
        // the canonical pool it creates copies coin_creator from the curve. The first PumpSwap trade on that
        // pool then reads pool-v2 and credits the creator vault and fee-recipient quote ATAs.
        opt(global.withdrawAuthority, "pump withdraw authority (credited by migrate)");
        const vaultAuthority = await coinCreatorVaultAuthorityPda(curve.creator);
        opt(vaultAuthority, "migration coin: coin-creator vault authority of its future pool");
        opt(await findAssociatedTokenAddress(vaultAuthority, WSOL_MINT, TOKEN_PROGRAM_ID), "migration coin: coin-creator vault wSOL ATA");
        opt(await poolV2Pda(t.mint), "migration coin: pool-v2 PDA of its future pool");
        for (const r of [...ammProtocol, ...ammBuyback]) {
          opt(r, "PumpSwap fee recipient (read-only)");
          opt(await findAssociatedTokenAddress(r, WSOL_MINT, TOKEN_PROGRAM_ID), "PumpSwap fee recipient wSOL ATA");
        }
      }
    } else {
      const [poolAcc] = await fetchRawAccounts(rpc, [t.market]);
      if (!poolAcc) throw new Error(`pool ${t.market} missing`);
      const pool = decodePool(poolAcc.data);
      const [quoteMintAcc] = await fetchRawAccounts(rpc, [pool.quoteMint]);
      if (!quoteMintAcc) throw new Error(`quote mint ${pool.quoteMint} missing`);
      const quoteProgram = tokenProgramFromMintOwner(quoteMintAcc.owner);
      need(t.mint, "pumpswap base mint");
      need(pool.quoteMint, "pumpswap quote mint");
      need(t.market, "pumpswap pool");
      need(pool.poolBaseTokenAccount, "pumpswap pool base vault");
      need(pool.poolQuoteTokenAccount, "pumpswap pool quote vault");
      const vaultAuthority = await coinCreatorVaultAuthorityPda(pool.coinCreator);
      opt(vaultAuthority, "pumpswap coin-creator vault authority (live pool.coin_creator)");
      opt(await findAssociatedTokenAddress(vaultAuthority, pool.quoteMint, quoteProgram), "pumpswap coin-creator vault quote ATA");
      opt(await poolV2Pda(pool.baseMint), "pumpswap pool-v2 PDA");
      // PumpSwap only reads the recipients and credits their quote ATAs (creating missing ATAs at the payer's
      // expense), so the recipients are optional and the ATAs are cloned when they exist on mainnet.
      const protocol = pool.isMayhemMode ? ammReserved : ammProtocol;
      for (const r of protocol) {
        opt(r, "PumpSwap protocol fee recipient (read-only)");
        opt(await findAssociatedTokenAddress(r, pool.quoteMint, quoteProgram), "PumpSwap protocol fee recipient quote ATA");
      }
      for (const r of ammBuyback) {
        opt(r, "PumpSwap buyback fee recipient (read-only)");
        opt(await findAssociatedTokenAddress(r, pool.quoteMint, quoteProgram), "PumpSwap buyback fee recipient quote ATA");
      }
    }
  }

  // Required wins over optional (e.g. buyback recipients are SOL-credited by the curve but only read by
  // PumpSwap). Everything required must exist now, or the validator would refuse to start.
  const req = [...required];
  const accs = await fetchRawAccounts(rpc, req);
  const missing = req.filter((_, i) => !accs[i]);
  if (missing.length) {
    throw new Error(`required accounts missing on the clone source: ${missing.map((a) => `${a} (${why[a]})`).join(", ")}`);
  }
  return {
    upgradeablePrograms,
    programAccounts,
    accounts: req,
    maybeAccounts: [...maybe].filter((a) => !required.has(a)),
    why,
  };
}

// ---------------------------------------------------------------------------------------------
// Program binary fingerprints (prove the fork runs mainnet's code)
// ---------------------------------------------------------------------------------------------

/** Size of UpgradeableLoaderState::ProgramData metadata before the ELF. */
const PROGRAMDATA_HEADER = 45;

export interface ProgramElf {
  program: Address;
  loader: "upgradeable" | "loader2";
  sha256: string;
  bytes: number;
}

export async function programElfFingerprints(
  rpc: Parameters<typeof fetchRawAccounts>[0],
  programs: readonly Address[],
): Promise<ProgramElf[]> {
  const accs = await fetchRawAccounts(rpc, programs);
  const out: ProgramElf[] = [];
  const decoder = getAddressDecoder();
  for (const [i, program] of programs.entries()) {
    const acc = accs[i];
    if (!acc) throw new Error(`program ${program} missing`);
    let elf: Uint8Array;
    let loader: ProgramElf["loader"];
    if (acc.owner === UPGRADEABLE_LOADER) {
      const programData = decoder.decode(acc.data.subarray(4, 36));
      const [pd] = await fetchRawAccounts(rpc, [programData]);
      if (!pd) throw new Error(`programdata ${programData} of ${program} missing`);
      elf = pd.data.subarray(PROGRAMDATA_HEADER);
      loader = "upgradeable";
    } else {
      elf = acc.data;
      loader = "loader2";
    }
    out.push({ program, loader, sha256: new Bun.CryptoHasher("sha256").update(elf).digest("hex"), bytes: elf.length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI: print targets + clone list
// ---------------------------------------------------------------------------------------------

if (import.meta.main) {
  const rpc = createReadOnlyRpc();
  const mints = process.argv.slice(2).filter((a) => !a.startsWith("-")) as Address[];
  const log = (l: string) => console.error(l);
  log(`clone source ${redactUrl(cloneSourceUrl())} (read-only)`);
  const targets = mints.length ? await classifyMints(rpc, mints) : await discoverTargets(rpc, { log });
  const missing = REQUIRED_KINDS.filter((k) => !targets.some((t) => t.kind === k));
  if (missing.length) log(`warning: no ${missing.join(" / ")} target found; pass mints explicitly`);
  const clone = await resolveCloneList(rpc, targets);
  log(
    `clone list: ${clone.upgradeablePrograms.length} upgradeable programs, ${clone.programAccounts.length} program accounts, ` +
      `${clone.accounts.length} accounts, ${clone.maybeAccounts.length} maybe`,
  );
  console.log(toJson({ targets, clone }));
}
