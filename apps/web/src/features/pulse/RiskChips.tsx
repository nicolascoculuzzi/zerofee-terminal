import { memo, type ReactNode } from "react";
import { MetricTip } from "../../components/ui/bits";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtRiskPct } from "../../lib/format";
import { bandsText, RISK_LETTER, type RiskKey, type RiskThresholds, riskTone, TONE_CHIP, TONE_TEXT, type Tone } from "../../lib/metrics";
import type { TokenRisk } from "../../protocol";
import { useSettings } from "../../state/settings";
import { ICON, MASK, RISK_ICON } from "./icons";

export const RISK_CHIPS: { key: RiskKey; field: keyof TokenRisk; spoken: string }[] = [
  { key: "top10", field: "top10Pct", spoken: "Top 10 holders" },
  { key: "dev", field: "devPct", spoken: "Dev holdings" },
  { key: "snipers", field: "snipersPct", spoken: "Snipers" },
  { key: "insiders", field: "insidersPct", spoken: "Insiders" },
  { key: "bundlers", field: "bundlersPct", spoken: "Bundlers" },
];

const BAND_WORD = { good: "low", warn: "medium", bad: "high", neutral: "", unknown: "not computed yet" } as const;

export interface RiskChipModel {
  key: RiskKey;
  text: string;
  tone: Tone;
  devSold: boolean;
  unknown: boolean;
  aria: string;
}

/** Display model of one chip: the rounded text, its band (on the displayed value) and the spoken label. */
export function riskChip(key: RiskKey, risk: TokenRisk | null, thresholds: RiskThresholds): RiskChipModel {
  const def = RISK_CHIPS.find((c) => c.key === key) ?? RISK_CHIPS[0];
  const raw = risk && def ? (risk[def.field] as number) : null;
  const devSold = key === "dev" && !!risk?.devSold;
  const tone: Tone = devSold ? "neutral" : riskTone(key, raw, thresholds);
  const text = devSold ? "DS" : raw === null ? "–" : fmtRiskPct(raw);
  const spoken = def?.spoken ?? key;
  const aria = devSold
    ? `${spoken}: dev sold 100%`
    : raw === null
      ? `${spoken}: not computed yet`
      : `${spoken} ${text.replace("%", " percent")}, ${BAND_WORD[tone]} risk`;
  return { key, text, tone, devSold, unknown: raw === null && !devSold, aria };
}

/** Tooltip content for a chip (DESIGN.md 4.14): label and value, definition, active bands. */
export function RiskTip({ chip, thresholds, updated }: { chip: RiskChipModel; thresholds: RiskThresholds; updated?: string }) {
  if (chip.unknown) return <>Computing (needs 3 slots)</>;
  return (
    <MetricTip
      metric={chip.key}
      value={<span className={chip.devSold ? "text-fg-2" : TONE_TEXT[chip.tone]}>{chip.devSold ? "Dev sold 100%" : chip.text}</span>}
      bands={bandsText(chip.key, thresholds)}
      updated={updated}
    />
  );
}

/**
 * Pulse slot tones (DESIGN.md 4.5): the band lives in the value's colour alone, like Axiom's and
 * Binance Meme Rush's icon rows. High adds a faint tint behind the slot (no border), as on
 * Binance Meme Rank: https://mobbin.com/screens/55442959-3968-4340-9c27-3efe6dfffeb5
 */
const SLOT_TONE: Record<Tone, string> = {
  good: "text-risk-low",
  warn: "text-risk-mid",
  bad: "bg-[color-mix(in_srgb,var(--zf-risk-high)_8%,transparent)] text-risk-high",
  neutral: "text-fg-2",
  unknown: "text-fg-4",
};

/**
 * The five holder-risk metrics (DESIGN.md 4.5, bands per 3.11): top 10, dev, snipers, insiders,
 * bundlers, always in that order.
 *
 * `tips="delegate"` is the Pulse slot (cards and phone rows): one node per metric, the lucide
 * glyph (icons.tsx RISK_ICON) as a 12 px ::before mask in text-3, then the value; the band
 * colours the value only, and 0% reads dim in text-3, never as an alert. Each slot has a fixed
 * minimum width so slots line up from card to card; a metric the server hasn't computed keeps
 * its slot but draws nothing. `data-tip="risk:<key>"` opens the full name, value and bands from
 * the page's tooltip layer (DESIGN.md 8: at most 45 nodes per card).
 *
 * `tips="own"` (token page, trackers) keeps the lettered chip T D S I B, wrapped in a Tooltip.
 *
 * `letters`: whether the identifier (icon on Pulse, letter elsewhere) shows: "always", "never"
 * (narrow columns, where the legend row names them), or "auto" (hidden in containers under 424 px;
 * on Pulse, in a strip under 22.4em). "always" on Pulse also drops the icons in a strip under
 * 20.5em (226 px at the 11 px label size).
 */
