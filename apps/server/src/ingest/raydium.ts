/**
 * Raydium LaunchLab / CPMM facts that live in instruction accounts, not in the events: LaunchLab TradeEvents
 * and PoolCreateEvents name the pool but neither the mints nor the wallet, CPMM SwapEvents name the pool and
 * the mints but not the wallet, and `migrate_to_cpswap` (graduation, signed by Raydium's migration wallet)
 * emits no event at all. Sources that deliver the whole transaction (Yellowstone, a fetched getTransaction)
 * recover them here; the RPC logs feed has no accounts and falls back to account lookups.
 *
 * Pairing: each swap / initialize instruction emits exactly one event, and both the event-CPIs and the
 * `Program data:` logs come out in execution order, so the k-th event on a pool belongs to the k-th
 * instruction on that pool in execution order (top-level instruction i, then its inner instructions).
 *
 * Account positions (idl/raydium_launchpad.json, idl/raydium_cp_swap.json; verified against the mainnet
 * transactions in packages/core/test/fixtures/raydium-mainnet.json):
 *   LaunchLab buy/sell_exact_in/out: 0 payer, 2 global_config, 3 platform_config, 4 pool_state, 5 user_base_token,
 *     6 user_quote_token, 7 base_vault, 8 quote_vault, 9 base_mint, 10 quote_mint, 11/12 base/quote token program
 *   LaunchLab initialize / initialize_v2: 0 payer, 1 creator, 2 global_config, 3 platform_config, 5 pool_state,
 *     6 base_mint, 7 quote_mint, 8 base_vault, 9 quote_vault, 11/12 token programs (10 = metadata account);
 *     initialize_with_token_2022: same up to 9, token programs at 10/11
 *   LaunchLab migrate_to_cpswap: 0 payer, 1 base_mint, 2 quote_mint, 3 platform_config, 5 cpswap_pool,
 *     7 cpswap_lp_mint, 8/9 cpswap base/quote vault, 10 cpswap_config, 12 cpswap_observation, 17 pool_state,
 *     18 global_config. The live instruction has 38 accounts against the IDL's 28 and position 23 is
 *     Token-2022 on an SPL pair, so token programs are not read from it (the pools say which they use).
 *   CPMM swap_base_input/output: 0 payer, 2 amm_config, 3 pool_state, 4/5 user input/output token account,
 *     6/7 input/output vault, 8/9 input/output token program, 10/11 input/output mint, 12 observation
 */
import {
  type DecodedEvent,
  RAYDIUM_CPMM_IX,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LAUNCHLAB_IX,
  RAYDIUM_LAUNCHLAB_PROGRAM_ID,
  type TransactionEventInput,
  type TxInstruction,
} from "@zerofee/core";

export interface LaunchLabSwapAccounts {
  kind: "launchlabSwap";
  /** Signer of the swap: the trading wallet (a router's PDA when a program trades for its own account). */
  payer: string;
  pool: string;
  globalConfig: string;
  platformConfig: string;
  userBaseToken: string;
  userQuoteToken: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
}

export interface LaunchLabCreateAccounts {
  kind: "launchlabCreate";
  payer: string;
  creator: string;
  pool: string;
  globalConfig: string;
  platformConfig: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
}

export interface CpmmSwapAccounts {
  kind: "cpmmSwap";
  payer: string;
  pool: string;
  ammConfig: string;
  inputTokenAccount: string;
  outputTokenAccount: string;
  inputVault: string;
  outputVault: string;
  inputTokenProgram: string;
  outputTokenProgram: string;
  inputMint: string;
  outputMint: string;
  observation: string;
}

export type RaydiumEventAccounts = LaunchLabSwapAccounts | LaunchLabCreateAccounts | CpmmSwapAccounts;

/** A `migrate_to_cpswap`: the LaunchLab curve's liquidity moved into its canonical CPMM pool. */
export interface LaunchLabMigration {
  payer: string;
  /** LaunchLab pool (PoolState). */
  pool: string;
  baseMint: string;
  quoteMint: string;
  platformConfig: string;
  globalConfig: string;
  cpmmPool: string;
  cpmmConfig: string;
  cpmmLpMint: string;
  cpmmBaseVault: string;
  cpmmQuoteVault: string;
  cpmmObservation: string;
  /** Post-tx balances of the new CPMM vaults (raw; no fees are owed yet), when the source has token balances. */
  baseVaultAmount: bigint | null;
  quoteVaultAmount: bigint | null;
}

