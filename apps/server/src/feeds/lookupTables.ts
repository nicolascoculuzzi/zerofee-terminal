/**
 * GET /api/lookup-tables: address lookup table contents read from chain, for the browser.
 *
 * The browser compiles v0 transactions against these contents and hands the signer firewall the same
 * map. Jupiter `/build` names the tables its routes need and also lists their contents; the browser
 * checks that claim against this chain read instead of trusting the API (a table's entries never change
 * once written: tables only grow, then deactivate and close). Only accounts the Address Lookup Table
 * program owns count; anything else (missing, closed, another owner, undecodable) reads as null.
 *
 * Reads are cached briefly per table (append-only data: a cached list is a correct prefix of the live one).
 */
import type { Address } from "@solana/kit";
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, decodeLookupTable } from "@zerofee/core";
import type { LookupTableContents, LookupTablesResponse } from "@zerofee/protocol";
import type { RpcClient } from "../util/rpc";

/** Most tables one request may name (a Jupiter route uses up to ~4). */
export const MAX_LOOKUP_TABLES_PER_REQUEST = 8;
const U64_MAX = (1n << 64n) - 1n;
const CACHE_MAX = 512;

export class LookupTableReader {
  private readonly cache = new Map<string, { at: number; slot: number; value: LookupTableContents | null }>();

  constructor(
    private readonly rpc: Pick<RpcClient, "getMultipleAccounts">,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async read(addresses: readonly string[]): Promise<LookupTablesResponse> {
    const unique = [...new Set(addresses)];
    const t = this.now();
    const stale = unique.filter((a) => {
      const hit = this.cache.get(a);
      return !hit || t - hit.at > this.ttlMs;
    });
    let slot = 0;
    if (stale.length > 0) {
      const res = await this.rpc.getMultipleAccounts(stale as Address[], "confirmed");
      slot = res.slot;
      stale.forEach((a, i) => {
        const acc = res.accounts[i] ?? null;
        let value: LookupTableContents | null = null;
        if (acc && acc.owner === ADDRESS_LOOKUP_TABLE_PROGRAM_ID) {
          try {
            const d = decodeLookupTable(acc.data);
            value = { addresses: d.addresses, active: d.deactivationSlot === U64_MAX, lastExtendedSlot: Number(d.lastExtendedSlot) };
          } catch {
            value = null;
          }
        }
        this.remember(a, { at: t, slot: res.slot, value });
      });
    }
    const tables: Record<string, LookupTableContents | null> = {};
    for (const a of unique) {
      const hit = this.cache.get(a);
      tables[a] = hit?.value ?? null;
      slot = Math.max(slot, hit?.slot ?? 0);
    }
    return { slot, tables };
  }

  private remember(address: string, entry: { at: number; slot: number; value: LookupTableContents | null }): void {
    this.cache.delete(address);
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(address, entry);
  }
}
