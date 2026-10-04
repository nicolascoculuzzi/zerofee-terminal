/**
 * Armed-order kit for the mainnet-fork e2e suite (armed.e2e.ts).
 *
 * The trading wallet lives in a real @zerofee/signer Vault and signs ONLY through SignerService with the
 * shipped policy (createSignerPolicy): firewall, then the daily spend tracker, then the vault's
 * non-extractable key. The armed builders sign their batches through the same service (armedSigner), and
 * right before anything is sent, the exact wire bytes are checked again with checkTransaction. Sends go through
 * SubmitRouter with one loopback-only RpcLane, as in the trade suites.
 *
 * The other actors are plain in-memory keypairs funded by the fork's faucet, because on mainnet they are not
 * the user's wallet either: the operator (creates and extends the lookup table) and "market" wallets (other
 * traders that move prices, and whoever calls the permissionless `migrate`).
 */
import { expect } from "bun:test";
import {
  AccountRole,
  type Address,
  type AddressesByLookupTableAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  type Instruction,
  lamports,
  pipe,
  type Signature,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";
import {
  AuditLog,
  checkTransaction,
  createSignerPolicy,
  type DailySpendCaps,
  type DailySpendTotals,
  type FirewallContext,
  MemoryStore,
  type SignerPolicy,
  SignerService,
  type SignRequest,
  type SpendState,
  SpendTracker,
  type StoredVault,
  type TransactionSummary,
  Vault,
} from "@zerofee/signer";
import { loopbackOnlyFetch, sleep, toJson } from "../scripts/fork/env";
import {
  type ArmedOrder,
  type ArmedOrderEvent,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  addressBytes,
  ammFeeRates,
  applyBuy,
  applySell,
  assembleTransaction,
  type BuiltTrade,
  bondingCurvePda,
  buildPumpBuyInstructions,
  buildTrade,
  bytesEqual,
  type ConfirmResult,
  canonicalPoolPda,
  confirmSignature,
  createLookupTableInstruction,
  createNonceSlotInstructions,
  currentInterfaceVersion,
  curveFeeRates,
  type DurableNonceRef,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodePool,
  decodePumpGlobal,
  decodeTokenAccount,
  extendLookupTableInstruction,
  type FeePlan,
  fetchLookupTables,
  fetchNonceRent,
  fetchNonceSlots,
  fetchRawAccounts,
  findAssociatedTokenAddress,
  globalFeeRecipients,
  globalMayhemFeeRecipients,
  HELIUS_SENDER_TIP_ACCOUNTS,
  JITO_TIP_ACCOUNTS_FALLBACK,
  LAMPORTS_PER_SOL,
  type LaneAck,
  type LatencyRecord,
  LatencyTracker,
  type LiveMarketState,
  type LookupTableState,
  liveMarketFromState,
  liveQuoteOut,
  loadTokenState,
  nonceSlotAddresses,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_PROGRAM_ID,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  type PumpCurveState,
  type PumpTradeContext,
  planFees,
  planLookupTableExtension,
  poolAuthorityPda,
  quoteAmmBuyExactQuoteIn,
  quoteAmmSell,
  quoteBuyExactQuoteIn,
  quoteBuyExactTokens,
  quoteSell,
  RpcLane,
  type SignedTx,
  type StalenessObservation,
  SubmitRouter,
  SYSTEM_PROGRAM_ID,
  SYSVAR_RENT_ID,
  setComputeUnitLimitInstruction,
  type TipSpec,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type TokenState,
  transactionSize,
  usableLookupTableAddresses,
  utf8,
  WSOL_MINT,
} from "../src";
import { appendReport, CLI_DEFAULTS, type Fork, fetchLandedTx, type LandedTx, type Wallet, waitConfirmed } from "./harness";

const U64_MAX = (1n << 64n) - 1n;
const b64 = getBase64Decoder();
const fromB64 = (wire: string) => new Uint8Array(getBase64Encoder().encode(wire));

/** Armed default tip levels: Jito bundle-only (one Jito tip + the jitodontfront marker), two levels. */
export const ARMED_TIP_LEVELS = [
  { tipLamports: 10_000n, cuPriceMicroLamports: 100_000n },
  { tipLamports: 50_000n, cuPriceMicroLamports: 200_000n },
] as const;

// ---------------------------------------------------------------------------------------------
// The trading wallet: vault + SignerService (shipped policy) + daily spend tracker
// ---------------------------------------------------------------------------------------------

/** Far below the OWASP floor: tests only (allowWeakKdfForTesting), like packages/signer's own tests. */
const TEST_KDF = { memoryKiB: 64, iterations: 1, parallelism: 1 };
const VAULT_PASSWORD = "armed e2e throwaway vault password";
/** Generous daily caps; the suite compares deltas with each order's ArmedCapCost. */
export const E2E_DAILY_CAPS: DailySpendCaps = { buyLamports: 20n * LAMPORTS_PER_SOL, feeLamports: LAMPORTS_PER_SOL };

export interface TradingWallet {
  address: Address;
  walletId: string;
  /** The user's main wallet bound into the vault (only an address here). */
  connectedWallet: Address;
  service: SignerService;
  spend: SpendTracker;
  audit: AuditLog;
  /** createSignerPolicy(): embedded allowlist, tip accounts, pump / PumpSwap rules and default caps. */
  policy: SignerPolicy;
  /** Nonce slots 0..n-1 (createWithSeed(wallet, "zerofee-nonce-<i>", System)). */
  slots: Address[];
  /** Operator lookup tables, filled once the table is active. Untrusted input to the signer. */
  tables: AddressesByLookupTableAddress;
}

export async function createTradingWallet(fork: Fork, opts: { sol: bigint; slotCount: number }): Promise<TradingWallet> {
  const vault = new Vault({
    storage: new MemoryStore<StoredVault>(),
    kdfParams: TEST_KDF,
    allowWeakKdfForTesting: true,
    autoLockMs: 3_600_000,
  });
  const connected = await generateKeyPairSigner();
  await vault.createVault(VAULT_PASSWORD, { connectedWallet: connected.address });
  const info = await vault.addWallet("armed e2e");
  const policy = createSignerPolicy();
  const spend = new SpendTracker({ storage: new MemoryStore<SpendState>(), caps: E2E_DAILY_CAPS });
  const audit = new AuditLog(2_000);
  const service = new SignerService({ vault, policy, spendTracker: spend, auditLog: audit });
  const sig = await fork.rpc.requestAirdrop(info.address, lamports(opts.sol * LAMPORTS_PER_SOL)).send();
  await waitConfirmed(fork.rpc, sig);
  return {
    address: info.address,
    walletId: info.id,
    connectedWallet: connected.address,
    service,
    spend,
    audit,
    policy,
    slots: await nonceSlotAddresses(info.address, opts.slotCount),
    tables: {},
  };
}

/** Per-request data a (possibly compromised) app passes to the signer: owned nonce slots and table contents. */
export function signRequest(tw: TradingWallet): SignRequest {
  return { ownedNonceAccounts: tw.slots, addressLookupTables: tw.tables };
}

/** The firewall context SignerService builds from the shipped policy, for the pre-send re-check. */
export function firewallContext(tw: TradingWallet): FirewallContext {
  return {
    signer: tw.address,
    connectedWallet: tw.connectedWallet,
    ownedNonceAccounts: tw.slots,
    allowedPrograms: tw.policy.allowedPrograms,
    tipAccounts: tw.policy.tipAccounts,
    caps: tw.policy.caps,
    venueRules: tw.policy.venueRules,
    addressLookupTables: tw.tables,
  };
}

/** checkTransaction on the exact bytes about to be sent; throws with the violations if refused. */
export async function firewallCheck(tw: TradingWallet, wireBase64: string): Promise<TransactionSummary> {
  const r = await checkTransaction(fromB64(wireBase64), firewallContext(tw));
  if (!r.ok) throw new Error(`the signer firewall refused the bytes about to be sent:\n  ${r.violations.join("\n  ")}`);
  return r.summary;
}

/** Signs one compiled transaction through SignerService (firewall + daily caps + vault key). */
export async function signThroughSigner(tw: TradingWallet, tx: Transaction): Promise<SignedTx & { summary: TransactionSummary }> {
  const { signedTransaction, signature, summary } = await tw.service.signTransaction(
    tw.walletId,
    new Uint8Array(getTransactionEncoder().encode(tx)),
    signRequest(tw),
  );
  return { wireBase64: b64.decode(signedTransaction), signature, size: signedTransaction.length, summary };
}

/**
 * kit TransactionPartialSigner backed by SignerService: what armOrders signs its batch with. Every variant and
 * cancel passes the firewall and is reserved against the daily caps before the vault key signs it.
 */
export function armedSigner(tw: TradingWallet): TransactionPartialSigner {
  return {
    address: tw.address,
    async signTransactions(transactions) {
      const out: Record<Address, SignatureBytes>[] = [];
      for (const tx of transactions) {
        const bytes = new Uint8Array(getTransactionEncoder().encode(tx));
        const { signedTransaction } = await tw.service.signTransaction(tw.walletId, bytes, signRequest(tw));
        // SignerService returns [1][signature][message]; it must have signed exactly the message we built.
        if (!bytesEqual(signedTransaction.subarray(65), new Uint8Array(tx.messageBytes)))
          throw new Error("the signer signed another message");
        out.push({ [tw.address]: signedTransaction.slice(1, 65) as SignatureBytes });
      }
      return out;
    },
  };
}

/** Runs `fn` and returns the change in the signer's daily totals it caused. */
export async function spendDelta<T>(
  tw: TradingWallet,
  fn: () => Promise<T>,
): Promise<{ result: T; buyLamports: bigint; feeLamports: bigint }> {
  const before: DailySpendTotals = await tw.spend.totals();
  const result = await fn();
  const after = await tw.spend.totals();
  return { result, buyLamports: after.buyLamports - before.buyLamports, feeLamports: after.feeLamports - before.feeLamports };
}

// ---------------------------------------------------------------------------------------------
// Landing (SubmitRouter + RpcLane) and the report
// ---------------------------------------------------------------------------------------------

export interface Landing {
  label: string;
  signature: Signature;
  firstAck: LaneAck | null;
  confirm: ConfirmResult;
  latency: LatencyRecord;
  tx: LandedTx;
}

interface LandMeta {
  label: string;
  venue: string;
  side: string;
  mint: string;
  cuLimit: number;
  priorityFee: bigint;
  tips: string;
  sizeBytes: number;
  simulatedUnits?: bigint;
  /** Blockhash transactions: the height after which they can no longer land. Durable-nonce ones never expire. */
  lastValidBlockHeight?: bigint;
  /** Market moves are scaffolding: kept out of the report unless asked. */
  record?: boolean;
}

/** Sends identical bytes through the router (rebroadcasting) until they land, then reads the landed tx back. */
export async function land(fork: Fork, wireBase64: string, signature: string, m: LandMeta): Promise<Landing> {
  const tracker = new LatencyTracker({
    side: m.side === "buy" ? "buy" : "sell",
    venue: m.venue === "pumpswap" ? "pumpswap" : "pump",
    mint: m.mint,
    dryRun: false,
  });
  // LIVE send - to the local fork only (the lane's fetch refuses any non-loopback URL).
  const router = new SubmitRouter({ lanes: [new RpcLane({ url: fork.rpcUrl, fetchFn: loopbackOnlyFetch })], dryRun: false });
  tracker.record.signature = signature;
  tracker.record.slotAtSend = await fork.rpc.getSlot({ commitment: "processed" }).send();
  const confirming = confirmSignature({
    rpc: fork.rpc,
    rpcSubscriptions: fork.rpcSubscriptions,
    signature: signature as Signature,
    lastValidBlockHeight: m.lastValidBlockHeight ?? U64_MAX,
    abortSignal: AbortSignal.timeout(30_000),
  });
  tracker.mark("sent");
  const { first, all } = router.send(wireBase64);
  const firstAck = await first;
  if (firstAck) tracker.mark("firstAck", firstAck.ackAt);
  const stop = new AbortController();
  void router.rebroadcast(wireBase64, stop.signal).catch(() => {});
  const confirm = await confirming;
  stop.abort();
  for (const ack of await all) tracker.laneAck(ack);
  if (confirm.status !== "confirmed" && confirm.status !== "failed") {
    throw new Error(`${m.label}: ${signature} did not land (${confirm.status}); lane ack: ${toJson(firstAck ?? (await all)[0], 0)}`);
  }
  tracker.landed(confirm.slot, confirm.observedAt);
  tracker.record.outcome = `${confirm.status}${confirm.err ? ` ${toJson(confirm.err, 0)}` : ""}`;
  const tx = await fetchLandedTx(fork.rpc, signature as Signature);
  if (m.record !== false) {
    appendReport(fork, {
      label: m.label,
      venue: m.venue,
      side: m.side,
      mint: m.mint,
      signature,
      slot: tx.slot.toString(),
      computeUnits: tx.computeUnits.toString(),
      simulatedUnits: m.simulatedUnits === undefined ? "" : m.simulatedUnits.toString(),
      cuLimit: m.cuLimit,
      sizeBytes: m.sizeBytes,
      fee: tx.fee.toString(),
      priorityFee: m.priorityFee.toString(),
      tips: m.tips,
      stages: tracker.record.stages,
      slotDelta: String(tracker.record.slotDelta ?? ""),
      outcome: tracker.record.outcome,
    });
  }
  return { label: m.label, signature: signature as Signature, firstAck, confirm, latency: tracker.record, tx };
}

const tipsLabel = (s: TransactionSummary) =>
  s.actions
    .flatMap((a) => (a.kind === "tip" ? [`${HELIUS_SENDER_TIP_ACCOUNTS.includes(a.to) ? "helius" : "jito"}:${a.lamports}`] : []))
    .join(",") || "-";

export interface ReportTags {
  label: string;
  venue: string;
  side: string;
  mint: string;
}

/** A trading-wallet blockhash transaction: assemble, sign through the signer, re-check the bytes, land. */
export async function sendUserTx(
  fork: Fork,
  tw: TradingWallet,
  args: ReportTags & {
    instructions: readonly Instruction[];
    fees: Pick<FeePlan, "cuLimit" | "cuPriceMicroLamports" | "tips" | "jitoDontFront">;
  },
): Promise<Landing & { summary: TransactionSummary; sizeBytes: number }> {
  const { value: blockhash } = await fork.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const tx = assembleTransaction({
    feePayer: tw.address,
    instructions: args.instructions,
    blockhash,
    fees: args.fees,
    tipAccounts: { jito: [...JITO_TIP_ACCOUNTS_FALLBACK] },
  });
  const signed = await signThroughSigner(tw, tx);
  const summary = await firewallCheck(tw, signed.wireBase64);
  const landing = await land(fork, signed.wireBase64, signed.signature, {
    ...args,
    cuLimit: args.fees.cuLimit,
    priorityFee: summary.priorityFeeLamports,
    tips: tipsLabel(summary),
    sizeBytes: signed.size,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });
  return { ...landing, summary, sizeBytes: signed.size };
}

/** A trade exactly as the CLI builds it (standard mode, CLI defaults), but signed by the vault through the firewall. */
export async function userTrade(
  fork: Fork,
  tw: TradingWallet,
  req: { label: string; mint: Address; side: "buy" | "sell"; amount: bigint },
): Promise<Landing & { summary: TransactionSummary; state: TokenState; trade: BuiltTrade }> {
  const state = await loadTokenState(fork.rpc, { mint: req.mint, user: tw.address });
  const trade = await buildTrade(state, { side: req.side, amount: req.amount, slippageBps: CLI_DEFAULTS.slippageBps });
  const plan = planFees({
    mode: CLI_DEFAULTS.landingMode,
    preset: CLI_DEFAULTS.speedPreset,
    cuLimit: trade.defaultCuLimit,
    prioritySamples: [],
    tipFloor: null,
    caps: { maxPriorityFeeLamports: CLI_DEFAULTS.maxPriorityFeeLamports, maxTipLamports: CLI_DEFAULTS.maxTipLamports },
    heliusSwqosTipLamports: CLI_DEFAULTS.heliusSwqosTipLamports,
    minCuPriceMicroLamports: CLI_DEFAULTS.minCuPriceMicroLamports,
  });
  const landing = await sendUserTx(fork, tw, {
    label: req.label,
    venue: state.venue,
    side: req.side,
    mint: req.mint,
    instructions: trade.instructions,
    fees: plan,
  });
  if (landing.tx.err !== null) throw new Error(`${req.label} failed: ${toJson(landing.tx.err, 0)}`);
  return { ...landing, state, trade };
}

/** Submits a stored armed transaction: firewall re-check on its exact bytes, optional simulation, then land. */
export async function submitArmed(
  fork: Fork,
  tw: TradingWallet,
  signed: SignedTx,
  tags: ReportTags & { simulate?: boolean },
): Promise<Landing & { summary: TransactionSummary }> {
  const summary = await firewallCheck(tw, signed.wireBase64);
  // Variants and cancels alike start by advancing one of the wallet's own nonce slots.
  if (!summary.durableNonce || !tw.slots.includes(summary.durableNonce.nonceAccount)) {
    throw new Error(`${tags.label}: not a durable-nonce transaction on one of the wallet's slots`);
  }
  let simulatedUnits: bigint | undefined;
  if (tags.simulate) {
    const sim = await fork.rpc
      .simulateTransaction(signed.wireBase64 as never, { encoding: "base64", commitment: "confirmed", sigVerify: true })
      .send();
    if (sim.value.err)
      throw new Error(`${tags.label}: simulation failed ${toJson(sim.value.err, 0)}\n${(sim.value.logs ?? []).join("\n")}`);
    simulatedUnits = sim.value.unitsConsumed;
  }
  const landing = await land(fork, signed.wireBase64, signed.signature, {
    ...tags,
    cuLimit: summary.computeUnitLimit ?? 0,
    priorityFee: summary.priorityFeeLamports,
    tips: tipsLabel(summary),
    sizeBytes: signed.size,
    ...(simulatedUnits !== undefined ? { simulatedUnits } : {}),
  });
  return { ...landing, summary };
}

/**
 * A transaction whose nonce already advanced can never land: the RPC's preflight refuses it, and sent without
 * preflight (as the production lanes do) it is dropped without executing or charging a fee. Returns the
 * preflight error. The bytes still pass the signer firewall: only the chain refuses them.
 */
export async function expectDead(fork: Fork, tw: TradingWallet, signed: SignedTx, watch: readonly Address[] = []): Promise<string> {
  await firewallCheck(tw, signed.wireBase64);
  const accounts = [tw.address, ...watch];
  const before = await Promise.all(accounts.map((a) => balanceOf(fork, a)));
  const preflight = new RpcLane({ url: fork.rpcUrl, name: "rpc-preflight", skipPreflight: false, fetchFn: loopbackOnlyFetch });
  const ack = await preflight.sendTransaction(signed.wireBase64);
  expect(ack.ok).toBe(false);
  // A durable-nonce tx whose nonce moved on is checked like an unknown blockhash.
  expect(ack.error).toMatch(/Blockhash not found/);
  const router = new SubmitRouter({ lanes: [new RpcLane({ url: fork.rpcUrl, fetchFn: loopbackOnlyFetch })], dryRun: false });
  await router.send(signed.wireBase64).first;
  const from = await fork.rpc.getSlot({ commitment: "confirmed" }).send();
  while ((await fork.rpc.getSlot({ commitment: "confirmed" }).send()) < from + 4n) await sleep(100);
  const { value } = await fork.rpc.getSignatureStatuses([signed.signature as Signature], { searchTransactionHistory: true }).send();
  expect(value[0]).toBeNull();
  expect(await Promise.all(accounts.map((a) => balanceOf(fork, a)))).toEqual(before);
  return ack.error ?? "";
}

// ---------------------------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------------------------

export async function balanceOf(fork: Fork, a: Address): Promise<bigint> {
  return BigInt((await fork.rpc.getBalance(a, { commitment: "confirmed" }).send()).value);
}

/** Token balance of a token account, or null when it does not exist. */
export async function tokenBalance(fork: Fork, account: Address): Promise<bigint | null> {
  const [acc] = await fetchRawAccounts(fork.rpc, [account]);
  return acc ? decodeTokenAccount(acc.data).amount : null;
}

export async function nonceRef(fork: Fork, tw: TradingWallet, index: number): Promise<DurableNonceRef> {
  const account = tw.slots[index];
  if (!account) throw new Error(`no nonce slot ${index}`);
  const [snap] = await fetchNonceSlots(fork.rpc, [account]);
  if (!snap) throw new Error(`nonce slot ${account} is missing or uninitialized`);
  return { account, authority: snap.authority, value: snap.value };
}

/** The slot advanced away from the value the order was signed against, and is still the wallet's. */
export async function expectNonceAdvanced(fork: Fork, tw: TradingWallet, ref: DurableNonceRef): Promise<void> {
  const [snap] = await fetchNonceSlots(fork.rpc, [ref.account]);
  expect(snap).not.toBeNull();
  expect(snap?.authority).toBe(tw.address);
  expect(snap?.value).not.toBe(ref.value);
}

/** The status-machine event the engine derives after seeing `landing` consume `nonce`. */
export function nonceConsumed(
  landing: Landing,
  nonce: DurableNonceRef,
  bySiblingOrderId?: string,
): Extract<ArmedOrderEvent, { type: "nonce-consumed" }> {
  return {
    type: "nonce-consumed",
    nonce: nonce.account,
    nonceValue: nonce.value,
    signature: landing.signature,
    success: landing.tx.err === null,
    slot: landing.tx.slot,
    ...(bySiblingOrderId ? { bySiblingOrderId } : {}),
  };
}

/** The trigger engine's market view, from the same state loadTokenState returns (core's liveMarketFromState). */
export function liveMarket(s: TokenState): LiveMarketState {
  return liveMarketFromState(s);
}

export function pumpContext(s: PumpCurveState, user: Address): PumpTradeContext {
  return {
    mint: s.mint,
    baseTokenProgram: s.mintInfo.tokenProgram,
    quoteTokenProgram: s.quoteTokenProgram,
    user,
    curve: s.curve,
    global: s.global,
  };
}

/** What the server would observe right now, for detectStaleness. */
export async function observe(fork: Fork, tw: TradingWallet, order: ArmedOrder): Promise<StalenessObservation> {
  const [curveAddr, pool, userAta] = await Promise.all([
    bondingCurvePda(order.mint),
    canonicalPoolPda(order.mint, order.frozen.quoteMint),
    findAssociatedTokenAddress(tw.address, order.mint, order.frozen.baseTokenProgram),
  ]);
  const [curveAcc, poolAcc, globalAcc, gcAcc, ataAcc] = await fetchRawAccounts(fork.rpc, [
    curveAddr,
    pool,
    PUMP_GLOBAL,
    PUMP_AMM_GLOBAL_CONFIG,
    userAta,
  ]);
  if (!globalAcc || !gcAcc) throw new Error("pump Global / PumpSwap GlobalConfig missing on the fork");
  const global = decodePumpGlobal(globalAcc.data);
  const gc = decodeAmmGlobalConfig(gcAcc.data);
  const curve = curveAcc ? decodeBondingCurve(curveAcc.data) : null;
  const livePool = poolAcc ? decodePool(poolAcc.data) : null;
  const slots = order.attempts.map((a) => a.nonce.account);
  const snaps = await fetchNonceSlots(fork.rpc, slots);
  return {
    curve: curve && {
      creator: curve.creator,
      complete: curve.complete,
      isMayhemMode: curve.isMayhemMode,
      isCashbackCoin: curve.isCashbackCoin,
    },
    pool: livePool && { coinCreator: livePool.coinCreator, isMayhemMode: livePool.isMayhemMode, isCashbackCoin: livePool.isCashbackCoin },
    feeRecipients: {
      pump: [...globalFeeRecipients(global), ...globalMayhemFeeRecipients(global)],
      pumpswap: [...gc.protocolFeeRecipients, gc.reservedFeeRecipient, ...gc.reservedFeeRecipients],
    },
    buybackFeeRecipients: { pump: global.buybackFeeRecipients, pumpswap: gc.buybackFeeRecipients },
    nonces: Object.fromEntries(slots.map((s, i) => [s, snaps[i] ?? null])),
    lookupTables: await fetchLookupTables(fork.rpc, order.frozen.lookupTables),
    currentSlot: await fork.rpc.getSlot({ commitment: "confirmed" }).send(),
    interfaceVersion: currentInterfaceVersion(),
    jitoTipAccounts: JITO_TIP_ACCOUNTS_FALLBACK,
    walletTokenBalance: ataAcc ? decodeTokenAccount(ataAcc.data).amount : 0n,
  };
}

// ---------------------------------------------------------------------------------------------
// Market wallets: other traders (and the migrate caller). Not the user's wallet, so no signer firewall.
// ---------------------------------------------------------------------------------------------

/** A plain keypair transaction (operator / market); lands like everything else. */
export async function plainTx(
  fork: Fork,
  wallet: Wallet,
  instructions: readonly Instruction[],
  meta: ReportTags & { cuLimit: number; record?: boolean },
): Promise<Landing> {
  const { value: bh } = await fork.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(wallet.address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions([setComputeUnitLimitInstruction(meta.cuLimit), ...instructions], m),
  );
  const tx = await signTransaction([wallet.keyPair], compileTransaction(msg));
  const signature = getBase58Decoder().decode(tx.signatures[wallet.address] as Uint8Array);
  const wire = b64.decode(new Uint8Array(getTransactionEncoder().encode(tx)));
  const landing = await land(fork, wire, signature, {
    ...meta,
    priorityFee: 0n,
    tips: "-",
    sizeBytes: transactionSize(tx),
    lastValidBlockHeight: bh.lastValidBlockHeight,
    record: meta.record ?? false,
  });
  if (landing.tx.err !== null) throw new Error(`${meta.label} failed: ${toJson(landing.tx.err, 0)}\n${landing.tx.logs.join("\n")}`);
  return landing;
}

/** The market after a trade of `amount` (buy: quote spent incl. fees; sell: base sold), by the venue's own math. */
export function marketAfter(market: LiveMarketState, side: "buy" | "sell", amount: bigint): LiveMarketState {
  if (market.venue === "pump") {
    const rates = curveFeeRates({ curve: market.curve, global: market.global, feeConfig: market.feeConfig, mintSupply: market.mintSupply });
    if (side === "buy") {
      const q = quoteBuyExactQuoteIn(market.curve, amount, rates);
      if (q.capped) throw new RangeError("the market buy would complete the curve");
      return { ...market, curve: applyBuy(market.curve, q) };
    }
    return { ...market, curve: applySell(market.curve, quoteSell(market.curve, amount, rates)) };
  }
  // The fork suite moves pump and PumpSwap markets only (no Raydium accounts are cloned).
  if (market.venue !== "pumpswap") throw new Error(`marketAfter does not model venue ${market.venue}`);
  const rates = ammFeeRates({
    pool: market.pool,
    isCanonical: market.isCanonical,
    reserves: market.reserves,
    baseMintSupply: market.baseMintSupply,
    feeConfig: market.feeConfig,
    globalConfig: market.globalConfig,
  });
  const r = market.reserves;
  if (side === "buy") {
    const q = quoteAmmBuyExactQuoteIn(r, amount, rates);
    // The pool's quote vault keeps the input and the LP fee; protocol and creator fees leave it.
    return {
      ...market,
      reserves: { ...r, baseReserve: r.baseReserve - q.baseOut, quoteVaultReserve: r.quoteVaultReserve + q.quoteIn + q.lpFee },
    };
  }
  const q = quoteAmmSell(r, amount, rates);
  return {
    ...market,
    reserves: { ...r, baseReserve: r.baseReserve + amount, quoteVaultReserve: r.quoteVaultReserve - (q.quoteOutGross - q.lpFee) },
  };
}

/**
 * Smallest market trade after which selling `position` quotes at least (dir "up": market buys, amount in
 * lamports) or at most (dir "down": market sells, amount in tokens) `target`. Exponential then binary search
 * over the venue math; never a trade that would complete a curve.
 */
export function marketMoveFor(market: LiveMarketState, position: bigint, target: bigint, dir: "up" | "down", max: bigint): bigint {
  const reached = (amount: bigint): boolean => {
    try {
      const q = liveQuoteOut("sell", position, marketAfter(market, dir === "up" ? "buy" : "sell", amount));
      return q !== null && (dir === "up" ? q >= target : q <= target);
    } catch (e) {
      if (e instanceof RangeError) return false;
      throw e;
    }
  };
  let hi = dir === "up" ? 10_000_000n : 1_000_000n;
  while (!reached(hi)) {
    if (hi >= max) throw new Error(`no market ${dir === "up" ? "buy" : "sale"} up to ${max} moves the quote to ${target}`);
    hi = hi * 2n > max ? max : hi * 2n;
  }
  let lo = 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (reached(mid)) hi = mid;
    else lo = mid + 1n;
  }
  return hi;
}

