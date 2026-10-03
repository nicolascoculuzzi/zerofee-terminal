import { memo } from "react";
import { MetricTip } from "../../components/ui/bits";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtRiskPct } from "../../lib/format";
import { bandsText, RISK_LETTER, type RiskKey, riskTone, TONE_CHIP, TONE_TEXT } from "../../lib/metrics";
import type { TokenRisk } from "../../protocol";
import { useSettings } from "../../state/settings";

const CHIPS: { key: RiskKey; field: keyof TokenRisk; spoken: string }[] = [
  { key: "top10", field: "top10Pct", spoken: "Top 10 holders" },
  { key: "dev", field: "devPct", spoken: "Dev holdings" },
  { key: "snipers", field: "snipersPct", spoken: "Snipers" },
  { key: "insiders", field: "insidersPct", spoken: "Insiders" },
  { key: "bundlers", field: "bundlersPct", spoken: "Bundlers" },
];

const BAND_WORD = { good: "low", warn: "medium", bad: "high", neutral: "", unknown: "not computed yet" } as const;

/**
 * Five holder-risk chips T D S I B (DESIGN.md 4.5, bands per 3.11): 16px tall, min-width 40px,
 * letter in text-3, value in the band colour. Low is unfilled, mid warn-tint, high sell-tint with
 * a sell-edge border. "DS" when the dev sold everything; "–" before the metric is computed.
 * Letters replace Axiom's icon metaphors; severity tints after Railway:
 * https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531
 *
 * `letters="auto"` hides the letters in narrow Pulse columns (container under 424px), where the
 * column shows a legend row instead.
 */
export const RiskChips = memo(function RiskChips({
  risk,
  colored = true,
  letters = "always",
  className,
}: {
  risk: TokenRisk | null;
  colored?: boolean;
  letters?: "always" | "auto";
  className?: string;
}) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      {CHIPS.map(({ key, field, spoken }) => {
        const raw = risk ? (risk[field] as number) : null;
        const devSold = key === "dev" && !!risk?.devSold;
        const tone = devSold ? "neutral" : riskTone(key, raw, thresholds);
        const text = devSold ? "DS" : raw === null ? "–" : fmtRiskPct(raw);
        const aria = devSold
          ? `${spoken}: dev sold 100%`
          : raw === null
            ? `${spoken}: not computed yet`
            : `${spoken} ${text.replace("%", " percent")}, ${BAND_WORD[tone]} risk`;
        return (
          <Tooltip
            key={key}
            content={
              raw === null && !devSold ? (
                "Computing (needs 3 slots)"
              ) : (
                <MetricTip
                  metric={key}
                  value={<span className={devSold ? "text-fg-2" : TONE_TEXT[tone]}>{devSold ? "Dev sold 100%" : text}</span>}
                  bands={bandsText(key, thresholds)}
                />
              )
            }
          >
            <span
              role="img"
              aria-label={aria}
              className={cn(
                "inline-flex h-4 items-center justify-between gap-0.5 rounded-xs border px-[3px]",
                letters === "auto" ? "min-w-[30px] @min-[424px]:min-w-10" : "min-w-10",
                colored ? TONE_CHIP[tone] : "border-transparent bg-surface-3 text-fg-2",
              )}
            >
              <span className={cn("text-micro font-medium text-fg-3", letters === "auto" && "hidden @min-[424px]:inline")}>
                {RISK_LETTER[key]}
              </span>
              <span className="zf-num ml-auto text-label font-medium">{text}</span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
});

/** Legend row for narrow cards (DESIGN.md 4.3): "T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers". */
export function RiskLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex h-5 items-center gap-1 px-2 text-micro text-fg-3", className)}>
      T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers
    </div>
  );
}
