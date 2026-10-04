import { BadgeCheck, Check, Copy, Ellipsis, Eye, Globe, Lock, Send, Users, Zap } from "lucide-react";
import { type RefObject, useLayoutEffect, useRef } from "react";
import { type BrandMark, brandMaskUrl } from "../../components/ui/Logo";

/*
 * Card icons as CSS masks (DESIGN.md 8: at most 45 DOM nodes per Pulse card). An inline lucide
 * SVG costs 2–5 nodes per icon and a card shows up to nine of them, so the page renders each
 * lucide icon once (hidden), serialises it with a 1.5 px stroke at 12 px, and publishes it as a
 * custom property on the page root. A card icon is then a ::before pseudo-element painted in
 * currentColor through that mask: still lucide, still 12 px with a 1.5 px stroke, zero nodes.
 */

const SOURCES = {
  users: Users,
  badge: BadgeCheck,
  eye: Eye,
  globe: Globe,
  send: Send,
  copy: Copy,
  check: Check,
  zap: Zap,
  lock: Lock,
  more: Ellipsis,
} as const;

/** Brand marks for social links (simple-icons paths, filled): published from their path data directly. */
const BRANDS: readonly BrandMark[] = ["x", "telegram", "discord"];

export type MaskIcon = keyof typeof SOURCES | "x" | "telegram" | "discord";

/** 12 px icon in currentColor on the element's ::before (the parent must be a flex container). */
export const ICON = "before:size-3 before:shrink-0 before:bg-current before:content-['']";

/** Mask per icon. Missing variables fall back to an empty mask (invisible, never a solid square). */
export const MASK: Record<MaskIcon, string> = {
  users: "before:[mask:var(--zfp-users,url(#zfp-none))_center/contain_no-repeat]",
  badge: "before:[mask:var(--zfp-badge,url(#zfp-none))_center/contain_no-repeat]",
  eye: "before:[mask:var(--zfp-eye,url(#zfp-none))_center/contain_no-repeat]",
  globe: "before:[mask:var(--zfp-globe,url(#zfp-none))_center/contain_no-repeat]",
  send: "before:[mask:var(--zfp-send,url(#zfp-none))_center/contain_no-repeat]",
  copy: "before:[mask:var(--zfp-copy,url(#zfp-none))_center/contain_no-repeat]",
  check: "before:[mask:var(--zfp-check,url(#zfp-none))_center/contain_no-repeat]",
  zap: "before:[mask:var(--zfp-zap,url(#zfp-none))_center/contain_no-repeat]",
  lock: "before:[mask:var(--zfp-lock,url(#zfp-none))_center/contain_no-repeat]",
  more: "before:[mask:var(--zfp-more,url(#zfp-none))_center/contain_no-repeat]",
  x: "before:[mask:var(--zfp-x,url(#zfp-none))_center/contain_no-repeat]",
  telegram: "before:[mask:var(--zfp-telegram,url(#zfp-none))_center/contain_no-repeat]",
  discord: "before:[mask:var(--zfp-discord,url(#zfp-none))_center/contain_no-repeat]",
};

/** Lucide draws on a 24-unit grid: a 3-unit stroke renders 1.5 px at 12 px (DESIGN.md 2.11). */
const STROKE_AT_12PX = "3";

/**
 * Renders the source icons hidden and publishes them on `target` before the first paint
 * (layout effect in the same commit as the cards).
 */
export function IconMasks({ target }: { target: RefObject<HTMLElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = holder.current;
    // A child's layout effect runs before its parent's ref is attached, so on the first commit
    // `target.current` is still null: fall back to the holder's parent (the page root it renders in).
    const root = target.current ?? box?.parentElement ?? null;
    if (!root || !box) return;
    for (const name of BRANDS) root.style.setProperty(`--zfp-${name}`, brandMaskUrl(name));
    const serializer = new XMLSerializer();
    for (const svg of box.querySelectorAll<SVGSVGElement>("svg[data-mask]")) {
      const name = svg.dataset.mask;
      if (!name) continue;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.removeAttribute("class");
      clone.removeAttribute("data-mask");
      clone.removeAttribute("aria-hidden");
      clone.setAttribute("stroke-width", STROKE_AT_12PX);
      const markup = serializer.serializeToString(clone);
      root.style.setProperty(`--zfp-${name}`, `url("data:image/svg+xml,${encodeURIComponent(markup)}")`);
    }
  }, [target]);
  return (
    <div ref={holder} hidden aria-hidden="true">
      {(Object.keys(SOURCES) as (keyof typeof SOURCES)[]).map((name) => {
        const Icon = SOURCES[name];
        return <Icon key={name} data-mask={name} />;
      })}
    </div>
  );
}
