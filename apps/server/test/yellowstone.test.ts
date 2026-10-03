/**
 * Yellowstone parsing from recorded SubscribeUpdate protobufs (test/fixtures/yellowstone-updates.json,
 * reconstructed from real mainnet transactions), and the real N-API client end-to-end under Bun against
 * a local mock Geyser server.
 */
import { describe, expect, test } from "bun:test";
import { CommitmentLevel, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { decodeTransactionEvents, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from "@zerofee/core";
import type { ChainDelta } from "@zerofee/protocol";
import { ChainPublisher } from "../src/feeds/chain";
import type { BlockMeta, IngestTx, SlotStatus } from "../src/ingest/types";
import { YellowstoneSource } from "../src/ingest/yellowstone";
import { parseSubscribeUpdate } from "../src/ingest/yellowstoneParse";
import { setLogLevel } from "../src/log";
import { RpcClient } from "../src/util/rpc";
import recorded from "./fixtures/yellowstone-updates.json";
import { eventInput, fixture, waitFor } from "./helpers";
import { startMockGeyser } from "./mockGeyser";

setLogLevel("error");
const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
const UPDATES = (recorded as { updates: { label: string; b64: string }[] }).updates;
const bytesOf = (label: string) => {
  const u = UPDATES.find((x) => x.label.split("+").includes(label));
  if (!u) throw new Error(`no recorded update ${label}`);
  return new Uint8Array(Buffer.from(u.b64, "base64"));
};
const decoded = (label: string) => SubscribeUpdate.decode(bytesOf(label));

describe("parseSubscribeUpdate (recorded protobufs)", () => {
  test.each(["pump-create-v2", "pump-buy", "pump-sell", "pump-complete", "pump-migrate", "amm-buy", "amm-sell"])(
    "%s: same events as decoding the transaction directly",
    (label) => {
      const p = parseSubscribeUpdate(decoded(label), 1_000);
      expect(p.kind).toBe("tx");
      if (p.kind !== "tx") return;
      const f = fixture(label);
      expect(p.tx.signature).toBe(f.signature);
      expect(p.tx.slot).toBe(f.tx.slot);
      expect(p.failures).toEqual([]);
      expect(JSON.stringify(p.tx.events, big)).toBe(JSON.stringify(decodeTransactionEvents(eventInput(f.tx)).events, big));
      expect(p.tx.signers?.length).toBe(f.tx.transaction.message.header.numRequiredSignatures);
      expect(p.tx.signers?.[0]).toBe(f.tx.transaction.message.accountKeys[0] as string);
      expect(p.tx.sourceCreatedAt).toBe((f.tx.blockTime ?? 0) * 1000 + 250);
      expect(p.tx.receivedAt).toBe(1_000);
    },
  );

  test("PumpSwap swaps carry the pool's base mint from instruction accounts; balances are absolute", () => {
    const p = parseSubscribeUpdate(decoded("amm-buy"), 0);
    if (p.kind !== "tx") throw new Error("expected tx");
    expect(p.tx.poolMints).toEqual([
      expect.objectContaining({
        pool: "37DYHS64kSovQoz1Zb3jq7gFKPQdUvC7gt2cWsa3EB4y",
        baseMint: "kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump",
      }),
    ]);
    const buyer = fixture("amm-buy").tx.meta.postTokenBalances?.find(
      (b) => b.owner === "J9fw6YJpurCpzrUsMiByCYnhtofcVMjns5ew9dGEJxAy" && b.mint.endsWith("pump"),
    );
    expect(p.tx.tokenBalances).toContainEqual({
      mint: "kHdpWPAq9K9JMJUo4Hd4eNcG82FzqFaXY3HvkJZpump",
      owner: "J9fw6YJpurCpzrUsMiByCYnhtofcVMjns5ew9dGEJxAy",
      amount: BigInt(buyer?.uiTokenAmount.amount ?? "-1"),
    });
  });

  test("blocks_meta and slot statuses", () => {
    const meta = parseSubscribeUpdate(decoded("blocks_meta"), 0);
    expect(meta).toMatchObject({ kind: "blockMeta", meta: { blockHeight: 431_000_000, slot: fixture("pump-create-v2").tx.slot } });
    expect(parseSubscribeUpdate(decoded("slot-confirmed"), 0)).toMatchObject({ kind: "slot", status: "confirmed" });
    expect(parseSubscribeUpdate(decoded("slot-dead"), 0)).toMatchObject({ kind: "slot", status: "dead", deadError: "fork" });
  });

  test("failed transactions are reported, not decoded", () => {
    const u = decoded("pump-buy");
    if (!u.transaction?.transaction?.meta) throw new Error("bad fixture");
    u.transaction.transaction.meta.err = { err: new Uint8Array([1, 2]) };
    expect(parseSubscribeUpdate(u, 0)).toMatchObject({ kind: "failedTx" });
  });
});

describe("chain blockhash from blocks_meta (stream mode)", () => {
  test("published once the slot is confirmed; lastValidBlockHeight = height + 150", () => {
    const deltas: ChainDelta[] = [];
    const chain = new ChainPublisher({
      rpc: new RpcClient({ url: "http://unused" }),
      blockhashMode: "stream",
      pollMs: 1_000,
      onChange: (d) => deltas.push(d),
    });
    const meta: BlockMeta = { slot: 10, blockhash: "BH10", blockHeight: 1_000, blockTime: 1, parentSlot: 9 };
    chain.onBlockMeta(meta);
    expect(chain.state.blockhash).toBeNull(); // processed only: not yet
    chain.onSlot(10, "confirmed");
    expect(chain.state).toMatchObject({ blockhash: "BH10", lastValidBlockHeight: 1_150, blockhashSlot: 10 });
    chain.onSlot(9, "confirmed"); // older slots never move it back
    chain.onBlockMeta({ ...meta, slot: 9, blockhash: "BH9", blockHeight: 999 });
    expect(chain.state.blockhash).toBe("BH10");
    expect(deltas.some((d) => d.blockhash === "BH10")).toBe(true);
  });
});

describe("YellowstoneSource with the real N-API client under Bun", () => {
  test("subscribes with the right filters, streams updates, reconnects and resumes from the last slot", async () => {
    const txLabels = ["pump-create-v2", "pump-buy", "amm-sell"];
    const geyser = await startMockGeyser((session) => ({
      updates: session === 0 ? [...txLabels.map(bytesOf), bytesOf("blocks_meta"), bytesOf("slot-confirmed")] : [bytesOf("pump-sell")],
      end: session === 0,
    }));
    const txs: IngestTx[] = [];
    const slots: [number, SlotStatus][] = [];
    const metas: BlockMeta[] = [];
    const src = new YellowstoneSource({
      endpoint: `http://127.0.0.1:${geyser.port}`,
      xToken: "test-token",
      commitment: "processed",
      programs: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID],
      pingIntervalMs: 60_000,
    });
    src.start({ tx: (t) => txs.push(t), slot: (s, st) => slots.push([s, st]), blockMeta: (m) => metas.push(m) });
    try {
      await waitFor(() => txs.length >= 4, 10_000);
      expect(txs.map((t) => t.signature)).toEqual([...txLabels, "pump-sell"].map((l) => fixture(l).signature));
      expect(metas).toHaveLength(1);
      expect(slots).toContainEqual([fixture("pump-create-v2").tx.slot, "confirmed"]);
      expect(src.health().reconnects).toBeGreaterThanOrEqual(1);
      expect(geyser.tokens[0]).toBe("test-token");
      const subs = geyser.requests.filter((r) => Object.keys(r.transactions).length > 0);
      const first = subs[0];
      expect(first?.transactions.launchpads).toMatchObject({
        vote: false,
        failed: false,
        accountInclude: [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID],
      });
      expect(first?.commitment).toBe(CommitmentLevel.PROCESSED);
      expect(first?.slots.slots).toMatchObject({ filterByCommitment: false });
      expect(first?.fromSlot).toBeUndefined();
      // blocks_meta {"blockmeta": {}} goes out as a key-only map entry (field 5): tag 0x2a, key "blockmeta"
      const rawFirst = Buffer.from(geyser.raw[geyser.requests.indexOf(first as never)] ?? []).toString("hex");
      expect(rawFirst).toContain(`2a0b0a09${Buffer.from("blockmeta").toString("hex")}`);
      // resubscribe replays from a few slots before the last one seen
      const maxSlot = Math.max(...txLabels.map((l) => fixture(l).tx.slot));
      expect(Number(subs[1]?.fromSlot)).toBe(maxSlot - 8);
    } finally {
      await src.stop();
      await geyser.close();
    }
  }, 20_000);
});
