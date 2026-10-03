/**
 * Dev tool: captures real mainnet pump.fun / PumpSwap transactions for the offline event-decoder tests
 * into test/fixtures/event-txs.json. Read-only: one public-RPC `logsSubscribe` per program to spot each
 * event kind, then `getTransaction` for the chosen signatures, plus pairs of consecutive trades on one
 * bonding curve and one pool (reserve-continuity tests). No keys involved, nothing is sent.
 *   bun run packages/core/scripts/capture-event-fixtures.ts [maxMinutes] [found-signatures.json]
 * The public RPC enforces a per-IP data allowance (~100 MB / 30 s) that the logs stream alone nearly
 * uses up, so the fetch phase retries "data allowance" errors and phase 1 can be skipped by passing the
 * signatures file it writes (`<fixture>.found.json`).
 */
import type { Address } from "@solana/kit";
import { DEFAULT_RPC_URL, decodeLogEvents, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src";

const RPC = process.env.RPC_URL ?? DEFAULT_RPC_URL;
const WS = process.env.RPC_WS_URL ?? RPC.replace(/^http/, "ws");
const MAX_MS = Number(process.argv[2] ?? 12) * 60_000;
const FOUND_FILE = process.argv[3];

const REQUIRED = ["pump-create-v2", "pump-buy", "pump-sell", "pump-complete", "pump-migrate", "amm-buy", "amm-sell"] as const;
const OPTIONAL = ["pump-create-legacy", "pump-create-and-buy", "pump-mayhem-trade", "pump-non-sol-trade", "pump-multi-buyer-tx"] as const;
type Label = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];

const found = new Map<Label, { signature: string; slot: number }>();

function classify(logs: string[]): Label[] {
  const { events } = decodeLogEvents(logs);
  const labels: Label[] = [];
  const creates = events.filter((e) => e.kind === "pumpCreate");
  const trades = events.filter((e) => e.kind === "pumpTrade");
  for (const c of creates) {
    if (c.tokenProgram === TOKEN_2022_PROGRAM_ID) labels.push("pump-create-v2");
    if (c.tokenProgram === TOKEN_PROGRAM_ID) labels.push("pump-create-legacy");
  }
  if (creates.length && trades.some((t) => t.isBuy)) labels.push("pump-create-and-buy");
  if (trades.some((t) => t.isBuy)) labels.push("pump-buy");
  if (trades.some((t) => !t.isBuy)) labels.push("pump-sell");
  if (trades.some((t) => t.mayhemMode)) labels.push("pump-mayhem-trade");
  if (trades.some((t) => t.quote && t.quote.mint !== "11111111111111111111111111111111" && !t.quote.mint.startsWith("So1111")))
    labels.push("pump-non-sol-trade");
  if (new Set(trades.filter((t) => t.isBuy).map((t) => t.user)).size >= 2) labels.push("pump-multi-buyer-tx");
  if (events.some((e) => e.kind === "pumpComplete")) labels.push("pump-complete");
  if (events.some((e) => e.kind === "pumpMigrate")) labels.push("pump-migrate");
  if (events.some((e) => e.kind === "ammBuy")) labels.push("amm-buy");
  if (events.some((e) => e.kind === "ammSell")) labels.push("amm-sell");
  return labels;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429 && attempt < 8) {
      await Bun.sleep(1500 * (attempt + 1));
      continue;
    }
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error && /data allowance/i.test(j.error.message) && attempt < 8) {
      console.warn(`  ${method}: ${j.error.message}; waiting 35 s`);
      await Bun.sleep(35_000);
      continue;
    }
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result as T;
  }
}

const TX_OPTS = { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" };

/** Keeps only what decoders and source parsers read (drops balances, rewards, return data). */
function slimTx(tx: Record<string, unknown>): Record<string, unknown> {
  const t = tx.transaction as { signatures: string[]; message: Record<string, unknown> };
  const m = tx.meta as Record<string, unknown>;
  const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
  return {
    slot: tx.slot,
    blockTime: tx.blockTime,
    version: tx.version,
    transaction: {
      signatures: t.signatures,
      message: pick(t.message, ["header", "accountKeys", "recentBlockhash", "instructions", "addressTableLookups"]),
    },
    meta: pick(m, [
      "err",
      "fee",
      "logMessages",
      "innerInstructions",
      "loadedAddresses",
      "preTokenBalances",
      "postTokenBalances",
      "computeUnitsConsumed",
    ]),
  };
}

async function getTx(signature: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 20; i++) {
    const tx = await rpc<Record<string, unknown> | null>("getTransaction", [signature, TX_OPTS]);
    if (tx) return slimTx(tx);
    await Bun.sleep(1500);
  }
  throw new Error(`getTransaction ${signature}: not found`);
}

