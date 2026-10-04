/**
 * Prints armed-transaction sizes (durable nonce + compute budget + tips + trade) with and without
 * the operator lookup table, for pump curve and PumpSwap trades, built from the offline mainnet
 * fixtures. No network access.
 *   bun run packages/core/scripts/armed-sizes.ts
 */
import { armedSizeMatrix } from "../test/armedSizeCases";

const rows = await armedSizeMatrix();
const pad = (s: string | number, n: number) => String(s).padEnd(n);
console.log(`${pad("trade", 40)}${pad("tips", 28)}${pad("with ALT", 10)}${pad("without", 9)}static/lookup`);
for (const r of rows) {
  console.log(
    `${pad(r.trade, 40)}${pad(r.tips, 28)}${pad(r.size.size, 10)}${pad(r.size.sizeWithoutLookupTables, 9)}${r.size.staticAccounts}/${r.size.lookedUpAccounts}`,
  );
}
console.log(`\nlimit ${rows[0]?.size.limit} bytes; lookup table holds ${rows[0]?.tableSize} addresses`);
