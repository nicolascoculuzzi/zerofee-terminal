/**
 * Local mainnet fork:  bun run fork:start [mint ...] [--reuse] [--no-feature-set] [--allow-missing]
 *
 *  1. Picks targets - the mints you pass, the previous fork's (--reuse), or auto-picked from recent on-chain
 *     activity - and resolves every account their trades touch (accounts.ts). Required kinds (a Token-2022
 *     curve coin and a canonical PumpSwap pool) missing from the mints you pass are discovered; when
 *     discovery cannot find one either, it fails fast with how to pass one (or starts anyway with
 *     --allow-missing, and the e2e cases that need it are skipped). Mainnet is read READ-ONLY: the
 *     clone-source client refuses every method that is not a read.
 *  2. Launches solana-test-validator bound to 127.0.0.1 with a fresh ledger in FORK_DIR (outside the repo by
 *     default), cloning exactly that set plus mainnet's feature set. It runs detached: `bun run fork:stop`.
 *  3. Waits for health; verifies every required clone exists and every program's ELF is byte-identical to
 *     mainnet's; tops up cloned accounts that sit below the fork's rent-exempt minimum (the test validator's
 *     genesis keeps the classic rent rate, see docs/dev/FORK_TESTING.md); proves the faucet with an in-memory
 *     keypair; writes FORK_DIR/fork.json and prints the env the e2e suite reads.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { fetchRawAccounts, maxBig, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, systemTransferInstruction } from "../../src";
import {
  classifyMints,
  createReadOnlyRpc,
  type DiscoveryStats,
  describeStats,
  discoverTargets,
  programElfFingerprints,
  REQUIRED_KINDS,
  resolveCloneList,
} from "./accounts";
import {
  assertLoopbackUrl,
  cloneSourceUrl,
  type ForkManifest,
  type ForkPaths,
  type ForkTarget,
  forkPaths,
  forkPorts,
  isHealthy,
  isValidatorProcess,
  MANIFEST_VERSION,
  type ProgramCheck,
  type RentTopUp,
  readManifest,
  redactUrl,
  sleep,
  type TargetKind,
  toJson,
  validatorBinary,
} from "./env";

const USAGE = "usage: bun run fork:start [mint ...] [--reuse] [--no-feature-set] [--allow-missing]";
const OPTIONS = new Set(["--reuse", "--no-feature-set", "--allow-missing"]);
const KIND_HINT: Partial<Record<TargetKind, string>> = {
  curve2022: "a Token-2022 (create_v2) pump.fun coin still on its bonding curve, not within 10% of completion",
  pumpswap: "a migrated pump.fun coin trading on its canonical PumpSwap wSOL pool",
};

/** The clear failure when a required target is missing after discovery. */
function missingTargetsMessage(missing: readonly TargetKind[], source: string, stats: DiscoveryStats | null): string {
  const lines = [`no ${missing.join(" / ")} target found.`];
  for (const k of missing) lines.push(`  ${k}: ${KIND_HINT[k] ?? k}`);
  if (stats) lines.push(`  discovery read ${describeStats(stats)} through ${redactUrl(source)}`);
  lines.push(
    "  The public RPC throttles getTransaction, so discovery can come up empty. Any of these fixes it:",
    "    - pass the mints:  bun run fork:start <token-2022 curve mint> <pumpswap mint>   (missing kinds are still discovered)",
    "    - point FORK_CLONE_URL at your own RPC, or raise FORK_DISCOVERY_TIMEOUT_MS",
    "    - run it again (discovery reads newer activity each time)",
    "    - add --allow-missing to start anyway: the e2e cases that need the missing target are skipped",
  );
  return lines.join("\n");
}

const START_TIMEOUT_MS = Number(process.env.FORK_START_TIMEOUT_MS ?? 240_000);

const t0 = performance.now();
const log = (line = "") => console.log(line);
const elapsed = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

function fail(msg: string, child?: ChildProcess): never {
  if (child?.pid && child.exitCode === null) child.kill("SIGKILL");
  console.error(`\nfork:start failed: ${msg}`);
  process.exit(1);
}

function tail(path: string, lines = 25): string {
  try {
    return readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no output)";
  }
}

function printEnv(m: Pick<ForkManifest, "rpcUrl" | "wsUrl">, paths: ForkPaths) {
  log(`  export FORK_RPC_URL=${m.rpcUrl}`);
  log(`  export FORK_WS_URL=${m.wsUrl}`);
  log(`  export FORK_DIR=${paths.dir}`);
  log("");
  log("next: bun run e2e        stop: bun run fork:stop");
}

