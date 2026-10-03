import type { ReactNode } from "react";
import { MetricLabel } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { fmtCount, fmtPct, fmtSol, shortAddr } from "../../lib/format";
import { type MetricKey, riskTone, TONE_TEXT, token2022Danger } from "../../lib/metrics";
import type { TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";

function Tile({ metric, label, value, tone }: { metric: MetricKey; label?: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-1 border-hairline px-1 py-2 text-center">
      <span className={cn("text-data font-semibold", tone ?? "text-fg-1")}>{value}</span>
      <span className="zf-label">
        <MetricLabel metric={metric}>{label}</MetricLabel>
      </span>
    </div>
  );
}

function AddressRow({ label, address }: { label: string; address: string | null }) {
  return (
    <div className="flex h-7 items-center justify-between gap-2 px-3 text-label">
      <span className="text-fg-3">{label}</span>
      {address ? (
        <span className="flex items-center gap-1 font-mono text-fg-2">
          {shortAddr(address, 6, 6)}
          <CopyButton text={address} label={`Copy ${label.toLowerCase()}`} />
        </span>
      ) : (
        <span className="text-fg-3">Unknown</span>
      )}
    </div>
  );
}

/**
 * Token info grid: every metric from SPEC "Token metric definitions", each with its published
 * definition on hover. Tile grid after Kraken Pro's account summary tiles
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 */
export function TokenInfo({ detail }: { detail: TokenDetail }) {
  const colors = useSettings((s) => s.display.metricColors);
  const t = detail.summary;
  const r = t.risk;
  const tone = (key: "top10" | "dev" | "snipers" | "insiders" | "bundlers", v: number) =>
    colors ? TONE_TEXT[riskTone(key, v)] : undefined;
  const danger = token2022Danger(t.token2022);
  return (
    <section className="border-t border-hairline">
      <div className="flex h-8 items-center px-3 text-data font-semibold">Token info</div>
      <div className="grid grid-cols-3 divide-x divide-y divide-hairline border-y border-hairline">
        <Tile metric="top10" value={fmtPct(r.top10Pct)} tone={tone("top10", r.top10Pct)} />
        <Tile metric="dev" value={r.devSold ? "Sold" : fmtPct(r.devPct)} tone={r.devSold ? "text-fg-2" : tone("dev", r.devPct)} />
        <Tile metric="snipers" value={fmtPct(r.snipersPct)} tone={tone("snipers", r.snipersPct)} />
        <Tile metric="insiders" value={fmtPct(r.insidersPct)} tone={tone("insiders", r.insidersPct)} />
        <Tile metric="bundlers" value={fmtPct(r.bundlersPct)} tone={tone("bundlers", r.bundlersPct)} />
        <Tile
          metric="lpBurned"
          value={t.lpBurnedPct === null ? "On curve" : fmtPct(t.lpBurnedPct)}
          tone={t.lpBurnedPct === 100 ? "text-buy" : undefined}
        />
        <Tile metric="holders" value={fmtCount(t.holders)} />
        <Tile metric="proTraders" value={fmtCount(t.proTraders)} />
        <Tile metric="dexPaid" value={t.dexPaid ? "Paid" : "Unpaid"} tone={t.dexPaid ? "text-fg-1" : "text-fg-2"} />
        <Tile
          metric="token2022"
          value={t.token2022 === null ? "SPL" : danger.length > 0 ? `${danger.length} flag${danger.length > 1 ? "s" : ""}` : "Clean"}
          tone={danger.length > 0 ? "text-sell" : undefined}
        />
        <Tile metric="fees" value={`${fmtSol(t.feesPaidSol)} SOL`} />
        <Tile metric="devLaunches" label="Dev launches" value={`${detail.devLaunches} · ${detail.devMigrations} mig.`} />
      </div>
      {danger.length > 0 && (
        <div className="border-b border-hairline px-3 py-2 text-label text-sell">Token-2022 extensions: {danger.join(", ")}</div>
      )}
      <AddressRow label="Contract" address={t.mint} />
      <AddressRow label="Creator" address={t.creator} />
      <AddressRow label="Funding wallet" address={t.fundingWallet} />
      {detail.pool && <AddressRow label="Pool" address={detail.pool.poolAddress} />}
    </section>
  );
}
