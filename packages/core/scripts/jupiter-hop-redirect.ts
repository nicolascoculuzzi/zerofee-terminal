/**
 * Experiment behind the signer's Jupiter hop checks (read-only: simulation, never signs or sends).
 * Builds a real /build route for <wallet>, then points ONLY the hop's output account at <other>'s token
 * account (user_destination_token_account stays the wallet's ATA) and simulates both versions.
 *
 *   bun run packages/core/scripts/jupiter-hop-redirect.ts <wallet with SOL> <mint> <other holder of the mint> [buy|sell]
 *
 * 2026-10-03 results (NOTES.md): on a route_v2 (Meteora DAMM v2) the redirected version SUCCEEDED and
 * credited the other account while the wallet's destination stayed unchanged: Jupiter does not check a
 * route_v2 hop's accounts. On a shared_accounts_route_v2 (BONK, two hops) it failed with 6021
 * InvalidOutputTokenAccount. RPC_URL defaults to public mainnet.
 */
import { address, createSolanaRpc, type Instruction } from "@solana/kit";
import {
  assembleTransaction,
  buildTrade,
  DEFAULT_RPC_URL,
  findAssociatedTokenAddress,
  JUPITER_PROGRAM_ID,
  JUPITER_ROUTE_LAYOUTS,
  loadTokenState,
  planFees,
  toWireBase64,
} from "../src";

const [userArg, mintArg, otherArg, sideArg] = process.argv.slice(2);
if (!userArg || !mintArg || !otherArg) {
  console.error("usage: bun run packages/core/scripts/jupiter-hop-redirect.ts <wallet> <mint> <other holder> [buy|sell]");
  process.exit(1);
}
const rpc = createSolanaRpc(process.env.RPC_URL?.trim() || DEFAULT_RPC_URL);
const user = address(userArg);
const side = sideArg === "sell" ? "sell" : "buy";

const state = await loadTokenState(rpc, { mint: address(mintArg), user });
if (state.venue !== "jupiter") throw new Error(`${mintArg} resolves to ${state.venue}, not the Jupiter fallback`);
const trade = await buildTrade(state, { side, amount: side === "buy" ? 10_000_000n : state.userBaseBalance / 2n, slippageBps: 1500 });
const kind = trade.quote.jupiter!.instruction;
const L = JUPITER_ROUTE_LAYOUTS[kind];
const swapAt = trade.instructions.findIndex((ix) => ix.programAddress === JUPITER_PROGRAM_ID);
const swap = trade.instructions[swapAt]!;
const accounts = swap.accounts!;
const destination = accounts[L.destination]!.address;
// Where the hops credit the output: route_v2, the destination ATA itself; shared, Jupiter's program account.
const credited = kind === "route_v2" ? destination : accounts[JUPITER_ROUTE_LAYOUTS.shared_accounts_route_v2.programDestination]!.address;
const outputMint = side === "buy" ? state.mint : state.quoteMint;
const outputProgram = accounts[L.destinationTokenProgram]!.address;
const other = await findAssociatedTokenAddress(address(otherArg), outputMint, outputProgram);
const slots = accounts.flatMap((a, i) => (i >= L.fixedAccounts && a.address === credited ? [i] : []));
console.log(`${kind} via ${trade.quote.jupiter!.labels.join(" > ")}: redirecting hop slot(s) ${slots.join(", ")} to ${other}`);
const tampered: Instruction = { ...swap, accounts: accounts.map((a, i) => (slots.includes(i) ? { ...a, address: other } : a)) };

const { value: blockhash } = await rpc.getLatestBlockhash().send();
const fees = planFees({
  mode: "standard",
  preset: "fast",
  cuLimit: 400_000,
  prioritySamples: [],
  caps: { maxPriorityFeeLamports: 500_000n, maxTipLamports: 2_000_000n },
});
for (const [label, instructions] of [
  ["as built", trade.instructions],
  ["hop output redirected", trade.instructions.map((ix, i) => (i === swapAt ? tampered : ix))],
] as const) {
  const tx = assembleTransaction({ feePayer: user, instructions, blockhash, fees, lookupTables: trade.lookupTables });
  const config = {
    encoding: "base64",
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: [destination, other] },
  };
  const sim = await rpc.simulateTransaction(toWireBase64(tx) as never, config as never).send();
  const v = sim.value as unknown as { err: unknown; accounts: ({ data: [string, string] } | null)[] | null };
  const amount = (a: { data: [string, string] } | null | undefined) =>
    a ? new DataView(new Uint8Array(Buffer.from(a.data[0], "base64")).buffer).getBigUint64(64, true) : "n/a";
  const err = JSON.stringify(v.err, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
  console.log(
    `${label}: error ${err}; wallet's destination after ${amount(v.accounts?.[0])}, other account after ${amount(v.accounts?.[1])}`,
  );
  await Bun.sleep(1_500);
}
