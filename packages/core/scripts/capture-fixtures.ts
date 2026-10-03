/**
 * Dev tool: snapshots live mainnet accounts used by the offline unit tests into
 * test/fixtures/mainnet-accounts.json (read-only RPC calls; no keys involved).
 *   bun run packages/core/scripts/capture-fixtures.ts
 */
import { address, createSolanaRpc, getBase64Decoder } from "@solana/kit";
import {
  bondingCurvePda,
  DEFAULT_RPC_URL,
  decodePool,
  fetchRawAccounts,
  PUMP_AMM_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_FEE_CONFIG,
  PUMP_GLOBAL,
} from "../src";

const rpc = createSolanaRpc(process.env.RPC_URL ?? DEFAULT_RPC_URL);
const CURVE_MINT = address("8iF53SDsUDd3WpcJ1XQcwFxHD36t2RVEBescHU56pump");
const MAYHEM_MINT = address("2rGcJhheGSAYN84ksPh7keV4QgnD92aqHUKZJ2w3pump");
const POOL = address("5RxfsBsyA8t2Z1J21SkSq2gaNr8JvPFGPZBd8crXY9Ck");

const [poolAcc] = await fetchRawAccounts(rpc, [POOL]);
if (!poolAcc) throw new Error("pool missing");
const pool = decodePool(poolAcc.data);
const addrs = [
  PUMP_GLOBAL,
  PUMP_FEE_CONFIG,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_AMM_FEE_CONFIG,
  CURVE_MINT,
  await bondingCurvePda(CURVE_MINT),
  MAYHEM_MINT,
  await bondingCurvePda(MAYHEM_MINT),
  POOL,
  pool.baseMint,
  pool.poolBaseTokenAccount,
  pool.poolQuoteTokenAccount,
];
const accs = await fetchRawAccounts(rpc, addrs);
const b64 = getBase64Decoder();
const out: Record<string, { owner: string; lamports: string; data: string }> = {};
accs.forEach((a, i) => {
  if (!a) throw new Error(`missing ${addrs[i]}`);
  out[a.address] = { owner: a.owner, lamports: a.lamports.toString(), data: b64.decode(a.data) };
});
const file = new URL("../test/fixtures/mainnet-accounts.json", import.meta.url);
await Bun.write(
  file,
  JSON.stringify(
    { capturedAt: new Date().toISOString(), curveMint: CURVE_MINT, mayhemMint: MAYHEM_MINT, pool: POOL, accounts: out },
    null,
    2,
  ),
);
console.log(`wrote ${Object.keys(out).length} accounts to ${file.pathname}`);
