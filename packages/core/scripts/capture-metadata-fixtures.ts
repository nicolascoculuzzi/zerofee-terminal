/**
 * Dev tool: snapshots the mint / metadata / pool / curve accounts behind the event fixtures into
 * test/fixtures/metadata-accounts.json (read-only RPC; no keys).
 *   bun run packages/core/scripts/capture-metadata-fixtures.ts
 */
import { address, createSolanaRpc, getBase64Decoder } from "@solana/kit";
import { DEFAULT_RPC_URL, fetchRawAccounts, metaplexMetadataPda } from "../src";

const rpc = createSolanaRpc(process.env.RPC_URL ?? DEFAULT_RPC_URL);
const V2_MINT = address("F62MDKs1XcNtTFmh6aeCDGhd2Q1u1Jt86mnWTK3Gpump"); // create_v2 (Token-2022) "SPECTRE"
const LEGACY_MINT = address("22ajt1wUcZQNY25TanUGwQXbQtCooR3cy6CuStN4uGVQ"); // legacy create "TALUN"
const POOL = address("37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y"); // boost pool from the amm-buy fixture
const POOL_BASE_MINT = address("kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump");
const V2_CURVE = address("AHyxTxjFHPFVC2BbyvM62B7hBm9iBjHUe9nMkiLy9HbX");

const addrs = [V2_MINT, LEGACY_MINT, await metaplexMetadataPda(LEGACY_MINT), POOL, POOL_BASE_MINT, V2_CURVE];
const accs = await fetchRawAccounts(rpc, addrs);
const b64 = getBase64Decoder();
const out: Record<string, { owner: string; lamports: string; data: string }> = {};
accs.forEach((a, i) => {
  if (!a) throw new Error(`missing ${addrs[i]}`);
  out[a.address] = { owner: a.owner, lamports: a.lamports.toString(), data: b64.decode(a.data) };
});
const file = new URL("../test/fixtures/metadata-accounts.json", import.meta.url);
await Bun.write(
  file,
  `${JSON.stringify({ capturedAt: new Date().toISOString(), v2Mint: V2_MINT, legacyMint: LEGACY_MINT, pool: POOL, poolBaseMint: POOL_BASE_MINT, v2Curve: V2_CURVE, accounts: out }, null, 1)}\n`,
);
console.log(`wrote ${Object.keys(out).length} accounts`);
