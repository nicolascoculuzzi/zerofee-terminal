import { Segmented } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { fmtCompact, fmtPct, fmtPriceText, fmtSol } from "../../lib/format";
import type { TokenSummary } from "../../protocol";
import type { QuoteCurrency } from "../../state/settings";
import type { TriggerMetric } from "../token/tokenUi";
import { FormattedInput } from "./FormattedInput";
import { Slider } from "./Slider";
import { distancePct, nudgePrice } from "./tradeMath";

/*
 * Limit fields (DESIGN.md 4.11 item 4): "Trigger" with an xs MC | Price switch, a 32 px input
 * ("9.80K" with "MC" in text-3), a −100% … +100% slider with ticks at −50, −25, 0, +25, +50, the
 * distance helper and the expiry note. The chart's dashed draft line is the same value (two-way).
 * "Current market price" helper under the limit input after Gemini:
 * https://mobbin.com/screens/f58f1725-5477-40de-9271-bfac6f2fadfe
 */

/** Trigger value in the panel's unit: MC or price, in the global quote. */
export function triggerValue(priceSol: number, metric: TriggerMetric, quote: QuoteCurrency, supply: number, solUsd: number): number {
  const fx = quote === "USD" ? solUsd : 1;
  return metric === "mc" ? priceSol * supply * fx : priceSol * fx;
}

export function priceFromTrigger(value: number, metric: TriggerMetric, quote: QuoteCurrency, supply: number, solUsd: number): number {
  const fx = quote === "USD" ? solUsd : 1;
  return metric === "mc" ? value / (supply * fx) : value / fx;
}

/** "9.80K" (MC, USD), "81.2" (MC, SOL), "0.000004123" (price, full decimal). */
export function fmtTrigger(value: number, metric: TriggerMetric, quote: QuoteCurrency): string {
  if (metric === "price") return fmtPriceText(value);
  return quote === "USD" ? fmtCompact(value) : fmtSol(value);
}

export function LimitFields({
  token,
  priceSol,
  onPriceSol,
  metric,
  onMetric,
  quote,
  solUsd,
  onEnter,
}: {
  token: TokenSummary;
  priceSol: number;
  onPriceSol: (p: number) => void;
  metric: TriggerMetric;
  onMetric: (m: TriggerMetric) => void;
  quote: QuoteCurrency;
  solUsd: number;
  onEnter?: () => void;
}) {
  const current = token.priceSol;
  const dist = distancePct(priceSol, current);
  const value = triggerValue(priceSol, metric, quote, token.supply, solUsd);
  const currentValue = triggerValue(current, metric, quote, token.supply, solUsd);
  const usd = quote === "USD";
  return (
    <div className="space-y-2">
      <div className="flex h-5 items-center justify-between">
        <span className="zf-label">Trigger</span>
        <Segmented<TriggerMetric>
          size="xs"
          value={metric}
          onChange={onMetric}
          options={[
            { value: "mc", label: "MC" },
            { value: "price", label: "Price" },
          ]}
          label="Trigger on market cap or price"
        />
      </div>
      <FormattedInput
        size="amount"
        value={value}
        format={(v) => fmtTrigger(v, metric, quote)}
        onChange={(v) => onPriceSol(priceFromTrigger(v, metric, quote, token.supply, solUsd))}
        onStep={(pct) => onPriceSol(nudgePrice(priceSol, current, pct))}
        onEnter={onEnter}
        prefix={usd ? "$" : undefined}
        suffix={metric === "mc" ? (usd ? "MC" : "SOL MC") : usd ? undefined : "SOL"}
        ariaLabel={metric === "mc" ? "Trigger market cap" : "Trigger price"}
      />
      <Slider
        value={Math.max(-100, Math.min(100, dist))}
        onChange={(pct) => onPriceSol(current * Math.max(0.001, 1 + pct / 100))}
        min={-100}
        max={100}
        step={0.5}
        origin={0}
        ticks={[-50, -25, 0, 25, 50]}
        label="Distance from the current value"
        valueText={`${fmtPct(dist, { signed: true })} vs now`}
      />
      <p className="text-label text-fg-3">
        <span className="zf-num">{fmtPct(dist, { signed: true })}</span> vs current {metric === "mc" ? "MC" : "price"}{" "}
        {metric === "mc" ? (
          <span className="zf-num">{usd ? `$${fmtCompact(currentValue)}` : `${fmtSol(currentValue)} SOL`}</span>
        ) : (
          <Num kind="price" usd={usd} value={currentValue} unit={usd ? undefined : "SOL"} />
        )}
      </p>
      <p className="text-label text-fg-3">Expires: never (durable nonce)</p>
    </div>
  );
}
