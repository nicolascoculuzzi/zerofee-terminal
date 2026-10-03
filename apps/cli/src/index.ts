#!/usr/bin/env bun
/**
 * Developer trade harness.
 *   bun run trade buy  <mint> <sol>
 *   bun run trade sell <mint> <percent>
 *
 * DRY_RUN=true (default): build, sign (if a dev key is set), simulateTransaction, NEVER send.
 * With SIMULATE_AS=<address> (dry run only) the tx is built for that read-only fee payer and
 * simulated unsigned (sigVerify:false, replaceRecentBlockhash:true) - no key needed.
 */
import { type Address, createSolanaRpc, createSolanaRpcSubscriptions, type Signature, type Transaction } from "@solana/kit";
import {
  assembleTransaction,
  buildTrade,
  confirmSignature,
  type DecodedEvent,
  decodeEventsFromLogs,
  feePayerSignature,
  fetchHeliusPriorityFeeEstimate,
  fetchJitoTipAccounts,
  fetchJitoTipFloor,
  fetchPriorityFeeSamples,
  formatUnits,
  LatencyTracker,
  lanesForPlan,
  loadTokenState,
  PUMP_AMM_ERRORS,
  PUMP_ERRORS,
  parseUiAmount,
  planFees,
  SubmitRouter,
  signAssembled,
  type TipFloor,
  TOKEN_2022_PROGRAM_ID,
  type TokenState,
  toWireBase64,
  transactionSize,
  WSOL_MINT,
} from "@zerofee/core";
import { loadConfig, redactUrl } from "./config";
import { loadDevSigner } from "./keyAdapter";
import { assertWithinDailyLimit, recordSpend, spentToday } from "./spendLedger";

const USAGE = "usage:\n  bun run trade buy <mint> <sol>\n  bun run trade sell <mint> <percent>";

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

