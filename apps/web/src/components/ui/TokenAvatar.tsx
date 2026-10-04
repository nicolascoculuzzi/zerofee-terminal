import { memo, useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { LAUNCHPAD_BY_ID } from "../../lib/metrics";
import type { Launchpad } from "../../protocol";
import { PlatformMark } from "./Logo";
import { LAUNCHPAD_LOGO } from "./logos";
import { tokenImageSrc } from "./tokenImage";

/**
 * Token avatars and monograms (DESIGN.md 4.22, ring and badge per 4.4). A 4px-radius square:
 * the token image when one exists (served by our image proxy only, tokenImage.ts), otherwise one
 * or two characters in Plex 600 on one of 8 muted fills picked by hash(mint). No gradients, no art.
 * The monogram is drawn first and stays until the image has loaded, which then fades in over it
 * (opacity, dur-1; reduced motion: none) inside the same fixed box, so nothing ever shifts. A failed
 * image keeps the monogram and is retried twice (a brand-new token's image can take a moment).
 * Initials on muted squares after Xero: https://mobbin.com/screens/44ed8739-8ccb-4d6f-a532-7a31b1fa5c5f
 */
export type AvatarSize = "2xs" | "xs" | "sm" | "md" | "row" | "lg" | "xl" | "card";

/** 16, 20, 28, 32, 36 (phone list rows), 40, 48 px, or the Pulse card size (set by the card). */
const BOX: Record<AvatarSize, string> = {
  "2xs": "size-4",
  xs: "size-5",
  sm: "size-7",
  md: "size-8",
  row: "size-9",
  lg: "size-10",
  xl: "size-12",
  // The Pulse card overrides --zf-card-avatar with its avatar track (52 / 60 px, 44 / 52 narrow).
  card: "size-card-avatar",
};

/**
 * Box size in CSS px for the image request. The Pulse card passes its tile's real size (`imagePx`:
 * 46 / 54 px wide, 38 / 46 px narrow, by density); 46, the compact tile, is the fallback.
 */
const PX: Record<AvatarSize, number> = { "2xs": 16, xs: 20, sm: 28, md: 32, row: 36, lg: 40, xl: 48, card: 46 };
/**
 * Card tiles are always requested at 2x (DESIGN.md 8: images), so they stay sharp on any screen:
 * a 46 px tile asks for 96, the size the server prefetches for new launches (a cache hit for the
 * first viewer), and the 54 px comfortable tile asks for 128.
 */
const CARD_MIN_DPR = 2;

/** Retries of a failed image (ms after the failure); the server negative-caches failures for 15 s first. */
const RETRY_MS = [20_000, 60_000];

type ImgState = { base: string | null; attempt: number; state: "loading" | "loaded" | "failed" };

/** Monogram glyph at about 40% of the box height, never below the 10px floor (DESIGN.md 2.2). */
const TEXT: Record<AvatarSize, string> = {
  "2xs": "text-micro",
  xs: "text-micro",
  sm: "text-label",
  md: "text-body",
  row: "text-body",
  lg: "text-title",
  xl: "text-display-2",
  // About 40% of the framed tile (46 / 54 px).
  card: "text-[18px] in-data-[density=comfortable]:text-[21px]",
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
  /** CSS px of the image box when the size class can't tell (the Pulse card tile varies with density). */
  imagePx?: number;
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
  imagePx,
  className,
}: TokenAvatarProps) {
  const s = toSize(size);
  const letters = monogram(symbol, s === "2xs" || s === "xs" ? 1 : 2);
  const big = s === "lg" || s === "xl" || s === "card";
  const lp = badge && launchpad && big ? LAUNCHPAD_BY_ID[launchpad] : null;
  const lpLogo = launchpad ? LAUNCHPAD_LOGO[launchpad] : null;
  const ring = progress !== null && progress !== undefined;
  // The Pulse card draws its bonding ring inside its own box (a 2 px track, a 1 px gap, then
  // the tile), so the column's avatar track is exactly the box. Other sizes draw it outside.
  const framed = ring && s === "card";
  const p = migrated ? 1 : Math.max(0, Math.min(1, progress ?? 0));
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  const base = tokenImageSrc(mint, imageUri, imagePx ?? PX[s], dpr, s === "card" ? CARD_MIN_DPR : 1);
  const [stored, setImg] = useState<ImgState>({ base, attempt: 0, state: "loading" });
  const img: ImgState = stored.base === base ? stored : { base, attempt: 0, state: "loading" };
  useEffect(() => {
    if (img.state !== "failed" || !img.base) return;
    const wait = RETRY_MS[img.attempt];
    if (wait === undefined) return;
    const t = setTimeout(() => setImg({ base: img.base, attempt: img.attempt + 1, state: "loading" }), wait);
    return () => clearTimeout(t);
  }, [img.base, img.attempt, img.state]);
  const src = base && img.state !== "failed" ? (img.attempt ? `${base}&r=${img.attempt}` : base) : null;
  const shown = src !== null && img.state === "loaded";
  return (
    <div
      aria-hidden="true"
      className={cn(
        // The tile: a monogram fill (or surface-3 behind a loaded image, so transparent and white
        // images sit on a consistent backdrop) clipped to the content box, and a 1 px inner
        // hairline on ::after above the image so a white image never bleeds into the card.
        "relative flex shrink-0 items-center justify-center bg-clip-content leading-none font-semibold tracking-[-0.01em] transition-colors select-none motion-reduce:transition-none",
        "after:pointer-events-none after:absolute after:inset-(--zf-av-in) after:z-[1] after:rounded-sm after:shadow-[inset_0_0_0_1px_var(--zf-hairline-strong)] after:content-['']",
        framed ? "rounded-md p-[3px] [--zf-av-in:3px]" : "rounded-sm [--zf-av-in:0px]",
        BOX[s],
        TEXT[s],
        shown ? "bg-surface-3 text-transparent" : "text-fg-1",
        className,
      )}
      // The shorthand carries content-box so the fill stays inside the ring's 3 px frame.
      style={shown ? undefined : { background: `${monoFill(mint)} content-box` }}
    >
      {letters}
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setImg({ base, attempt: img.attempt, state: "loaded" })}
          onError={() => setImg({ base, attempt: img.attempt, state: "failed" })}
          className={cn(
            "absolute inset-(--zf-av-in) size-[calc(100%-2*var(--zf-av-in))] rounded-sm object-cover transition-opacity motion-reduce:transition-none",
            shown ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      {ring && (
        <svg
          className={cn(
            "pointer-events-none absolute overflow-visible",
            framed ? "inset-0 size-full" : "-inset-[3px] size-[calc(100%+6px)]",
          )}
          aria-hidden="true"
        >
          <rect fill="none" className={cn(RING_RECT, "stroke-hairline-strong")} strokeWidth="2" />
          <rect fill="none" className={cn(RING_RECT, "stroke-fg-2")} strokeWidth="2" pathLength={100} strokeDasharray={`${p * 100} 100`} />
        </svg>
      )}
      {lp &&
        (lpLogo ? (
          <PlatformMark
            logo={lpLogo}
            label={lp.label}
            className={cn(
              "absolute z-[2] bg-surface-3 ring-2 ring-[color:var(--zf-avatar-bg,var(--zf-bg))]",
              framed ? BADGE_FRAMED : BADGE,
            )}
          />
        ) : (
          <span
            title={lp.label}
            className={cn(
              "absolute z-[2] flex size-4 items-center justify-center rounded-xs bg-surface-3 text-micro font-semibold text-fg-2 ring-2 ring-[color:var(--zf-avatar-bg,var(--zf-bg))]",
              framed ? BADGE_FRAMED : BADGE,
            )}
          >
            {lp.short}
          </span>
        ))}
    </div>
  );
});