export const RiskChips = memo(function RiskChips({
  risk,
  colored = true,
  letters = "always",
  tips = "own",
  pending = "dash",
  className,
  children,
}: {
  risk: TokenRisk | null;
  colored?: boolean;
  letters?: "always" | "auto" | "never";
  tips?: "own" | "delegate";
  /**
   * Metrics the server hasn't computed yet: "dash" shows "–" (token page, trackers); "quiet" keeps
   * the slot's width so the row stays aligned but leaves it empty, and drops the row's content
   * altogether while none of the five is known (Pulse cards: no wall of dashes, no stray letters).
   */
  pending?: "dash" | "quiet";
  className?: string;
  /** Rendered after the chips in the same row (flags such as DEX, T22, LP). */
  children?: ReactNode;
}) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const chips = RISK_CHIPS.map(({ key }) => riskChip(key, risk, thresholds));
  const quiet = pending === "quiet";
  const none = quiet && chips.every((c) => c.unknown);
  return (
    <div className={cn("flex min-w-0 items-center gap-1", tips === "delegate" && "text-label @container/risk", className)}>
      {!none &&
        chips.map((chip) => {
          const key = chip.key;
          if (tips === "delegate") {
            // A Pulse slot never shows a dash: an uncomputed metric keeps its width and draws nothing.
            const empty = chip.unknown;
            const tone = chip.text === "0%" ? "text-fg-3" : colored ? SLOT_TONE[chip.tone] : "text-fg-2";
            return (
              <span
                key={key}
                role="img"
                aria-label={chip.aria}
                data-tip={`risk:${key}`}
                className={cn(
                  // Sizes are in em of the label type (11 px compact, 12 px comfortable and touch),
                  // so they follow the numerals. 4.2em (46 px) holds the icon and any value up to
                  // "100%", so slots line up card to card; only "<0.1%" grows. Strips too short
                  // for five of those (wide columns near 424 px, phones) step down and stay
                  // aligned: 3.8em slots from 20.5em, then the value alone in 2.8em slots (the
                  // column shows its legend row there).
                  "zf-num inline-flex h-4 shrink-0 items-center gap-0.5 rounded-xs px-0.5 text-label font-medium",
                  ICON,
                  MASK[key],
                  "before:text-fg-3",
                  letters === "always" &&
                    "min-w-[4.2em] @max-[22.35em]/risk:min-w-[3.8em] @max-[22.35em]/risk:px-0 @max-[20.45em]/risk:min-w-[2.8em] @max-[20.45em]/risk:before:hidden",
                  letters === "never" && "min-w-[2.8em] before:hidden",
                  letters === "auto" && "min-w-[2.8em] before:hidden @min-[22.4em]/risk:min-w-[4.2em] @min-[22.4em]/risk:before:block",
                  empty && "before:hidden",
                  !empty && tone,
                )}
              >
                {empty ? null : chip.text}
              </span>
            );
          }
          const tone = colored ? TONE_CHIP[chip.tone] : "border-transparent bg-surface-3 text-fg-2";
          // 44 px fits every common value ("T 0.4%", "D 14%") so chips line up card to card; only the
          // rare "<0.1%" and "100%" grow (DESIGN.md 4.5). 34 px without the letter.
          const width = letters === "always" ? "min-w-11" : letters === "never" ? "min-w-[34px]" : "min-w-[34px] @min-[424px]:min-w-11";
          return (
            <Tooltip key={key} content={<RiskTip chip={chip} thresholds={thresholds} />}>
              <span
                role="img"
                aria-label={chip.aria}
                className={cn("inline-flex h-4 items-center justify-between gap-0.5 rounded-xs border px-[3px]", width, tone)}
              >
                <span
                  className={cn(
                    "text-micro font-medium text-fg-3",
                    letters === "never" && "hidden",
                    letters === "auto" && "hidden @min-[424px]:inline",
                  )}
                >
                  {RISK_LETTER[key]}
                </span>
                <span className="zf-num ml-auto text-label font-medium">{chip.text}</span>
              </span>
            </Tooltip>
          );
        })}
      {children}
    </div>
  );
});

const LEGEND: Record<RiskKey, string> = { top10: "Top 10", dev: "Dev", snipers: "Snipers", insiders: "Insiders", bundlers: "Bundlers" };

/**
 * Legend row (DESIGN.md 4.3), forced on for narrow cards, whose slots show values only: each
 * metric's glyph and short name in order, micro type in text-3.
 */
export function RiskLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-5 shrink-0 items-center gap-2.5 overflow-hidden px-2 text-micro font-medium text-fg-3", className)}>
      {RISK_CHIPS.map(({ key }) => {
        const Icon = RISK_ICON[key];
        return (
          <span key={key} className="inline-flex shrink-0 items-center gap-1">
            <Icon aria-hidden="true" className="icon-xs" strokeWidth={1.5} absoluteStrokeWidth />
            {LEGEND[key]}
          </span>
        );
      })}
    </div>
  );
}

/** A string that changes exactly when any chip's text or band changes (card memo key). */
export function riskKey(risk: TokenRisk | null, thresholds: RiskThresholds): string {
  let out = "";
  for (const { key } of RISK_CHIPS) {
    const c = riskChip(key, risk, thresholds);
    out += `${c.text}:${c.tone}|`;
  }
  return out;
}
