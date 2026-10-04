/**
 * The Content-Security-Policy stays strict and consistent: index.html needs no 'unsafe-inline', the build's
 * meta policy and the edge's header (deploy/docker/Caddyfile) both allow exactly the inline <style> the app
 * ships (Lightweight Charts' attribution logo rule, hashed from the installed library), and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildCsp, caddyAppCsp, chartAttributionStyle, cspHash, directive, inlineCspProblems, inlineStyleHashes } from "../csp";
import { edgeCsp } from "../scripts/preview-live";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const indexHtml = read("../index.html");
const caddyCsp = caddyAppCsp(read("../../../deploy/docker/Caddyfile"));

describe("CSP", () => {
  test("index.html has no inline style attribute, <style> or <script> the policy would block", () => {
    expect(inlineCspProblems(indexHtml, buildCsp("", true))).toEqual([]);
    expect(inlineCspProblems(indexHtml, caddyCsp)).toEqual([]);
  });

  test("the checker catches style attributes, unhashed <style> and inline scripts (and ignores comments)", () => {
    const policy = buildCsp("", false, [cspHash(".a{color:red}")]);
    expect(inlineCspProblems('<div style="color:red"></div>', policy)).toHaveLength(1);
    expect(inlineCspProblems("<style>.b{}</style>", policy)).toHaveLength(1);
    expect(inlineCspProblems("<style>.a{color:red}</style>", policy)).toEqual([]);
    expect(inlineCspProblems("<script>alert(1)</script>", policy)).toHaveLength(1);
    expect(inlineCspProblems('<script type="module" src="/x.js"></script><!-- <p style="x"> -->', policy)).toEqual([]);
  });

  test("the chart attribution <style> is the one hashed inline style", () => {
    expect(chartAttributionStyle()).toStartWith("a#tv-attr-logo{");
    expect(inlineStyleHashes()).toEqual([cspHash(chartAttributionStyle())]);
  });

  test("the build's meta policy and the edge's header allow exactly 'self' and that hash for styles", () => {
    const expected = ["'self'", ...inlineStyleHashes()];
    expect(directive(buildCsp("", true), "style-src")).toEqual(expected);
    // Fails after a Lightweight Charts upgrade that changes the rule: put the new hash in the Caddyfile.
    expect(directive(caddyCsp, "style-src")).toEqual(expected);
  });

  test("no 'unsafe-inline' or 'unsafe-eval' anywhere", () => {
    for (const policy of [buildCsp("https://gw.example", true), caddyCsp]) {
      expect(policy).not.toContain("'unsafe-inline'");
      expect(policy).not.toContain("'unsafe-eval'");
      expect(policy).not.toContain("'unsafe-hashes'");
    }
  });

  test("preview:live sends the edge's policy for its own origin", () => {
    const p = edgeCsp("http://127.0.0.1:4173", "https://api.jup.ag");
    expect(directive(p, "style-src")).toEqual(directive(caddyCsp, "style-src"));
    expect(directive(p, "connect-src")).toEqual(["'self'", "ws://127.0.0.1:4173", "https://api.jup.ag"]);
    expect(p).not.toContain("upgrade-insecure-requests");
    expect(p).not.toContain("{$");
  });
});