export interface RaydiumTxInfo {
  /** Parallel to IngestTx.events: the instruction accounts of each Raydium event (undefined for the others). */
  accounts: (RaydiumEventAccounts | undefined)[];
  migrations: LaunchLabMigration[];
}

/** Post-tx token balance by account index (Yellowstone / getTransaction meta). */
export interface PostTokenBalance {
  accountIndex: number;
  amount: string;
}

const LAUNCHLAB_SWAPS = [
  RAYDIUM_LAUNCHLAB_IX.buyExactIn,
  RAYDIUM_LAUNCHLAB_IX.buyExactOut,
  RAYDIUM_LAUNCHLAB_IX.sellExactIn,
  RAYDIUM_LAUNCHLAB_IX.sellExactOut,
];
const CPMM_SWAPS = [RAYDIUM_CPMM_IX.swapBaseInput, RAYDIUM_CPMM_IX.swapBaseOutput];

/** Account positions (see the module comment). */
const LAUNCHLAB_SWAP_LAYOUT = {
  payer: 0,
  globalConfig: 2,
  platformConfig: 3,
  pool: 4,
  userBaseToken: 5,
  userQuoteToken: 6,
  baseVault: 7,
  quoteVault: 8,
  baseMint: 9,
  quoteMint: 10,
  baseTokenProgram: 11,
  quoteTokenProgram: 12,
} as const;
const LAUNCHLAB_CREATE_LAYOUT = {
  payer: 0,
  creator: 1,
  globalConfig: 2,
  platformConfig: 3,
  pool: 5,
  baseMint: 6,
  quoteMint: 7,
  baseVault: 8,
  quoteVault: 9,
  baseTokenProgram: 11,
  quoteTokenProgram: 12,
} as const;
const LAUNCHLAB_CREATE_2022_LAYOUT = { ...LAUNCHLAB_CREATE_LAYOUT, baseTokenProgram: 10, quoteTokenProgram: 11 } as const;
const LAUNCHLAB_MIGRATE_LAYOUT = {
  payer: 0,
  baseMint: 1,
  quoteMint: 2,
  platformConfig: 3,
  cpmmPool: 5,
  cpmmLpMint: 7,
  cpmmBaseVault: 8,
  cpmmQuoteVault: 9,
  cpmmConfig: 10,
  cpmmObservation: 12,
  pool: 17,
  globalConfig: 18,
} as const;
const CPMM_SWAP_LAYOUT = {
  payer: 0,
  ammConfig: 2,
  pool: 3,
  inputTokenAccount: 4,
  outputTokenAccount: 5,
  inputVault: 6,
  outputVault: 7,
  inputTokenProgram: 8,
  outputTokenProgram: 9,
  inputMint: 10,
  outputMint: 11,
  observation: 12,
} as const;

function starts(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < disc.length) return false;
  for (let i = 0; i < disc.length; i++) if (data[i] !== disc[i]) return false;
  return true;
}

