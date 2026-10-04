/**
 * Stops the local mainnet fork:  bun run fork:stop [--keep-ledger]
 *
 * Signals the detached solana-test-validator (only after checking the pid really is one), waits for it to
 * exit, then deletes the ledger and logs. fork.json is kept (marked stopped) so `fork:start --reuse` can
 * re-fork the same coins; --keep-ledger leaves everything in place. Nothing outside a directory created by
 * fork:start is ever deleted.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { forkPaths, isHealthy, isProcessAlive, isValidatorProcess, readManifest, sleep, toJson } from "./env";

const keepLedger = process.argv.includes("--keep-ledger");
const paths = forkPaths();
const manifest = (() => {
  try {
    return readManifest(paths);
  } catch {
    return null;
  }
})();

if (!manifest) {
  console.log(`no fork manifest in ${paths.dir}; nothing to stop`);
} else if (manifest.pid && isValidatorProcess(manifest.pid)) {
  process.kill(manifest.pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (isProcessAlive(manifest.pid) && Date.now() < deadline) await sleep(250);
  if (isProcessAlive(manifest.pid)) {
    process.kill(manifest.pid, "SIGKILL");
    await sleep(500);
  }
  console.log(`stopped solana-test-validator (pid ${manifest.pid})`);
} else {
  console.log(`validator (pid ${manifest.pid}) is not running`);
}
if (manifest && (await isHealthy(manifest.rpcUrl))) {
  console.warn(`warn: something still answers on ${manifest.rpcUrl}`);
}

if (manifest && !keepLedger) {
  // Only ever delete inside a directory fork:start created (marker file), never a home/tmp root.
  const dir = resolve(paths.dir);
  const forbidden = new Set([resolve("/"), resolve(homedir()), resolve(tmpdir()), resolve(process.cwd())]);
  if (!existsSync(paths.markerPath) || forbidden.has(dir)) {
    console.warn(`warn: ${dir} has no fork marker (or is a protected path); leaving files in place`);
  } else {
    rmSync(paths.ledgerDir, { recursive: true, force: true });
    rmSync(paths.outPath, { force: true });
    writeFileSync(paths.manifestPath, toJson({ ...manifest, pid: 0, stoppedAt: new Date().toISOString() }));
    console.log(`removed ledger and logs from ${dir} (fork.json kept for --reuse)`);
  }
}
