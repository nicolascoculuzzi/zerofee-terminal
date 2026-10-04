import { memo, type ReactNode } from "react";
import { MetricTip } from "../../components/ui/bits";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtRiskPct } from "../../lib/format";
import { bandsText, RISK_LETTER, type RiskKey, type RiskThresholds, riskTone, TONE_CHIP, TONE_TEXT, type Tone } from "../../lib/metrics";
import type { TokenRisk } from "../../protocol";
import { useSettings } from "../../state/settings";

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
 * Five holder-risk chips T D S I B (DESIGN.md 4.5, bands per 3.11): 16px tall, min-width 40px,
 * letter in text-3, value in the band colour. Low is unfilled, mid warn-tint, high sell-tint with
 * a sell-edge border. "DS" when the dev sold everything; "–" before the metric is computed.
 * Letters replace Axiom's icon metaphors; severity tints after Railway:
 * https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531
 *
 * `letters`: "auto" hides them in containers under 424px (the column shows a legend row
 * instead), "never" always hides them. `tips="delegate"` renders one node per chip, with the
 * letter as a pseudo-element and `data-tip="risk:<key>"` for the page's tooltip layer (Pulse
 * cards, DESIGN.md 8: at most 45 nodes per card); "own" wraps each chip in a Tooltip.
 */
export const RiskChips = memo(function RiskChips({
  risk,
  colored = true,
  letters = "always",
  tips = "own",
  className,
  children,
}: {
  risk: TokenRisk | null;
  colored?: boolean;
  letters?: "always" | "auto" | "never";
  tips?: "own" | "delegate";
  className?: string;
  /** Rendered after the chips in the same row (flags such as DEX, T22, LP). */
  children?: ReactNode;
}) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      {RISK_CHIPS.map(({ key }) => {
        const chip = riskChip(key, risk, thresholds);
        const tone = colored ? TONE_CHIP[chip.tone] : "border-transparent bg-surface-3 text-fg-2";
        const width = letters === "always" ? "min-w-10" : letters === "never" ? "min-w-[30px]" : "min-w-[30px] @min-[424px]:min-w-10";
        if (tips === "delegate") {
          return (
            <span
              key={key}
              role="img"
              aria-label={chip.aria}
              data-tip={`risk:${key}`}
              data-l={RISK_LETTER[key]}
              className={cn(
                "zf-num inline-flex h-4 shrink-0 items-center justify-between gap-0.5 rounded-xs border px-[3px] text-label font-medium",
                "before:text-micro before:font-medium before:text-fg-3 before:content-[attr(data-l)]",
                letters === "never" && "before:hidden",
                letters === "auto" && "before:hidden @min-[424px]:before:inline",
                width,
                tone,
              )}
            >
              {chip.text}
            </span>
          );
        }
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

/** Legend row for narrow cards (DESIGN.md 4.3): "T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers". */
export function RiskLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-5 shrink-0 items-center gap-1 truncate px-2 text-micro font-medium text-fg-3", className)}>
      T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers
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
