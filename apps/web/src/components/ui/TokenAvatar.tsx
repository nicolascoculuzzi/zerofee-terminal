import { memo } from "react";
import { cn } from "../../lib/cn";
import { LAUNCHPAD_BY_ID } from "../../lib/metrics";
import type { Launchpad } from "../../protocol";

/**
 * Token avatars and monograms (DESIGN.md 4.22, ring and badge per 4.4). A 4px-radius square:
 * the token image when one exists (served by our image proxy only), otherwise one or two
 * characters in Plex 600 on one of 8 muted fills picked by hash(mint). No gradients, no art.
 * Initials on muted squares after Xero: https://mobbin.com/screens/44ed8739-8ccb-4d6f-a532-7a31b1fa5c5f
 */
export type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "card";

/** 16, 20, 28, 32, 40, 48 px, or the Pulse card size (40 compact / 48 comfortable). */
const BOX: Record<AvatarSize, string> = {
  "2xs": "size-4",
  xs: "size-5",
  sm: "size-7",
  md: "size-8",
  lg: "size-10",
  xl: "size-12",
  card: "size-card-avatar",
};

/** Monogram glyph at about 40% of the box height, never below the 10px floor (DESIGN.md 2.2). */
const TEXT: Record<AvatarSize, string> = {
  "2xs": "text-micro",
  xs: "text-micro",
  sm: "text-label",
  md: "text-body",
  lg: "text-title",
  xl: "text-display-2",
  card: "text-title in-data-[density=comfortable]:text-display-2",
};

function toSize(size: AvatarSize | number | undefined): AvatarSize {
  if (typeof size === "string") return size;
  if (size === undefined) return "lg";
  if (size <= 16) return "2xs";
  if (size <= 20) return "xs";
  if (size <= 28) return "sm";
  if (size <= 34) return "md";
  if (size <= 44) return "lg";
  return "xl";
}

/** djb2 over the mint, into the 8 monogram fills. */
export function monoIndex(seed: string): number {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
  return Math.abs(h) % 8;
}

export function monoFill(seed: string): string {
  return `var(--zf-mono-${monoIndex(seed)})`;
}

export interface TokenAvatarProps {
  mint: string;
  symbol: string;
  imageUri: string | null;
  launchpad?: Launchpad;
  size?: AvatarSize | number;
  /** 0..1 bonding progress drawn as a 2px ring; null hides it. */
  progress?: number | null;
  migrated?: boolean;
  /** Show the launchpad letter badge (cards and headers). */
  badge?: boolean;
  className?: string;
}

export const TokenAvatar = memo(function TokenAvatar({
  mint,
  symbol,
  imageUri,
  launchpad,
  size,
  progress = null,
  migrated,
  badge = true,
  className,
}: TokenAvatarProps) {
  const s = toSize(size);
  const letters = (s === "2xs" || s === "xs" ? symbol.slice(0, 1) : symbol.slice(0, 2)).toUpperCase() || "?";
  const big = s === "lg" || s === "xl" || s === "card";
  const lp = badge && launchpad && big ? LAUNCHPAD_BY_ID[launchpad] : null;
  const ring = progress !== null && progress !== undefined;
  const p = migrated ? 1 : Math.max(0, Math.min(1, progress ?? 0));
  return (
    <div className={cn("relative shrink-0", BOX[s], className)}>
      {imageUri ? (
        <img
          src={imageUri}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full rounded-sm object-cover shadow-[inset_0_0_0_1px_var(--zf-hairline)]"
        />
      ) : (
        <div
          aria-hidden="true"
          className={cn("flex size-full items-center justify-center rounded-sm font-semibold text-fg-1", TEXT[s])}
          style={{ background: monoFill(mint) }}
        >
          {letters}
        </div>
      )}
      {ring && (
        <svg
          className="pointer-events-none absolute -inset-[3px] size-[calc(100%+6px)] overflow-visible"
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <rect
            x="1"
            y="1"
            width="98"
            height="98"
            rx="9"
            fill="none"
            className="stroke-hairline-strong"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x="1"
            y="1"
            width="98"
            height="98"
            rx="9"
            fill="none"
            className="stroke-fg-2"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            pathLength={100}
            strokeDasharray={`${p * 100} 100`}
          />
        </svg>
      )}
      {lp && (
        <span
          title={lp.label}
          className="absolute -right-[3px] -bottom-[3px] flex size-4 items-center justify-center rounded-xs bg-surface-3 text-micro font-semibold text-fg-2 ring-2 ring-bg"
        >
          {lp.short}
        </span>
      )}
    </div>
  );
});

/**
 * Wallet avatar (DESIGN.md 4.22): a circle of 16, 20 or 24 px. A tag the user chose (one or two
 * characters, possibly an emoji from an import) sits centred; otherwise a 2-letter monogram from
 * the label or address, on the same muted palette.
 */
export const WalletAvatar = memo(function WalletAvatar({
  seed,
  label,
  tag,
  size = 16,
  className,
}: {
  seed: string;
  label: string;
  tag?: string;
  size?: 16 | 20 | 24;
  className?: string;
}) {
  const letters = Array.from(label.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, size === 16 ? 1 : 2);
  const text = tag?.trim() || letters.join("").toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-fg-1",
        "text-micro",
        size === 16 ? "size-4" : size === 20 ? "size-5" : "size-6",
        className,
      )}
      style={{ background: monoFill(seed) }}
    >
      {text}
    </span>
  );
});
