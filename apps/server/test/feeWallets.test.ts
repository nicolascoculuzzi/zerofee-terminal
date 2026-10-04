/** The pro-trader fee-wallet registry: well-formed, cited, and the derived token account checks out. */
import { describe, expect, test } from "bun:test";
import { type Address, getAddressEncoder } from "@solana/kit";
import { findAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@zerofee/core";
import { loadConfig } from "../src/config";
import { FEE_WALLETS, proTraderSet } from "../src/market/feeWallets";

const enc = getAddressEncoder();

describe("fee-wallet registry", () => {
  test("every entry is a valid, unique address with a terminal name and an https source", () => {
    const seen = new Set<string>();
    for (const e of FEE_WALLETS) {
      expect(enc.encode(e.address as Address)).toHaveLength(32);
      expect(seen.has(e.address)).toBe(false);
      seen.add(e.address);
      expect(e.terminal.length).toBeGreaterThan(0);
      expect(e.source).toMatch(/^https:\/\//);
      if (e.provenance === "defillama") expect(e.source).toContain("/DefiLlama/dimension-adapters/blob/0937579a");
    }
    // the vendor-documented entry from the research notes (Maestro docs, monetization page)
    expect(FEE_WALLETS.find((e) => e.provenance === "vendor-docs")).toMatchObject({
      address: "MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36",
      source: "https://docs.maestrobots.com/sniper/monetization",
    });
  });

  test("token-fee entries carry the fee wallet's associated token account (derived, not guessed)", async () => {
    for (const e of FEE_WALLETS.filter((x) => x.feeTokenAccount)) {
      const ata = await findAssociatedTokenAddress(e.address as Address, e.feeTokenAccount?.mint as Address, TOKEN_PROGRAM_ID);
      expect(ata).toBe(e.feeTokenAccount?.address as Address);
    }
  });

  test("provenance filter and operator additions", () => {
    const all = proTraderSet("all");
    const vendor = proTraderSet("vendor-docs", ["Extra1111111111111111111111111111111111111"]);
    expect(all.wallets.length + all.tokenAccounts.length).toBe(FEE_WALLETS.length);
    expect(all.tokenAccounts).toEqual(["HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq"]);
    expect(vendor.wallets).toEqual(["MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36", "Extra1111111111111111111111111111111111111"]);
    expect(vendor.entries.at(-1)).toMatchObject({ provenance: "env", source: "env:PRO_TRADER_WALLETS" });
  });

  test("config: the registry by default, PRO_TRADER_PROVENANCE and PRO_TRADER_WALLETS", () => {
    expect(loadConfig({}).metrics.proTraderWallets.length).toBeGreaterThan(50);
    const c = loadConfig({ PRO_TRADER_PROVENANCE: "vendor-docs", PRO_TRADER_WALLETS: "Extra1111111111111111111111111111111111111" });
    expect(c.metrics.proTraderWallets).toEqual([
      "MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36",
      "Extra1111111111111111111111111111111111111",
    ]);
    expect(c.metrics.proTraderTokenAccounts).toEqual([]);
    expect(() => loadConfig({ PRO_TRADER_PROVENANCE: "rumors" })).toThrow();
  });
});
