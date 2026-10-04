/**
 * Chain snapshots of a token's holders, for reconciling the trade-based holder book
 * (MarketState.applyHolderSnapshot):
 *
 *  - `largest`: `getTokenLargestAccounts` (the 20 largest token accounts) + one `getMultipleAccounts` to
 *    read their owners. When fewer than 20 accounts come back the list is the whole token (complete);
 *    otherwise any account not listed holds at most the smallest listed amount (the floor).
 *  - `dasScan`: Helius DAS `getTokenAccounts`, every account with a positive balance, page by page. Gives
 *    up (returns null) past `maxPages` rather than apply a partial "full" snapshot.
 *
 * Owners are aggregated (one wallet may hold several token accounts). Excluded owners (curve, pool, burn)
 * are filtered by the holder book itself.
 */
import type { Address } from "@solana/kit";
import { decodeTokenAccount } from "@zerofee/core";
import type { SnapshotEntry } from "../market/holders";
import type { RpcClient } from "../util/rpc";
import type { HeliusClient } from "./helius";

/** getTokenLargestAccounts returns at most this many accounts. */
export const LARGEST_ACCOUNTS_MAX = 20;

export interface LargestSnapshot {
  slot: number;
  entries: SnapshotEntry[];
  /** True when the token has fewer accounts than the RPC's maximum: the list is every account. */
  complete: boolean;
  /** Upper bound for any account not in the list (when not complete). */
  floor: bigint | undefined;
}

export interface DasSnapshot {
  slot: number;
  entries: SnapshotEntry[];
  pages: number;
}

function aggregate(rows: { owner: string; amount: bigint; slot: number }[]): SnapshotEntry[] {
  const byOwner = new Map<string, SnapshotEntry>();
  for (const r of rows) {
    const e = byOwner.get(r.owner);
    if (e) e.amount += r.amount;
    else byOwner.set(r.owner, { owner: r.owner, amount: r.amount, slot: r.slot });
  }
  return [...byOwner.values()];
}

export async function largestAccountsSnapshot(rpc: RpcClient, mint: string): Promise<LargestSnapshot> {
  const r = await rpc.call<{ context: { slot: number }; value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [
    mint,
    { commitment: "confirmed" },
  ]);
  const listed = r.value ?? [];
  if (!listed.length) return { slot: r.context.slot, entries: [], complete: true, floor: undefined };
  const { slot, accounts } = await rpc.getMultipleAccounts(
    listed.map((a) => a.address as Address),
    "confirmed",
  );
  const rows: { owner: string; amount: bigint; slot: number }[] = [];
  let floor: bigint | undefined;
  for (const acc of accounts) {
    if (!acc) continue;
    try {
      const t = decodeTokenAccount(acc.data);
      if (t.mint !== mint) continue;
      rows.push({ owner: t.owner, amount: t.amount, slot });
      if (floor === undefined || t.amount < floor) floor = t.amount;
    } catch {
      /* closed or not a token account any more */
    }
  }
  const complete = listed.length < LARGEST_ACCOUNTS_MAX;
  return { slot, entries: aggregate(rows.filter((x) => x.amount > 0n)), complete, floor: complete ? undefined : floor };
}

export async function dasSnapshot(
  helius: HeliusClient,
  mint: string,
  o: { pageSize: number; maxPages: number; fallbackSlot: number; takePage(): boolean },
): Promise<DasSnapshot | null | "budget"> {
  const rows: { owner: string; amount: bigint; slot: number }[] = [];
  let oldest = Number.MAX_SAFE_INTEGER;
  for (let page = 1; page <= o.maxPages; page++) {
    if (!o.takePage()) return "budget";
    const p = await helius.tokenAccountsPage(mint, page, o.pageSize);
    const slot = p.slot ?? o.fallbackSlot;
    if (slot < oldest) oldest = slot;
    for (const a of p.accounts) rows.push({ owner: a.owner, amount: a.amount, slot });
    if (p.returned < p.limit) return { slot: oldest, entries: aggregate(rows), pages: page };
  }
  return null;
}
