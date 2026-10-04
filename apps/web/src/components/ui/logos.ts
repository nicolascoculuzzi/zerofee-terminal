/**
 * Platform logos (DESIGN.md 2.11): each launchpad's, AMM's and aggregator's own icon, bundled as a 64 px WebP
 * under public/venues/ (sources in public/venues/LOGOS.md, refreshed by scripts/fetch-venue-logos.ts) and
 * shown at 12-16 px. Brand marks for X, Telegram, Discord and Solana come from simple-icons (CC0) instead.
 * Logos only identify the platform; everything else stays monochrome.
 */
import type { Launchpad, Venue } from "../../protocol";

export type PlatformLogo =
  | "pump"
  | "pumpswap"
  | "mayhem"
  | "bonk"
  | "stonkfun"
  | "raydium"
  | "meteora"
  | "bags"
  | "moonit"
  | "boop"
  | "heaven"
  | "jupiter"
  | "orca"
  | "dexscreener";

export const PLATFORM_LOGOS: Record<PlatformLogo, { label: string; src: string }> = {
  pump: { label: "pump.fun", src: "/venues/pump.webp" },
  pumpswap: { label: "PumpSwap", src: "/venues/pumpswap.webp" },
  mayhem: { label: "pump.fun Mayhem", src: "/venues/mayhem.webp" },
  bonk: { label: "BONK.fun", src: "/venues/bonk.webp" },
  stonkfun: { label: "StonkFun", src: "/venues/stonkfun.webp" },
  raydium: { label: "Raydium", src: "/venues/raydium.webp" },
  meteora: { label: "Meteora", src: "/venues/meteora.webp" },
  bags: { label: "Bags", src: "/venues/bags.webp" },
  moonit: { label: "Moonit", src: "/venues/moonit.webp" },
  boop: { label: "Boop", src: "/venues/boop.webp" },
  heaven: { label: "Heaven", src: "/venues/heaven.webp" },
  jupiter: { label: "Jupiter", src: "/venues/jupiter.webp" },
  orca: { label: "Orca", src: "/venues/orca.webp" },
  dexscreener: { label: "DexScreener", src: "/venues/dexscreener.webp" },
};

/** Launchpad (Pulse protocols) -> logo; "other" has none (a neutral letter is drawn). */
export const LAUNCHPAD_LOGO: Record<Launchpad, PlatformLogo | null> = {
  pump: "pump",
  mayhem: "mayhem",
  bonk: "bonk",
  bags: "bags",
  stonkfun: "stonkfun",
  launchlab: "raydium",
  meteora_dbc: "meteora",
  moonit: "moonit",
  boop: "boop",
  heaven: "heaven",
  other: null,
};

/** Trading venue -> logo. */
export const VENUE_LOGO: Record<Venue, PlatformLogo | null> = {
  pump_curve: "pump",
  pumpswap: "pumpswap",
  launchlab: "raydium",
  raydium_cpmm: "raydium",
  meteora_dbc: "meteora",
  meteora_damm_v2: "meteora",
  other: null,
};

/** Venue ids the server's protocol uses (packages/protocol Launchpad / TradeVenue) and route names. */
const EXTRA: Record<string, PlatformLogo> = {
  pumpfun: "pump",
  "pump.fun": "pump",
  amm: "pumpswap",
  letsbonk: "bonk",
  "bonk.fun": "bonk",
  raydium: "raydium",
  meteora: "meteora",
  meteora_damm: "meteora",
  jupiter: "jupiter",
  jup: "jupiter",
  orca: "orca",
  dexscreener: "dexscreener",
};

/** pump.fun, PumpSwap and Mayhem share pump.fun's mark: one logo is enough where two would repeat it. */
const BRAND_FAMILY: Partial<Record<PlatformLogo, string>> = { pump: "pump", pumpswap: "pump", mayhem: "pump" };

export function sameBrand(a: PlatformLogo | null, b: PlatformLogo | null): boolean {
  if (!a || !b) return a === b;
  return (BRAND_FAMILY[a] ?? a) === (BRAND_FAMILY[b] ?? b);
}

/** Logo for any launchpad, venue or route id this app or the server uses; null when it has none. */
export function platformLogo(id: string | null | undefined): PlatformLogo | null {
  if (!id) return null;
  const k = id.toLowerCase();
  if (k in LAUNCHPAD_LOGO) return LAUNCHPAD_LOGO[k as Launchpad];
  if (k in VENUE_LOGO) return VENUE_LOGO[k as Venue];
  return EXTRA[k] ?? null;
}
