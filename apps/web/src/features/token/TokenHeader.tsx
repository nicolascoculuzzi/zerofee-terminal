import { AppWindow, Star } from "lucide-react";
import type { ReactNode } from "react";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { MetricLabel, SocialLinks } from "../../components/ui/bits";
import { CopyButton, Hotkey } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtCompact, fmtCount, fmtPct, fmtUsd, shortAddr } from "../../lib/format";
import type { MetricKey } from "../../lib/metrics";
import { LAUNCHPAD_BY_ID, VENUE_LABEL } from "../../lib/metrics";
import type { TokenSummary } from "../../protocol";
import { useSettings } from "../../state/settings";

function Stat({ metric, label, children, className }: { metric: MetricKey; label?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex shrink-0 flex-col justify-center", className)}>
      <span className="zf-label">
        <MetricLabel metric={metric}>{label}</MetricLabel>
      </span>
      <span className="text-data text-fg-1">{children}</span>
    </div>
  );
}

/**
 * Token header strip: identity, then label-over-value stats with the market cap as the headline.
 * Anatomy: Coinbase Advanced's ticker bar https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
 * and Base's token page (market cap headline) https://mobbin.com/screens/2439249c-3665-4ba4-b7e2-602b39aa8df8
 */
export function TokenHeader({ token }: { token: TokenSummary }) {
  const watched = useSettings((s) => s.watchlist.includes(token.mint));
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const instantOpen = useSettings((s) => s.instant.open);
  const setInstant = useSettings((s) => s.setInstant);
  const instantKey = useSettings((s) => s.hotkeys["instant.toggle"][0]);
  const up = token.change5mPct >= 0;
  const migrated = token.migratedAt !== null;
  return (
    <div className="flex h-14 shrink-0 items-center gap-4 border-b border-hairline bg-surface-1 px-3">
      <div className="flex shrink-0 items-center gap-2">
        <TokenAvatar
          mint={token.mint}
          symbol={token.symbol}
          imageUri={token.imageUri}
          launchpad={token.launchpad}
          size="lg"
          progress={token.bondingProgress}
          migrated={migrated}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="text-heading font-semibold">{token.symbol}</h1>
            <span className="max-w-40 truncate text-data text-fg-2">{token.name}</span>
            <CopyButton text={token.mint} label="Copy contract address" />
            <button
              type="button"
              aria-pressed={watched}
              aria-label={watched ? "Remove from watchlist" : "Add to watchlist"}
              title={watched ? "Remove from watchlist" : "Add to watchlist"}
              onClick={() => toggleWatch(token.mint)}
              className={cn("flex size-4 items-center justify-center", watched ? "text-fg-1" : "text-fg-3 hover:text-fg-1")}
            >
              <Star className={cn("icon-sm", watched && "fill-fg-1")} />
            </button>
          </div>
          <div className="flex items-center gap-2 text-label text-fg-3">
            <Age ts={token.createdAt} className="text-fg-1" />
            <SocialLinks socials={token.socials} />
            <span>{LAUNCHPAD_BY_ID[token.launchpad].label}</span>
            <span>{VENUE_LABEL[token.venue]}</span>
            <span className="font-mono">{shortAddr(token.mint, 4, 4)}</span>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
        <div className="flex shrink-0 flex-col justify-center">
          <span className="zf-label">
            <MetricLabel metric="marketCap" />
          </span>
          <span className={cn("text-display-2 font-semibold", up ? "text-buy" : "text-sell")}>{fmtUsd(token.marketCapUsd)}</span>
        </div>
        <Stat metric="price">
          <Num kind="price" usd value={token.priceUsd} />{" "}
          <Num kind="price" value={token.priceSol} unit="SOL" className="text-label text-fg-3" />
        </Stat>
        <Stat metric="change5m" label="5m">
          <span className={up ? "text-buy" : "text-sell"}>{fmtPct(token.change5mPct, { signed: true })}</span>
        </Stat>
        <Stat metric="liquidity">{fmtUsd(token.liquidityUsd)}</Stat>
        <Stat metric="volume">{fmtUsd(token.volumeUsd)}</Stat>
        <Stat metric="supply">{fmtCompact(token.supply)}</Stat>
        <Stat metric="holders">{fmtCount(token.holders)}</Stat>
        <Stat metric="progress" label="Bonding">
          {migrated ? (
            <span className="text-fg-2">Migrated</span>
          ) : (
            <span className="flex items-center gap-2">
              {fmtPct(token.bondingProgress * 100)}
              <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full bg-fg-2" style={{ width: `${token.bondingProgress * 100}%` }} />
              </span>
            </span>
          )}
        </Stat>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="md"
          variant={instantOpen ? "secondary" : "secondary"}
          icon={<AppWindow className="icon-sm" />}
          onClick={() => setInstant({ open: !instantOpen })}
          aria-pressed={instantOpen}
        >
          Instant Trade
          <Hotkey binding={instantKey} />
        </Button>
      </div>
    </div>
  );
}
