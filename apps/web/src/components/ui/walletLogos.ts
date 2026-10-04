/**
 * Official wallet logos and download sites for the wallets the connect step offers.
 *
 * An installed wallet supplies its own logo through Wallet Standard (`wallet.icon`, a data: URI), and that
 * always wins. These bundled files stand in when the extension is not installed (and in the simulation), so
 * the list never falls back to letter squares. They are the icons the official @solana/wallet-adapter-*
 * packages embed (Phantom and Solflare as SVG, Backpack as a 128 px PNG), served same-origin from
 * public/wallets/ (CSP img-src 'self'). Sources in public/wallets/LOGOS.md.
 */
import type { WalletProvider } from "../../services/walletService";

export interface WalletBrand {
  name: string;
  /** Same-origin logo file. */
  logo: string;
  /** Official site, opened in a new tab from the "Install" affordance. */
  site: string;
  /** Short host shown next to "Install". */
  host: string;
  /** The logo is a transparent mark rather than an app tile, so it sits on a dark plate. */
  plate?: string;
}

export const WALLET_BRANDS: Record<WalletProvider, WalletBrand> = {
  phantom: { name: "Phantom", logo: "/wallets/phantom.svg", site: "https://phantom.com/", host: "phantom.com" },
  solflare: { name: "Solflare", logo: "/wallets/solflare.svg", site: "https://solflare.com/", host: "solflare.com" },
  backpack: { name: "Backpack", logo: "/wallets/backpack.png", site: "https://backpack.app/", host: "backpack.app", plate: "#151517" },
};

const IDS = Object.keys(WALLET_BRANDS) as WalletProvider[];

/** The provider a wallet name refers to ("Phantom", "Backpack Wallet"), or null. */
export function providerFromName(name: string): WalletProvider | null {
  const n = name.toLowerCase();
  return IDS.find((id) => n.includes(id)) ?? null;
}

/** A wallet-supplied icon we may render: image data: URIs only, so no remote URL is ever loaded. */
const DATA_IMAGE = /^data:image\/(?:svg\+xml|png|webp|jpeg|gif)[;,]/i;

/** The logo to draw: the wallet's own Wallet Standard icon, else the bundled one, else null (letter square). */
export function walletLogoSrc(icon: string | null | undefined, name: string, provider?: WalletProvider | null): string | null {
  return walletLogo(icon, name, provider)?.src ?? null;
}

/** Like walletLogoSrc, plus the plate colour a bundled transparent mark needs. */
export function walletLogo(
  icon: string | null | undefined,
  name: string,
  provider?: WalletProvider | null,
): { src: string; plate: string | null } | null {
  if (icon && DATA_IMAGE.test(icon)) return { src: icon, plate: null };
  const id = provider ?? providerFromName(name);
  return id ? { src: WALLET_BRANDS[id].logo, plate: WALLET_BRANDS[id].plate ?? null } : null;
}