/** Prepares FORK_DIR without ever clobbering a directory start.ts did not create. */
function prepareDir(paths: ForkPaths) {
  if (existsSync(paths.dir) && readdirSync(paths.dir).length > 0 && !existsSync(paths.markerPath)) {
    fail(`${paths.dir} exists and was not created by fork:start; set FORK_DIR to an empty or new directory`);
  }
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.markerPath, "Created by zerofee-terminal fork:start. bun run fork:stop deletes this directory.\n");
  rmSync(paths.ledgerDir, { recursive: true, force: true });
  rmSync(paths.reportPath, { force: true });
}

type LocalRpc = Rpc<SolanaRpcApi>;

async function waitForSignature(rpc: LocalRpc, sig: Signature, what: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const s = value[0];
    if (s?.err) throw new Error(`${what} failed on the fork: ${toJson(s.err, 0)}`);
    if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") return;
    await sleep(250);
  }
  throw new Error(`${what} did not confirm within ${timeoutMs} ms`);
}

/** Owners whose accounts may encode "lamports above rent" as program state (curve SOL, accrued fees, ...). */
const LAMPORT_ACCOUNTING_PROGRAMS: readonly Address[] = [PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID];

/**
 * The test validator's genesis keeps the classic rent rate (6,960 lamports/byte incl. overhead) while mainnet
 * charges 5,080, so balances that satisfy mainnet's rent rules can violate the fork's:
 *  - Any account below the fork's rent-exempt minimum is "rent-paying" there, and the runtime rejects a
 *    transaction that credits it without lifting it to the minimum (e.g. a 1,000-lamport Jito tip into a freshly
 *    swept tip account fails with InsufficientFundsForRent). Such accounts are lifted to the fork's minimum.
 *  - pump treats lamports above rent(len) as program state (a bonding curve holds rent + its real SOL + any
 *    tracked extras such as fee-sharing balances) and charges the trader whenever that cushion falls short, so
 *    on an un-normalized fork the first trade paid the rent-rate difference (524,520 lamports for a 151-byte
 *    curve) into the curve - a cost that does not exist on mainnet. Accounts owned by the pump / PumpSwap / fees
 *    programs therefore get exactly rent_fork(len) - rent_mainnet(len) added, which preserves lamports - rent.
 * Mainnet rent is read live (never hardcoded). Trade math never reads these lamports; every top-up is recorded.
 */
