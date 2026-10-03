import type { Launchpad, QuoteToken, Token2022Flags, Venue, WalletTag } from "../protocol";

/**
 * Published metric definitions (SPEC.md "Token metric definitions"). Every metric shown in the
 * app carries its definition on hover; that transparency is a deliberate difference from Axiom.
 */
export type MetricKey =
  | "top10"
  | "dev"
  | "snipers"
  | "insiders"
  | "bundlers"
  | "lpBurned"
  | "holders"
  | "proTraders"
  | "dexPaid"
  | "token2022"
  | "marketCap"
  | "price"
  | "liquidity"
  | "volume"
  | "txns"
  | "fees"
  | "progress"
  | "supply"
  | "age"
  | "change5m"
  | "devLaunches";

export interface MetricDef {
  label: string;
  short: string;
  definition: string;
}

export const METRICS: Record<MetricKey, MetricDef> = {
  top10: {
    label: "Top 10 H.",
    short: "T10",
    definition: "Share of supply held by the 10 largest holders. Excludes the bonding-curve PDA, AMM vaults, burn addresses and lockers.",
  },
  dev: {
    label: "Dev H.",
    short: "DEV",
    definition:
      'Creator wallet balance (read from the live bonding_curve.creator) as % of supply. "DS" means the dev sold their whole position.',
  },
  snipers: {
    label: "Snipers H.",
    short: "SNP",
    definition: "Supply held by non-dev buyers whose first buy landed within 3 slots of creation.",
  },
  insiders: {
    label: "Insiders",
    short: "INS",
    definition:
      "Supply held by wallets that received tokens by transfer and never bought, plus wallets the creator funded within two hops.",
  },
  bundlers: {
    label: "Bundlers",
    short: "BND",
    definition:
      "Supply held by creation-slot co-buyers; or 4+ distinct buyers in one slot who also share a funder or a tight size band; or several wallets in one transaction.",
  },
  lpBurned: {
    label: "LP Burned",
    short: "LP",
    definition:
      "Share of the pool's LP tokens sent to a burn address. pump.fun migrations burn 100%. Not applicable while on the bonding curve.",
  },
  holders: {
    label: "Holders",
    short: "HLD",
    definition: "Wallets with a non-zero balance, excluding curve and pool accounts. Tracked incrementally and reconciled periodically.",
  },
  proTraders: {
    label: "Pro Traders",
    short: "PRO",
    definition:
      "Holders whose wallets show sustained trading history across many tokens (provisional definition: 50+ trades over 10+ tokens in 30 days).",
  },
  dexPaid: {
    label: "Dex Paid",
    short: "DEX",
    definition:
      "DexScreener /orders/v1/solana/{mint} has an approved tokenProfile (a paid Enhanced Token Info listing). It says nothing about safety.",
  },
  token2022: {
    label: "Token-2022",
    short: "T22",
    definition:
      "Danger flags on Token-2022 mints: permanentDelegate, transferHook, pausable, nonTransferable, or frozen-by-default. Any of these lets someone else move, freeze or block your tokens.",
  },
  marketCap: {
    label: "Market cap",
    short: "MC",
    definition: "Price × total supply (1B for standard pump.fun coins, 2B for mayhem coins).",
  },
  price: {
    label: "Price",
    short: "P",
    definition: "Spot price from the live curve or pool reserves (effective reserves for PumpSwap).",
  },
  liquidity: {
    label: "Liquidity",
    short: "L",
    definition: "Quote reserves in the bonding curve or pool, counted on both sides (2 × quote reserve), in USD.",
  },
  volume: {
    label: "Volume",
    short: "V",
    definition: "Sum of trade sizes in USD since creation (rolling 24 h for tokens older than a day).",
  },
  txns: {
    label: "Txns",
    short: "TX",
    definition: "Number of decoded buy and sell fills since creation. The bar shows buys (green) vs sells (red).",
  },
  fees: {
    label: "Fees paid",
    short: "F",
    definition: "Total fees traders paid on this token: venue fees, priority fees and tips, in SOL.",
  },
  progress: {
    label: "Bonding",
    short: "BC",
    definition:
      "Bonding-curve progress = 1 − real_token_reserves_now / real_token_reserves_initial. Works for mayhem coins (2B supply) and non-SOL quotes. Migrates at 100%.",
  },
  supply: {
    label: "Supply",
    short: "SUP",
    definition: "Total token supply (decimals applied).",
  },
  age: {
    label: "Age",
    short: "AGE",
    definition: "Time since the create transaction landed.",
  },
  change5m: {
    label: "5m",
    short: "5m",
    definition: "Price change over the last 5 minutes (since launch for younger tokens).",
  },
  devLaunches: {
    label: "Dev launches",
    short: "DL",
    definition: "Earlier tokens launched by the same creator wallet, and how many of them migrated.",
  },
};

