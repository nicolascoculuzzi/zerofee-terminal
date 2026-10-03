/**
 * Dev tool: writes test/fixtures/yellowstone-updates.json - Yellowstone SubscribeUpdate messages in
 * protobuf wire format (base64), reconstructed from real mainnet transactions (getTransaction json,
 * packages/core/test/fixtures/event-txs.json) plus blocks_meta and slot-status updates. Without a paid
 * gRPC endpoint this is the closest thing to recorded updates: tests decode these bytes with the
 * client's own SubscribeUpdate codec and run them through the parser and the source.
 *   bun run apps/server/scripts/record-yellowstone-fixtures.ts
 */
import { getAddressEncoder, getBase58Encoder } from "@solana/kit";
import { SlotStatus, SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import captured from "../../../packages/core/test/fixtures/event-txs.json";
import type { RpcJsonIx, RpcJsonTx } from "../test/helpers";

const b58 = getBase58Encoder();
const addr = getAddressEncoder();
const bytes = (s: string) => new Uint8Array(b58.encode(s));
const key = (s: string) => new Uint8Array(addr.encode(s as never));

function txUpdate(signature: string, tx: RpcJsonTx, index: number): SubscribeUpdate {
  const m = tx.transaction.message;
  const ix = (i: RpcJsonIx) => ({ programIdIndex: i.programIdIndex, accounts: Uint8Array.from(i.accounts), data: bytes(i.data) });
  const bal = (b: NonNullable<RpcJsonTx["meta"]["postTokenBalances"]>[number]) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    programId: b.programId,
    uiTokenAmount: { amount: b.uiTokenAmount.amount, decimals: b.uiTokenAmount.decimals, uiAmount: 0, uiAmountString: "" },
  });
  return SubscribeUpdate.fromPartial({
    filters: ["launchpads"],
    createdAt: new Date((tx.blockTime ?? 0) * 1000 + 250),
    transaction: {
      slot: String(tx.slot),
      transaction: {
        signature: bytes(signature),
        isVote: false,
        index: String(index),
        transaction: {
          signatures: tx.transaction.signatures.map(bytes),
          message: {
            header: m.header,
            accountKeys: m.accountKeys.map(key),
            recentBlockhash: bytes(m.recentBlockhash),
            instructions: m.instructions.map(ix),
            versioned: tx.version !== "legacy",
            addressTableLookups: (m.addressTableLookups ?? []).map((l) => ({
              accountKey: key(l.accountKey),
              writableIndexes: Uint8Array.from(l.writableIndexes),
              readonlyIndexes: Uint8Array.from(l.readonlyIndexes),
            })),
          },
        },
        meta: {
          fee: String(tx.meta.fee),
          innerInstructions: tx.meta.innerInstructions.map((g) => ({
            index: g.index,
            instructions: g.instructions.map((i) => ({ ...ix(i), stackHeight: i.stackHeight ?? undefined })),
          })),
          innerInstructionsNone: false,
          logMessages: tx.meta.logMessages,
          logMessagesNone: false,
          preTokenBalances: (tx.meta.preTokenBalances ?? []).map(bal),
          postTokenBalances: (tx.meta.postTokenBalances ?? []).map(bal),
          loadedWritableAddresses: (tx.meta.loadedAddresses?.writable ?? []).map(key),
          loadedReadonlyAddresses: (tx.meta.loadedAddresses?.readonly ?? []).map(key),
          computeUnitsConsumed: tx.meta.computeUnitsConsumed !== undefined ? String(tx.meta.computeUnitsConsumed) : undefined,
        },
      },
    },
  });
}

const WANTED = ["pump-create-v2", "pump-buy", "pump-sell", "pump-complete", "pump-migrate", "amm-buy", "amm-sell"];
const fx = (captured as unknown as { txs: { labels: string[]; signature: string; tx: RpcJsonTx }[] }).txs.filter((t) =>
  t.labels.some((l) => WANTED.includes(l)),
);
const updates: { label: string; b64: string }[] = [];
fx.forEach((t, i) => {
  updates.push({
    label: t.labels.join("+"),
    b64: Buffer.from(SubscribeUpdate.encode(txUpdate(t.signature, t.tx, i)).finish()).toString("base64"),
  });
});
const first = fx[0]?.tx as RpcJsonTx;
const meta = SubscribeUpdate.fromPartial({
  filters: ["blockmeta"],
  createdAt: new Date((first.blockTime ?? 0) * 1000 + 400),
  blockMeta: {
    slot: String(first.slot),
    blockhash: first.transaction.message.recentBlockhash,
    blockTime: { timestamp: String(first.blockTime) },
    blockHeight: { blockHeight: "431000000" },
    parentSlot: String(first.slot - 1),
    parentBlockhash: first.transaction.message.recentBlockhash,
    executedTransactionCount: "1500",
    entriesCount: "64",
  },
});
updates.push({ label: "blocks_meta", b64: Buffer.from(SubscribeUpdate.encode(meta).finish()).toString("base64") });
for (const [label, status] of [
  ["slot-confirmed", SlotStatus.SLOT_CONFIRMED],
  ["slot-dead", SlotStatus.SLOT_DEAD],
] as const) {
  const u = SubscribeUpdate.fromPartial({
    filters: ["slots"],
    createdAt: new Date(),
    slot: {
      slot: String(first.slot),
      parent: String(first.slot - 1),
      status,
      ...(status === SlotStatus.SLOT_DEAD ? { deadError: "fork" } : {}),
    },
  });
  updates.push({ label, b64: Buffer.from(SubscribeUpdate.encode(u).finish()).toString("base64") });
}
const file = new URL("../test/fixtures/yellowstone-updates.json", import.meta.url);
await Bun.write(
  file,
  `${JSON.stringify({ note: "SubscribeUpdate protobufs reconstructed from real mainnet transactions (see script)", updates })}\n`,
);
console.log(`wrote ${updates.length} updates`);