/**
 * Other traders move the price until selling `position` quotes past `target` (one market transaction sized by
 * the venue math, then verified on the fork). Returns the new live quote.
 */
export async function moveQuote(
  fork: Fork,
  market: Wallet,
  mint: Address,
  position: bigint,
  target: bigint,
  dir: "up" | "down",
): Promise<{ live: bigint; state: TokenState; amount: bigint }> {
  const s = await loadTokenState(fork.rpc, { mint, user: market.address });
  const max = dir === "up" ? 200n * LAMPORTS_PER_SOL : s.userBaseBalance;
  const amount = marketMoveFor(liveMarket(s), position, target, dir, max);
  const trade = await buildTrade(s, { side: dir === "up" ? "buy" : "sell", amount, slippageBps: 500, closeOnFullExit: false });
  await plainTx(fork, market, trade.instructions, {
    label: `market ${dir === "up" ? "buy" : "sell"}`,
    venue: s.venue,
    side: dir === "up" ? "buy" : "sell",
    mint,
    cuLimit: trade.defaultCuLimit,
  });
  const state = await loadTokenState(fork.rpc, { mint, user: market.address });
  const live = liveQuoteOut("sell", position, liveMarket(state));
  if (live === null || (dir === "up" ? live < target : live > target))
    throw new Error(`market move missed: live ${live}, target ${target}`);
  return { live, state, amount };
}

