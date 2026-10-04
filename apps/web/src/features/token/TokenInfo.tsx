import { BadgeCheck, ChefHat, CircleDollarSign, Flame, type LucideIcon, Users } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { MetricLabel, Skeleton } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtAge, fmtCount, fmtRiskPct, shortAddr } from "../../lib/format";
import { bandsText, METRICS, type MetricKey, type RiskKey, riskTone, type Tone, token2022Danger } from "../../lib/metrics";
import type { TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useTrackers } from "../../state/trackers";
import { RISK_ICON } from "../pulse/icons";

/*
 * Token info (DESIGN.md 4.11 item 10) in the Pulse risk-slot language (4.5): a 3 x 3 grid of
 * hairline-tiled 40 px tiles, each the metric's lucide glyph (12 px, text-3) beside its value
 * (13/600, coloured by band), with the dotted-underline metric label under it. Colour sits on the
 * value only; a high band adds a faint 8% tint to the tile, never a border, and 0% reads dim.
 * Grey icon plus value per metric after Binance Meme Rush
 * https://mobbin.com/screens/2aa0b210-3bdf-44dd-b04a-8fa2556db2f5 ; a high value on a faint tint
 * without a border after Binance Meme Rank https://mobbin.com/screens/55442959-3968-4340-9c27-3efe6dfffeb5 ;
 * dotted labels that carry definitions after OKX https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae
 *
 * Unknown values: while the metric may still be computing (the first seconds on the page, or a
 * token younger than FRESH_MS) the tile shows a static skeleton; after that the tile is omitted
 * (Axiom omits null metrics) and one quiet text-4 line names what isn't computed, never a dash.
 */

/** Tokens younger than this are still in their first slots: their metrics may not be computed. */
const FRESH_MS = 20_000;
/** First paint grace before an unknown metric reads as "unknown" rather than "loading". */
const MOUNT_GRACE_MS = 2_500;

/** When this session first showed each token, so remounting the Info tab doesn't restart the grace. */
const firstSeen = new Map<string, number>();

/** Milliseconds until an unknown metric of this token stops reading as "loading" (0 when it already has). */
function settleIn(mint: string, createdAt: number): number {
  const now = Date.now();
  let seen = firstSeen.get(mint);
  if (seen === undefined) {
    seen = now;
    if (firstSeen.size > 200) firstSeen.clear();
    firstSeen.set(mint, seen);
  }
  const born = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : Number.NEGATIVE_INFINITY;
  return Math.max(0, Math.max(seen + MOUNT_GRACE_MS, born + FRESH_MS) - now);
}

/** True while an unknown metric is plausibly still on its way for this token. */
function useSettling(mint: string, createdAt: number): boolean {
  const [settledFor, setSettledFor] = useState<string | null>(() => (settleIn(mint, createdAt) === 0 ? mint : null));
  useEffect(() => {
    const wait = settleIn(mint, createdAt);
    if (wait === 0) {
      setSettledFor(mint);
      return;
    }
    const t = setTimeout(() => setSettledFor(mint), wait);
    return () => clearTimeout(t);
  }, [mint, createdAt]);
  return settledFor !== mint;
}

/** Value colours per band, as on the Pulse slots: the band lives in the value alone. */
const VALUE_TONE: Record<Tone, string> = {
  good: "text-risk-low",
  warn: "text-risk-mid",
  bad: "text-risk-high",
  neutral: "text-fg-2",
  unknown: "text-fg-4",
};
const HIGH_TINT = "bg-[color-mix(in_srgb,var(--zf-risk-high)_8%,transparent)]";

interface TileModel {
  metric: MetricKey;
  label: string;
  icon: LucideIcon;
  /** Null: unknown. */
  value: string | null;
  tone: string;
  high?: boolean;
  bands?: string;
  /** A word rather than a number ("Curve", "Unpaid"): set at 500 so it never outweighs the figures. */
  word?: boolean;
}

