/**
 * Known terminal / trading-bot fee wallets for the "Pro Traders" metric: a trader counts as pro when one
 * of their swap transactions pays one of these (SPEC.md metric table; research notes §1 "Pro traders").
 *
 * Every entry cites where the address is documented. Nothing here is guessed:
 *  - "vendor-docs": the terminal's own documentation names the wallet.
 *  - "defillama": DefiLlama's open-source fee adapters (third-party attribution: their analysts traced the
 *    wallets on-chain and use them for the public fee/revenue dashboards). Pinned to one commit; each
 *    address is copied verbatim from the cited file. Only wallets that receive the fee inside the swap
 *    transaction are listed (not cashback / referral payout or treasury wallets, which are paid later).
 *
 * PRO_TRADER_PROVENANCE=vendor-docs restricts the list to vendor-documented entries; PRO_TRADER_WALLETS
 * adds operator-supplied addresses (cited as "env"). Retrieved 2026-10-03.
 */

export type FeeWalletProvenance = "vendor-docs" | "defillama" | "env";

export interface FeeWallet {
  address: string;
  terminal: string;
  provenance: FeeWalletProvenance;
  /** URL of the document that names this wallet. */
  source: string;
  /**
   * Set when the terminal takes its fee in an SPL token: the wallet's associated token account for that
   * mint (what appears in the swap's account keys), derived with the SPL Token program. Verified in tests.
   */
  feeTokenAccount?: { mint: string; address: string };
}

const DEFILLAMA_COMMIT = "0937579a7ee1d8166e16393c7fe458a00ffd1487";
const defillama = (path: string) => `https://github.com/DefiLlama/dimension-adapters/blob/${DEFILLAMA_COMMIT}/${path}`;

function group(terminal: string, provenance: FeeWalletProvenance, source: string, addresses: string[]): FeeWallet[] {
  return addresses.map((address) => ({ address, terminal, provenance, source }));
}

const AXIOM = defillama("fees/axiom.ts");
const GMGN = defillama("fees/gmgnai.ts");
const TROJAN = defillama("dexs/trojan/index.ts");
const SOLTRADINGBOT = defillama("fees/sol-trading-bot/index.ts");

