import { useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { MetricLabel } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { fmtAge, fmtCount, fmtRiskPct, shortAddr } from "../../lib/format";
import { bandsText, METRICS, type MetricKey, type RiskKey, riskTone, TONE_TEXT, token2022Danger } from "../../lib/metrics";
import type { TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useTrackers } from "../../state/trackers";

/*
 * Token info (DESIGN.md 4.11 item 10): a 32 px header with a Methodology link, a 3-column grid of
 * 40 px cells (dotted metric label over a 13/600 value in its band colour), Token-2022 flags in
 * sell-tint chips, and the dev row with copy and Track dev. Dotted-underline labels that carry
 * definitions after OKX https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae
 */

function InfoCell({
  metric,
  label,
  value,
  tone,
  bands,
}: {
  metric: MetricKey;
  label?: string;
  value: string;
  tone: string;
  bands?: string;
}) {
  return (
    <div className="flex h-10 min-w-0 flex-col justify-center gap-0.5 px-2">
      <span className="truncate text-label text-fg-3">
        <MetricLabel metric={metric} bands={bands} value={<span className={tone}>{value}</span>}>
          {label}
        </MetricLabel>
      </span>
      <span className={cn("zf-num truncate text-body font-semibold", tone)}>{value}</span>
    </div>
  );
}

const ORDER: MetricKey[] = [
  "top10",
  "dev",
  "snipers",
  "insiders",
  "bundlers",
  "lpBurned",
  "holders",
  "proTraders",
  "dexPaid",
  "token2022",
  "marketCap",
  "progress",
];

function Methodology() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-label text-fg-3 transition-colors hover:text-fg-1"
      >
        Methodology
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={320} padding="form">
        <div className="max-h-96 space-y-2 overflow-y-auto">
          <div className="text-data font-semibold text-fg-1">How these metrics are computed</div>
          {ORDER.map((k) => (
            <div key={k}>
              <div className="text-label font-medium text-fg-1">{METRICS[k].label}</div>
              <div className="text-label text-fg-3">{METRICS[k].definition}</div>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

export function TokenInfo({ detail, header = true }: { detail: TokenDetail; header?: boolean }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const colors = useSettings((s) => s.display.metricColors);
  const devTracked = useTrackers((s) => s.wallets.some((w) => w.address === detail.summary.creator));
  const addWallet = useTrackers((s) => s.addWallet);
  const removeWallet = useTrackers((s) => s.removeWallet);
  const t = detail.summary;
  const r = t.risk;
  const danger = token2022Danger(t.token2022);
  const band = (key: RiskKey, v: number | null) => (colors ? TONE_TEXT[riskTone(key, v, thresholds)] : "text-fg-1");
  const lpTone =
    t.lpBurnedPct === null ? "text-fg-2" : t.lpBurnedPct >= 100 ? "text-fg-1" : t.lpBurnedPct <= 0 ? "text-risk-high" : "text-risk-mid";

  return (
    <section aria-label="Token info" className="border-t border-hairline">
      {header && (
        <div className="flex h-8 items-center justify-between px-3">
          <span className="text-data font-semibold text-fg-1">Token info</span>
          <Methodology />
        </div>
      )}
      <div className="grid grid-cols-3 divide-x divide-hairline border-y border-hairline">
        <InfoCell
          metric="top10"
          label="Top 10"
          value={fmtRiskPct(r.top10Pct)}
          tone={band("top10", r.top10Pct)}
          bands={bandsText("top10", thresholds)}
        />
        <InfoCell
          metric="dev"
          label="Dev"
          value={r.devSold ? "DS" : fmtRiskPct(r.devPct)}
          tone={r.devSold ? "text-fg-2" : band("dev", r.devPct)}
          bands={bandsText("dev", thresholds)}
        />
        <InfoCell
          metric="snipers"
          label="Snipers"
          value={fmtRiskPct(r.snipersPct)}
          tone={band("snipers", r.snipersPct)}
          bands={bandsText("snipers", thresholds)}
        />
      </div>
      <div className="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
        <InfoCell
          metric="insiders"
          label="Insiders"
          value={fmtRiskPct(r.insidersPct)}
          tone={band("insiders", r.insidersPct)}
          bands={bandsText("insiders", thresholds)}
        />
        <InfoCell
          metric="bundlers"
          label="Bundlers"
          value={fmtRiskPct(r.bundlersPct)}
          tone={band("bundlers", r.bundlersPct)}
          bands={bandsText("bundlers", thresholds)}
        />
        <InfoCell
          metric="lpBurned"
          label="LP burned"
          value={t.lpBurnedPct === null ? "On curve" : fmtRiskPct(t.lpBurnedPct)}
          tone={lpTone}
          bands="Neutral at 100% · Amber below 100% · Red at 0%"
        />
      </div>
      <div className="grid grid-cols-3 divide-x divide-hairline border-b border-hairline">
        <InfoCell metric="holders" value={fmtCount(t.holders)} tone="text-fg-1" />
        <InfoCell metric="proTraders" label="Pro traders" value={fmtCount(t.proTraders)} tone="text-fg-1" />
        <InfoCell
          metric="dexPaid"
          label="Dex paid"
          value={t.dexPaid ? (t.dexPaidAt !== null ? `Paid ${fmtAge(t.dexPaidAt)} ago` : "Paid") : "Unpaid"}
          tone={t.dexPaid ? "text-fg-1" : "text-fg-2"}
        />
      </div>
      {danger.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-hairline px-3 py-2">
          <span className="mr-1 text-label text-fg-3">
            <MetricLabel metric="token2022" />
          </span>
          {danger.map((f) => (
            <span
              key={f}
              className="inline-flex h-4 items-center rounded-xs border border-sell-edge bg-sell-tint px-1 font-mono text-micro font-medium text-sell"
            >
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="flex h-8 items-center gap-1 px-3 text-label text-fg-3">
        <MetricLabel metric="devLaunches">Dev</MetricLabel>
        <span className="font-mono text-fg-2" title={t.creator}>
          {shortAddr(t.creator)}
        </span>
        <CopyButton text={t.creator} label="Copy dev address" />
        <span className="truncate">
          · <span className="zf-num text-fg-2">{fmtCount(detail.devLaunches)}</span> launches ·{" "}
          <span className="zf-num text-fg-2">{fmtCount(detail.devMigrations)}</span> migrated
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={() =>
            devTracked
              ? removeWallet(t.creator)
              : addWallet({ address: t.creator, name: `Dev ${t.symbol}`.slice(0, 16), emoji: "", alerts: true })
          }
        >
          {devTracked ? "Untrack dev" : "Track dev"}
        </Button>
      </div>
      {t.fundingWallet && (
        <div className="flex h-6 items-center gap-1 px-3 pb-2 text-label text-fg-3">
          Funded by <span className="font-mono text-fg-2">{shortAddr(t.fundingWallet)}</span>
          <CopyButton text={t.fundingWallet} label="Copy funding wallet" />
        </div>
      )}
    </section>
  );
}
