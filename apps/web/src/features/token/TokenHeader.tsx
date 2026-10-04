import { AppWindow, Check, Share2, Star } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Age } from "../../components/ui/Age";
import { IconButton } from "../../components/ui/Button";
import { MetricLabel, SocialLinks } from "../../components/ui/bits";
import { CopyButton, Hotkey } from "../../components/ui/controls";
import { PlatformMark } from "../../components/ui/Logo";
import { LAUNCHPAD_LOGO, sameBrand, VENUE_LOGO } from "../../components/ui/logos";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtCount, fmtPct, fmtProgress, fmtSol, fmtUsd, shortAddr, signClass } from "../../lib/format";
import { LAUNCHPAD_BY_ID, type MetricKey, VENUE_LABEL } from "../../lib/metrics";
import { useMediaQuery } from "../../lib/useMediaQuery";
import type { TokenSummary } from "../../protocol";
import { useSettings } from "../../state/settings";
import { AlertsButton } from "./AlertsButton";
import { Money, useQuote } from "./money";
import { useTickFlash } from "./useTickFlash";
import { useWindowChanges } from "./useWindowChanges";

/*
 * Token header (DESIGN.md 5.2): a 48 px band. Left: avatar 28 with two 20 px lines (ticker and
 * name; CA, age, socials). Then one stats strip with hairline dividers, micro labels over data
 * values, market cap as the display-2 headline. Actions on the right: watchlist, alerts, share and
 * the Instant Trade toggle. MC and price flash their text colour for 600 ms, at most twice a
 * second (6.6). Micro labels over values after OpenSea https://mobbin.com/screens/d07a9d5b-cd19-4c4b-a600-0ba26e29c68c;
 * one strip with dividers instead of cards after Fey https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2;
 * market cap as the headline with price under it after Base https://mobbin.com/screens/5d35e943-618c-402a-a9e8-2d8addd1f612
 */

function Cell({
  metric,
  label,
  tip,
  children,
  className,
}: {
  metric: MetricKey;
  label?: string;
  /** Definition for labels without a published metric key (1h, 24h). */
  tip?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex shrink-0 flex-col justify-center border-l border-hairline px-3", className)}>
      <span className="text-micro font-medium text-fg-3">
        {tip ? (
          <Tooltip
            content={
              <span className="block">
                <span className="block text-data font-semibold text-fg-1">{label}</span>
                <span className="mt-1 block text-label text-fg-2">{tip}</span>
              </span>
            }
          >
            <span className="zf-metric">{label}</span>
          </Tooltip>
        ) : (
          <MetricLabel metric={metric}>{label}</MetricLabel>
        )}
      </span>
      <span className="flex items-center text-data text-fg-1">{children}</span>
    </div>
  );
}

/** ↑ / ↓ in text-3 for the last tick when motion is reduced (DESIGN.md 6.6); keeps its width. */
function TickArrow({ dir }: { dir: "up" | "down" | null }) {
  return (
    <span aria-hidden="true" className="ml-0.5 inline-block w-[1ch] text-label text-fg-3">
      {dir === "up" ? "↑" : dir === "down" ? "↓" : ""}
    </span>
  );
}

function Change({ value }: { value: number | null }) {
  return (
    <span className={cn("zf-num inline-block min-w-[7ch]", value === null ? "text-fg-4" : signClass(value))}>
      {value === null ? "–" : fmtPct(value, { signed: true })}
    </span>
  );
}

export function StatsStrip({ token, className }: { token: TokenSummary; className?: string }) {
  const { quote } = useQuote();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const mcValue = quote === "USD" ? token.marketCapUsd : token.marketCapSol;
  const mcFlash = useTickFlash(mcValue);
  const priceFlash = useTickFlash(token.priceSol);
  const { h1, h24 } = useWindowChanges(token.mint, token.priceSol);
  const migrated = token.migratedAt !== null;
  return (
    <div className={cn("flex min-w-0 items-stretch overflow-hidden", className)}>
      <Cell metric="marketCap" className="border-l-0 pl-0 lg:border-l lg:pl-3">
        <span key={mcFlash.key} className={cn("zf-num inline-block min-w-[6ch] text-display-2 font-semibold text-fg-1", mcFlash.className)}>
          {quote === "USD" ? fmtUsd(mcValue) : fmtSol(mcValue)}
          {quote === "SOL" && <span className="zf-unit">{" SOL"}</span>}
        </span>
        {reduced && <TickArrow dir={mcFlash.last} />}
      </Cell>
      <Cell metric="price">
        <span key={priceFlash.key} className={cn("inline-block min-w-[10ch]", priceFlash.className)}>
          <Num
            kind="price"
            usd={quote === "USD"}
            value={quote === "USD" ? token.priceUsd : token.priceSol}
            unit={quote === "SOL" ? "SOL" : undefined}
          />
        </span>
        {reduced && <TickArrow dir={priceFlash.last} />}
      </Cell>
      <Cell metric="liquidity">
        <Money usd={token.liquidityUsd} unit className="inline-block min-w-[6ch]" />
      </Cell>
      <Cell metric="volume" label="Vol 24h">
        <Money usd={token.volumeUsd} unit className="inline-block min-w-[6ch]" />
      </Cell>
      <Cell metric="change5m" label="5m">
        <Change value={token.change5mPct} />
      </Cell>
      <Cell
        metric="change5m"
        label="1h"
        tip="Price change over the last hour (since launch for younger tokens)."
        className="hidden xl:flex"
      >
        <Change value={h1} />
      </Cell>
      <Cell
        metric="change5m"
        label="24h"
        tip="Price change over the last 24 hours (since launch for younger tokens)."
        className="hidden 2xl:flex"
      >
        <Change value={h24} />
      </Cell>
      <Cell metric="holders" className="hidden xl:flex">
        <span className="zf-num inline-block min-w-[5ch]">{fmtCount(token.holders)}</span>
      </Cell>
      <Cell metric="progress" label={migrated ? "Pool" : "BC"}>
        {migrated ? (
          <span className="text-fg-2">Migrated</span>
        ) : (
          <span className="flex items-center gap-2">
            <span className="zf-num inline-block min-w-[4ch]">{fmtProgress(token.bondingProgress)}</span>
            <span className="h-0.5 w-8 bg-surface-3" aria-hidden="true">
              <span className="block h-full bg-fg-2" style={{ width: `${Math.min(100, token.bondingProgress * 100)}%` }} />
            </span>
          </span>
        )}
      </Cell>
    </div>
  );
}