export type Tone = "good" | "warn" | "bad" | "neutral";

const RISK_THRESHOLDS: Record<"top10" | "dev" | "snipers" | "insiders" | "bundlers", [number, number]> = {
  top10: [20, 35],
  dev: [3, 8],
  snipers: [5, 15],
  insiders: [5, 15],
  bundlers: [5, 20],
};

/** Lower is better for every holder-concentration metric. */
export function riskTone(key: keyof typeof RISK_THRESHOLDS, pct: number): Tone {
  const [good, warn] = RISK_THRESHOLDS[key];
  if (pct <= good) return "good";
  if (pct <= warn) return "warn";
  return "bad";
}

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-buy",
  warn: "text-warn",
  bad: "text-sell",
  neutral: "text-muted",
};

export const TONE_CHIP: Record<Tone, string> = {
  good: "bg-buy/10 text-buy border-buy/20",
  warn: "bg-warn/10 text-warn border-warn/20",
  bad: "bg-sell/10 text-sell border-sell/20",
  neutral: "bg-elev text-muted border-line",
};

export function token2022Danger(flags: Token2022Flags | null): string[] {
  if (!flags) return [];
  const out: string[] = [];
  if (flags.permanentDelegate) out.push("permanentDelegate");
  if (flags.transferHook) out.push("transferHook");
  if (flags.pausable) out.push("pausable");
  if (flags.nonTransferable) out.push("nonTransferable");
  if (flags.defaultFrozen) out.push("frozen-by-default");
  return out;
}

export const LAUNCHPADS: { id: Launchpad; label: string; short: string; color: string }[] = [
  { id: "pump", label: "Pump", short: "P", color: "#3ddc97" },
  { id: "mayhem", label: "Mayhem", short: "M", color: "#ff5d8f" },
  { id: "bonk", label: "Bonk", short: "B", color: "#f7a531" },
  { id: "bags", label: "Bags", short: "Bg", color: "#2bb3ff" },
  { id: "stonkfun", label: "StonkFun", short: "S", color: "#b388ff" },
  { id: "launchlab", label: "Raydium LaunchLab", short: "R", color: "#7c8cff" },
  { id: "meteora_dbc", label: "Meteora DBC", short: "Mt", color: "#ff7a45" },
  { id: "moonit", label: "Moonit", short: "Mo", color: "#ffd84d" },
  { id: "boop", label: "Boop", short: "Bp", color: "#4dd2ff" },
  { id: "heaven", label: "Heaven", short: "H", color: "#e6e6e6" },
  { id: "other", label: "Other", short: "?", color: "#8a93a3" },
];

export const LAUNCHPAD_BY_ID = Object.fromEntries(LAUNCHPADS.map((l) => [l.id, l])) as Record<Launchpad, (typeof LAUNCHPADS)[number]>;

export const QUOTES: QuoteToken[] = ["SOL", "USDC", "USD1", "OTHER"];

export const VENUE_LABEL: Record<Venue, string> = {
  pump_curve: "pump.fun curve",
  pumpswap: "PumpSwap",
  launchlab: "Raydium LaunchLab",
  raydium_cpmm: "Raydium CPMM",
  meteora_dbc: "Meteora DBC",
  meteora_damm_v2: "Meteora DAMM v2",
  other: "Other",
};

export const TAG_LABEL: Record<WalletTag, string> = {
  you: "YOU",
  dev: "DEV",
  sniper: "SNIPER",
  insider: "INSIDER",
  bundler: "BUNDLER",
  pro: "PRO",
  whale: "WHALE",
  tracked: "TRACKED",
  kol: "KOL",
  curve: "CURVE",
  pool: "POOL",
};

export const TAG_STYLE: Record<WalletTag, string> = {
  you: "bg-accent/15 text-accent border-accent/30",
  dev: "bg-warn/15 text-warn border-warn/30",
  sniper: "bg-sell/10 text-sell border-sell/25",
  insider: "bg-sell/10 text-sell border-sell/25",
  bundler: "bg-sell/10 text-sell border-sell/25",
  pro: "bg-info/10 text-info border-info/25",
  whale: "bg-info/10 text-info border-info/25",
  tracked: "bg-violet/15 text-violet border-violet/30",
  kol: "bg-violet/15 text-violet border-violet/30",
  curve: "bg-elev text-muted border-line",
  pool: "bg-elev text-muted border-line",
};