function explainError(err: unknown, logs: readonly string[] | null | undefined): string {
  const text = JSON.stringify(err, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
  const m = /"Custom":(\d+)/.exec(text);
  if (m) {
    const code = Number(m[1]);
    const program = (logs ?? []).find((l) => l.includes("failed: custom program error"))?.split(" ")[1] ?? "";
    const name = program.startsWith("pAMM") ? PUMP_AMM_ERRORS[code] : PUMP_ERRORS[code];
    return `${text}${name ? ` -> ${name}` : ""}`;
  }
  return text;
}

async function main() {
  const [side, mintArg, amountArg] = process.argv.slice(2);
  if ((side !== "buy" && side !== "sell") || !mintArg || !amountArg) fail(USAGE);

  const cfg = loadConfig();
  const mint = mintArg as Address;
  // Enforce MAX_BUY_SOL / MAX_DAILY_SPEND_SOL before any network I/O.
  const buyLamports = side === "buy" ? parseUiAmount(amountArg, 9) : 0n;
  if (side === "buy") {
    if (buyLamports <= 0n) fail("buy amount must be > 0");
    if (buyLamports > cfg.maxBuyLamports) {
      fail(`buy ${formatUnits(buyLamports, 9)} SOL exceeds MAX_BUY_SOL ${formatUnits(cfg.maxBuyLamports, 9)}`);
    }
    assertWithinDailyLimit(cfg.ledgerPath, buyLamports, cfg.maxDailySpendLamports);
  }
  const tracker = new LatencyTracker({ side, venue: "pump", mint, dryRun: cfg.dryRun });

  // --- signer / fee payer -------------------------------------------------------------------
  let user: Address;
  let signer: Awaited<ReturnType<typeof loadDevSigner>> = null;
  if (cfg.dryRun && cfg.simulateAs) {
    user = cfg.simulateAs;
  } else {
    signer = await loadDevSigner();
    if (!signer) fail("WALLET_PRIVATE_KEY is not set (or use SIMULATE_AS=<address> with DRY_RUN=true)");
    user = signer.address;
  }

  console.log(`mode      ${cfg.dryRun ? "DRY RUN (simulate only, never sends)" : "LIVE - WILL SEND"}`);
  console.log(`rpc       ${redactUrl(cfg.rpcUrl)}`);
  console.log(`fee payer ${user}${signer ? " (dev key)" : " (SIMULATE_AS, unsigned)"}`);

  const rpc = createSolanaRpc(cfg.rpcUrl);

  // --- state + tip data in parallel ---------------------------------------------------------
  const [state, tipAccounts, tipFloor, blockhash] = await Promise.all([
    loadTokenState(rpc, { mint, user }),
    fetchJitoTipAccounts(cfg.jitoRegion, { uuid: cfg.jitoUuid }),
    fetchJitoTipFloor().catch((e): TipFloor | null => {
      console.warn(`warn: tip floor unavailable (${e}); using lane minimums`);
      return null;
    }),
    rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send()
      .then((r) => r.value),
  ]);
  tracker.record.venue = state.venue;
  tracker.mark("stateLoaded");
  if (!tipAccounts.live) console.warn(`warn: Jito getTipAccounts failed (${tipAccounts.error}); using documented fallback list`);
  printState(state);

  // --- amount + limits ----------------------------------------------------------------------
  let amount: bigint;
  if (side === "buy") {
    amount = buyLamports;
    if (state.quoteMint !== WSOL_MINT) fail(`non-SOL quote (${state.quoteMint}) not supported by this CLI`);
  } else {
    const hundredths = parseUiAmount(amountArg, 2); // percent with 2 decimals
    if (hundredths <= 0n || hundredths > 10_000n) fail("percent must be in (0, 100]");
    if (state.userBaseBalance === 0n) fail(`${user} holds no ${mint}`);
    amount = hundredths === 10_000n ? state.userBaseBalance : (state.userBaseBalance * hundredths) / 10_000n;
    if (amount === 0n) fail("computed sell amount is 0");
  }

  // --- quote + instructions -----------------------------------------------------------------
  const trade = await buildTrade(state, { side, amount, slippageBps: cfg.slippageBps });
  tracker.mark("quoted");
  printQuote(state, trade.quote);

  // Helius RPC: use its estimator (primary per the notes); otherwise sample getRecentPrioritizationFees.
  const prioritySamples: (number | bigint)[] = cfg.rpcUrl.includes("helius-rpc.com")
    ? await fetchHeliusPriorityFeeEstimate(cfg.rpcUrl, [trade.hotAccount], cfg.speedPreset)
        .then((v) => [v])
        .catch(() => [])
    : await fetchPriorityFeeSamples(rpc, [trade.hotAccount]).catch(() => [] as number[]);
  const cuLimit = cfg.cuLimitOverride ?? trade.defaultCuLimit;
  const plan = planFees({
    mode: cfg.landingMode,
    preset: cfg.speedPreset,
    cuLimit,
    prioritySamples,
    tipFloor,
    caps: { maxPriorityFeeLamports: cfg.maxPriorityFeeLamports, maxTipLamports: cfg.maxTipLamports },
    heliusSwqosTipLamports: cfg.heliusSwqosTipLamports,
    minCuPriceMicroLamports: cfg.minCuPriceMicroLamports,
  });
  console.log(
    `fees      mode=${plan.mode} cuLimit=${plan.cuLimit} cuPrice=${plan.cuPriceMicroLamports}µL ` +
      `priority=${plan.priorityFeeLamports} lamports tips=${plan.tips.map((t) => `${t.lane}:${t.lamports}`).join(",")} ` +
      `(${prioritySamples.length} fee samples)`,
  );
  for (const w of plan.warnings) console.warn(`warn: ${w}`);

  const tx = assembleTransaction({
    feePayer: user,
    instructions: trade.instructions,
    blockhash,
    fees: plan,
    tipAccounts: { jito: tipAccounts.accounts },
  });
  tracker.mark("built");
  console.log(`tx        v0, ${transactionSize(tx)} bytes, ${trade.instructions.length} trade ixs + ${plan.tips.length} tip(s)`);

  let finalTx: Transaction = tx;
  if (signer) {
    finalTx = await signAssembled(tx, signer.keyPair);
    tracker.mark("signed");
  }
  const wire = toWireBase64(finalTx);

  // --- simulate (always) --------------------------------------------------------------------
  // Signed: verify signatures against the real blockhash. Unsigned (SIMULATE_AS): skip sig checks.
  const simConfig = signer
    ? ({ encoding: "base64", commitment: "confirmed", sigVerify: true } as const)
    : ({ encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true } as const);
  const sim = await rpc.simulateTransaction(wire as never, simConfig).send();
  tracker.mark("simulated");
  const v = sim.value;
  console.log(`\nsimulation (slot ${sim.context.slot}): ${v.err ? `FAILED ${explainError(v.err, v.logs)}` : "OK"}`);
  console.log(`unitsConsumed ${v.unitsConsumed ?? "?"} / limit ${plan.cuLimit}`);
  console.log("logs:");
  for (const l of v.logs ?? []) console.log(`  ${l}`);
  printSimulatedFill(trade.quote, decodeEventsFromLogs(v.logs ?? []));

  if (cfg.dryRun) {
    tracker.record.outcome = v.err ? "simulation failed" : "simulated ok (dry run, not sent)";
    console.log(`\n${tracker.format()}`);
    process.exit(v.err ? 2 : 0);
  }

  // --- LIVE send (DRY_RUN=false only) -------------------------------------------------------
  if (v.err) fail("simulation failed; refusing to send");
  if (!signer) fail("live send requires a signer");
  const signature = feePayerSignature(finalTx, user) as Signature | null;
  if (!signature) fail("transaction is not signed");
  const router = new SubmitRouter({
    lanes: lanesForPlan(plan, {
      heliusRegion: cfg.senderRegion,
      jitoRegion: cfg.jitoRegion,
      heliusApiKey: cfg.heliusSenderApiKey,
      jitoUuid: cfg.jitoUuid,
      heliusMevProtect: cfg.heliusMevProtect,
    }),
    dryRun: cfg.dryRun,
  });
  tracker.record.signature = signature;
  tracker.record.slotAtSend = await rpc.getSlot({ commitment: "processed" }).send();
  const confirm = confirmSignature({
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions(cfg.rpcWsUrl),
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
  tracker.record.outcome = `${result.status}${result.err ? ` ${json(result.err)}` : ""}`;
  if (result.status === "confirmed" && side === "buy") {
    recordSpend(cfg.ledgerPath, amount + plan.priorityFeeLamports + plan.totalTipLamports);
  }
  console.log(`\nsignature ${signature}`);
  console.log(tracker.format());
  console.log(`spent today ${formatUnits(spentToday(cfg.ledgerPath), 9)} SOL`);
}

/** Compares the event emitted by the simulated execution with our local quote. */
function printSimulatedFill(q: Awaited<ReturnType<typeof buildTrade>>["quote"], events: DecodedEvent[]) {
  const ev = events.find(
    (e): e is Extract<DecodedEvent, { kind: "pumpTrade" | "ammBuy" | "ammSell" }> =>
      e.kind === "pumpTrade" || e.kind === "ammBuy" || e.kind === "ammSell",
  );
  if (!ev) return console.log("simulated fill: no trade event in logs");
  if (ev.kind === "pumpTrade") {
    const got = q.side === "buy" ? ev.tokenAmount : ev.quoteAmount - ev.fee - ev.creatorFee;
    console.log(
      `simulated fill: tokens=${ev.tokenAmount} quoteNet=${ev.quoteAmount} fee=${ev.fee} creatorFee=${ev.creatorFee} ` +
        `-> ${q.side === "buy" ? "tokens" : "SOL out"} ${got} vs quoted ${q.expectedOut} (${got === q.expectedOut ? "EXACT MATCH" : `diff ${got - q.expectedOut}; state moved between fetch and simulation`})`,
    );
  } else {
    const got = ev.kind === "ammBuy" ? ev.baseAmount : ev.userQuoteAmount;
    console.log(
      `simulated fill: base=${ev.baseAmount} quote=${ev.quoteAmount} userQuote=${ev.userQuoteAmount} lpFee=${ev.lpFee} protocolFee=${ev.protocolFee} ` +
        `-> ${got} vs quoted ${q.expectedOut} (${got === q.expectedOut ? "EXACT MATCH" : `diff ${got - q.expectedOut}; state moved between fetch and simulation`})`,
    );
  }
}

function printState(s: TokenState) {
  if (s.venue === "pump") {
    console.log(
      `venue     pump bonding curve ${s.curveAddress} (${s.mintInfo.tokenProgram === TOKEN_2022_PROGRAM_ID ? "Token-2022" : "SPL Token"}` +
        `${s.curve.isMayhemMode ? ", MAYHEM" : ""}) vQ=${s.curve.virtualQuoteReserves} vT=${s.curve.virtualTokenReserves} creator=${s.curve.creator}`,
    );
  } else {
    console.log(
      `venue     PumpSwap pool ${s.poolAddress} (${s.isCanonical ? "canonical" : "non-canonical"}) base=${s.reserves.baseReserve} ` +
        `quoteVault=${s.reserves.quoteVaultReserve} virtualQuote=${s.reserves.virtualQuoteReserves}`,
    );
  }
  console.log(`balances  ${formatUnits(s.userLamports, 9)} SOL, ${formatUnits(s.userBaseBalance, s.mintInfo.decimals)} tokens`);
}

function printQuote(s: TokenState, q: Awaited<ReturnType<typeof buildTrade>>["quote"]) {
  const d = s.mintInfo.decimals;
  if (q.side === "buy") {
    console.log(
      `quote     spend ${formatUnits(q.amountIn, 9)} SOL -> ~${formatUnits(q.expectedOut, d)} tokens (min ${formatUnits(q.minOut, d)})`,
    );
  } else {
    console.log(
      `quote     sell ${formatUnits(q.amountIn, d)} tokens -> ~${formatUnits(q.expectedOut, 9)} SOL (min ${formatUnits(q.minOut, 9)})`,
    );
  }
  console.log(
    `          fees protocol=${q.feesQuote.protocol} (${q.feeBps.protocol}bps, buyback ${q.feesQuote.buyback}) creator=${q.feesQuote.creator} (${q.feeBps.creator}bps) lp=${q.feesQuote.lp} (${q.feeBps.lp}bps)`,
  );
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