export const FEE_WALLETS: readonly FeeWallet[] = [
  ...group("Maestro", "vendor-docs", "https://docs.maestrobots.com/sniper/monetization", ["MaestroUL88UBnZr3wfoN7hqmNWFi3ZYCGqZoJJHE36"]),
  ...group("Maestro", "defillama", defillama("fees/maestro.ts"), ["FRMxAnZgkW58zbYcE7Bxqsg99VWpJh6sMP5xLzAWNabN"]),
  ...group("Axiom", "defillama", AXIOM, [
    "7LCZckF6XXGQ1hDY6HFXBKWAtiUgL9QY5vj1C4Bn1Qjj",
    "4V65jvcDG9DSQioUVqVPiUcUY9v6sb6HKtMnsxSKEz5S",
    "CeA3sPZfWWToFEBmw5n1Y93tnV66Vmp8LacLzsVprgxZ",
    "AaG6of1gbj1pbDumvbSiTuJhRCRkkUNaWVxijSbWvTJW",
    "7oi1L8U9MRu5zDz5syFahsiLUric47LzvJBQX6r827ws",
    "9kPrgLggBJ69tx1czYAbp7fezuUmL337BsqQTKETUEhP",
    "DKyUs1xXMDy8Z11zNsLnUg3dy9HZf6hYZidB6WodcaGy",
    "4FobGn5ZWYquoJkxMzh2VUAWvV36xMgxQ3M7uG1pGGhd",
    "76sxKrPtgoJHDJvxwFHqb3cAXWfRHFLe3VpKcLCAHSEf",
    "H2cDR3EkJjtTKDQKk8SJS48du9mhsdzQhy8xJx5UMqQK",
    "8m5GkL7nVy95G4YVUbs79z873oVKqg2afgKRmqxsiiRm",
    "4kuG6NsAFJNwqEkac8GFDMMheCGKUPEbaRVHHyFHSwWz",
    "8vFGAKdwpn4hk7kc1cBgfWZzpyW3MEMDATDzVZhddeQb",
    "86Vh4XGLW2b6nvWbRyDs4ScgMXbuvRCHT7WbUT3RFxKG",
    "DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM",
    "5L2QKqDn5ukJSWGyqR4RPvFvwnBabKWqAqMzH4heaQNB",
    "DYVeNgXGLAhZdeLMMYnCw1nPnMxkBN7fJnNpHmizTrrF",
    "Hbj6XdxX6eV4nfbYTseysibp4zZJtVRRPn2J3BhGRuK9",
    "846ah7iBSu9ApuCyEhA5xpnjHHX7d4QJKetWLbwzmJZ8",
    "5BqYhuD4q1YD3DMAYkc1FeTu9vqQVYYdfBAmkZjamyZg",
  ]),
  ...group("GMGN", "defillama", GMGN, [
    "BB5dnY55FXS1e1NXqZDwCzgdYJdMCj3B92PU6Q5Fb6DT",
    "7sHXjs1j7sDJGVSMSPjD1b4v3FD6uRSvRWfhRdfv5BiA",
    "HeZVpHj9jLwTVtMMbzQRf6mLtFPkWNSg11o68qrbUBa3",
    "ByRRgnZenY6W2sddo1VJzX9o4sMU4gPDUkcmgrpGBxRy",
    "DXfkEGoo6WFsdL7x6gLZ7r6Hw2S6HrtrAQVPWYx2A1s9",
    "3t9EKmRiAUcQUYzTZpNojzeGP1KBAVEEbDNmy6wECQpK",
    "DymeoWc5WLNiQBaoLuxrxDnDRvLgGZ1QGsEoCAM7Jsrx",
    "dBhdrmwBkRa66XxBuAK4WZeZnsZ6bHeHCCLXa3a8bTJ",
    "6TxjC5wJzuuZgTtnTMipwwULEbMPx5JPW3QwWkdTGnrn",
  ]),
  ...group("Terminal (pump.fun, ex-Padre)", "defillama", defillama("fees/trading-terminal/index.ts"), [
    "J5XGHmzrRmnYWbmw45DbYkdZAU2bwERFZ11qCDXPvFB5",
    "DoAsxPQgiyAxyaJNvpAAUb2ups6rbJRdYrCPyWxwRxBb",
  ]),
  ...group("Photon", "defillama", defillama("fees/photon.ts"), ["AVUCZyuT35YSuj4RH7fwiyPu82Djn2Hfg7y2ND2XcnZH"]),
  ...group("Trojan", "defillama", TROJAN, [
    "9yMwSPk9mrXSN7yDHUuZurAh1sjbJsfpUqjZ7SvVtdco",
    "92Med3qeK7duC5iiYsHX38H2f2twJfRsSx93oNrza2VH",
    "2jwHNxavSoMZMEDbT1eV9PcPt5dDcayCqM6MkgaPpmWQ",
    "65gDv7pZQCZELsNpNYSFEBtNFpWZAbxmRFB6BGMqFkHH",
    "BWgb8wR1FEGiu1jCDSKuHKf752W27b4iN6SvoNCiK4qp",
    "8jgg7moFJkHyTtAv9M6RBSPMp2oXeXhuiUMKW8YbYCWn",
  ]),
  ...group("BullX", "defillama", defillama("fees/bullx.ts"), [
    "9RYJ3qr5eU5xAooqVcbmdeusjcViL5Nkiq7Gske3tiKq",
    "F4hJ3Ee3c5UuaorKAMfELBjYCjiiLH75haZTKqTywRP3",
  ]),
  ...group("Bloom", "defillama", defillama("fees/bloom.ts"), ["7HeD6sLLqAnKVRuSfc1Ko3BSPMNKWgGTiWLKXJF31vKM"]),
  ...group("BONKbot", "defillama", defillama("fees/bonk-bot/index.ts"), ["ZG98FUCjb8mJ824Gbs6RsgVmr1FhXb2oNiJHa2dwmPd"]),
  ...group("Telemetry (BONKbot)", "defillama", defillama("fees/telemetry.ts"), ["FBYmU5XbRgX2DV2i2SpPPpHpXmf6mdZS98wQChmUyMba"]),
  ...group("Banana Gun", "defillama", defillama("fees/banana-gun-trading.ts"), [
    "47hEzz83VFR23rLTEeVm9A7eFzjJwjvdupPPmX3cePqF",
    "4BBNEVRgrxVKv9f7pMNE788XM1tt379X9vNjpDH2KCL7",
    "8r2hZoDfk5hDWJ1sDujAi2Qr45ZyZw5EQxAXiMZWLKh2",
  ]),
  ...group("Nova", "defillama", defillama("fees/nova/index.ts"), ["noVakKQGTTjpHARvecAUbVnc85AatCLm3ijDFk8JXZB"]),
  ...group("MevX", "defillama", defillama("fees/mevx.ts"), [
    "3kxSQybWEeQZsMuNWMRJH4TxrhwoDwfv41TNMLRzFP5A",
    "BS3CyJ9rRC4Tp8G7f86r6hGvuu3XdrVGNVpbNM9U5WRZ",
    "4Lpvp1q69SHentfYcMBUrkgvppeEx6ovHCSYjg4UYXiq",
  ]),
  ...group("Looter", "defillama", defillama("fees/looter.ts"), ["3Pu1V4duyLyVpAJue1kLAfr74nGjQ3JDzj3aJjnoEXuL"]),
  ...group("SolTradingBot", "defillama", SOLTRADINGBOT, [
    "F34kcgMgCF7mYWkwLN3WN7KrFprr2NbwxuLvXx4fbztj",
    "K1LRSA1DSoKBtC5DkcvnermRQ62YxogWSCZZPWQrdG5",
    "HEPL5rTb6n1Ax6jt9z2XMPFJcDe9bSWvWQpsK7AMcbZg",
    "96aFQc9qyqpjMfqdUeurZVYRrrwPJG2uPV6pceu4B1yb",
    "BTQyUXhxiLrFPD5JUANCwg4ViibmNY39McmWk4bVNxLA",
    "4vfFG2xGZsjXQgA6ZCTzA1PgUGLppFHY9eGnh3ZVGUuz",
    "A7XTexV13EPnhtH55qhT7qmFkgYCMAMnfXk89VWu9PCJ",
    "GreGavLfh5sK1BeQ2WYvmk352wbyNNzQdCmqWCV8QSib",
  ]),
  {
    // fomo takes its Solana fee in USDC: the swap transfers into this wallet's USDC account.
    address: "R4rNJHaffSUotNmqSKNEfDcJE8A7zJUkaoM5Jkd7cYX",
    terminal: "fomo",
    provenance: "defillama",
    source: defillama("fees/fomo/index.ts"),
    feeTokenAccount: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", address: "HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq" },
  },
];

export interface ProTraderSet {
  /** SOL fee wallets: a swap pays one when the wallet's lamports go up in that transaction. */
  wallets: string[];
  /** SPL fee accounts: a swap pays one when the account is in its account keys. */
  tokenAccounts: string[];
  entries: FeeWallet[];
}

/**
 * The registry filtered by provenance ("all" | "vendor-docs") plus operator-supplied addresses.
 * Operator addresses are treated as SOL fee wallets.
 */
export function proTraderSet(provenance: "all" | "vendor-docs", extra: readonly string[] = []): ProTraderSet {
  const entries: FeeWallet[] = FEE_WALLETS.filter((e) => provenance === "all" || e.provenance === "vendor-docs");
  const known = new Set(entries.map((e) => e.address));
  for (const address of extra) {
    if (!known.has(address)) entries.push({ address, terminal: "operator list", provenance: "env", source: "env:PRO_TRADER_WALLETS" });
    known.add(address);
  }
  const wallets: string[] = [];
  const tokenAccounts: string[] = [];
  for (const e of entries) {
    if (e.feeTokenAccount) tokenAccounts.push(e.feeTokenAccount.address);
    else wallets.push(e.address);
  }
  return { wallets, tokenAccounts, entries };
}
