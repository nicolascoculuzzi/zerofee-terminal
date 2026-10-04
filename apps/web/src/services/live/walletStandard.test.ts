import { describe, expect, test } from "bun:test";
import type { Wallet } from "@wallet-standard/base";
import { isKnownWallet, walletProviderName } from "../walletService";
import { detectFrom, providerOf, usable } from "./walletStandard";

const SOLANA_FEATURES = ["standard:connect", "solana:signTransaction", "solana:signMessage"];

function wallet(name: string, opts: { features?: string[]; chains?: string[] } = {}): Wallet {
  const features = Object.fromEntries((opts.features ?? SOLANA_FEATURES).map((f) => [f, {}]));
  return {
    version: "1.0.0",
    name,
    icon: `data:image/svg+xml;base64,${name}`,
    chains: (opts.chains ?? ["solana:mainnet"]) as Wallet["chains"],
    features,
    accounts: [],
  } as unknown as Wallet;
}

describe("Wallet Standard detection", () => {
  test("known wallets map to their ids by registered name", () => {
    expect(providerOf("Phantom")).toBe("phantom");
    expect(providerOf("Coinbase Wallet")).toBe("coinbase");
    expect(providerOf("OKX Wallet")).toBe("okx");
    expect(providerOf("Trust")).toBe("trust");
    expect(providerOf("Backpack")).toBe("backpack");
  });

  test("any other wallet keeps its own name", () => {
    expect(providerOf("Glow")).toBe("std:Glow");
    expect(providerOf("Trustee")).toBe("std:Trustee");
    expect(walletProviderName("std:Glow")).toBe("Glow");
    expect(walletProviderName("okx")).toBe("OKX Wallet");
    expect(isKnownWallet("std:Glow")).toBe(false);
  });

  test("usable needs a Solana chain, connect, signTransaction and a way to sign the SIWS message", () => {
    expect(usable(wallet("A"))).toBe(true);
    expect(usable(wallet("B", { features: ["standard:connect", "solana:signTransaction", "solana:signIn"] }))).toBe(true);
    expect(usable(wallet("C", { features: ["standard:connect", "solana:signMessage"] }))).toBe(false);
    expect(usable(wallet("D", { features: ["standard:connect", "solana:signTransaction"] }))).toBe(false);
    expect(usable(wallet("E", { chains: ["ethereum:1"] }))).toBe(false);
  });

  test("detectFrom lists every usable wallet once, with its own icon, in registration order", () => {
    const found = detectFrom([
      wallet("Glow"),
      wallet("Phantom"),
      wallet("Phantom"),
      wallet("MetaMask", { chains: ["ethereum:1"] }),
      wallet("OKX Wallet"),
    ]);
    expect(found.map((w) => w.provider)).toEqual(["std:Glow", "phantom", "okx"]);
    expect(found[0]?.icon).toBe("data:image/svg+xml;base64,Glow");
  });
});
