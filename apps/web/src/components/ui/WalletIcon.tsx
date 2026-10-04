import { cn } from "../../lib/cn";

/**
 * A wallet's official logo: the `icon` its extension registers through Wallet Standard (a data: URI the
 * wallet supplies, allowed by img-src data:). Anything that is not an image data: URI is ignored, so no
 * remote URL is ever loaded; without a logo (the simulation, or a wallet that sets none) a neutral letter
 * square stands in.
 */
const DATA_IMAGE = /^data:image\/(?:svg\+xml|png|webp|jpeg|gif)[;,]/i;

const BOX = { sm: "size-4", md: "size-6" } as const;

export function WalletIcon({
  icon,
  name,
  size = "md",
  className,
}: {
  icon: string | null | undefined;
  name: string;
  size?: keyof typeof BOX;
  className?: string;
}) {
  if (icon && DATA_IMAGE.test(icon)) {
    return <img src={icon} alt="" draggable={false} className={cn(BOX[size], "shrink-0 rounded-xs object-contain", className)} />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        BOX[size],
        "flex shrink-0 items-center justify-center rounded-xs bg-surface-3 font-semibold text-fg-1",
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
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <WalletIcon icon={wallet.icon} name={wallet.name} size="sm" />
      <span className="truncate">{wallet.name}</span>
    </span>
  );
}