/** A plain market trade (e.g. to hold tokens for later sells). */
export async function marketTrade(fork: Fork, market: Wallet, mint: Address, side: "buy" | "sell", amount: bigint): Promise<Landing> {
  const s = await loadTokenState(fork.rpc, { mint, user: market.address });
  const trade = await buildTrade(s, { side, amount, slippageBps: 500, closeOnFullExit: false });
  return plainTx(fork, market, trade.instructions, { label: `market ${side}`, venue: s.venue, side, mint, cuLimit: trade.defaultCuLimit });
}

/** Buys every token left on the curve (exact tokens), completing it. */
export async function completeCurve(fork: Fork, market: Wallet, mint: Address): Promise<Landing> {
  const s = await loadTokenState(fork.rpc, { mint, user: market.address });
  if (s.venue !== "pump") throw new Error(`${mint} is not on its bonding curve`);
  const rates = curveFeeRates({ curve: s.curve, global: s.global, feeConfig: s.feeConfig, mintSupply: s.mintInfo.supply });
  const q = quoteBuyExactTokens(s.curve, s.curve.realTokenReserves, rates);
  const { instructions } = await buildPumpBuyInstructions(pumpContext(s, market.address), {
    mode: "exactTokens",
    amount: s.curve.realTokenReserves,
    limit: q.totalQuote,
  });
  return plainTx(fork, market, instructions, {
    label: "market: buy out the curve (exact tokens)",
    venue: "pump",
    side: "buy",
    mint,
    cuLimit: 200_000,
    record: true,
  });
}