function Identity({ token }: { token: TokenSummary }) {
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-2">
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} launchpad={token.launchpad} size="sm" badge={false} />
      <div className="min-w-0">
        <div className="flex h-5 items-center gap-2">
          <h1 className="max-w-[10ch] truncate text-heading font-semibold text-fg-1">{token.symbol}</h1>
          <span className="max-w-40 truncate text-data text-fg-3">{token.name}</span>
          <VenueMarks token={token} />
        </div>
        <div className="flex h-5 items-center gap-2 text-label text-fg-3">
          <span className="flex items-center">
            <Tooltip content={<span className="font-mono break-all">{token.mint}</span>}>
              <span className="font-mono text-fg-2">{shortAddr(token.mint)}</span>
            </Tooltip>
            <CopyButton text={token.mint} label="Copy contract address" />
          </span>
          <Age ts={token.createdAt} />
          <SocialLinks socials={token.socials} mint={token.mint} pump={token.launchpad === "pump" || token.launchpad === "mayhem"} />
        </div>
      </div>
    </div>
  );
}

/** Launchpad logo, plus the venue's when the token trades elsewhere now (migrated), each with its name on hover. */
function VenueMarks({ token }: { token: TokenSummary }) {
  const launch = LAUNCHPAD_LOGO[token.launchpad];
  const venue = VENUE_LOGO[token.venue];
  return (
    <span className="flex shrink-0 items-center gap-1">
      {launch && <PlatformMark logo={launch} size={14} label={`Launched on ${LAUNCHPAD_BY_ID[token.launchpad]?.label ?? "Other"}`} />}
      {venue && !sameBrand(venue, launch) && <PlatformMark logo={venue} size={14} label={`Trades on ${VENUE_LABEL[token.venue]}`} />}
    </span>
  );
}

function ShareButton({ token }: { token: TokenSummary }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <IconButton
      label={done ? "Copied" : `Copy link to ${token.symbol}`}
      onClick={() => void copyText(`${window.location.origin}/t/${token.mint}`).then((ok) => setDone(ok))}
    >
      {done ? <Check /> : <Share2 />}
    </IconButton>
  );
}

export function HeaderActions({ token }: { token: TokenSummary }) {
  const watched = useSettings((s) => s.watchlist.includes(token.mint));
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const instantOpen = useSettings((s) => s.instant.open);
  const setInstant = useSettings((s) => s.setInstant);
  const instantKey = useSettings((s) => s.hotkeys["instant.toggle"]?.[0]);
  return (
    <div className="flex shrink-0 items-center gap-1">
      <IconButton label={watched ? "Remove from watchlist" : "Add to watchlist"} active={watched} onClick={() => toggleWatch(token.mint)}>
        <Star className={cn(watched && "fill-current")} />
      </IconButton>
      <AlertsButton token={token} />
      <ShareButton token={token} />
      <Tooltip
        content={
          <span className="flex items-center gap-1">
            Instant Trade window <Hotkey binding={instantKey} />
          </span>
        }
      >
        <button
          type="button"
          aria-pressed={instantOpen}
          onClick={() => setInstant({ open: !instantOpen })}
          className={cn(
            "ml-1 inline-flex h-6 items-center gap-1 rounded-sm border px-2 text-data font-medium transition-colors",
            instantOpen
              ? "border-hairline-strong bg-surface-3 text-fg-1 hover:bg-surface-3-hover"
              : "border-hairline-strong text-fg-2 hover:bg-surface-3 hover:text-fg-1",
          )}
        >
          <AppWindow className="icon-sm" />
          Instant
        </button>
      </Tooltip>
    </div>
  );
}

/** Desktop (one 48 px band) and tablet (two rows) header. */
export function TokenHeader({ token, layout = "desktop" }: { token: TokenSummary; layout?: "desktop" | "tablet" }) {
  if (layout === "tablet") {
    return (
      <header className="shrink-0 border-b border-hairline bg-surface-1">
        <div className="flex h-12 items-center justify-between gap-3 px-3">
          <Identity token={token} />
          <HeaderActions token={token} />
        </div>
        <div className="flex h-11 items-stretch border-t border-hairline px-3 py-1">
          <StatsStrip token={token} />
        </div>
      </header>
    );
  }
  return (
    <header className="flex h-12 shrink-0 items-stretch gap-0 border-b border-hairline bg-surface-1 pl-3">
      <div className="flex items-center pr-3">
        <Identity token={token} />
      </div>
      <StatsStrip token={token} className="flex-1 py-1" />
      <div className="flex items-center px-3">
        <HeaderActions token={token} />
      </div>
    </header>
  );
}
