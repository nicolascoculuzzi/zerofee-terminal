/**
 * Writer thread: owns a second connection to the market database and applies the StorageWriter's batches
 * there, so SQLite inserts (5-50 ms per flush under the firehose, more as the tables grow) never run on the
 * event loop that reads the ingest socket and serves clients. WAL lets the main thread keep reading.
 *
 * Messages in:  { type: "init", path } | { type: "batch", id, batch } | { type: "prune", id, now, retentionHours, pruneBatch } | { type: "close", id }
 * Messages out: { type: "done", id, ms, rows, pruned?, error? }
 */
import type { Database } from "bun:sqlite";
import { BatchApplier, batchRows, type WriteBatch } from "./batch";
import { openDb } from "./db";

declare const self: Worker;

type In =
  | { type: "init"; path: string }
  | { type: "batch"; id: number; batch: WriteBatch }
  | { type: "prune"; id: number; now: number; retentionHours: number; pruneBatch: number }
  | { type: "close"; id: number };

let db: Database | null = null;
let applier: BatchApplier | null = null;
let dbPath = "";

function open(): BatchApplier {
  if (applier) return applier;
  if (!dbPath) throw new Error("writer thread: no database path (init first)");
  db = openDb(dbPath);
  applier = new BatchApplier(db);
  return applier;
}

self.onmessage = (ev: MessageEvent<In>) => {
  const m = ev.data;
  if (m.type === "init") {
    dbPath = m.path;
    return;
  }
  const t0 = performance.now();
  try {
    if (m.type === "batch") {
      open().apply(m.batch);
      self.postMessage({ type: "done", id: m.id, ms: performance.now() - t0, rows: batchRows(m.batch) });
    } else if (m.type === "prune") {
      const pruned = open().prune(m.now, m.retentionHours, m.pruneBatch);
      self.postMessage({ type: "done", id: m.id, ms: performance.now() - t0, rows: 0, pruned });
    } else if (m.type === "close") {
      db?.close();
      db = null;
      applier = null;
      self.postMessage({ type: "done", id: m.id, ms: 0, rows: 0 });
    }
  } catch (e) {
    self.postMessage({ type: "done", id: m.id, ms: performance.now() - t0, rows: 0, error: e instanceof Error ? e.message : String(e) });
  }
};
