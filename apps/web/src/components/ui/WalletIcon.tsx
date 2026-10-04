import { cn } from "../../lib/cn";
import type { WalletProvider } from "../../services/walletService";
import { walletLogo } from "./walletLogos";

/**
 * A wallet's official logo. An installed wallet's own Wallet Standard icon (a data: URI it supplies) wins;
 * otherwise the bundled logo for Phantom, Solflare or Backpack (walletLogos.ts). Only a wallet we have no
 * logo for at all gets a neutral letter square. Logos keep their own colours: like platform logos (DESIGN.md
 * 2.11), they identify rather than decorate.
 */
/** Inset of a transparent mark on its plate, per size. */
const PLATE_PAD = { sm: "p-px", md: "p-0.5", lg: "p-1", xl: "p-1" } as const;

const BOX = { sm: "size-4 rounded-xs", md: "size-6 rounded-sm", lg: "size-8 rounded-md", xl: "size-10 rounded-md" } as const;

export function WalletIcon({
  icon,
  name,
  provider,
  size = "md",
  className,
}: {
  icon: string | null | undefined;
  name: string;
  provider?: WalletProvider | null;
  size?: keyof typeof BOX;
  className?: string;
}) {
  const logo = walletLogo(icon, name, provider);
  if (logo) {
    return (
      <img
        src={logo.src}
        style={logo.plate ? { backgroundColor: logo.plate } : undefined}
        alt=""
        width={64}
        height={64}
        draggable={false}
        decoding="async"
        className={cn(BOX[size], "shrink-0", logo.plate ? cn("object-contain", PLATE_PAD[size]) : "object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        BOX[size],
        "flex shrink-0 items-center justify-center bg-surface-3 font-semibold text-fg-1",
        size === "sm" ? "text-micro" : "text-label",
        className,
      )}
    >
      {name.charAt(0)}
    </span>
  );
}

/** Icon and name of a connected wallet, inline. */
export function WalletBadge({ wallet, className }: { wallet: { name: string; icon: string | null }; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 align-middle", className)}>
      <WalletIcon icon={wallet.icon} name={wallet.name} size="sm" />
      <span className="truncate">{wallet.name}</span>
    </span>
  );
}
