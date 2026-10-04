/**
 * Daily venue interface watch (SPEC.md "Verify before you code"): pump.fun / PumpSwap, Raydium
 * LaunchLab / CPMM and Jupiter v6.
 *
 * pump.fun: compares the committed IDL snapshots in packages/core/idl/ (pinned in idl/SOURCE.json) with
 * the official repo (github.com/pump-fun/pump-public-docs).
 * Raydium: compares the IDL snapshots pinned in idl/RAYDIUM_SOURCE.json with github.com/raydium-io/raydium-idl,
 * and reports changes to the program sources the layouts were also taken from (the IDL repo lags the
 * deployed programs): raydium-cp-swap's program and raydium-cpi's LaunchLab crate.
 * Both: compares the pinned official SDK versions in packages/core/package.json (the golden-test oracles,
 * incl. @raydium-io/raydium-sdk-v2) with npm.
 * Jupiter: compares idl/jupiter.json (pinned in idl/JUPITER_SOURCE.json) with the program's on-chain
 * Anchor IDL account (RPC_URL, default public mainnet). A new Swap variant means routes through that
 * venue are refused by the signer until its embedded copy is updated.
 * Prints a Markdown report; exits 1 on any drift.
 *
 *   bun run packages/core/scripts/check-pump-idl.ts            # check
 *   bun run packages/core/scripts/check-pump-idl.ts --update   # refresh snapshots, SOURCE.json, RAYDIUM_SOURCE.json, JUPITER_SOURCE.json
 *
 * A drift means: read the upstream changelog, update builders/decoders/constants, re-run the
 * golden tests, and re-arm any armed orders the change invalidates.
 */
import { join } from "node:path";
import { fetchJupiterIdl, readJupiterSource, writeJupiterIdl } from "./jupiter-idl";

const UPSTREAM_REPO = "pump-fun/pump-public-docs";
const IDL_FILES = ["pump.json", "pump_amm.json", "pump_fees.json"] as const;
const SDKS = ["@pump-fun/pump-sdk", "@pump-fun/pump-swap-sdk"] as const;
const RAYDIUM_SDK = "@raydium-io/raydium-sdk-v2";

const coreDir = join(import.meta.dir, "..");
const idlDir = join(coreDir, "idl");
const update = process.argv.includes("--update");

interface Source {
  repo: string;
  commit: string;
  committedAt: string;
  files: Record<string, string>;
}

interface PinnedRepo {
  repo: string;
  /** Watched subtree (program sources); absent = whole repo. */
  path?: string;
  commit: string;
  committedAt: string;
}

/** idl/RAYDIUM_SOURCE.json (other keys are kept as they are). */
interface RaydiumSource {
  idl: PinnedRepo & { files: Record<string, { path: string; sha256: string }> };
  cpmmProgramSource: PinnedRepo;
  launchlabCpiCrate: PinnedRepo;
  sdk: PinnedRepo & { npm: string };
  [key: string]: unknown;
}

interface GhCommit {
  sha: string;
  commit: { committer: { date: string } };
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const ghHeaders: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) ghHeaders.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function ghJson<T>(path: string): Promise<T> {
  return (await (await fetchOk(`https://api.github.com${path}`, { headers: ghHeaders })).json()) as T;
}