/** Instructions in execution order: top-level instruction i, then the instructions it invoked. */
export function executionOrder(input: Pick<TransactionEventInput, "instructions" | "innerInstructions">): TxInstruction[] {
  const top = input.instructions ?? [];
  const inner = new Map<number, readonly TxInstruction[]>();
  for (const g of input.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const out: TxInstruction[] = [];
  const n = Math.max(top.length, ...[...inner.keys()].map((k) => k + 1));
  for (let i = 0; i < n; i++) {
    const t = top[i];
    if (t) out.push(t);
    for (const ix of inner.get(i) ?? []) out.push(ix);
  }
  return out;
}

/** True when the transaction invokes LaunchLab or CPMM at all (cheap pre-check). */
export function touchesRaydium(accountKeys: readonly string[]): boolean {
  return accountKeys.includes(RAYDIUM_LAUNCHLAB_PROGRAM_ID) || accountKeys.includes(RAYDIUM_CPMM_PROGRAM_ID);
}

/**
 * Recovers the instruction accounts of every Raydium event in `events` (the events decoded from the same
 * transaction, in emission order) and the graduations it performed. null when the transaction has neither.
 */
export function extractRaydium(
  input: Pick<TransactionEventInput, "accountKeys" | "instructions" | "innerInstructions">,
  events: readonly DecodedEvent[],
  postTokenBalances?: readonly PostTokenBalance[] | null,
): RaydiumTxInfo | null {
  const keys = input.accountKeys;
  if (!touchesRaydium(keys)) return null;
  const swaps = new Map<string, LaunchLabSwapAccounts[]>();
  const creates = new Map<string, LaunchLabCreateAccounts[]>();
  const cpmm = new Map<string, CpmmSwapAccounts[]>();
  const migrations: LaunchLabMigration[] = [];
  const push = <T extends { pool: string }>(m: Map<string, T[]>, v: T) => {
    const list = m.get(v.pool);
    if (list) list.push(v);
    else m.set(v.pool, [v]);
  };
  const balanceOf = (address: string): bigint | null => {
    if (!postTokenBalances) return null;
    for (const b of postTokenBalances) {
      if (keys[b.accountIndex] === address) {
        try {
          return BigInt(b.amount);
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  for (const ix of executionOrder(input)) {
    const program = keys[ix.programIdIndex];
    if (program !== RAYDIUM_LAUNCHLAB_PROGRAM_ID && program !== RAYDIUM_CPMM_PROGRAM_ID) continue;
    const accounts = ix.accounts;
    if (!accounts) continue;
    const pick = <K extends string>(layout: Record<K, number>): Record<K, string> | null => {
      const out = {} as Record<K, string>;
      for (const name of Object.keys(layout) as K[]) {
        const k = accounts[layout[name]];
        const a = k === undefined ? undefined : keys[k];
        if (!a) return null;
        out[name] = a;
      }
      return out;
    };
    if (program === RAYDIUM_CPMM_PROGRAM_ID) {
      if (accounts.length < 13 || !CPMM_SWAPS.some((d) => starts(ix.data, d))) continue;
      const a = pick(CPMM_SWAP_LAYOUT);
      if (a) push(cpmm, { kind: "cpmmSwap", ...a });
      continue;
    }
    if (LAUNCHLAB_SWAPS.some((d) => starts(ix.data, d))) {
      if (accounts.length < 13) continue;
      const a = pick(LAUNCHLAB_SWAP_LAYOUT);
      if (a) push(swaps, { kind: "launchlabSwap", ...a });
      continue;
    }
    const t2022 = starts(ix.data, RAYDIUM_LAUNCHLAB_IX.initializeWithToken2022);
    if (t2022 || starts(ix.data, RAYDIUM_LAUNCHLAB_IX.initialize) || starts(ix.data, RAYDIUM_LAUNCHLAB_IX.initializeV2)) {
      const a = pick(t2022 ? LAUNCHLAB_CREATE_2022_LAYOUT : LAUNCHLAB_CREATE_LAYOUT);
      if (a) push(creates, { kind: "launchlabCreate", ...a });
      continue;
    }
    if (starts(ix.data, RAYDIUM_LAUNCHLAB_IX.migrateToCpswap) && accounts.length >= 24) {
      const a = pick(LAUNCHLAB_MIGRATE_LAYOUT);
      if (a) migrations.push({ ...a, baseVaultAmount: balanceOf(a.cpmmBaseVault), quoteVaultAmount: balanceOf(a.cpmmQuoteVault) });
    }
  }

  let any = migrations.length > 0;
  const accounts = events.map((ev): RaydiumEventAccounts | undefined => {
    let v: RaydiumEventAccounts | undefined;
    if (ev.kind === "launchlabTrade") v = swaps.get(ev.pool)?.shift();
    else if (ev.kind === "launchlabPoolCreate") v = creates.get(ev.pool)?.shift();
    else if (ev.kind === "cpmmSwap") v = cpmm.get(ev.pool)?.shift();
    if (v) any = true;
    return v;
  });
  return any ? { accounts, migrations } : null;
}
