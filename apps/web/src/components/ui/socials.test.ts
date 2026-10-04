import { describe, expect, test } from "bun:test";
import { safeHttpsUrl, socialLink, tokenLinks } from "./socials";

const MINT = "6FrwqBPGwwbyxwzwkWnks2qmVRXbu53LGnhnvM7apump";

describe("social links", () => {
  test("X: server URLs and simulated handles, statuses and communities", () => {
    expect(socialLink("x", "https://x.com/solana")).toEqual({ href: "https://x.com/solana", label: "@solana", icon: "x" });
    expect(socialLink("x", "solana")).toEqual({ href: "https://x.com/solana", label: "@solana", icon: "x" });
    expect(socialLink("x", "@solana")?.href).toBe("https://x.com/solana");
    expect(socialLink("x", "solana/status/123")).toEqual({ href: "https://x.com/solana/status/123", label: "Tweet", icon: "x" });
    expect(socialLink("x", "https://twitter.com/solana/status/9?s=20")?.href).toBe("https://x.com/solana/status/9");
    expect(socialLink("x", "https://x.com/i/communities/77")?.label).toBe("X community");
    expect(socialLink("x", "https://evil.example/solana")).toBeNull();
    expect(socialLink("x", "javascript:alert(1)")).toBeNull();
  });

  test("Telegram: handles, t.me URLs and invites", () => {
    expect(socialLink("telegram", "frog_portal")).toEqual({
      href: "https://t.me/frog_portal",
      label: "t.me/frog_portal",
      icon: "telegram",
    });
    expect(socialLink("telegram", "https://t.me/frog_portal")?.href).toBe("https://t.me/frog_portal");
    expect(socialLink("telegram", "https://t.me/+AbCdEfGh12")?.label).toBe("Telegram invite");
    expect(socialLink("telegram", "https://evil.example/x")).toBeNull();
  });

  test("websites: https only, icon by host (Discord, pump.fun, DexScreener get their logos)", () => {
    expect(socialLink("website", "frog.fun")).toEqual({ href: "https://frog.fun/", label: "frog.fun", icon: "globe" });
    expect(socialLink("website", "http://frog.fun/about")).toEqual({
      href: "https://frog.fun/about",
      label: "frog.fun/about",
      icon: "globe",
    });
    expect(socialLink("website", "https://discord.gg/abc")?.icon).toBe("discord");
    expect(socialLink("website", "https://pump.fun/coin/x")?.icon).toBe("pump");
    expect(socialLink("website", "https://dexscreener.com/solana/x")?.icon).toBe("dexscreener");
    expect(socialLink("website", "https://t.me/frog")?.icon).toBe("telegram");
  });

  test("refused: other schemes, credentials, ports, IP and local hosts, markup, control characters", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "https://u:p@frog.fun",
      "https://frog.fun:8443/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "https://printer.local/",
      'https://frog.fun/"onmouseover="x',
      "https://frog.fun/\nx",
      "word",
    ]) {
      expect(safeHttpsUrl(bad)).toBeNull();
      expect(socialLink("website", bad)).toBeNull();
    }
    expect(socialLink("website", null)).toBeNull();
  });

  test("token links: pump.fun page for pump coins, DexScreener for all; invalid mints get none", () => {
    expect(tokenLinks(MINT, { pump: true }).map((l) => l.href)).toEqual([
      `https://pump.fun/coin/${MINT}`,
      `https://dexscreener.com/solana/${MINT}`,
    ]);
    expect(tokenLinks(MINT, { pump: false }).map((l) => l.icon)).toEqual(["dexscreener"]);
    expect(tokenLinks("not/a/mint", { pump: true })).toEqual([]);
  });
});
