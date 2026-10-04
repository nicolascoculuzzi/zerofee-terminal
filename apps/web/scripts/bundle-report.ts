#!/usr/bin/env bun
/**
 * First-screen bundle budget. Reads the built index.html (run `VITE_DATA_SOURCE=live bun run build` first) and
 * sums what a visit to /pulse downloads before the first rows: the entry script, every `modulepreload` (the
 * entry's static imports, the data layer and the Pulse route, see vite.config.ts) and the stylesheet. Sizes are
 * gzip -9 (what the budget is written in) and brotli (what preview:live / the edge serve).
 *
 *   bun scripts/bundle-report.ts [--dist dist] [--budget 170] [--check]
 *
 * --check exits 1 when the first-screen JS is over budget. Lazy chunks that matter (chart, settings,
 * onboarding, the trade engine, the signer worker) are listed with their sizes so regressions show.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
};
const dist = opt("--dist", join(import.meta.dir, "..", "dist"));
const budgetKb = Number(opt("--budget", "170"));
const html = readFileSync(join(dist, "index.html"), "utf8");

const sizes = (file: string) => {
  const buf = readFileSync(join(dist, file.replace(/^\//, "")));
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    br: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
};

const js = new Set<string>();
for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) js.add(m[1] as string);
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) js.add(m[1] as string);
for (const m of html.matchAll(/<link[^>]+href="([^"]+)"[^>]+rel="modulepreload"/g)) js.add(m[1] as string);
// The first screen needs the data layer and the Pulse route whether or not index.html preloads them (older
// builds loaded them one after another): add them and everything they import statically.
const assets = readdirSync(join(dist, "assets"));
for (const f of assets) if (/^(live|mock|PulsePage)-[\w-]+\.js$/.test(f)) js.add(`/assets/${f}`);
const queue = [...js];
while (queue.length) {
  const f = queue.pop() as string;
  const code = readFileSync(join(dist, f.replace(/^\//, "")), "utf8");
  for (const m of code.matchAll(/(?:from|import)\s*"\.\/([\w.-]+\.js)"/g)) {
    const dep = `/assets/${m[1]}`;
    if (!js.has(dep)) {
      js.add(dep);
      queue.push(dep);
    }
  }
}
const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1] as string);

const kb = (n: number) => (n / 1024).toFixed(1).padStart(7);
let total = { raw: 0, gzip: 0, br: 0 };
const rows: [string, ReturnType<typeof sizes>][] = [];
for (const f of js) {
  const s = sizes(f);
  rows.push([f, s]);
  total = { raw: total.raw + s.raw, gzip: total.gzip + s.gzip, br: total.br + s.br };
}
rows.sort((a, b) => b[1].gzip - a[1].gzip);
console.log(`first screen (/pulse): ${js.size} scripts, ${css.length} stylesheet(s)`);
console.log(`  ${"file".padEnd(48)} ${"raw KB".padStart(7)} ${"gzip".padStart(7)} ${"br".padStart(7)}`);
for (const [f, s] of rows.slice(0, 12)) console.log(`  ${f.replace("/assets/", "").padEnd(48)} ${kb(s.raw)} ${kb(s.gzip)} ${kb(s.br)}`);
if (rows.length > 12) console.log(`  … ${rows.length - 12} more`);
console.log(`  ${"JS total".padEnd(48)} ${kb(total.raw)} ${kb(total.gzip)} ${kb(total.br)}`);
for (const f of css) {
  const s = sizes(f);
  console.log(`  ${`CSS ${f.replace("/assets/", "")}`.padEnd(48)} ${kb(s.raw)} ${kb(s.gzip)} ${kb(s.br)}`);
}

const lazy = [
  /^TokenPage-/,
  /^TokenChart-/,
  /^chartTheme-/,
  /^SettingsDrawer-/,
  /^OnboardingPage-/,
  /^LiveTradeService-/,
  /^signer\.worker-/,
];
console.log("\nlazy (not on the first screen):");
for (const f of assets) {
  if (!f.endsWith(".js") || !lazy.some((re) => re.test(f))) continue;
  const s = sizes(`assets/${f}`);
  console.log(`  ${f.padEnd(48)} ${kb(s.raw)} ${kb(s.gzip)} ${kb(s.br)}`);
}

const over = total.gzip / 1024 > budgetKb;
console.log(`\nbudget: first-screen JS ${(total.gzip / 1024).toFixed(1)} KB gzip of ${budgetKb} KB ${over ? "OVER" : "ok"}`);
if (over && argv.includes("--check")) process.exit(1);