async function rawFile(repo: string, commit: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchOk(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`)).arrayBuffer());
}

const pkg = JSON.parse(await Bun.file(join(coreDir, "package.json")).text()) as { devDependencies?: Record<string, string> };
const pinnedVersion = (name: string) => pkg.devDependencies?.[name];

/** npm `latest` vs the version pinned in packages/core/package.json. */
async function checkSdk(name: string, lines: string[]): Promise<boolean> {
  const pinned = pinnedVersion(name) ?? "not pinned";
  const latest = ((await (await fetchOk(`https://registry.npmjs.org/${name}/latest`)).json()) as { version: string }).version;
  if (pinned.replace(/^[\^~]/, "") !== latest) {
    lines.push(`- **${name}: pinned ${pinned}, npm latest ${latest}**`);
    return true;
  }
  lines.push(`- ${name}: ${latest} (pinned)`);
  return false;
}

async function checkPump(lines: string[]): Promise<boolean> {
  let drift = false;
  const head = await ghJson<GhCommit>(`/repos/${UPSTREAM_REPO}/commits/main`);
  const source: Source = JSON.parse(
    await Bun.file(join(idlDir, "SOURCE.json"))
      .text()
      .catch(() => "null"),
  ) ?? {
    repo: UPSTREAM_REPO,
    commit: "",
    committedAt: "",
    files: {},
  };

  // 1) IDL snapshots
  const upstreamHashes: Record<string, string> = {};
  for (const file of IDL_FILES) {
    const bytes = await rawFile(UPSTREAM_REPO, head.sha, `idl/${file}`);
    const upstream = sha256(bytes);
    upstreamHashes[file] = upstream;
    const local = source.files[file];
    if (update) await Bun.write(join(idlDir, file), bytes);
    if (local !== upstream) {
      drift = true;
      lines.push(`- **${file} changed**: snapshot ${local?.slice(0, 12) ?? "missing"} → upstream ${upstream.slice(0, 12)}`);
    } else {
      lines.push(`- ${file}: unchanged`);
    }
  }
  if (head.sha !== source.commit) {
    lines.push(
      `- Upstream main moved: ${source.commit.slice(0, 7) || "none"} → ${head.sha.slice(0, 7)} (${head.commit.committer.date}). ` +
        `Commits: https://github.com/${UPSTREAM_REPO}/compare/${source.commit || "main"}...${head.sha}`,
    );
  }

  // 2) Official SDK versions vs our pinned test oracles
  for (const name of SDKS) drift = (await checkSdk(name, lines)) || drift;

  if (update) {
    const next: Source = { repo: UPSTREAM_REPO, commit: head.sha, committedAt: head.commit.committer.date, files: upstreamHashes };
    await Bun.write(join(idlDir, "SOURCE.json"), `${JSON.stringify(next, null, 2)}\n`);
  }
  return drift;
}

/**
 * Files changed under `pin.path` between the pinned commit and the default branch's HEAD
 * (GitHub compare API; it lists at most 300 files, plenty for a program crate).
 */
async function checkProgramSource(pin: PinnedRepo, lines: string[]): Promise<{ drift: boolean; head: GhCommit }> {
  const head = await ghJson<GhCommit>(`/repos/${pin.repo}/commits/HEAD`);
  const label = `${pin.repo} ${pin.path ?? ""}`.trim();
  if (head.sha === pin.commit) {
    lines.push(`- ${label}: unchanged (${pin.commit.slice(0, 7)})`);
    return { drift: false, head };
  }
  const cmp = await ghJson<{ files?: { filename: string }[] }>(`/repos/${pin.repo}/compare/${pin.commit}...${head.sha}`);
  const prefix = pin.path ? `${pin.path}/` : "";
  const touched = (cmp.files ?? []).map((f) => f.filename).filter((f) => f.startsWith(prefix));
  const compare = `https://github.com/${pin.repo}/compare/${pin.commit}...${head.sha}`;
  if (touched.length === 0) {
    lines.push(`- ${label}: unchanged (repo moved ${pin.commit.slice(0, 7)} → ${head.sha.slice(0, 7)} outside it)`);
    return { drift: false, head };
  }
  const shown = touched.slice(0, 8).join(", ") + (touched.length > 8 ? `, … (${touched.length} files)` : "");
  lines.push(
    `- **${label} changed** since ${pin.commit.slice(0, 7)} (HEAD ${head.sha.slice(0, 7)}, ${head.commit.committer.date}): ${shown}. ${compare}`,
  );
  return { drift: true, head };
}

async function checkRaydium(lines: string[]): Promise<boolean> {
  let drift = false;
  const sourcePath = join(idlDir, "RAYDIUM_SOURCE.json");
  const source = JSON.parse(await Bun.file(sourcePath).text()) as RaydiumSource;

  // 1) IDL snapshots (raydium-io/raydium-idl, default branch)
  const head = await ghJson<GhCommit>(`/repos/${source.idl.repo}/commits/HEAD`);
  for (const [file, pin] of Object.entries(source.idl.files)) {
    const bytes = await rawFile(source.idl.repo, head.sha, pin.path);
    const upstream = sha256(bytes);
    const local = pin.sha256;
    if (update) {
      await Bun.write(join(idlDir, file), bytes);
      pin.sha256 = upstream;
    }
    if (local !== upstream) {
      drift = true;
      lines.push(`- **${file} changed**: snapshot ${local.slice(0, 12)} → upstream ${upstream.slice(0, 12)} (${pin.path})`);
    } else {
      lines.push(`- ${file}: unchanged`);
    }
  }
  if (head.sha !== source.idl.commit) {
    lines.push(
      `- ${source.idl.repo} moved: ${source.idl.commit.slice(0, 7)} → ${head.sha.slice(0, 7)} (${head.commit.committer.date}). ` +
        `Commits: https://github.com/${source.idl.repo}/compare/${source.idl.commit}...${head.sha}`,
    );
  }

  // 2) Program sources the layouts also come from (the IDL repo lags the deployed programs)
  const sources: PinnedRepo[] = [source.cpmmProgramSource, source.launchlabCpiCrate];
  const heads: GhCommit[] = [];
  for (const pin of sources) {
    const r = await checkProgramSource(pin, lines);
    drift = r.drift || drift;
    heads.push(r.head);
  }

  // 3) Official SDK (golden-test oracle) vs npm; RAYDIUM_SOURCE.json records the same pin
  drift = (await checkSdk(RAYDIUM_SDK, lines)) || drift;
  const pinnedSdk = `${RAYDIUM_SDK}@${pinnedVersion(RAYDIUM_SDK) ?? "not pinned"}`;
  if (source.sdk.npm !== pinnedSdk && !update) {
    drift = true;
    lines.push(`- **RAYDIUM_SOURCE.json sdk.npm is ${source.sdk.npm}, package.json pins ${pinnedSdk}**`);
  }

  if (update) {
    source.idl.commit = head.sha;
    source.idl.committedAt = head.commit.committer.date;
    sources.forEach((pin, i) => {
      const h = heads[i] as GhCommit;
      pin.commit = h.sha;
      pin.committedAt = h.commit.committer.date;
    });
    source.sdk.npm = pinnedSdk;
    await Bun.write(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  }
  return drift;
}

async function checkJupiter(lines: string[]): Promise<boolean> {
  const source = await readJupiterSource();
  const chain = await fetchJupiterIdl();
  const local = sha256(new Uint8Array(await Bun.file(join(idlDir, "jupiter.json")).arrayBuffer()));
  if (update) await writeJupiterIdl(chain);
  if (chain.sha256 !== source.sha256 || local !== source.sha256) {
    lines.push(
      `- **jupiter.json changed**: pin ${source.sha256.slice(0, 12)}, vendored ${local.slice(0, 12)}, on chain ${chain.sha256.slice(0, 12)} ` +
        `(IDL account ${chain.idlAccount}, slot ${chain.slot}). Update packages/signer/src/firewall/rules/jupiter-idl.ts (the embedded Swap enum).`,
    );
    return true;
  }
  lines.push(`- jupiter.json: unchanged (on-chain IDL at slot ${chain.slot})`);
  return false;
}

const lines: string[] = [`## pump.fun / Raydium / Jupiter interface watch (${new Date().toISOString().slice(0, 10)})`];
let drift = false;
let failed = false;
for (const [title, check] of [
  ["pump.fun / PumpSwap", checkPump],
  ["Raydium LaunchLab / CPMM", checkRaydium],
  ["Jupiter v6 (long-tail fallback)", checkJupiter],
] as const) {
  lines.push("", `### ${title}`, "");
  try {
    drift = (await check(lines)) || drift;
  } catch (e) {
    // Report it (the workflow files the report as an issue) instead of dying with an empty report.
    failed = true;
    lines.push(`- **check failed: ${e instanceof Error ? e.message : String(e)}**`);
  }
}

if (update) {
  lines.push(
    "",
    failed
      ? "Update incomplete: a section failed (see above), so its snapshots and pins may not be written."
      : "Snapshots, SOURCE.json, RAYDIUM_SOURCE.json and JUPITER_SOURCE.json updated (Raydium program-source pins moved to HEAD). " +
          "SDK pins are updated by hand after the golden tests pass.",
  );
} else if (drift) {
  lines.push(
    "",
    "### What to do",
    "1. Read the upstream diff and changelog notes (pump: docs/ in pump-public-docs; Raydium: the program-source diff and SDK release).",
    "2. Update packages/core builders, decoders and constants (pump/, pumpswap/, raydium/, events/, jupiter/) and the signer's copies; bump the SDK pins.",
    "3. `bun test` (golden tests against the official SDKs) and dry-run simulations.",
    "4. Re-arm any armed orders the change invalidates; then `--update` the snapshots.",
  );
}

console.log(lines.join("\n"));
process.exit(failed || (drift && !update) ? 1 : 0);
