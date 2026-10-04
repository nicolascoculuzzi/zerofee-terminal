import { Globe } from "lucide-react";
import { siDiscord, siSolana, siTelegram, siX } from "simple-icons";
import { cn } from "../../lib/cn";
import { LAUNCHPAD_BY_ID } from "../../lib/metrics";
import type { Launchpad } from "../../protocol";
import { LAUNCHPAD_LOGO, PLATFORM_LOGOS, type PlatformLogo, platformLogo } from "./logos";
import type { LinkIcon } from "./socials";

/**
 * Logos (DESIGN.md 2.11). Platform logos keep their own colours at 12-16 px: they identify the launchpad or
 * venue, the one place third-party colour is allowed. Brand marks for links (X, Telegram, Discord) and the
 * SOL mark are simple-icons paths in currentColor, so they follow text-3 / hover text-1 like every icon.
 */

const PX: Record<12 | 14 | 16, string> = { 12: "size-3", 14: "size-3.5", 16: "size-4" };

/** A platform's logo: one element (a background image), so it fits the Pulse card's node budget. */
export function PlatformMark({
  logo,
  size = 16,
  className,
  label,
}: {
  logo: PlatformLogo;
  size?: 12 | 14 | 16;
  className?: string;
  /** Accessible name and tooltip; defaults to the platform's name. "" = decorative (the parent names it). */
  label?: string;
}) {
  const p = PLATFORM_LOGOS[logo];
  const name = label ?? p.label;
  const style = { backgroundImage: `url("${p.src}")` };
  const cls = cn("inline-block shrink-0 rounded-xs bg-cover bg-center bg-no-repeat", PX[size], className);
  if (!name) return <span aria-hidden="true" className={cls} style={style} />;
  return <span role="img" aria-label={name} title={name} className={cls} style={style} />;
}

const BRAND = { x: siX.path, telegram: siTelegram.path, discord: siDiscord.path, solana: siSolana.path } as const;
export type BrandMark = keyof typeof BRAND;

/** Monochrome brand mark (simple-icons, CC0 path data) at 12 px in currentColor. */
export function BrandIcon({ name, className, label }: { name: BrandMark; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("inline-block size-3 shrink-0", className)}
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={BRAND[name]} />
    </svg>
  );
}

/** Data URL of a brand mark, for CSS masks (Pulse cards, icons.tsx). */
export function brandMaskUrl(name: BrandMark): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${BRAND[name]}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** A token's launchpad logo with its name on hover; nothing for launchpads without a logo. */
export function LaunchpadMark({ launchpad, size = 12, className }: { launchpad: Launchpad; size?: 12 | 14 | 16; className?: string }) {
  const logo = LAUNCHPAD_LOGO[launchpad];
  return logo ? <PlatformMark logo={logo} size={size} label={LAUNCHPAD_BY_ID[launchpad]?.label} className={className} /> : null;
}

/**
 * A launchpad or venue name with its logo in front (filter rows, menus, headers). Ids without a logo
 * ("other") get an empty 14 px slot so names in a list stay aligned.
 */
export function PlatformName({ id, label, className }: { id: string; label: string; className?: string }) {
  const logo = platformLogo(id);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {logo ? <PlatformMark logo={logo} size={14} label="" /> : <span aria-hidden="true" className="inline-block size-3.5 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The 12 px icon of a link: brand marks, platform logos for pump.fun / DexScreener, else a globe. */
export function LinkIconView({ icon }: { icon: LinkIcon }) {
  if (icon === "x" || icon === "telegram" || icon === "discord") return <BrandIcon name={icon} />;
  if (icon === "pump" || icon === "dexscreener") return <PlatformMark logo={icon} size={12} label="" />;
  return <Globe />;
}
