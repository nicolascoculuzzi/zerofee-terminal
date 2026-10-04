import { describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder } from "@solana/kit";
import { ADDRESS_LOOKUP_TABLE_PROGRAM_ID, SYSTEM_PROGRAM_ID } from "@zerofee/core";
import { LookupTableReader } from "../src/feeds/lookupTables";
import type { RpcAccount } from "../src/util/rpc";
import { addr } from "./helpers";

const enc = getAddressEncoder();
const U64_MAX = (1n << 64n) - 1n;

/** A lookup table account: u32 tag 1, deactivation slot, last extended slot, start index, authority, padding, addresses. */
function tableData(addresses: string[], deactivationSlot = U64_MAX, lastExtendedSlot = 100n): Uint8Array {
  const data = new Uint8Array(56 + 32 * addresses.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, deactivationSlot, true);
  view.setBigUint64(12, lastExtendedSlot, true);
  data[20] = 0;
  data[21] = 1;
  data.set(enc.encode(addr("authority") as Address), 22);
  addresses.forEach((a, i) => {
    data.set(enc.encode(a as Address), 56 + 32 * i);
  });
  return data;
}

function fakeRpc(accounts: Record<string, RpcAccount>) {
  const calls: string[][] = [];
  return {
    calls,
    rpc: {
      getMultipleAccounts: async (list: readonly Address[]) => {
        calls.push([...list]);
        return { slot: 500, accounts: list.map((a) => accounts[a] ?? null) };
      },
    },
  };
}

describe("LookupTableReader", () => {
  const live = addr("table-live");
  const old = addr("table-deactivating");
  const imposter = addr("table-imposter");
  const entries = [addr("entry-0"), addr("entry-1"), addr("entry-2")];

  test("decodes tables the ALT program owns; anything else is null; reads are cached", async () => {
    let now = 1_000;
    const { rpc, calls } = fakeRpc({
      [live]: { address: live as Address, owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data: tableData(entries) },
      [old]: { address: old as Address, owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data: tableData(entries.slice(0, 1), 90n) },
      // Same bytes under another owner: not a lookup table.
      [imposter]: { address: imposter as Address, owner: SYSTEM_PROGRAM_ID, lamports: 1n, data: tableData(entries) },
    });
    const reader = new LookupTableReader(rpc, 30_000, () => now);
    const missing = addr("table-missing");
    const res = await reader.read([live, old, imposter, missing, live]);
    expect(res.slot).toBe(500);
    expect(res.tables[live]).toEqual({ addresses: entries, active: true, lastExtendedSlot: 100 });
    expect(res.tables[old]).toEqual({ addresses: entries.slice(0, 1), active: false, lastExtendedSlot: 100 });
    expect(res.tables[imposter]).toBeNull();
    expect(res.tables[missing]).toBeNull();
    expect(calls).toEqual([[live, old, imposter, missing]]);

    // Cached within the TTL; re-read after it.
    await reader.read([live]);
    expect(calls).toHaveLength(1);
    now += 31_000;
    await reader.read([live]);
    expect(calls).toHaveLength(2);
  });

  test("an undecodable table account reads as null", async () => {
    const broken = addr("table-broken");
    const { rpc } = fakeRpc({
      [broken]: { address: broken as Address, owner: ADDRESS_LOOKUP_TABLE_PROGRAM_ID, lamports: 1n, data: new Uint8Array(10) },
    });
    expect((await new LookupTableReader(rpc).read([broken])).tables[broken]).toBeNull();
  });
});
