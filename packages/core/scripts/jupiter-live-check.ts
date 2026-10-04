/**
 * Live check of the Jupiter fallback end to end, read-only (never signs, never sends):
 *   loadTokenState -> buildTrade (/build) -> planFees -> assembleTransaction -> the signer firewall
 *   (createSignerPolicy, fed the lookup tables as they are ON CHAIN, not as Jupiter described them)
 *   -> simulateTransaction (unsigned, replaceRecentBlockhash) in every landing mode.
 *
 *   SIMULATE_AS=<wallet> bun run packages/core/scripts/jupiter-live-check.ts <mint> buy <sol>
 *   SIMULATE_AS=<wallet holding the token> bun run packages/core/scripts/jupiter-live-check.ts <mint> sell <percent>
 *
 * RPC_URL (default public mainnet) and JUPITER_API_KEY are optional. Prints CU, size and the firewall
 * summary per mode; exits 1 if anything is refused or fails.
 */
import { type Address, address, createSolanaRpc } from "@solana/kit";
import { checkTransaction, createSignerPolicy } from "@zerofee/signer";
import {
  assembleTransaction,
  buildTrade,
  DEFAULT_RPC_URL,
  fetchLookupTables,
  jupiterCuLimitFromSimulation,
  type LandingMode,
  loadTokenState,
  MAX_COMPUTE_UNIT_LIMIT,
  parseUiAmount,
  planFees,
  toAddressesByLookupTable,
  toWireBase64,
  transactionSize,
} from "../src";

const [mintArg, side, amountArg] = process.argv.slice(2);
const user = process.env.SIMULATE_AS?.trim();
if (!mintArg || (side !== "buy" && side !== "sell") || !amountArg || !user) {
  console.error("usage: SIMULATE_AS=<wallet> bun run packages/core/scripts/jupiter-live-check.ts <mint> buy <sol> | sell <percent>");
  process.exit(1);
}
const rpc = createSolanaRpc(process.env.RPC_URL?.trim() || DEFAULT_RPC_URL);
const policy = createSignerPolicy();
const caps = { maxPriorityFeeLamports: 500_000n, maxTipLamports: 2_000_000n };
const SLIPPAGE_BPS = 1500;

const state = await loadTokenState(rpc, { mint: address(mintArg), user: address(user) });
if (state.venue !== "jupiter") throw new Error(`${mintArg} resolves to ${state.venue}: not a long-tail token`);
const amount =
  side === "buy"
    ? parseUiAmount(amountArg, 9)
    : amountArg === "100"
      ? state.userBaseBalance
      : (state.userBaseBalance * parseUiAmount(amountArg, 2)) / 10_000n;
if (amount <= 0n) throw new Error("nothing to trade");

let failed = false;
for (const mode of ["standard", "turbo", "protected"] as LandingMode[]) {
  const trade = await buildTrade(
    state,
    { side, amount, slippageBps: SLIPPAGE_BPS },
    { jupiter: { apiKey: process.env.JUPITER_API_KEY?.trim() || undefined, forJitoBundle: mode === "protected" } },
  );
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const plan = (cuLimit: number) =>
    planFees({ mode, preset: "fast", cuLimit, prioritySamples: [], caps, minCuPriceMicroLamports: 100_000n });
  const build = (cuLimit: number) =>
    assembleTransaction({
      feePayer: address(user),
      instructions: trade.instructions,
      blockhash,
      fees: plan(cuLimit),
      lookupTables: trade.lookupTables,
    });
  const sim = (wire: string) =>
    rpc
      .simulateTransaction(wire as never, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true })
      .send();

  const probe = await sim(toWireBase64(build(MAX_COMPUTE_UNIT_LIMIT)));
  const cuLimit = probe.value.unitsConsumed ? jupiterCuLimitFromSimulation(probe.value.unitsConsumed) : trade.defaultCuLimit;
  const tx = build(cuLimit);
  // The signer is handed the tables as they are on chain (what the runtime will resolve).
  const tableAddresses = Object.keys(trade.lookupTables ?? {}) as Address[];
  const onChain = toAddressesByLookupTable(await fetchLookupTables(rpc, tableAddresses));
  const verdict = await checkTransaction(new Uint8Array(Buffer.from(toWireBase64(tx), "base64")), {
    signer: address(user),
    connectedWallet: address(user),
    ownedNonceAccounts: [],
    ...policy,
    addressLookupTables: onChain,
    expectations: [
      {
        instruction: 2 + trade.instructions.findIndex((ix) => ix.programAddress.startsWith("JUP6")),
        expectedOut: trade.quote.expectedOut,
        slippageBps: SLIPPAGE_BPS,
      },
    ],
  });
  const result = await sim(toWireBase64(tx));
  const ok = verdict.ok && !result.value.err;
  failed ||= !ok;
  console.log(
    `${mode.padEnd(9)} ${trade.quote.jupiter?.instruction} via ${trade.quote.jupiter?.labels.join(" > ")}: ` +
      `${transactionSize(tx)} B, ${tableAddresses.length} table(s), CU ${result.value.unitsConsumed} / limit ${cuLimit}, ` +
      `firewall ${verdict.ok ? "PASS" : "REFUSED"}, simulation ${result.value.err ? `FAILED ${JSON.stringify(result.value.err)}` : "OK"}`,
  );
  if (!verdict.ok) for (const v of verdict.violations) console.log(`  - ${v}`);
  else if (mode === "standard") for (const line of verdict.summary.lines) console.log(`  | ${line}`);
  await Bun.sleep(2_500); // keyless /build: 0.5 RPS
}
process.exit(failed ? 1 : 0);
