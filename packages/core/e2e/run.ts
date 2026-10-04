/**
 * `bun run e2e`: runs packages/core/e2e/*.e2e.ts against the local mainnet fork, then prints a CU / size /
 * fee / latency table from the run's report. These files are deliberately not named *.test.ts, so the
 * default (offline, CI) `bun test` never picks them up. Extra args go to `bun test` (e.g. `-t "PumpSwap"`).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertLoopbackUrl, forkPaths, isHealthy, readManifest } from "../scripts/fork/env";
import type { ReportLine } from "./harness";

const paths = forkPaths();
const manifest = readManifest(paths);
if (!manifest?.pid) {
  console.error(`no running fork in ${paths.dir}: run \`bun run fork:start\` first`);
  process.exit(1);
}
assertLoopbackUrl(manifest.rpcUrl, "fork RPC");
if (!(await isHealthy(manifest.rpcUrl))) {
  console.error(`the fork at ${manifest.rpcUrl} is not healthy: run \`bun run fork:start\` (or fork:stop then fork:start)`);
  process.exit(1);
}

console.log(
  `fork: solana-test-validator ${manifest.validatorVersion} at ${manifest.rpcUrl}, cloned at mainnet slot ${manifest.mainnetSlotAtClone}`,
);
for (const t of manifest.targets) console.log(`  ${t.kind.padEnd(10)} ${t.mint}`);

rmSync(paths.reportPath, { force: true });
const files = readdirSync(import.meta.dir)
  .filter((f) => f.endsWith(".e2e.ts"))
  .sort()
  .map((f) => join(import.meta.dir, f));
const proc = Bun.spawn([process.execPath, "test", "--timeout", "180000", ...process.argv.slice(2), ...files], {
  stdio: ["inherit", "inherit", "inherit"],
  env: { ...process.env, FORK_DIR: paths.dir },
});
const code = await proc.exited;

if (existsSync(paths.reportPath)) {
  const rows = readFileSync(paths.reportPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ReportLine);
  const fmt = (n: string | number) => Number(n).toLocaleString("en-US");
  const ms = (r: ReportLine) =>
    r.stages.landed !== undefined && r.stages.sent !== undefined ? `${(r.stages.landed - r.stages.sent).toFixed(0)} ms` : "-";
  // Armed ladders land failures on purpose (a landed failure still consumes its nonce), hence the result column.
  const result = (r: ReportLine) =>
    r.outcome.startsWith("confirmed") ? "ok" : r.outcome.startsWith("failed") ? "failed" : r.outcome || "-";
  const header = ["case", "result", "CU used", "CU limit", "size", "fee", "tips", "sent->landed", "slots"];
  const table = rows.map((r) => [
    r.label,
    result(r),
    fmt(r.computeUnits),
    fmt(r.cuLimit),
    `${r.sizeBytes} B`,
    fmt(r.fee),
    r.tips,
    ms(r),
    r.slotDelta || "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => String(row[i]).length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  console.log(`\nlanded on the fork (${rows.length} transactions; fee = base + priority, lamports):`);
  console.log(line(header));
  for (const row of table) console.log(line(row.map(String)));
  console.log(`report: ${paths.reportPath}`);
}
process.exit(code);
