/**
 * Image / metadata worker process (media/pool.ts spawns it under `nice`). Answers one request at a time over
 * Bun's IPC channel; it holds no state and touches no network, disk or database.
 */
import { makeMaster, parseMetadataText, renderSize } from "./imageops";
import type { WorkReply, WorkRequest } from "./pool";

async function handle(m: WorkRequest): Promise<WorkReply> {
  try {
    switch (m.op) {
      case "master":
        return { id: m.id, ok: true, value: await makeMaster(m.bytes, m.format, m.maxPixels, m.size) };
      case "render":
        return { id: m.id, ok: true, value: await renderSize(m.bytes, m.size) };
      case "metadata":
        return { id: m.id, ok: true, value: parseMetadataText(m.text, m.gateways) };
    }
  } catch (e) {
    return {
      id: (m as { id: number }).id,
      ok: false,
      error: (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e)),
    };
  }
}

process.on("message", (m: WorkRequest) => {
  void handle(m).then((reply) => process.send?.(reply));
});
// the parent went away: nothing left to do
process.on("disconnect", () => process.exit(0));
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, 2_000).unref();