async function normalizeRent(
  rpc: LocalRpc,
  mainnetRent: (len: number) => Promise<bigint>,
  addresses: readonly Address[],
): Promise<RentTopUp[]> {
  const accs = await fetchRawAccounts(rpc, addresses);
  const forkRentByLen = new Map<number, bigint>();
  const deficits: { address: Address; len: number; before: bigint; min: bigint }[] = [];
  // Programs are cloned separately and never appear in `addresses`.
  for (const acc of accs) {
    if (!acc) continue;
    const len = acc.data.length;
    let forkMin = forkRentByLen.get(len);
    if (forkMin === undefined) {
      forkMin = await rpc.getMinimumBalanceForRentExemption(BigInt(len)).send();
      forkRentByLen.set(len, forkMin);
    }
    const target = LAMPORT_ACCOUNTING_PROGRAMS.includes(acc.owner)
      ? acc.lamports + maxBig(0n, forkMin - (await mainnetRent(len)))
      : maxBig(acc.lamports, forkMin);
    if (target > acc.lamports) deficits.push({ address: acc.address, len, before: acc.lamports, min: target });
  }
  if (deficits.length === 0) return [];

  // Fund an in-memory keypair from the local faucet (proves the faucet), then pay the deficits from it.
  const keyPair = await generateKeyPair();
  const funder = await getAddressFromPublicKey(keyPair.publicKey);
  const total = deficits.reduce((s, d) => s + (d.min - d.before), 0n);
  const airdrop = await rpc.requestAirdrop(funder, lamports(total + 1_000_000_000n)).send();
  await waitForSignature(rpc, airdrop, "faucet airdrop");
  for (let i = 0; i < deficits.length; i += 12) {
    const chunk = deficits.slice(i, i + 12);
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(funder, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          chunk.map((d) => systemTransferInstruction({ from: funder, to: d.address, lamports: d.min - d.before })),
          m,
        ),
    );
    const tx = await signTransaction([keyPair], compileTransaction(message));
    await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64" }).send();
    await waitForSignature(rpc, getSignatureFromTransaction(tx), "rent top-up");
  }
  return deficits.map((d) => ({
    address: d.address,
    dataLength: d.len,
    lamportsBefore: d.before.toString(),
    lamportsAfter: d.min.toString(),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith("-") && !OPTIONS.has(a));
  if (unknown.length) fail(`unknown option(s) ${unknown.join(" ")}\n${USAGE}`);
  const reuse = args.includes("--reuse");
  const cloneFeatureSet = !args.includes("--no-feature-set");
  const allowMissing = args.includes("--allow-missing");
  const mints = args.filter((a) => !a.startsWith("-")).map((a) => address(a));

  const paths = forkPaths();
  const ports = forkPorts();
  const rpcUrl = `http://127.0.0.1:${ports.rpc}`;
  const wsUrl = `ws://127.0.0.1:${ports.ws}`;
  assertLoopbackUrl(rpcUrl, "fork RPC");

  let previous: ForkManifest | null = null;
  try {
    previous = readManifest(paths);
  } catch {
    previous = null;
  }
  if (previous?.pid && isValidatorProcess(previous.pid)) {
    if (!(await isHealthy(previous.rpcUrl))) {
      fail(`a fork validator (pid ${previous.pid}) is running but not healthy; run \`bun run fork:stop\` first`);
    }
    log(`fork already running (pid ${previous.pid}); targets: ${previous.targets.map((t) => `${t.kind} ${t.mint}`).join(", ")}`);
    printEnv(previous, paths);
    return;
  }
  if (await isHealthy(rpcUrl)) fail(`something already answers on ${rpcUrl}; stop it or set FORK_RPC_PORT`);

  const source = cloneSourceUrl();
  log(`clone source ${redactUrl(source)} (read-only)`);
  const mainnet = createReadOnlyRpc(source);

  let targets: ForkTarget[];
  let stats: DiscoveryStats | null = null;
  const onStats = (s: DiscoveryStats) => {
    stats = s;
  };
  if (mints.length || (reuse && previous?.targets.length)) {
    const explicit = mints.length ? mints : (previous?.targets ?? []).map((t) => t.mint);
    log(mints.length ? `classifying ${mints.length} mint(s)...` : "re-classifying the previous fork's targets...");
    targets = await classifyMints(mainnet, explicit);
    const missing = REQUIRED_KINDS.filter((k) => !targets.some((t) => t.kind === k));
    if (missing.length) {
      log(`discovering the missing ${missing.join(" / ")} target(s) from recent activity...`);
      targets = [...targets, ...(await discoverTargets(mainnet, { log, kinds: missing, exclude: explicit, onStats }))];
    }
  } else {
    log("auto-picking targets from recent pump / Mayhem / PumpSwap activity...");
    targets = await discoverTargets(mainnet, { log, onStats });
  }
  const missing = REQUIRED_KINDS.filter((k) => !targets.some((t) => t.kind === k));
  if (missing.length) {
    const msg = missingTargetsMessage(missing, source, stats);
    if (!allowMissing || targets.length === 0) fail(msg);
    log(`warn: ${msg.split("\n")[0]} Starting anyway (--allow-missing): the e2e cases that need it are skipped.`);
  }
  if (!targets.some((t) => t.kind === "migration")) {
    log("note: no migration target (a second Token-2022 curve coin); the armed migration-snipe case will be skipped");
  }

  log("resolving accounts...");
  const clone = await resolveCloneList(mainnet, targets);
  const programs = [...clone.upgradeablePrograms, ...clone.programAccounts];
  const mainnetSlot = await mainnet.getSlot({ commitment: "confirmed" }).send();
  const mainnetElves = await programElfFingerprints(mainnet, programs);
  log(
    `clone list: ${clone.upgradeablePrograms.length} upgradeable programs, ${clone.programAccounts.length} program accounts, ` +
      `${clone.accounts.length} accounts, ${clone.maybeAccounts.length} optional (mainnet slot ${mainnetSlot})`,
  );

  prepareDir(paths);
  const argv = [
    "--reset",
    "--quiet",
    "--ledger",
    paths.ledgerDir,
    "--bind-address",
    "127.0.0.1",
    "--rpc-port",
    String(ports.rpc),
    "--gossip-port",
    String(ports.gossip),
    "--faucet-port",
    String(ports.faucet),
    "--dynamic-port-range",
    `${ports.dynamicRange[0]}-${ports.dynamicRange[1]}`,
    "--log-messages-bytes-limit",
    "100000",
    "--url",
    source,
    ...(cloneFeatureSet ? ["--clone-feature-set"] : []),
    ...clone.upgradeablePrograms.flatMap((p) => ["--clone-upgradeable-program", p]),
    ...[...clone.programAccounts, ...clone.accounts].flatMap((a) => ["--clone", a]),
    ...clone.maybeAccounts.flatMap((a) => ["--maybe-clone", a]),
  ];
  const bin = validatorBinary();
  log(`launching ${bin} (log: ${paths.outPath})...`);
  const out = openSync(paths.outPath, "w");
  const child = spawn(bin, argv, { detached: true, stdio: ["ignore", out, out] });
  let spawnError: Error | null = null;
  child.on("error", (e) => {
    spawnError = e;
  });
  const abort = () => fail("interrupted", child);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await isHealthy(rpcUrl))) {
    if (spawnError) fail(`could not launch ${bin}: ${String(spawnError)} (set SOLANA_TEST_VALIDATOR)`);
    if (child.exitCode !== null) {
      fail(`validator exited with code ${child.exitCode}:\n${tail(paths.outPath)}\n${tail(`${paths.ledgerDir}/validator.log`)}`);
    }
    if (Date.now() > deadline) fail(`validator not healthy after ${START_TIMEOUT_MS} ms:\n${tail(paths.outPath)}`, child);
    await sleep(500);
  }
  log(`validator healthy after ${elapsed()} (pid ${child.pid})`);

  const local = createSolanaRpc(rpcUrl);
  try {
    // Every required clone exists, optional ones as on mainnet.
    const localAccs = await fetchRawAccounts(local, clone.accounts);
    const missing = clone.accounts.filter((_, i) => !localAccs[i]);
    if (missing.length) fail(`clones missing on the fork: ${missing.join(", ")}`, child);
    const maybeLocal = await fetchRawAccounts(local, clone.maybeAccounts);
    const presentMaybe = clone.maybeAccounts.filter((_, i) => maybeLocal[i]);

    // The fork must execute mainnet's exact program binaries.
    const localElves = await programElfFingerprints(local, programs);
    const checks: ProgramCheck[] = mainnetElves.map((m, i) => ({
      program: m.program,
      loader: m.loader,
      mainnetSha256: m.sha256,
      localSha256: localElves[i]?.sha256 ?? "missing",
      bytes: m.bytes,
    }));
    const mismatched = checks.filter((c) => c.mainnetSha256 !== c.localSha256);
    if (mismatched.length) fail(`program ELF differs from mainnet: ${mismatched.map((c) => c.program).join(", ")}`, child);

    const mainnetRentByLen = new Map<number, Promise<bigint>>();
    const mainnetRent = (len: number) => {
      let r = mainnetRentByLen.get(len);
      if (!r) {
        r = mainnet
          .getMinimumBalanceForRentExemption(BigInt(len))
          .send()
          .then((v) => BigInt(v));
        mainnetRentByLen.set(len, r);
      }
      return r;
    };
    const rentTopUps = await normalizeRent(local, mainnetRent, [...clone.accounts, ...presentMaybe]);
    // Prove the faucet even when no top-up was needed.
    if (rentTopUps.length === 0) {
      const kp = await generateKeyPair();
      const sig = await local.requestAirdrop(await getAddressFromPublicKey(kp.publicKey), lamports(1_000_000_000n)).send();
      await waitForSignature(local, sig, "faucet airdrop");
    }

    const version = await local.getVersion().send();
    const manifest: ForkManifest = {
      version: MANIFEST_VERSION,
      startedAt: new Date().toISOString(),
      pid: child.pid as number,
      rpcUrl,
      wsUrl,
      ports,
      ledgerDir: paths.ledgerDir,
      outPath: paths.outPath,
      cloneSource: redactUrl(source),
      mainnetSlotAtClone: mainnetSlot.toString(),
      featureSetCloned: cloneFeatureSet,
      validatorVersion: version["solana-core"],
      targets,
      clone,
      programs: checks,
      rentTopUps,
    };
    writeFileSync(paths.manifestPath, toJson(manifest));
    child.unref();

    log("");
    log(`fork ready in ${elapsed()}: solana-test-validator ${manifest.validatorVersion} on 127.0.0.1 (pid ${manifest.pid})`);
    log(`  ledger       ${paths.ledgerDir}`);
    for (const t of targets) log(`  ${t.kind.padEnd(12)} ${t.mint}  ${t.venue === "pump" ? "" : `pool ${t.market}, `}${t.note}`);
    log(
      `  cloned       ${programs.length} programs (ELF identical to mainnet), ${clone.accounts.length} accounts, ` +
        `${presentMaybe.length}/${clone.maybeAccounts.length} optional`,
    );
    log(`  rent         ${rentTopUps.length} cloned accounts topped up to the fork's rent-exempt minimum`);
    log(`  feature set  ${cloneFeatureSet ? "cloned from mainnet" : "test-validator default (all features)"}`);
    log("");
    printEnv(manifest, paths);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), child);
  }
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
}

await main();
process.exit(0);
