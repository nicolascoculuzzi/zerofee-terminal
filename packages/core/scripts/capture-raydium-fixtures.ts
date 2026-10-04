/**
 * Dev tool: snapshots the mainnet accounts and transactions the Raydium LaunchLab / CPMM tests replay
 * into test/fixtures/raydium-mainnet.json (read-only RPC calls; no keys involved).
 *   bun run packages/core/scripts/capture-raydium-fixtures.ts
 *
 * Transactions keep only what the tests need: every LaunchLab/CPMM instruction (top-level and inner,
 * including event-CPI self-invocations), the invoke/data/instruction log lines, the fee payer and the
 * token balance changes of the swap's user token accounts.
 */
import { getBase58Encoder, getBase64Decoder } from "@solana/kit";
import {
  DEFAULT_RPC_URL,
  decodeCpmmPool,
  postJsonRpc,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  SYSVAR_CLOCK_ID,
} from "../src";

const RPC_URL = process.env.RPC_URL ?? DEFAULT_RPC_URL;

const LAUNCHLAB_ACCOUNTS = [
  "6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX", // GlobalConfig SOL / constant product / index 0
  "G9NjYUD96DfCBUnduDHoZ7TCRrvdG41GLUkuoRch6qFC", // GlobalConfig used by the METAx-quoted StonkFun pool
  "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1", // PlatformConfig letsbonk.fun
  "6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt", // PlatformConfig StonkFun
  "FbqEaSHPF3kekscjqzEU5xdDAnWp5vf9w2d2oT5Bxng9", // PlatformConfig TRiX (non-zero creator fee)
  "4Bu96XjU84XjPDSpveTVf6LYGCkfW5FK7SNkREWcEfV4", // PlatformConfig Raydium
  "6kgXHSnUa2g9n2VH6aGL9GYBEuQJYxVLwNzSsgNqmrYo", // pool: BONK.fun, SPL base, SOL quote
  "2mVGHRxDWc5ckj93LgwzcBhZVbzi1QNWf3SWXumfKKX2", // pool: StonkFun, Token-2022 base with 3% transfer fee, SOL quote
  "G5WBxuD4cEjRSVvbxodNtJ7ruDatqwSQwNCMxdFdozZY", // pool: TRiX (creator fee 0.5%)
  "EkvuyEhr2JHmgMnoNQGzBYw8mAAqgB7W6BBQAkpVTnBS", // pool: StonkFun quoted in METAx (Token-2022 xStock)
  "yBtLj7s4aWFuBgSZCE5JpU6LoY6rofRui8cRmgbjT4S", // pool: BONK.fun, graduated (status 2)
  "5ojxCYwee4AgDRH4NxwCEXCGiMiKiYYB5r4Ycdo6bonk",
  "9RAPesjvcxKjGXn7QXvRaNPQ9HhhTZoqBqeZmqEuN1fK",
  "Bngb8iUrSuRCsmKRzVu44xmRMp2NB2LkEEyw6UAUTRiX",
  "GY5YxnQxPB6pPSryEEy9n6vUjJEow341edR5VVj8L2Pd",
  "7dmcQ9TyPDcfTTjfCfcZhuwK79FThVuKqmzVM9uKpRhK",
  "So11111111111111111111111111111111111111112",
  "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu", // METAx (Token-2022 xStock quote)
];
const CPMM_POOLS = [
  "92WCdsbayLJNUFAL3EQypWJLTL8gvmSpXMh6qZxo6PHh", // graduated BONK.fun coin (creator fee on token0 = wSOL)
  "F5MuM3C8PanScX296quAoNcLYGjtt8pN7JkBM3qsiK6Z", // graduated StonkFun coin (Token-2022 base, 3% transfer fee)
  "9nxAnMD7K78a9RMd2L3w8kQT5u9i7gsvV5aHiZ78sCC2", // swap_base_output sample (creator fee disabled)
];
const TRANSACTIONS = {
  // LaunchLab swaps
  bonkBuy: "2KW4kPuch2mxwMn2HWT4b8o9bayJJi3kiwNWC9dV6CoT1yuDig2Asbi5KUGrcjhbFS7mUZEKfSNFnkoGnRmVwQ3j",
  bonkSell: "2TE9q2CMcQ7n4QPirYg949Gbn7GBJeCsspW8McSHUsV8yrd4WznUvu57ByboMVjLLDGh896niManeBtH6HhWYZdu",
  bonkChainBuy: "VMYEAFYT8U6nwRvtZwDZE9zV9EhsUXpkhPYs6os9HG8M5uRzFz43qLQ8BqQ9bXnTkfCKwCy435GZYRst8QnpWdB",
  bonkChainSell: "4NBcNbhfgKERWmUDdQfCrFnkNPVBUdRHtp6AvqU4CTiCrvvTFc6wF252oQ5wZ4TUdNfFckShzRNzNFQ466tt7qCD",
  stonkFeeSell: "2n9RK58YeVFq7CYPoortJGtBgrJdktCUudhpY4CRz4jBFU3m4yr9jDGtKoCu38RcF4tBPDRzMHoQ55GcKsBcBs3J",
  stonkFeeBuy: "4DPvxS1rfpuQQ4WvZQifZVdT3t7WPXpjomEZALRuUXRHjtQKJi1Jo1mDjTKZeEiE1u8M3TRxjRZwrh5pAjbWPM4H",
  trixBuy: "5bTCwETvN4d2urbcuCTd1f5nGDb9Bw5xhSiFykG9DoEe7j6vk9SDpuuXc5FA6fnd54tBF8Pii5K5V8UHZjDtezEQ",
  trixSell: "4pgQxoxiSYrEjmS4RU9aG9qubin5yGJ5bJJYsSBpsKwnPwc8Pqut85My7jwRYTZyrVjDJmuTXBVLcdG2LtVqFEFJ",
  trixSell2: "5PoTEGRJtGh6TzQnixQ3rGvp9SnaKH1EvswbQRsjZWfBrejyasmZAjXwZGqEbGVfwGpCgn7VapC8C2c8ZKmXDWUG",
  stonkXstockSell: "56DN7E9gwSjyHQ7b7d8n98Lpjgf6ht9HLvaBJa9aXY3gE7Y6ev2zqKX2LHfDfd9ek8dLEjmvU8J2FWXsBFFCrsFx",
  // LaunchLab lifecycle (feed decoding)
  migrate: "5sFw84yv38nwLcruGL8riWf7CJaAwEzEnmK978BtZFP7MmJu2Ut2XyUF1J52PipkKnnnqURGaXMAbWkfAJCpER5h",
  create: "5eKxf9VNcE661Cdny4UNzjcPSUq7FxC1UHFujLygJxCndDvDXd92Uwy6U6Jo3Hcg1BWGvfBPwFysgFDbFTG7frNn",
  // CPMM swaps
  cpmmBonkSell: "jQywLECjaEad13t8rHUnqiiyL7V9gN8shRXUWnYXRXfCYmnwSEnGWM5SkrxpJ92JFe2UaTgmVhe68EdeDycQoi5",
  cpmmBonkBuy: "5z9gG5fVjib991EKHpJbEWrjAAgvPy5Rng5mN1snYo21omNaq6EdB3eXCAJ2XYHn7PAqoyZF36gLwyj1bfKwkRHn",
  cpmmStonkSell: "3aMQjR9u5ZyDcBdDpXUPYdiLzNPdkPQtEd12brGULhMuZEjZ2fzkDA4gM16vpP895FXQvn1PT6XjvXJg8JeFJypa",
  cpmmStonkBuy: "3S2SA2VLx9QrYeNK4DzvcTk5NQzakSCS6qamSpYTMQXNovcp4RLZiG9a8AAfV238ZbxLjUSyWX6NGwU271VcSwHy",
  cpmmStonkBuySplit: "j6GMrmzNZ2fQXsW1k7Ju5FvCKAh4zuW6mnPHn3wKs65nZFUjCLaAyiiRqURbbSzpcmGpXdZnF27juYA92f7qgtX",
  cpmmBaseOutput: "2Zc8orCaVugcU8L4Eg54DyBwNqj6e2FzPw56aVQqL9NrGaKnhPPPNZwKVVQmb8dhetFypTN3j2uSKpgvsiG8BKuH",
} as const;

