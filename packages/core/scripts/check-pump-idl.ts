/**
 * Daily pump.fun interface watch (SPEC.md "Verify before you code").
 *
 * Compares the committed IDL snapshots in packages/core/idl/ with the official repo
 * (github.com/pump-fun/pump-public-docs) and the pinned official SDK versions in
 * packages/core/package.json with npm. Prints a Markdown report; exits 1 on any drift.
 *
 *   bun run packages/core/scripts/check-pump-idl.ts            # check
 *   bun run packages/core/scripts/check-pump-idl.ts --update   # refresh snapshots + SOURCE.json
 *
 * A drift means: read the upstream changelog, update builders/decoders/constants, re-run the
 * golden tests, and re-arm any armed orders the change invalidates.
 */
import { join } from "node:path";

const UPSTREAM_REPO = "pump-fun/pump-public-docs";
const IDL_FILES = ["pump.json", "pump_amm.json", "pump_fees.json"] as const;
const SDKS = ["@pump-fun/pump-sdk", "@pump-fun/pump-swap-sdk"] as const;

const coreDir = join(import.meta.dir, "..");
const idlDir = join(coreDir, "idl");
const update = process.argv.includes("--update");

interface Source {
  repo: string;
  commit: string;
  committedAt: string;
  files: Record<string, string>;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const ghHeaders: Record<string, string> = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) ghHeaders.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const head = (await (await fetchOk(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/main`, { headers: ghHeaders })).json()) as {
  sha: string;
  commit: { committer: { date: string } };
};

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

const lines: string[] = [`## pump.fun interface watch (${new Date().toISOString().slice(0, 10)})`, ""];
let drift = false;

// 1) IDL snapshots
const upstreamHashes: Record<string, string> = {};
for (const file of IDL_FILES) {
  const bytes = new Uint8Array(
    await (await fetchOk(`https://raw.githubusercontent.com/${UPSTREAM_REPO}/${head.sha}/idl/${file}`)).arrayBuffer(),
  );
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
const pkg = JSON.parse(await Bun.file(join(coreDir, "package.json")).text()) as { devDependencies?: Record<string, string> };
for (const name of SDKS) {
  const pinned = pkg.devDependencies?.[name] ?? "not pinned";
  const latest = ((await (await fetchOk(`https://registry.npmjs.org/${name}/latest`)).json()) as { version: string }).version;
  if (pinned.replace(/^[\^~]/, "") !== latest) {
    drift = true;
    lines.push(`- **${name}: pinned ${pinned}, npm latest ${latest}**`);
  } else {
    lines.push(`- ${name}: ${latest} (pinned)`);
  }
}

if (update) {
  const next: Source = { repo: UPSTREAM_REPO, commit: head.sha, committedAt: head.commit.committer.date, files: upstreamHashes };
  await Bun.write(join(idlDir, "SOURCE.json"), `${JSON.stringify(next, null, 2)}\n`);
  lines.push("", "Snapshots and SOURCE.json updated. SDK pins are updated by hand after the golden tests pass.");
} else if (drift) {
  lines.push(
    "",
    "### What to do",
    "1. Read the upstream diff and docs/ changelog notes.",
    "2. Update packages/core builders, decoders and constants; bump the SDK pins.",
    "3. `bun test` (golden tests against the official SDKs) and dry-run simulations.",
    "4. Re-arm any armed orders the change invalidates; then `--update` the snapshots.",
  );
}

console.log(lines.join("\n"));
process.exit(drift && !update ? 1 : 0);
