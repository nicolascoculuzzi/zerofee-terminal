import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { SolGlyph } from "../../components/ui/bits";
import { type LinkIcon, type SafeLink, type SocialKind, socialLink } from "../../components/ui/socials";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { DASH } from "../../lib/format";
import type { PulseColumnId } from "../../protocol";
import { getServices } from "../../services";
import { copyCa, useCopied } from "./actions";
import type { CardView } from "./cardView";
import { ICON, MASK, type MaskIcon } from "./icons";
import { menuAnchor, usePulseUi } from "./store";

/*
 * Pieces of the Pulse card (DESIGN.md 4.4), each one DOM node where possible: icons are
 * pseudo-element masks (icons.tsx), labels such as "MC" are generated content, and tooltips go
 * through the page tooltip layer via data-tip (TipLayer.tsx, tipContent.tsx).
 */

/** ARIA grid cell. Virtualised rows are absolutely positioned divs, so the grid pattern uses roles (DESIGN.md 7). */
export function Cell({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualised rows can't be table rows; this is the ARIA grid pattern
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid; rows are reached through its aria-activedescendant cursor
    <div role="gridcell" className={className}>
      {children}
    </div>
  );
}

function useFlag(ms = 1200): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [on, ms]);
  return [on, () => setOn(true)];
}

/**
 * Copy-CA control: Copy 12 px in a 20 × 20 hit area, swapping to Check for 1,200 ms, also when
 * the C hotkey copied this card. No toast.
 */
export function CopyCa({ mint }: { mint: string }) {
  const copied = useCopied((s) => s.mint === mint);
  return (
    <button
      type="button"
      data-tip="copy"
      aria-label={copied ? "Copied" : "Copy contract address"}
      onClick={(e) => {
        e.stopPropagation();
        copyCa(mint);
      }}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-xs transition-colors",
        ICON,
        copied ? cn(MASK.check, "text-fg-1") : cn(MASK.copy, "text-fg-3 hover:text-fg-1"),
      )}
    />
  );
}

/** Per-card menu trigger: visible on hover, on the cursor card and on keyboard focus. */
export function MoreButton({ mint, symbol, column, shown }: { mint: string; symbol: string; column: PulseColumnId; shown: boolean }) {
  return (
    <button
      type="button"
      data-tip="more"
      aria-label={`More actions for ${symbol}`}
      onClick={(e) => {
        e.stopPropagation();
        menuAnchor.current = e.currentTarget;
        usePulseUi.getState().openMenu({ mint, column });
      }}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-fg-3 transition-colors hover:text-fg-1 focus-visible:opacity-100",
        ICON,
        MASK.more,
        shown ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
      )}
    />
  );
}

type CardSocial = "x" | "web" | "tg";
const SOCIAL_KIND: Record<CardSocial, SocialKind> = { x: "x", web: "website", tg: "telegram" };
/** Card masks per link logo: brand marks for X / Telegram / Discord, the globe for any other site. */
const LINK_MASK: Record<LinkIcon, MaskIcon> = {
  x: "x",
  telegram: "telegram",
  discord: "discord",
  pump: "globe",
  dexscreener: "globe",
  globe: "globe",
};

/** Safe https link for a card social, or null (not rendered). */
function cardLink(kind: CardSocial, value: string): SafeLink | null {
  return socialLink(SOCIAL_KIND[kind], value);
}

export function socialLabel(kind: CardSocial, value: string): string {
  return cardLink(kind, value)?.label ?? value;
}

/**
 * Social link (DESIGN.md 2.11): the X or Telegram mark, Discord's for discord links, else the globe, at
 * 12 px in a 16 × 16 box with a 24 px hit area; opens in a new tab. On simulated data the handles are
 * fictional, so a click copies the link instead (no network calls).
 */