const b64d = getBase64Decoder();
const b58e = getBase58Encoder();
const programs = new Set<string>([RAYDIUM_LAUNCHLAB_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID]);

async function call<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await postJsonRpc<T>(RPC_URL, method, params);
    if (!res.error) return res.result as T;
    if (attempt < 6 && /429|Too many|rate/i.test(res.error.message)) {
      await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`${method}: ${res.error.message}`);
  }
}

type RawAccount = { owner: string; lamports: number | bigint; data: [string, string] } | null;

async function snapshot(addrs: string[]) {
  const res = await call<{ context: { slot: number }; value: RawAccount[] }>("getMultipleAccounts", [
    addrs,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const out: Record<string, { owner: string; lamports: string; data: string }> = {};
  res.value.forEach((a, i) => {
    if (!a) throw new Error(`missing ${addrs[i]}`);
    out[addrs[i] as string] = { owner: a.owner, lamports: String(a.lamports), data: a.data[0] };
  });
  return { slot: res.context.slot, accounts: out };
}

// 1) CPMM pools first, to add their configs, vaults and mints to the account snapshot.
const poolSnap = await snapshot(CPMM_POOLS);
const extra = new Set<string>();
for (const p of CPMM_POOLS) {
  const pool = decodeCpmmPool(new Uint8Array(Buffer.from((poolSnap.accounts[p] as { data: string }).data, "base64")));
  for (const a of [pool.ammConfig, pool.token0Vault, pool.token1Vault, pool.token0Mint, pool.token1Mint, pool.observationKey]) extra.add(a);
}
const all = [...new Set([...LAUNCHLAB_ACCOUNTS, ...CPMM_POOLS, ...extra, SYSVAR_CLOCK_ID])];
const snap = await snapshot(all);

// 2) Transactions (jsonRpc "json" encoding).
interface RpcIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}
interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
interface RpcTx {
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
  transaction: { message: { accountKeys: string[]; instructions: RpcIx[] } };
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: { index: number; instructions: RpcIx[] }[];
    logMessages: string[];
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
  };
}
interface CapturedIx {
  where: string;
  programId: string;
  accounts: string[];
  data: string;
}
const txs: Record<string, unknown> = {};
for (const [label, sig] of Object.entries(TRANSACTIONS)) {
  const tx = await call<RpcTx | null>("getTransaction", [
    sig,
    { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  await Bun.sleep(250);
  if (!tx) throw new Error(`transaction ${sig} not found`);
  const keys: string[] = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const ixs: CapturedIx[] = [];
  const visit = (ix: RpcIx, where: string): void => {
    const programId = keys[ix.programIdIndex] as string;
    if (!programs.has(programId)) return;
    ixs.push({ where, programId, accounts: ix.accounts.map((i) => keys[i] as string), data: b64d.decode(b58e.encode(ix.data)) });
  };
  for (const [i, ix] of tx.transaction.message.instructions.entries()) visit(ix, `top${i}`);
  for (const inner of tx.meta.innerInstructions ?? []) for (const ix of inner.instructions) visit(ix, `inner${inner.index}`);
  const logs = tx.meta.logMessages.filter((l) =>
    /^Program \S+ (invoke \[\d+\]|success|failed)|^Program data: |^Program log: Instruction: /.test(l),
  );
  const balances = (arr: RpcTokenBalance[] | undefined) =>
    (arr ?? []).map((b) => ({ account: keys[b.accountIndex], mint: b.mint, owner: b.owner, amount: b.uiTokenAmount.amount }));
  txs[label] = {
    signature: sig,
    slot: tx.slot,
    blockTime: tx.blockTime,
    version: tx.version,
    feePayer: keys[0],
    err: tx.meta.err,
    instructions: ixs,
    logs,
    preTokenBalances: balances(tx.meta.preTokenBalances),
    postTokenBalances: balances(tx.meta.postTokenBalances),
  };
  console.log(`captured ${label} ${sig.slice(0, 12)}… slot ${tx.slot}: ${ixs.length} instructions, ${logs.length} log lines`);
}

const file = new URL("../test/fixtures/raydium-mainnet.json", import.meta.url);
await Bun.write(
  file,
  JSON.stringify({ capturedAt: new Date().toISOString(), slot: snap.slot, accounts: snap.accounts, transactions: txs }, null, 2),
);
console.log(`wrote ${Object.keys(snap.accounts).length} accounts and ${Object.keys(txs).length} transactions to ${file.pathname}`);
