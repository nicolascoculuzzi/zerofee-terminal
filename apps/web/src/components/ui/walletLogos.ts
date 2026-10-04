/**
 * Official wallet logos and download sites for the wallets the connect step offers.
 *
 * An installed wallet supplies its own logo through Wallet Standard (`wallet.icon`, a data: URI), and that
 * always wins. These bundled files stand in when the extension is not installed (and in the simulation), so
 * the list never falls back to letter squares. They are the icons the official @solana/wallet-adapter-*
 * packages embed (Phantom and Solflare as SVG, Backpack as a 128 px PNG), served same-origin from
 * public/wallets/ (CSP img-src 'self'). Sources in public/wallets/LOGOS.md.
 */
import { isKnownWallet, KNOWN_WALLETS, type KnownWallet, type WalletProvider } from "../../services/walletService";

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
  /** A black tile that would vanish into the dark UI: draw a hairline edge on it. */
  edge?: boolean;
}

export const WALLET_BRANDS: Record<KnownWallet, WalletBrand> = {
  phantom: { name: "Phantom", logo: "/wallets/phantom.svg", site: "https://phantom.com/", host: "phantom.com" },
  solflare: { name: "Solflare", logo: "/wallets/solflare.svg", site: "https://solflare.com/", host: "solflare.com" },
  backpack: { name: "Backpack", logo: "/wallets/backpack.png", site: "https://backpack.app/", host: "backpack.app", plate: "#151517" },
  coinbase: { name: "Coinbase Wallet", logo: "/wallets/coinbase.svg", site: "https://www.coinbase.com/wallet", host: "coinbase.com" },
  okx: { name: "OKX Wallet", logo: "/wallets/okx.png", site: "https://www.okx.com/web3", host: "okx.com", edge: true },
  trust: { name: "Trust Wallet", logo: "/wallets/trust.svg", site: "https://trustwallet.com/", host: "trustwallet.com" },
};

const NAME_MATCH: readonly [KnownWallet, RegExp][] = KNOWN_WALLETS.map((id) => [
  id,
  id === "okx" || id === "trust" ? new RegExp(`\\b${id}\\b`, "i") : new RegExp(id, "i"),
]);

/** The known wallet a name refers to ("Phantom", "Backpack Wallet", "OKX Wallet", "Trust"), or null. */
export function providerFromName(name: string): KnownWallet | null {
  return NAME_MATCH.find(([, re]) => re.test(name))?.[0] ?? null;
}

/** The brand for a provider id, or null for a wallet we only know through Wallet Standard. */
export function walletBrand(provider: WalletProvider | null | undefined): WalletBrand | null {
  return provider && isKnownWallet(provider) ? WALLET_BRANDS[provider] : null;
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
): { src: string; plate: string | null; edge: boolean } | null {
  if (icon && DATA_IMAGE.test(icon)) return { src: icon, plate: null, edge: false };
  const brand = walletBrand(provider) ?? walletBrand(providerFromName(name));
  return brand ? { src: brand.logo, plate: brand.plate ?? null, edge: brand.edge === true } : null;
}
