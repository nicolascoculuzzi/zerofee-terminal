/**
 * Content-Security-Policy pieces shared by the build (vite.config.ts writes the meta tag), the production-like
 * preview (scripts/preview-live.ts sends the edge header) and the CSP test (src/csp.test.ts), which keeps the
 * edge policy in deploy/docker/Caddyfile in step with them.
 *
 * style-src is 'self' plus the sha256 of every inline <style> the app knowingly ships. There is exactly one:
 * TradingView Lightweight Charts inserts a <style> element for its attribution logo (`layout.attributionLogo`,
 * which the Apache-2.0 NOTICE requires us to keep on; see src/lib/chartTheme.ts). Without its hash the browser
 * blocks the rule, logs a style-src violation on every page with a chart, and the logo falls into the
 * document flow instead of sitting in the chart's corner. The hash is computed from the installed library, so
 * an upgrade that changes the rule changes the build's policy; the CSP test then fails until the Caddyfile is
 * updated too. Never 'unsafe-inline'.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A CSP hash source for an inline <style> or <script> body: `'sha256-<base64>'`. */
export function cspHash(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** The text of the <style> element Lightweight Charts inserts for its attribution logo. */
export function chartAttributionStyle(): string {
  const file = fileURLToPath(import.meta.resolve("lightweight-charts"));
  const src = readFileSync(file, "utf8");
  // a string literal in either quote style: `a#tv-attr-logo{...}a#tv-attr-logo[data-dark]{...}`
  const m = /(["'`])(a#tv-attr-logo\{[^"'`]*)\1/.exec(src);
  if (!m?.[2]) {
    throw new Error(
      `csp.ts: the attribution <style> was not found in ${file}. Lightweight Charts changed how it styles the ` +
        "attribution logo: check what it injects now and update csp.ts (and the Caddyfile's style-src).",
    );
  }
  return m[2];
}

/** Hash sources for the inline <style> elements the app ships (see above). */
export function inlineStyleHashes(): string[] {
  return [cspHash(chartAttributionStyle())];
}

/**
 * The build's policy (the meta tag in dist/index.html). The simulation needs no network origin besides 'self'.
 * A live build also connects to the gateway (VITE_API_ORIGIN and its ws:/wss: twin; same-origin needs nothing
 * extra) and to Jupiter's Swap API, which the browser calls itself for the long-tail fallback (quotes and
 * routes). The signer worker is a same-origin module ('self'); its Argon2 WebAssembly runs inside the worker.
 * Images are same-origin only: token images through the server's image proxy (GET /api/img), platform logos
 * bundled in public/venues/; data: is for the Pulse card icon masks, blob: for chart and share-card previews.
 * The edge (deploy/docker/Caddyfile) sends the same img-src and style-src.
 */
export const JUPITER_API_ORIGIN = "https://api.jup.ag";

export function buildCsp(apiOrigin: string, live: boolean, styleHashes: readonly string[] = inlineStyleHashes()): string {
  const connect = ["'self'"];
  if (apiOrigin) connect.push(apiOrigin, apiOrigin.replace(/^http/, "ws"));
  if (live) connect.push(JUPITER_API_ORIGIN);
  return [
    "default-src 'self'",
    "script-src 'self'",
    ["style-src 'self'", ...styleHashes].join(" "),
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** The enforced Content-Security-Policy of the app origin in a Caddyfile (the `(app_headers)` snippet). */
export function caddyAppCsp(caddyfile: string): string {
  const snippet = caddyfile.slice(caddyfile.indexOf("(app_headers)"));
  const m = /\n\s*Content-Security-Policy "([^"]+)"/.exec(snippet);
  if (!m?.[1]) throw new Error("no Content-Security-Policy in the Caddyfile's (app_headers) snippet");
  return m[1];
}

/** The sources of one directive of a policy (empty when the directive is absent). */
export function directive(policy: string, name: string): string[] {
  for (const part of policy.split(";")) {
    const [n, ...sources] = part.trim().split(/\s+/);
    if (n === name) return sources;
  }
  return [];
}

/**
 * What in an HTML document the policy would block: `style="..."` attributes (a hash cannot allow those without
 * 'unsafe-hashes'), <style> elements whose sha256 is not in style-src, and inline <script> bodies. Comments are
 * ignored. The build fails on any (vite.config.ts), and the CSP test runs it on index.html.
 */
export function inlineCspProblems(html: string, policy: string): string[] {
  const doc = html.replace(/<!--[\s\S]*?-->/g, "");
  const styleSrc = new Set(directive(policy, "style-src"));
  const problems: string[] = [];
  for (const m of doc.matchAll(/<[a-zA-Z][^>]*\sstyle\s*=\s*["']?[^>]*>/g)) problems.push(`inline style attribute: ${m[0].slice(0, 120)}`);
  for (const m of doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const hash = cspHash(m[1] ?? "");
    if (!styleSrc.has(hash)) problems.push(`<style> element without its hash ${hash} in style-src`);
  }
  for (const m of doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc\s*=/.test(m[1] ?? "") && (m[2] ?? "").trim()) problems.push(`inline <script>: ${(m[2] ?? "").trim().slice(0, 80)}`);
  }
  return problems;
}
