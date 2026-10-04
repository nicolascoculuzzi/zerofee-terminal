/**
 * Armed-transaction size matrix built from the offline mainnet fixtures: every trade shape an
 * armed order can sign, with the armed default tip (Jito + jitodontfront) and the worst case
 * (Helius + Jito + jitodontfront), measured with and without the operator lookup table.
 * Shared by test/armed-size.test.ts and scripts/armed-sizes.ts.
 */
import { type Address, address, type Instruction, type Nonce } from "@solana/kit";
import {
  type ArmedTxFees,
  type ArmedTxSize,
  armedStaticAccounts,
  bondingCurvePda,
  buildAmmBuyInstructions,
  buildAmmSellInstructions,
  buildPumpBuyInstructions,
  buildPumpSellInstructions,
  DEFAULT_CU_LIMITS,
  decodeAmmGlobalConfig,
  decodeBondingCurve,
  decodeMint,
  decodePool,
  decodePumpGlobal,
  deriveLookupTableAddress,
  measureArmedTransaction,
  migrationPoolContext,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_GLOBAL,
} from "../src";
import { CURVE_MINT, fixture, MAYHEM_MINT, POOL } from "./fixtures";

export const SIZE_USER = address("HpqMfMw5r9DT3qWMHup63YndJF6hsjGAcy9qkFGtdpq4");
export const SIZE_NONCE = {
  account: address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
  authority: SIZE_USER,
  value: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Nonce,
};

export const ARMED_TIPS_JITO: ArmedTxFees = {
  cuLimit: 150_000,
  cuPriceMicroLamports: 100_000n,
  tips: [{ lane: "jito", lamports: 10_000n }],
  jitoDontFront: true,
};
export const ARMED_TIPS_DUAL: ArmedTxFees = {
  cuLimit: 150_000,
  cuPriceMicroLamports: 100_000n,
  tips: [
    { lane: "helius", lamports: 5_000n },
    { lane: "jito", lamports: 10_000n },
  ],
  jitoDontFront: true,
};

export interface SizeRow {
  trade: string;
  tips: string;
  size: ArmedTxSize;
  tableSize: number;
}

export async function sizeFixtureContext() {
  const global = decodePumpGlobal(fixture(PUMP_GLOBAL).data);
  const globalConfig = decodeAmmGlobalConfig(fixture(PUMP_AMM_GLOBAL_CONFIG).data);
  const staticSet = await armedStaticAccounts({ pumpGlobal: global, ammGlobalConfig: globalConfig });
  const { address: table } = await deriveLookupTableAddress(address("Hy5oibb1cYdmjyPJ2fiypDtKYvp1uZTuPkmFzVy7TL8c"), 300_000_000n);
  return { global, globalConfig, staticSet, table, tables: { [table]: staticSet } as Record<Address, Address[]> };
}

export async function armedTradeShapes(): Promise<{ name: string; instructions: Instruction[] }[]> {
  const { global, globalConfig } = await sizeFixtureContext();
  const user = SIZE_USER;
  const curveCtx = async (mint: Address) => {
    const curve = decodeBondingCurve(fixture(await bondingCurvePda(mint)).data);
    const m = fixture(mint);
    return { mint, baseTokenProgram: decodeMint(m.data, m.owner).tokenProgram, user, curve, global };
  };
  const curve = await curveCtx(CURVE_MINT);
  const mayhem = await curveCtx(MAYHEM_MINT);
  const pool = decodePool(fixture(POOL).data);
  const pm = fixture(pool.baseMint);
  const amm = { poolAddress: POOL, pool, user, baseTokenProgram: decodeMint(pm.data, pm.owner).tokenProgram, globalConfig };
  const cashback = { ...amm, pool: { ...pool, isCashbackCoin: true } };
  const snipe = await migrationPoolContext({
    mint: CURVE_MINT,
    curve: curve.curve,
    baseTokenProgram: curve.baseTokenProgram,
    user,
    globalConfig,
  });
  const buyQ = { mode: "exactQuoteIn" as const, amount: 10_000_000n, limit: 1n };
  return [
    { name: "pump buy_exact_quote_in_v2 + ATA (T22)", instructions: (await buildPumpBuyInstructions(curve, buyQ)).instructions },
    { name: "pump mayhem buy + ATA (T22)", instructions: (await buildPumpBuyInstructions(mayhem, buyQ)).instructions },
    {
      name: "pump sell_v2 + close (full exit)",
      instructions: (await buildPumpSellInstructions(curve, { amount: 1_000_000n, minQuoteOut: 1n, closeBaseAccount: true })).instructions,
    },
    { name: "PumpSwap buy (wrap + ATA, T22)", instructions: (await buildAmmBuyInstructions(amm, buyQ)).instructions },
    {
      name: "PumpSwap sell + close (full exit)",
      instructions: (await buildAmmSellInstructions(amm, { baseAmountIn: 1_000_000n, minQuoteOut: 1n, closeBaseAccount: true }))
        .instructions,
    },
    { name: "PumpSwap cashback buy", instructions: (await buildAmmBuyInstructions(cashback, buyQ)).instructions },
    {
      name: "PumpSwap cashback sell + close",
      instructions: (await buildAmmSellInstructions(cashback, { baseAmountIn: 1_000_000n, minQuoteOut: 1n, closeBaseAccount: true }))
        .instructions,
    },
    { name: "migration snipe (canonical pool buy)", instructions: (await buildAmmBuyInstructions(snipe, buyQ)).instructions },
  ];
}

export async function armedSizeMatrix(): Promise<SizeRow[]> {
  const { tables, staticSet } = await sizeFixtureContext();
  const rows: SizeRow[] = [];
  for (const shape of await armedTradeShapes()) {
    for (const [tips, fees] of [
      ["jito + dontfront", ARMED_TIPS_JITO],
      ["helius + jito + dontfront", ARMED_TIPS_DUAL],
    ] as const) {
      const size = measureArmedTransaction({
        feePayer: SIZE_USER,
        nonce: SIZE_NONCE,
        instructions: shape.instructions,
        fees: { ...fees, cuLimit: DEFAULT_CU_LIMITS.ammBuy },
        lookupTables: tables,
      });
      rows.push({ trade: shape.name, tips, size, tableSize: staticSet.length });
    }
  }
  return rows;
}
