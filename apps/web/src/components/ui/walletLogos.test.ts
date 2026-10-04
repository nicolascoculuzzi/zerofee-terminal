import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { providerFromName, WALLET_BRANDS, walletLogoSrc } from "./walletLogos";

const PUBLIC = join(import.meta.dir, "..", "..", "..", "public");

describe("wallet logos", () => {
  test("every bundled logo exists and every site is https", () => {
    for (const brand of Object.values(WALLET_BRANDS)) {
      expect(existsSync(join(PUBLIC, brand.logo))).toBe(true);
      expect(brand.site.startsWith("https://")).toBe(true);
    }
  });

  test("a wallet's own data: icon wins over the bundled logo", () => {
    const own = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(walletLogoSrc(own, "Phantom")).toBe(own);
    expect(walletLogoSrc(null, "Phantom")).toBe("/wallets/phantom.svg");
    expect(walletLogoSrc(undefined, "x", "backpack")).toBe("/wallets/backpack.png");
  });

  test("remote or non-image icons are never used", () => {
    expect(walletLogoSrc("https://evil.example/x.svg", "Solflare")).toBe("/wallets/solflare.svg");
    expect(walletLogoSrc("data:text/html,<b>", "Unknown wallet")).toBeNull();
  });

  test("names map to providers", () => {
    expect(providerFromName("Backpack Wallet")).toBe("backpack");
    expect(providerFromName("SOLFLARE")).toBe("solflare");
    expect(providerFromName("Glow")).toBeNull();
  });
});