function SocialButton({ kind, value, first }: { kind: CardSocial; value: string; first: boolean }) {
  const [copied, flash] = useFlag();
  const link = cardLink(kind, value);
  if (!link) return null;
  return (
    // biome-ignore lint/a11y/useAnchorContent: the mark is a ::before mask (card node budget); aria-label names the link
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      data-tip={`social:${kind}`}
      aria-label={copied ? "Copied" : link.label}
      onClick={(e) => {
        e.stopPropagation();
        if (!getServices().simulated) return;
        e.preventDefault();
        void copyText(link.href).then((ok) => ok && flash());
      }}
      onAuxClick={(e) => e.stopPropagation()}
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center transition-colors after:absolute after:-inset-1 after:content-['']",
        ICON,
        first && "ml-1",
        copied ? cn(MASK.check, "text-fg-1") : cn(MASK[LINK_MASK[link.icon]], "text-fg-3 hover:text-fg-1"),
      )}
    />
  );
}

/** `gap`: a 4 px lead before the first mark (after the age); off when the row starts with the socials. */
export function Socials({ view, gap = true }: { view: CardView; gap?: boolean }) {
  return (
    <>
      {view.x && <SocialButton kind="x" value={view.x} first={gap} />}
      {view.web && <SocialButton kind="web" value={view.web} first={gap && !view.x} />}
      {view.tg && <SocialButton kind="tg" value={view.tg} first={gap && !view.x && !view.web} />}
    </>
  );
}

/**
 * Holders, pro traders and tracked wallets holding: icon 12 px in text-3, value 11/500. Widths are
 * reserved in ch so a new digit never pushes the next counter (DESIGN.md 6.7: no layout shift). A
 * counter the feed hasn't computed is left out rather than shown as an icon and a dash (Axiom
 * omits unknown metrics; Binance Meme Rush keeps its rows to what it knows:
 * https://mobbin.com/screens/f9b4eff0-8083-4e54-913c-51177e462d1d).
 */
export function Counters({ view, gap }: { view: CardView; gap: boolean }) {
  const base = cn("zf-num inline-flex shrink-0 items-center gap-0.5 text-label font-medium", ICON, "before:text-fg-3");
  const holders = view.holders !== DASH;
  return (
    <>
      {holders && (
        <span data-tip="holders" className={cn(base, MASK.users, "min-w-[calc(14px+5ch)] text-fg-2", gap && "ml-1")}>
          {view.holders}
        </span>
      )}
      {view.pros !== DASH && (
        <span data-tip="pro" className={cn(base, MASK.badge, "min-w-[calc(14px+3ch)] text-fg-2", gap && !holders && "ml-1")}>
          {view.pros}
        </span>
      )}
      {view.tracked > 0 && (
        <span data-tip="eye" className={cn(base, MASK.eye, "text-info")}>
          {view.tracked}
        </span>
      )}
    </>
  );
}

const LP_TONE: Record<CardView["lpTone"], string> = {
  neutral: "border-hairline-strong text-fg-2",
  warn: "border-transparent bg-warn-tint text-warn",
  bad: "border-sell-edge bg-sell-tint text-sell",
};

/** Flags on line 1 after the copy button (DESIGN.md 3.11): DEX neutral, T22 sell-tint, LP by share burned. */
export function Flags({ view }: { view: CardView }) {
  const chip = "inline-flex h-4 shrink-0 items-center rounded-xs border px-1 text-micro font-semibold";
  return (
    <>
      {view.t22 && (
        <span data-tip="t22" className={cn(chip, "border-sell-edge bg-sell-tint text-sell")}>
          T22
        </span>
      )}
      {view.dex && (
        <span data-tip="dex" className={cn(chip, "border-hairline-strong text-fg-2")}>
          DEX
        </span>
      )}
      {view.lp && (
        <span data-tip="lp" className={cn("zf-num", chip, LP_TONE[view.lpTone])}>
          {view.lp}
        </span>
      )}
    </>
  );
}

/**
 * Metric labels ("MC", "V", "TX", "F", "NB") as generated content with the 1 px dotted text-3
 * underline of a metric label (DESIGN.md 4.14); the definition opens from the tooltip layer.
 */
export const LABEL =
  "before:mr-1 before:text-micro before:font-medium before:text-fg-3 before:underline before:decoration-fg-3 before:decoration-dotted before:decoration-1 before:underline-offset-2";

