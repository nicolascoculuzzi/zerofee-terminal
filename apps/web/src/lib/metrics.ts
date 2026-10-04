import type { Launchpad, QuoteToken, Token2022Flags, TokenRisk, Venue, WalletTag } from "../protocol";
import { fmtRiskPct } from "./format";

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
    definition: "Number of decoded buy and sell fills since creation. The bar splits buys (left) from sells (right).",
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

export type Tone = "good" | "warn" | "bad" | "neutral" | "unknown";

export type RiskKey = "top10" | "dev" | "snipers" | "insiders" | "bundlers";

/** [mid, high] band edges in percent (DESIGN.md 3.11). Users can override them in Settings > Display. */
export type RiskThresholds = Record<RiskKey, [number, number]>;

export const RISK_DEFAULTS: RiskThresholds = {
  top10: [20, 35],
  dev: [5, 10],
  snipers: [5, 15],
  insiders: [3, 10],
  bundlers: [5, 15],
};

export const RISK_LETTER: Record<RiskKey, string> = { top10: "T", dev: "D", snipers: "S", insiders: "I", bundlers: "B" };

/** The value as the chip displays it (integer from 10, one decimal below), so bands match the text. */
function displayed(pct: number): number {
  return pct >= 9.95 ? Math.round(pct) : Math.round(pct * 10) / 10;
}

/**
 * Band for a holder-concentration metric, evaluated on the rounded displayed value (a chip that
 * reads "20%" is always amber). Lower is better for every metric.
 */
export function riskTone(key: RiskKey, pct: number | null | undefined, thresholds: RiskThresholds = RISK_DEFAULTS): Tone {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "unknown";
  const [mid, high] = thresholds[key];
  const v = displayed(pct);
  if (v < mid) return "good";
  if (v < high) return "warn";
  return "bad";
}

/** Bands written out for tooltips, with no comparison glyph: "Green under 20% · Amber 20–35% · Red 35% or more". */
export function bandsText(key: RiskKey, thresholds: RiskThresholds = RISK_DEFAULTS): string {
  const [mid, high] = thresholds[key];
  return `Green under ${mid}% · Amber ${mid}–${high}% · Red ${high}% or more`;
}

/** Text colour for a band (risk numbers in grids and tooltips). */
export const TONE_TEXT: Record<Tone, string> = {
  good: "text-risk-low",
  warn: "text-risk-mid",
  bad: "text-risk-high",
  neutral: "text-fg-2",
  unknown: "text-fg-4",
};

/** Chip styles (DESIGN.md 4.5): low unfilled, mid warn-tint, high sell-tint plus a sell-edge border. */
export const TONE_CHIP: Record<Tone, string> = {
  good: "border-transparent text-risk-low",
  warn: "border-transparent bg-warn-tint text-risk-mid",
  bad: "border-sell-edge bg-sell-tint text-risk-high",
  neutral: "border-transparent text-fg-2",
  unknown: "border-transparent text-fg-4",
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

/**
 * Why a buy needs the 3 s countdown confirm (DESIGN.md 1.7): any Token-2022 danger flag, or
 * three or more holder metrics in the high band. Empty when the buy can go straight through.
 */
export function buyRiskReasons(
  token: { risk: TokenRisk; token2022: Token2022Flags | null },
  thresholds: RiskThresholds = RISK_DEFAULTS,
): string[] {
  const reasons: string[] = [];
  const danger = token2022Danger(token.token2022);
  if (danger.length > 0) reasons.push(`Token-2022 extensions: ${danger.join(", ")}`);
  const r = token.risk;
  const metrics: [RiskKey, number | null, string][] = [
    ["top10", r.top10Pct, "Top 10"],
    ["dev", r.devSold ? null : r.devPct, "Dev"],
    ["snipers", r.snipersPct, "Snipers"],
    ["insiders", r.insidersPct, "Insiders"],
    ["bundlers", r.bundlersPct, "Bundlers"],
  ];
  const high = metrics.filter(([key, v]) => v !== null && riskTone(key, v, thresholds) === "bad");
  if (high.length >= 3) {
    reasons.push(`High risk on ${high.length} holder metrics: ${high.map(([, v, label]) => `${label} ${fmtRiskPct(v ?? 0)}`).join(", ")}`);
  }
  return reasons;
}

/**
 * Launchpads in the Pulse "Protocols" filter. Badges are monochrome, one letter (DESIGN.md 4.4):
 * colour is reserved for meaning.
 */
export const LAUNCHPADS: { id: Launchpad; label: string; short: string }[] = [
  { id: "pump", label: "Pump", short: "P" },
  { id: "mayhem", label: "Mayhem", short: "M" },
  { id: "bonk", label: "Bonk", short: "B" },
  { id: "bags", label: "Bags", short: "G" },
  { id: "stonkfun", label: "StonkFun", short: "S" },
  { id: "launchlab", label: "Raydium LaunchLab", short: "R" },
  { id: "meteora_dbc", label: "Meteora DBC", short: "D" },
  { id: "moonit", label: "Moonit", short: "O" },
  { id: "boop", label: "Boop", short: "X" },
  { id: "heaven", label: "Heaven", short: "X" },
  { id: "other", label: "Other", short: "X" },
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
  sniper: "SNP",
  insider: "INS",
  bundler: "BND",
  pro: "PRO",
  whale: "WHALE",
  tracked: "TRK",
  kol: "KOL",
  curve: "CURVE",
  pool: "POOL",
};

/** Tag styles (DESIGN.md 4.5). YOU stands out by contrast, not hue. */
export const TAG_STYLE: Record<WalletTag, string> = {
  you: "border-fg-1 text-fg-1",
  dev: "border-transparent bg-warn-tint text-warn",
  sniper: "border-transparent bg-sell-tint text-sell",
  insider: "border-transparent bg-sell-tint text-sell",
  bundler: "border-transparent bg-sell-tint text-sell",
  pro: "border-transparent bg-surface-3 text-fg-2",
  whale: "border-transparent bg-surface-3 text-fg-2",
  tracked: "border-transparent bg-info-tint text-info",
  kol: "border-transparent bg-info-tint text-info",
  curve: "border-transparent text-fg-3",
  pool: "border-transparent text-fg-3",
};
