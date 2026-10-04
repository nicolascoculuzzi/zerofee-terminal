/**
 * Dev tool: writes test/fixtures/market-cap.json - the real mainnet transactions and accounts behind the
 * market-cap regression tests (test/marketCap.test.ts). They were picked from a 10-minute public-RPC run of
 * the server on 2026-10-04 that flagged every token whose market cap looked implausible (NOTES.md).
 * Read-only: getTransaction (json, v1) and getMultipleAccounts (base64, confirmed). No keys, nothing sent.
 *   bun run apps/server/scripts/record-market-cap-fixtures.ts
 */
import type { Address } from "@solana/kit";
import { bondingCurvePda, DEFAULT_RPC_URL } from "@zerofee/core";

const RPC = process.env.RPC_URL ?? DEFAULT_RPC_URL;

/** label -> signature */
const TXS: Record<string, string> = {
  // MHK: create_v2 of a mayhem coin (CreateEvent token_total_supply 1e15; two MintTo of 1e15) + the dev buy
  "mayhem-create": "2FCBGU2avg2hbMx4jUmygZFGGHhskw7Bj3qZSpfADfZ9RJLqLVVuJDDoTeWqK32s2XTMs1gaXSurwTG85pGFYugF",
  // MHK: the mayhem agent's sell through the Mayhem program; the curve's virtual SOL drops from 30 to 20.17 SOL
  "mayhem-agent-sell": "kyCQp5519BLYsNNTmsZ73zcRgNZXbWhbqt6WvP1byxnisRbw7Pne2DNCQukzf4KnNBoLuBctvHZ7STFpR2MXKeB",
  // MHK, six minutes later: virtual SOL offset 0.53 SOL, on-chain implied MC ~1 SOL with the 2B mint supply
  "mayhem-agent-buy-late": "5V67DtqZqKdkoqVA2zniBp2EVtkHBjkbPL8AxiE3Ez4RMzaHsXLbz8bd7cJq6jKTzbgsGSaFGT9D6P8v4KRWrgYM",
  // BOOTY: create_v2 of a USDC-quoted mayhem coin + the dev buy
  "usdc-mayhem-create": "4nzNvz5eVTHwSYrSKUpxrLiXQXifD8FpMxjcjZKc5fDB256J9rBJH8utuZ8MMRcgi8x66jGrpJSB4H5eYjdVkhZj",
  // ted: create_v2 quoted in SPYx (an xStock: no SOL value known to the server)
  "exotic-create": "4kXw1cVEaoKSgH7dBbzdk2oWe3UehCds5phfumJ3yez9N6TaxxfaCWUjRUczao5jks9b1NvovovMZgqaNQtvEk7n",
  // HALH: sell in a drained mayhem PumpSwap pool; the event's base_supply is 1e15, the mint holds ~2e15
  "mayhem-pool-sell": "4L4LjiEvpgRh8xoYChSrM4QzkjC4ThGPUN23rrtcSAUCNd1jncAhfgZkh7NFw9FdbYB6Wep798ZxRiDdPbHw8yvn",
  // GMk6j2: arbitrage buying in a third-party GMk6/PUMP pool and selling in the canonical GMk6/wSOL pool
  "arb-third-party-pool": "4LYf7b9iR3EhFGTfvir4xg2F7gstsD7XJFdpMcXZBzsDJ8BX2vnnusKRFVpq18yG4S2BHZj2k3MJx8PpM13CLrvt",
};

const MHK = "FaNi7NixrJqkMgqYFazFxv77KZcVW2GC64P65qBSpump";
/** label -> address (the MHK curve PDA is derived below) */
const ACCOUNTS: Record<string, string> = {
  "mhk-mint": MHK,
  "halh-mint": "DD8sR4dwMJKuUvzczuJGenZutvAbgiNTW7zzr31vpump",
  "halh-pool": "8rsc3NYZQsgp3iiBb3gPASHCsNnEnvgsFeRh7Xb4vJ4Q",
  "gmk6-mint": "GMk6j2defJhS7F194toqmJNFNhAkbDXhYJo5oR3Rpump",
  "gmk6-canonical-pool": "FDtu6W24K2iyW9Ce9NsTyVSmSGjxj2hHrTkKc2xFTxSL",
  "gmk6-pump-pool": "DDRz2Mrbb6UHfPSLHaeTTNBLqDuHMXDQT2cxtRjt9udG",
  "pump-mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
  "spyx-mint": "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
};

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 8) {
      await Bun.sleep(2_000 * (attempt + 1));
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error && attempt < 8) {
      console.warn(`  ${method}: ${j.error.message}; retrying`);
      await Bun.sleep(5_000);
      continue;
    }
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }
}

/** Keeps only what decoders and source parsers read (same shape as packages/core/test/fixtures/event-txs.json). */
function slimTx(tx: Record<string, unknown>): Record<string, unknown> {
  const t = tx.transaction as { signatures: string[]; message: Record<string, unknown> };
  const m = tx.meta as Record<string, unknown>;
  const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    version: tx.version,
    transaction: {
      signatures: t.signatures,
      message: pick(t.message, ["header", "accountKeys", "recentBlockhash", "instructions", "addressTableLookups"]),
    },
    meta: pick(m, ["err", "fee", "logMessages", "innerInstructions", "loadedAddresses", "preTokenBalances", "postTokenBalances"]),
  };
}

const txs: { labels: string[]; signature: string; tx: Record<string, unknown> }[] = [];
for (const [label, signature] of Object.entries(TXS)) {
  const tx = await rpc<Record<string, unknown> | null>("getTransaction", [
    signature,
    { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!tx) throw new Error(`${label}: transaction not found`);
  txs.push({ labels: [label], signature, tx: slimTx(tx) });
  console.log(`fetched ${label}`);
  await Bun.sleep(1_500);
}

const accounts: Record<string, string> = { ...ACCOUNTS, "mhk-curve": await bondingCurvePda(MHK as Address) };
const labels = Object.keys(accounts);
const r = await rpc<{ context: { slot: number }; value: ({ data: [string, string]; owner: string; lamports: number } | null)[] }>(
  "getMultipleAccounts",
  [labels.map((l) => accounts[l]), { encoding: "base64", commitment: "confirmed" }],
);
const accountFixtures: Record<string, { address: string; owner: string; data: string }> = {};
labels.forEach((l, i) => {
  const a = r.value[i];
  if (!a) throw new Error(`${l}: account not found`);
  accountFixtures[l] = { address: accounts[l] as string, owner: a.owner, data: a.data[0] };
});

const out = new URL("../test/fixtures/market-cap.json", import.meta.url);
await Bun.write(
  out,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), rpc: RPC, accountsSlot: r.context.slot, txs, accounts: accountFixtures }, null, 1)}\n`,
);
console.log(`wrote ${Bun.fileURLToPath(out)}: ${txs.length} transactions, ${labels.length} accounts at slot ${r.context.slot}`);
