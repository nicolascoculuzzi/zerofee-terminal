import { Boxes, ChefHat, Crosshair, Crown, Ghost, type LucideIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtPct } from "../../lib/format";
import { METRICS, type MetricKey, riskTone, TONE_CHIP } from "../../lib/metrics";
import type { TokenRisk } from "../../protocol";

const CHIPS: { key: "top10" | "dev" | "snipers" | "insiders" | "bundlers"; icon: LucideIcon; field: keyof TokenRisk }[] = [
  { key: "top10", icon: Crown, field: "top10Pct" },
  { key: "dev", icon: ChefHat, field: "devPct" },
  { key: "snipers", icon: Crosshair, field: "snipersPct" },
  { key: "insiders", icon: Ghost, field: "insidersPct" },
  { key: "bundlers", icon: Boxes, field: "bundlersPct" },
];

function chipValue(v: number): string {
  if (v > 0 && v < 1) return v.toFixed(1);
  return String(Math.round(v));
}

/**
 * Five holder-risk chips (Top 10, Dev, Snipers, Insiders, Bundlers). Colour = risk level only
 * (low / medium / high from lib/metrics thresholds); every chip carries its published definition.
 * Chip row anatomy after Binance Meme Rank cards: https://mobbin.com/screens/5fb08bd4-fd7c-4a78-8ca9-77bf63a3a1a8
 */
export const RiskChips = memo(function RiskChips({ risk, colored = true }: { risk: TokenRisk; colored?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {CHIPS.map(({ key, icon: Icon, field }) => {
        const value = risk[field] as number;
        const devSold = key === "dev" && risk.devSold;
        const tone = devSold ? "neutral" : riskTone(key, value);
        const def = METRICS[key as MetricKey];
        return (
          <Tooltip
            key={key}
            content={
              <span>
                <span className="font-semibold">
                  {def.label}: {devSold ? "dev sold everything" : fmtPct(value)}
                </span>
                <span className="mt-1 block text-muted">{def.definition}</span>
              </span>
            }
          >
            <span
              className={cn(
                "inline-flex h-4 items-center gap-px rounded-sm border px-1 text-2xs font-medium",
                colored ? TONE_CHIP[tone] : "border-line bg-elev text-muted",
              )}
            >
              <Icon className="icon-xs hidden @sm:block" strokeWidth={2.25} />
              {devSold ? "DS" : `${chipValue(value)}%`}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
});
