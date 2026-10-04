/**
 * Offline Jupiter `/build` responses (captured by scripts/capture-jupiter-fixtures.ts, 2026-10-03) and a
 * stub fetch / RPC that serve them, so venue resolution, buildTrade and assembly run with no network.
 */
import { type Address, address, getBase64Encoder } from "@solana/kit";
import { addressBytes, type StateRpc, SYSTEM_PROGRAM_ID } from "../src";
import capture from "./fixtures/jupiter-build.json";

export type JupiterCaseLabel = keyof typeof capture.cases;

export const JUPITER_TAKER: Address = address(capture.taker);
export const JUPITER_ATTACKER: Address = address(capture.attacker);
export const JUPITER_SLOT = capture.slot;

/** Meteora Dynamic Bonding Curve coin (SPL Token). */
export const DBC_COIN = address("3XhUNiVssekpBBQk7VunVTEooJDf4vF3M8ridbtCqRVn");
/** Token-2022 coin on Meteora DAMM v2. */
export const DAMM_2022_COIN = address("4Vn9mQogr4CNDokzSaH3L4sq3cbEtNrT7G1CpX1VtJLh");
/** SPL coin on Meteora DAMM v2 (bought with USDC over two hops). */
export const DAMM_COIN = address("6VsnbKz6erJRTPiiD34Msq7eWmmgZHDnh4Bxan4MpGjm");
export const BONK = address("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
/** BONK's would-be pump curve PDA: a System account someone sent 1.12 SOL to (venue resolution must ignore it). */
export const BONK_CURVE_PDA = address("HYdTodMngpgXxJAMxqiN5E8p1SMzTy24eNM2Y3yWpuj2");

export interface JupiterCase {
  label: JupiterCaseLabel;
  note: string;
  request: { inputMint: Address; outputMint: Address; amount: bigint; slippageBps: number; taker: Address };
  /** The raw JSON body exactly as /build returned it (a fresh deep copy per call). */
  response: Record<string, unknown>;
}

export function jupiterCase(label: JupiterCaseLabel): JupiterCase {
  const c = capture.cases[label];
  return {
    label,
    note: c.note,
    request: {
      inputMint: address(c.request.inputMint),
      outputMint: address(c.request.outputMint),
      amount: BigInt(c.request.amount),
      slippageBps: Number(c.request.slippageBps),
      taker: address(c.request.taker),
    },
    response: structuredClone(c.response) as unknown as Record<string, unknown>,
  };
}

export const JUPITER_CASES = Object.keys(capture.cases) as JupiterCaseLabel[];
/** The cases core may build (everything but the malicious platform-fee capture). */
export const LEGIT_JUPITER_CASES = JUPITER_CASES.filter((l) => l !== "platformFeeBuy");

export interface StubFetch {
  fetch: typeof fetch;
  requests: { url: string; headers: Record<string, string> }[];
}

/**
 * A fetch that answers /build with the captured response whose request matches (input, output, amount),
 * after `mutate` (to model a misbehaving API). Anything else gets HTTP 400 {"error":"No routes found"}.
 */
export function jupiterFetch(mutate?: (body: Record<string, unknown>, label: JupiterCaseLabel, query: URLSearchParams) => void): StubFetch {
  const requests: StubFetch["requests"] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), headers: { ...(init?.headers as Record<string, string>) } });
    const q = url.searchParams;
    const label = JUPITER_CASES.find((l) => {
      const r = capture.cases[l].request as Record<string, string>;
      return (
        l !== "platformFeeBuy" && r.inputMint === q.get("inputMint") && r.outputMint === q.get("outputMint") && r.amount === q.get("amount")
      );
    });
    if (!label) return new Response(JSON.stringify({ error: "No routes found" }), { status: 400 });
    const body = jupiterCase(label).response;
    mutate?.(body, label, q);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const b64 = getBase64Encoder();

export interface RpcAccount {
  owner: Address;
  lamports?: bigint;
  data: Uint8Array;
}

/** getMultipleAccounts over the captured mint accounts (+ `extra`); the user holds 10 SOL. */
export function jupiterRpc(user: Address = JUPITER_TAKER, extra: Record<string, RpcAccount> = {}): StateRpc {
  const accounts: Record<string, RpcAccount> = {
    [user]: { owner: SYSTEM_PROGRAM_ID, lamports: 10_000_000_000n, data: new Uint8Array(0) },
  };
  for (const [a, acc] of Object.entries(capture.accounts)) {
    accounts[a] = { owner: address(acc.owner), lamports: BigInt(acc.lamports), data: new Uint8Array(b64.encode(acc.data)) };
  }
  Object.assign(accounts, extra);
  const toBase64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
  return {
    getMultipleAccounts: (addrs: readonly Address[]) => ({
      send: async () => ({
        context: { slot: BigInt(capture.slot) },
        value: addrs.map((a) => {
          const acc = accounts[a];
          return acc
            ? { owner: acc.owner, lamports: acc.lamports ?? 2_039_280n, data: [toBase64(acc.data), "base64"], executable: false }
            : null;
        }),
      }),
    }),
    getRecentPrioritizationFees: () => ({ send: async () => [] }),
  } as unknown as StateRpc;
}

/** A 165-byte initialized token account (SPL Token and Token-2022 share the base layout). */
export function tokenAccountData(mint: Address, owner: Address, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressBytes(mint), 0);
  data.set(addressBytes(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
}