/**
 * The ring's rect in CSS geometry, so it follows the box at any size: a 2 px stroke centred 1 px
 * in from the edge with a 6 px outer radius (DESIGN.md 4.4).
 */
const RING_RECT = "[x:1px] [y:1px] [width:calc(100%-2px)] [height:calc(100%-2px)] [rx:5px]";
const BADGE = "-right-[3px] -bottom-[3px]";
const BADGE_FRAMED = "-right-0.5 -bottom-0.5";

/**
 * One or two monogram characters: the ticker's letters and digits (so "$CAT" reads "CA", not
 * "$C"), uppercase; "?" for a ticker with neither.
 */
export function monogram(symbol: string, n: 1 | 2): string {
  const chars = Array.from(symbol.replace(/[^\p{L}\p{N}]/gu, ""))
    .slice(0, n)
    .join("");
  return (chars || Array.from(symbol.trim()).slice(0, n).join("") || "?").toUpperCase();
}

/** A tag that is a single emoji (the user picked it, or an import carried it). */
const EMOJI = /^\p{Extended_Pictographic}(\u{FE0F}|\u{200D}\p{Extended_Pictographic})*$/u;

/**
 * Wallet avatar (DESIGN.md 4.22): a circle of 16, 20 or 24 px. A user-chosen emoji sits centred
 * at 70% of the box; otherwise a 2-letter monogram (the tag's letters, else the label's, else the
 * address's first two characters) on the same muted palette as token monograms.
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
  const t = tag?.trim() ?? "";
  const emoji = t !== "" && EMOJI.test(t);
  const letters = (s: string) =>
    Array.from(s.replace(/[^\p{L}\p{N}]/gu, ""))
      .slice(0, 2)
      .join("")
      .toUpperCase();
  const text = emoji ? t : letters(t) || letters(label) || letters(seed) || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold text-fg-1",
        size === 16 ? "size-4" : size === 20 ? "size-5" : "size-6",
        !emoji && "text-micro tracking-normal",
        className,
      )}
      style={{ background: monoFill(seed), fontSize: emoji ? Math.round(size * 0.7) : undefined }}
    >
      {text}
    </span>
  );
});
