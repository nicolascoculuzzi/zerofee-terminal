import { memo } from "react";
import { cn } from "../../lib/cn";
import { LAUNCHPAD_BY_ID } from "../../lib/metrics";
import type { Launchpad } from "../../protocol";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const BOX: Record<AvatarSize, string> = {
  xs: "size-5 text-2xs rounded-sm",
  sm: "size-6 text-2xs rounded-sm",
  md: "size-8 text-xs rounded-md",
  lg: "size-10 text-sm rounded-md",
  xl: "size-14 text-md rounded-lg",
};

function toSize(size: AvatarSize | number | undefined): AvatarSize {
  if (typeof size === "string") return size;
  if (size === undefined) return "lg";
  if (size <= 20) return "xs";
  if (size <= 26) return "sm";
  if (size <= 34) return "md";
  if (size <= 46) return "lg";
  return "xl";
}

export interface TokenAvatarProps {
  mint: string;
  symbol: string;
  imageUri: string | null;
  launchpad?: Launchpad;
  size?: AvatarSize | number;
  /** 0..1 bonding progress drawn as a hairline ring; null hides it. */
  progress?: number | null;
  migrated?: boolean;
  className?: string;
}

/**
 * Neutral monogram until metadata images come through an image proxy; nothing is fetched
 * from external hosts. Colour-free on purpose: colour is reserved for buy/sell/risk/state.
 * The ring shows bonding-curve progress (full when migrated).
 */
export const TokenAvatar = memo(function TokenAvatar({ symbol, launchpad, size, progress = null, migrated, className }: TokenAvatarProps) {
  const s = toSize(size);
  const letters = (s === "xs" || s === "sm" ? symbol.slice(0, 1) : symbol.slice(0, 2)).toUpperCase() || "?";
  const badge = launchpad && (s === "lg" || s === "xl") ? LAUNCHPAD_BY_ID[launchpad] : null;
  const ring = progress !== null && progress !== undefined;
  const p = migrated ? 1 : Math.max(0, Math.min(1, progress ?? 0));
  return (
    <div className={cn("relative shrink-0", BOX[s].split(" ")[0], className)}>
      <div className={cn("flex size-full items-center justify-center border border-line bg-elev font-semibold text-muted", BOX[s])}>
        {letters}
      </div>
      {ring && (
        <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" viewBox="0 0 100 100" aria-hidden="true">
          <rect
            x="0.5"
            y="0.5"
            width="99"
            height="99"
            rx="12"
            fill="none"
            className="stroke-fg"
            strokeOpacity={migrated ? 0.9 : 0.75}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            pathLength={100}
            strokeDasharray={`${p * 100} 100`}
          />
        </svg>
      )}
      {badge && (
        <span
          title={badge.label}
          className="absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-sm border border-line bg-panel px-px text-2xs font-semibold text-muted"
        >
          {badge.short}
        </span>
      )}
    </div>
  );
});
