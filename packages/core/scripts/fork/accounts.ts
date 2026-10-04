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

export function createReadOnlyRpc(url = cloneSourceUrl()) {
  const base = createDefaultRpcTransport({ url });
  let nextAt = 0;
  const transport: RpcTransport = async <T>(config: Parameters<RpcTransport>[0]) => {
    const method = (config.payload as { method?: unknown })?.method;
    if (typeof method !== "string" || !READ_ONLY_METHODS.has(method)) {
      throw new Error(`refusing to call ${String(method)} on ${redactUrl(url)}: mainnet is read-only for the fork tooling`);
    }
    for (let attempt = 1; ; attempt++) {
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      nextAt = Date.now() + MIN_SPACING_MS;
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

/**
 * Walks the most recent successful transactions that reference `program` (one getTransaction each) and
 * hands their decoded trade events to `onEvents` until it returns true or `maxTxs` are fetched.
 */
async function scanRecent(
  rpc: ReadOnlyRpc,
  program: Address,
  maxTxs: number,
  onEvents: (events: ReturnType<typeof decodeEventsFromLogs>) => Promise<boolean>,
): Promise<number> {
  const sigs = await rpc.getSignaturesForAddress(program, { limit: 50, commitment: "confirmed" }).send();
  let fetched = 0;
  for (const s of sigs) {
    if (s.err) continue;
    if (fetched >= maxTxs) break;
    fetched++;
    const tx = await rpc
      .getTransaction(s.signature as Signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" })
      .send()
      .catch(() => null);
    if (!tx?.meta || tx.meta.err) continue;
    if (await onEvents(decodeEventsFromLogs(tx.meta.logMessages ?? []))) break;
  }
  return fetched;
}

export interface DiscoverOptions {
  log?: (line: string) => void;
}

/**
 * Finds one coin per kind from recent on-chain activity, spending as few getTransaction calls as possible
 * (the public endpoint allows ~5 per 10 s):
 *   curve2022  Token-2022 (create_v2) coin on the curve - required; from recent pump trades
 *   migration  a second Token-2022 curve coin for the armed migration snipe - optional; from the same scan
 *   mayhem     mayhem-mode curve - optional; from recent Mayhem-program activity (its agent trades via CPI)
 *   curveSpl   legacy SPL Token curve coin - optional; only if one shows up along the way (rare since create_v2)
 *   pumpswap   canonical wSOL pool - required; an SPL-base pool is preferred so both token programs are
 *              exercised across venues
 */
export async function discoverTargets(rpc: ReadOnlyRpc, opts: DiscoverOptions = {}): Promise<ForkTarget[]> {
  const log = opts.log ?? (() => {});
  const [globalAcc] = await fetchRawAccounts(rpc, [PUMP_GLOBAL]);
  if (!globalAcc) throw new Error("pump Global not found on the clone source");
  const global = decodePumpGlobal(globalAcc.data);

  const found = new Map<TargetKind, ForkTarget>();
  const seenMints = new Set<string>();
  const curveRejects = new Map<string, number>();
  const takeCurves = async (events: ReturnType<typeof decodeEventsFromLogs>) => {
    const mints = [...new Set(events.flatMap((e) => (e.kind === "pumpTrade" && !seenMints.has(e.mint) ? [e.mint] : [])))] as Address[];
    for (const m of mints) seenMints.add(m);
    if (mints.length === 0) return;
    for (const c of await classifyCurveMints(rpc, mints, global)) {
      if (c.reject) curveRejects.set(c.reject, (curveRejects.get(c.reject) ?? 0) + 1);
      else if (!found.has(c.target.kind)) {
        found.set(c.target.kind, c.target);
        log(`  picked ${c.target.kind.padEnd(9)} ${c.target.mint} (${c.target.note})`);
      } else if (c.target.kind === "curve2022" && !found.has("migration")) {
        const t = asMigrationTarget(c.target);
        found.set("migration", t);
        log(`  picked migration ${t.mint} (${t.note})`);
      }
    }
  };

  // curve2022 is required (up to 30 transactions: at times most recent curve coins are ineligible); the
  // migration coin is worth up to 20.
  let pumpTxs = 0;
  let txs = await scanRecent(rpc, PUMP_PROGRAM_ID, 30, async (ev) => {
    pumpTxs++;
    await takeCurves(ev);
    return found.has("curve2022") && (found.has("migration") || pumpTxs >= 20);
  });
  if (!found.has("mayhem")) {
    txs += await scanRecent(rpc, MAYHEM_PROGRAM_ID, 8, async (ev) => {
      await takeCurves(ev);
      return found.has("mayhem");
    });
  }
  const curveWhy = [...curveRejects].map(([reason, n]) => `${n} ${reason}`).join(", ");
  log(`  ${txs} transactions, ${seenMints.size} curve mints classified${curveWhy ? ` (ineligible: ${curveWhy})` : ""}`);

  // Required: keep scanning up to 15 transactions, but stop at the first eligible pool once 6 transactions
  // have been spent looking for an SPL-base one.
  const seenPools = new Set<string>();
  const eligiblePools: ForkTarget[] = [];
  const poolRejects = new Map<string, number>();
  let poolTxsSeen = 0;
  const poolTxs = await scanRecent(rpc, PUMP_AMM_PROGRAM_ID, 15, async (events) => {
    poolTxsSeen++;
    const pools = [
      ...new Set(events.flatMap((e) => ((e.kind === "ammBuy" || e.kind === "ammSell") && !seenPools.has(e.pool) ? [e.pool] : []))),
    ] as Address[];
    for (const p of pools) seenPools.add(p);
    for (const c of pools.length ? await classifyPools(rpc, pools) : []) {
      if (c.reject) poolRejects.set(c.reject, (poolRejects.get(c.reject) ?? 0) + 1);
      else eligiblePools.push(c.target);
    }
    return eligiblePools.some((t) => t.tokenProgram === TOKEN_PROGRAM_ID) || (eligiblePools.length > 0 && poolTxsSeen >= 6);
  });
  const pool = eligiblePools.find((t) => t.tokenProgram === TOKEN_PROGRAM_ID) ?? eligiblePools[0];
  if (pool) {
    found.set("pumpswap", pool);
    log(`  picked pumpswap  ${pool.mint} (pool ${pool.market}, ${pool.note})`);
  }
  const why = [...poolRejects].map(([reason, n]) => `${n} ${reason}`).join(", ");
  log(`  ${poolTxs} transactions, ${seenPools.size} PumpSwap pools classified${why ? ` (ineligible: ${why})` : ""}`);

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
  const clone = await resolveCloneList(rpc, targets);
  log(
    `clone list: ${clone.upgradeablePrograms.length} upgradeable programs, ${clone.programAccounts.length} program accounts, ` +
      `${clone.accounts.length} accounts, ${clone.maybeAccounts.length} maybe`,
  );
  console.log(toJson({ targets, clone }));
}