/** Right-aligned metrics (72 px): MC 12/600, V 12/400 text-2, TX 11/500 with a 24 × 2 px buy/sell bar. */
export function MetricsCell({ view, stale }: { view: CardView; stale: boolean }) {
  const bar = { "--zfp-buy": `${Math.max(0, view.buyPct)}%` } as CSSProperties;
  return (
    <Cell className="flex min-w-0 flex-col items-end in-data-[density=comfortable]:gap-0.5">
      <span
        data-tip="mc"
        className={cn(
          "zf-num num-dense flex h-[18px] w-full items-center justify-end text-data font-semibold whitespace-nowrap in-data-[density=comfortable]:h-5",
          LABEL,
          "before:content-['MC']",
          view.mc === DASH ? "text-fg-4" : stale ? "text-fg-3" : "text-fg-1",
        )}
      >
        {view.sol && view.mc !== DASH && <SolGlyph className="mr-px" />}
        {view.mc}
      </span>
      <span
        data-tip="v"
        className={cn(
          "zf-num num-dense flex h-4 w-full items-center justify-end text-data whitespace-nowrap in-data-[density=comfortable]:h-[18px]",
          LABEL,
          "before:content-['V']",
          view.v === DASH ? "text-fg-4" : stale ? "text-fg-3" : "text-fg-2",
        )}
      >
        {view.sol && view.v !== DASH && <SolGlyph className="mr-px" />}
        {view.v}
      </span>
      <div data-tip="tx" className="flex h-[18px] w-full items-center justify-end gap-1 in-data-[density=comfortable]:h-5">
        <span className={cn("zf-num num-dense text-label font-medium", LABEL, "before:content-['TX']", stale ? "text-fg-3" : "text-fg-2")}>
          {view.tx}
        </span>
        <span
          aria-hidden="true"
          style={bar}
          className={cn(
            "flex h-0.5 w-6 gap-px before:h-full before:w-(--zfp-buy) before:content-[''] after:h-full after:flex-1 after:content-['']",
            view.buyPct < 0 ? "before:bg-surface-3 after:bg-surface-3" : "before:bg-buy after:bg-sell",
          )}
        />
      </div>
    </Cell>
  );
}

/**
 * Wide+ second metrics column: fees paid in SOL and net buy (signed, in the global quote). As
 * tall as the first metrics column, so F and NB line up with MC and V. A value the feed doesn't
 * report is left out, label and all: the column keeps its width, so nothing else moves, and a
 * live feed without fee data shows an empty column rather than a stack of "F –" / "NB –".
 */
const NB_TONE: Record<CardView["nbTone"], string> = { buy: "text-buy", sell: "text-sell", zero: "text-fg-3", unknown: "text-fg-4" };

export function FeesCell({ view, stale }: { view: CardView; stale: boolean }) {
  return (
    <Cell className="flex h-[52px] min-w-0 flex-col items-end in-data-[density=comfortable]:h-[62px] in-data-[density=comfortable]:gap-0.5">
      <span
        data-tip={view.fees === DASH ? undefined : "fees"}
        className={cn(
          "zf-num num-dense flex h-[18px] w-full items-center justify-end text-data whitespace-nowrap in-data-[density=comfortable]:h-5",
          view.fees !== DASH && cn(LABEL, "before:content-['F']"),
          stale ? "text-fg-3" : "text-fg-2",
        )}
      >
        {view.fees === DASH ? null : view.fees}
      </span>
      <span
        data-tip={view.nbTone === "unknown" ? undefined : "nb"}
        className={cn(
          "zf-num num-dense flex h-4 w-full items-center justify-end text-data in-data-[density=comfortable]:h-[18px]",
          view.nbTone !== "unknown" && cn(LABEL, "before:content-['NB']"),
          stale ? "text-fg-3" : NB_TONE[view.nbTone],
        )}
      >
        {view.nbTone === "unknown" ? null : view.nb}
      </span>
    </Cell>
  );
}
