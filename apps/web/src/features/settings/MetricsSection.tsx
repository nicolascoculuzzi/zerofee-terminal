import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { bandsText, METRICS, type MetricKey, RISK_DEFAULTS, RISK_LETTER, type RiskKey } from "../../lib/metrics";
import { useSettings } from "../../state/settings";
import type { SectionId } from "./sections";
import { SectionHeader, SubHeader, Tag } from "./ui";

const RISK_KEYS: RiskKey[] = ["top10", "dev", "snipers", "insiders", "bundlers"];
const RISK_NOTES: Partial<Record<RiskKey, string>> = {
  dev: '"DS" in grey means the dev sold their whole position.',
  insiders: "Stricter bands, because insiders are funded by the creator.",
};
const FLAGS: MetricKey[] = ["token2022", "dexPaid", "lpBurned"];
const MARKET: MetricKey[] = [
  "marketCap",
  "price",
  "liquidity",
  "volume",
  "txns",
  "fees",
  "holders",
  "proTraders",
  "progress",
  "supply",
  "age",
  "change5m",
  "devLaunches",
];

function Definition({ term, children }: { term: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-11 gap-x-4 gap-y-1 py-2 sm:grid-cols-[160px_minmax(0,1fr)]">
      <dt className="text-data font-medium text-fg-1">{term}</dt>
      <dd className="max-w-[72ch] text-label text-fg-2">{children}</dd>
    </div>
  );
}

function Letter({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 min-w-4 items-center justify-center rounded-xs bg-surface-3 px-1 text-micro font-medium text-fg-3"
    >
      {children}
    </span>
  );
}

/*
 * Metrics (DESIGN.md 5.5): the published definitions (SPEC "Token metric definitions") and the
 * bands in use, so every chip in the app can be checked against its method. Dotted-label
 * definitions after OKX and Coinbase Advanced:
 * https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae
 * https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544
 */
export function MetricsSection({ onNavigate }: { onNavigate: (section: SectionId, anchor?: string) => void }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);

  return (
    <>
      <SectionHeader
        title="Metrics"
        description="How every number and chip is computed. Hover a dotted label anywhere in the app for the same definition and the bands in use."
      />

      <SubHeader
        actions={
          <Button size="xs" variant="ghost" icon={<SlidersHorizontal />} onClick={() => onNavigate("display", "risk")}>
            Edit thresholds
          </Button>
        }
      >
        Risk chips
      </SubHeader>
      <dl className="divide-y divide-hairline border-y border-hairline">
        {RISK_KEYS.map((k) => {
          const custom = thresholds[k][0] !== RISK_DEFAULTS[k][0] || thresholds[k][1] !== RISK_DEFAULTS[k][1];
          return (
            <Definition
              key={k}
              term={
                <span className="inline-flex items-center gap-2">
                  <Letter>{RISK_LETTER[k]}</Letter>
                  {METRICS[k].label}
                </span>
              }
            >
              <span className="block">{METRICS[k].definition}</span>
              {RISK_NOTES[k] && <span className="block">{RISK_NOTES[k]}</span>}
              <span className="mt-1 flex flex-wrap items-center gap-2 text-fg-3">
                {bandsText(k, thresholds)}
                {custom && <Tag>Custom</Tag>}
              </span>
              {custom && <span className="block text-fg-3">Default: {bandsText(k, RISK_DEFAULTS)}</span>}
            </Definition>
          );
        })}
        <Definition term="Not computed yet">
          The first slots after creation show "–" with "Computing (needs 3 slots)" in the tooltip.
        </Definition>
      </dl>

      <SubHeader>Flags</SubHeader>
      <dl className="divide-y divide-hairline border-y border-hairline">
        {FLAGS.map((k) => (
          <Definition
            key={k}
            term={
              <span className="inline-flex items-center gap-2">
                <Letter>{METRICS[k].short}</Letter>
                {METRICS[k].label}
              </span>
            }
          >
            {METRICS[k].definition}
          </Definition>
        ))}
      </dl>

      <SubHeader>Market and activity</SubHeader>
      <dl className="divide-y divide-hairline border-y border-hairline">
        {MARKET.map((k) => (
          <Definition key={k} term={METRICS[k].label}>
            {METRICS[k].definition}
          </Definition>
        ))}
      </dl>
    </>
  );
}