const pda = async (program: Address, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const MIGRATE_DISCRIMINATOR = new Uint8Array([155, 234, 231, 146, 236, 158, 162, 30]);

/**
 * pump `migrate` (idl/pump.json, 25 accounts) plus the two boost accounts pump-sdk 2.0.0 appends
 * (migrateInstruction: boost_vault_authority = PumpSwap PDA ["boost_vault", pool], boost_vault = its wSOL ATA).
 * Permissionless once the curve is complete; `user` only pays the transaction fee and one account's rent.
 */
export async function migrateInstruction(args: {
  mint: Address;
  user: Address;
  withdrawAuthority: Address;
  baseTokenProgram: Address;
}): Promise<Instruction> {
  const { mint, baseTokenProgram } = args;
  const ata = findAssociatedTokenAddress;
  const [curve, pool, poolAuthority] = await Promise.all([bondingCurvePda(mint), canonicalPoolPda(mint), poolAuthorityPda(mint)]);
  const lpMint = await pda(PUMP_AMM_PROGRAM_ID, [utf8("pool_lp_mint"), addressBytes(pool)]);
  const boostVaultAuthority = await pda(PUMP_AMM_PROGRAM_ID, [utf8("boost_vault"), addressBytes(pool)]);
  const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
  const w = (address: Address) => ({ address, role: AccountRole.WRITABLE });
  return {
    programAddress: PUMP_PROGRAM_ID,
    data: MIGRATE_DISCRIMINATOR,
    accounts: [
      ro(PUMP_GLOBAL),
      w(args.withdrawAuthority),
      ro(mint),
      w(curve),
      w(await ata(curve, mint, baseTokenProgram)),
      { address: args.user, role: AccountRole.WRITABLE_SIGNER },
      ro(SYSTEM_PROGRAM_ID),
      ro(TOKEN_PROGRAM_ID),
      ro(PUMP_AMM_PROGRAM_ID),
      w(pool),
      w(poolAuthority),
      w(await ata(poolAuthority, mint, baseTokenProgram)),
      w(await ata(poolAuthority, WSOL_MINT, TOKEN_PROGRAM_ID)),
      ro(PUMP_AMM_GLOBAL_CONFIG),
      ro(WSOL_MINT),
      w(lpMint),
      w(await ata(poolAuthority, lpMint, TOKEN_2022_PROGRAM_ID)),
      w(await ata(pool, mint, baseTokenProgram)),
      w(await ata(pool, WSOL_MINT, TOKEN_PROGRAM_ID)),
      ro(TOKEN_2022_PROGRAM_ID),
      ro(ASSOCIATED_TOKEN_PROGRAM_ID),
      ro(await pda(PUMP_AMM_PROGRAM_ID, [utf8("__event_authority")])),
      ro(await pda(PUMP_PROGRAM_ID, [utf8("__event_authority")])),
      ro(PUMP_PROGRAM_ID),
      ro(SYSVAR_RENT_ID),
      ro(boostVaultAuthority),
      w(await ata(boostVaultAuthority, WSOL_MINT, TOKEN_PROGRAM_ID)),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Operator lookup table and nonce slots
// ---------------------------------------------------------------------------------------------

/**
 * Creates and extends the operator table, waits until every entry is usable (the slot after it was appended),
 * then until the last extension is finalized. Without that second wait, the first armed transaction (sent about
 * 12 slots after the extension, simulation clean, RPC ack ok) only landed 30 slots later through the router's
 * rebroadcasts, while every later one landed in the next slot. With it, the first one lands in the next slot
 * too. That is consistent with the leader resolving the table against a rooted bank when it takes the
 * transaction in, so the server should not arm against new entries before their extension is finalized.
 */
export async function createOperatorTable(
  fork: Fork,
  operator: Wallet,
  contents: readonly Address[],
): Promise<{ table: Address; state: LookupTableState; landings: Landing[]; usableSlot: bigint; finalizedAfterMs: number }> {
  const recentSlot = await fork.rpc.getSlot({ commitment: "finalized" }).send();
  const created = await createLookupTableInstruction({ authority: operator.address, payer: operator.address, recentSlot });
  const tags = { venue: "alt", side: "setup", mint: "-", record: true, cuLimit: 20_000 };
  const landings = [await plainTx(fork, operator, [created.instruction], { ...tags, label: "operator: create lookup table" })];
  for (const batch of planLookupTableExtension([], contents)) {
    const ix = extendLookupTableInstruction({
      table: created.address,
      authority: operator.address,
      payer: operator.address,
      addresses: batch,
    });
    landings.push(await plainTx(fork, operator, [ix], { ...tags, label: `operator: extend lookup table (+${batch.length})` }));
  }
  let state: LookupTableState | null | undefined;
  let usableSlot = 0n;
  for (;;) {
    state = (await fetchLookupTables(fork.rpc, [created.address]))[created.address];
    usableSlot = await fork.rpc.getSlot({ commitment: "confirmed" }).send();
    if (state && usableLookupTableAddresses(state, usableSlot).length === contents.length) break;
    await sleep(100);
  }
  const t0 = performance.now();
  while ((await fork.rpc.getSlot({ commitment: "finalized" }).send()) <= state.lastExtendedSlot) await sleep(200);
  return { table: created.address, state, landings, usableSlot, finalizedAfterMs: performance.now() - t0 };
}

/** Creates every slot of the wallet, `perTx` per transaction, each signed through the shipped firewall. */
export async function createNonceSlots(
  fork: Fork,
  tw: TradingWallet,
  perTx = 4,
): Promise<{ rent: bigint; landings: (Landing & { summary: TransactionSummary; sizeBytes: number })[] }> {
  const rent = await fetchNonceRent(fork.rpc);
  const landings: (Landing & { summary: TransactionSummary; sizeBytes: number })[] = [];
  for (let i = 0; i < tw.slots.length; i += perTx) {
    const instructions: Instruction[] = [];
    const end = Math.min(i + perTx, tw.slots.length);
    for (let index = i; index < end; index++) {
      const slot = await createNonceSlotInstructions({ wallet: tw.address, index, rentLamports: rent });
      if (slot.address !== tw.slots[index]) throw new Error(`slot ${index} derives to ${slot.address}`);
      instructions.push(...slot.instructions);
    }
    landings.push(
      await sendUserTx(fork, tw, {
        label: `nonce slots ${i}-${end - 1} (CreateAccountWithSeed + InitializeNonceAccount)`,
        venue: "system",
        side: "setup",
        mint: "-",
        instructions,
        fees: {
          cuLimit: 4_000 * (end - i),
          cuPriceMicroLamports: CLI_DEFAULTS.minCuPriceMicroLamports,
          tips: [] as TipSpec[],
          jitoDontFront: false,
        },
      }),
    );
  }
  return { rent, landings };
}

/** True while `target`'s bonding curve is still trading (a migration case can run only once per fork). */
export async function curveStillActive(fork: Fork, curve: Address): Promise<boolean> {
  const [acc] = await fetchRawAccounts(fork.rpc, [curve]);
  return acc !== null && acc !== undefined && !decodeBondingCurve(acc.data).complete;
}

// ---------------------------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------------------------

/** Size of the same message compiled WITHOUT lookup tables (every account a static key). */
export function sizeWithoutTables(signed: SignedTx, tables: AddressesByLookupTableAddress): number {
  const { messageBytes } = getTransactionDecoder().decode(fromB64(signed.wireBase64));
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: tables });
  const plain = {
    ...message,
    instructions: (message.instructions as readonly Instruction[]).map((ix) => ({
      ...ix,
      ...(ix.accounts ? { accounts: ix.accounts.map((a) => ({ address: a.address, role: a.role })) } : {}),
    })),
  } as unknown as typeof message;
  return transactionSize(compileTransaction(plain));
}