// ---- 1. watch logs until every required kind has a signature ------------------------------------------
const file = new URL("../test/fixtures/event-txs.json", import.meta.url);
if (FOUND_FILE) {
  const saved = (await Bun.file(FOUND_FILE).json()) as Record<string, { signature: string; slot: number }>;
  for (const [label, v] of Object.entries(saved)) found.set(label as Label, v);
  console.log(`loaded ${found.size} signatures from ${FOUND_FILE}`);
} else
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS);
    const done = () => {
      ws.close();
      resolve();
    };
    const timer = setTimeout(done, MAX_MS);
    ws.onopen = () => {
      for (const [i, p] of [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID].entries()) {
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [p] }, { commitment: "confirmed" }] }),
        );
      }
      console.log(`watching ${WS} for up to ${MAX_MS / 60_000} min...`);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.method !== "logsNotification") return;
      const v = m.params.result.value as { signature: string; err: unknown; logs: string[] };
      if (v.err) return;
      for (const label of classify(v.logs)) {
        if (found.has(label)) continue;
        found.set(label, { signature: v.signature, slot: m.params.result.context.slot });
        console.log(`  ${label.padEnd(22)} ${v.signature}`);
      }
      if (REQUIRED.every((l) => found.has(l)) && OPTIONAL.every((l) => found.has(l))) {
        clearTimeout(timer);
        done();
      }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });

const missing = REQUIRED.filter((l) => !found.has(l));
if (missing.length) console.warn(`WARNING: no sample for ${missing.join(", ")} (try a longer window)`);
if (!FOUND_FILE) {
  const foundPath = `${Bun.fileURLToPath(file)}.found.json`;
  await Bun.write(foundPath, JSON.stringify(Object.fromEntries(found), null, 1));
  console.log(`saved signatures to ${foundPath}; letting the data allowance window reset (35 s)`);
  await Bun.sleep(35_000);
}

// ---- 2. fetch the full transactions (one entry per signature, all its labels) ------------------------
const txs: { labels: string[]; signature: string; tx: Record<string, unknown> }[] = [];
for (const [label, { signature }] of found) {
  const existing = txs.find((t) => t.signature === signature);
  if (existing) {
    existing.labels.push(label);
    continue;
  }
  txs.push({ labels: [label], signature, tx: await getTx(signature) });
  console.log(`fetched ${label}`);
  await Bun.sleep(300);
}

// ---- 3. consecutive trade pairs on one curve and one pool (reserve continuity) ------------------------
interface SigInfo {
  signature: string;
  err: unknown;
  slot: number;
}
async function consecutivePair(account: string, label: string): Promise<void> {
  const sigs = await rpc<SigInfo[]>("getSignaturesForAddress", [account, { limit: 30, commitment: "confirmed" }]);
  // newest first: find two adjacent successful entries
  for (let i = 0; i + 1 < sigs.length; i++) {
    const newer = sigs[i] as SigInfo;
    const older = sigs[i + 1] as SigInfo;
    if (newer.err || older.err) continue;
    const a = await getTx(older.signature);
    const b = await getTx(newer.signature);
    txs.push({ labels: [`${label}-1`], signature: older.signature, tx: a }, { labels: [`${label}-2`], signature: newer.signature, tx: b });
    console.log(`fetched consecutive pair on ${account}`);
    return;
  }
  console.warn(`no consecutive successful pair on ${account}`);
}

const buyTx = txs.find((t) => t.labels.includes("pump-buy"));
const ammTx = txs.find((t) => t.labels.includes("amm-buy"));
type Meta = { logMessages: string[] };
if (buyTx) {
  const ev = decodeLogEvents((buyTx.tx.meta as Meta).logMessages).events.find((e) => e.kind === "pumpTrade");
  const { bondingCurvePda } = await import("../src");
  if (ev && ev.kind === "pumpTrade") await consecutivePair(await bondingCurvePda(ev.mint as Address), "pump-pair");
}
if (ammTx) {
  const ev = decodeLogEvents((ammTx.tx.meta as Meta).logMessages).events.find((e) => e.kind === "ammBuy");
  if (ev && ev.kind === "ammBuy") await consecutivePair(ev.pool, "amm-pair");
}

await Bun.write(file, `${JSON.stringify({ capturedAt: new Date().toISOString(), rpc: RPC, txs })}\n`);
console.log(`wrote ${txs.length} transactions to ${file.pathname}`);