/** One metric tile. A null value renders the static skeleton (unknown tiles are only drawn while loading). */
function Tile({ tile }: { tile: TileModel }) {
  const Icon = tile.icon;
  if (tile.value === null) {
    return (
      <div className="flex h-10 min-w-0 flex-col items-center justify-center gap-1.5">
        <span className="flex items-center gap-1">
          <Skeleton shape="square" size={12} className="rounded-xs" />
          <Skeleton width={28} />
        </span>
        <Skeleton width={40} />
      </div>
    );
  }
  return (
    <div className={cn("flex h-10 min-w-0 flex-col items-center justify-center gap-px px-1", tile.high && HIGH_TINT)}>
      <span className={cn("flex h-4.5 max-w-full items-center gap-1", tile.tone)}>
        <Icon aria-hidden="true" className="icon-xs text-fg-3" strokeWidth={1.5} absoluteStrokeWidth />
        <span className={cn("zf-num truncate text-body", tile.word ? "font-medium" : "font-semibold")}>{tile.value}</span>
      </span>
      <span className="max-w-full truncate text-label text-fg-3">
        <MetricLabel metric={tile.metric} bands={tile.bands} value={<span className={tile.tone}>{tile.value}</span>}>
          {tile.label}
        </MetricLabel>
      </span>
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
        className="rounded-xs text-label text-fg-3 transition-colors hover:text-fg-1"
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

/**
 * Facts separated by "·" that wrap between facts, never inside one. Each separator hangs in the gap
 * left of its fact; the row is shifted left by one gap and clipped, so a fact that starts a new line
 * hides its separator.
 */
function FactRow({ facts }: { facts: ReactNode[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="overflow-hidden">
      <div className="-ml-3 flex flex-wrap items-center">
        {facts.map((f, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a short static list of facts
            key={i}
            className="relative inline-flex h-5 items-center gap-1 pl-3 whitespace-nowrap before:absolute before:left-1 before:text-fg-4 before:content-['·']"
          >
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}

export function TokenInfo({
  detail,
  header = true,
  risk: showRisk = true,
}: {
  detail: TokenDetail;
  header?: boolean;
  /** False leaves out the five holder-risk tiles (the phone page shows them in its own risk strip). */
  risk?: boolean;
}) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const colors = useSettings((s) => s.display.metricColors);
  const devTracked = useTrackers((s) => s.wallets.some((w) => w.address === detail.summary.creator));
  const addWallet = useTrackers((s) => s.addWallet);
  const removeWallet = useTrackers((s) => s.removeWallet);
  const t = detail.summary;
  const r = t.risk;
  const loading = useSettling(t.mint, t.createdAt);
  const danger = token2022Danger(t.token2022);

  const risk = (key: RiskKey, label: string, v: number | null): TileModel => {
    const text = v === null || !Number.isFinite(v) ? null : fmtRiskPct(v);
    const band = riskTone(key, v, thresholds);
    // 0% is never an alert (DESIGN.md 4.5); with metric colours off every value is plain.
    const tone = text === "0%" ? "text-fg-3" : colors ? VALUE_TONE[band] : "text-fg-1";
    return {
      metric: key,
      label,
      icon: RISK_ICON[key],
      value: text,
      tone,
      high: colors && band === "bad" && text !== "0%",
      bands: bandsText(key, thresholds),
    };
  };

  const devTile: TileModel = r.devSold
    ? { metric: "dev", label: "Dev", icon: RISK_ICON.dev, value: "DS", tone: "text-fg-2", word: true, bands: bandsText("dev", thresholds) }
    : risk("dev", "Dev", r.devPct);

  const lp = t.lpBurnedPct;
  const lpTile: TileModel = {
    metric: "lpBurned",
    label: "LP burned",
    icon: Flame,
    value: lp !== null ? fmtRiskPct(lp) : t.migratedAt === null ? "Curve" : null,
    tone: lp === null ? "text-fg-2" : lp >= 100 ? "text-fg-1" : lp <= 0 ? "text-risk-high" : "text-risk-mid",
    high: lp !== null && lp <= 0,
    word: lp === null,
    bands: "Neutral at 100% · Amber below 100% · Red at 0%",
  };

  const riskTiles: TileModel[] = showRisk
    ? [
        risk("top10", "Top 10", r.top10Pct),
        devTile,
        risk("snipers", "Snipers", r.snipersPct),
        risk("insiders", "Insiders", r.insidersPct),
        risk("bundlers", "Bundlers", r.bundlersPct),
      ]
    : [];
  const tiles: TileModel[] = [
    ...riskTiles,
    lpTile,
    {
      metric: "holders",
      label: "Holders",
      icon: Users,
      value: t.holders === null ? null : fmtCount(t.holders),
      tone: "text-fg-1",
    },
    {
      metric: "proTraders",
      label: "Pro traders",
      icon: BadgeCheck,
      value: t.proTraders === null ? null : fmtCount(t.proTraders),
      tone: t.proTraders === 0 ? "text-fg-3" : "text-fg-1",
    },
    {
      metric: "dexPaid",
      label: "Dex paid",
      icon: CircleDollarSign,
      value: t.dexPaid ? (t.dexPaidAt !== null ? `${fmtAge(t.dexPaidAt)} ago` : "Paid") : "Unpaid",
      tone: t.dexPaid ? "text-fg-1" : "text-fg-3",
      word: true,
    },
  ];

  // Unknown after the settle window: hide the tile (no dash wall) and name it once, quietly, below.
  const shown = loading ? tiles : tiles.filter((x) => x.value !== null);
  const hidden = loading ? [] : tiles.filter((x) => x.value === null);

  // Unknown dev history arrives as zeros: omit it rather than claim "0 launches".
  const knownHistory = detail.devLaunches > 0;
  const facts: ReactNode[] = [];
  if (knownHistory) {
    facts.push(
      <>
        <span className="zf-num text-fg-2">{fmtCount(detail.devLaunches)}</span>
        {detail.devLaunches === 1 ? "launch" : "launches"}
      </>,
      <>
        <span className="zf-num text-fg-2">{fmtCount(detail.devMigrations)}</span>
        migrated
      </>,
    );
  }
  if (t.fundingWallet) {
    facts.push(
      <>
        Funded by
        <Tooltip content={<span className="font-mono break-all">{t.fundingWallet}</span>}>
          <span className="font-mono text-fg-2">{shortAddr(t.fundingWallet)}</span>
        </Tooltip>
        <CopyButton text={t.fundingWallet} label="Copy funding wallet" className="-ml-0.5" />
      </>,
    );
  }

  return (
    <section aria-label="Token info" aria-busy={loading || undefined} className="border-t border-hairline">
      {header && (
        <div className="flex h-8 items-center justify-between px-3">
          <span className="text-data font-semibold text-fg-1">Token info</span>
          <Methodology />
        </div>
      )}
      {/* Tiles flow in Axiom's order; each draws its own right and bottom hairline, so a short last row stays clean. */}
      <div className="grid grid-cols-3 border-t border-hairline [&>*]:border-b [&>*]:border-hairline [&>*:not(:nth-child(3n))]:border-r">
        {shown.map((tile) => (
          <Tile key={tile.metric} tile={tile} />
        ))}
      </div>
      {hidden.length > 0 && (
        <div className="flex min-h-6 items-center border-b border-hairline px-3 py-1 text-label text-fg-4">
          <span>
            {hidden.length >= 4 ? "Holder metrics not computed yet" : `Not computed yet: ${hidden.map((h) => h.label).join(" · ")}`}
          </span>
        </div>
      )}
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
      {/* Dev: address, copy and Track dev on one line; the record and funder on the next, wrapping between facts only. */}
      <div className="px-3 pt-1.5 pb-2 text-label text-fg-3">
        <div className="flex h-6 items-center gap-1 whitespace-nowrap">
          <ChefHat aria-hidden="true" className="icon-xs text-fg-3" strokeWidth={1.5} absoluteStrokeWidth />
          <MetricLabel metric="devLaunches">Dev</MetricLabel>
          <Tooltip content={<span className="font-mono break-all">{t.creator}</span>}>
            <span className="ml-0.5 font-mono text-fg-2">{shortAddr(t.creator)}</span>
          </Tooltip>
          <CopyButton text={t.creator} label="Copy dev address" className="-ml-0.5" />
          <Button
            variant="ghost"
            size="xs"
            className="-mr-1.5 ml-auto"
            aria-pressed={devTracked}
            onClick={() =>
              devTracked
                ? removeWallet(t.creator)
                : addWallet({ address: t.creator, name: `Dev ${t.symbol}`.slice(0, 16), emoji: "", alerts: true })
            }
          >
            {devTracked ? "Untrack dev" : "Track dev"}
          </Button>
        </div>
        <FactRow facts={facts} />
      </div>
    </section>
  );
}
