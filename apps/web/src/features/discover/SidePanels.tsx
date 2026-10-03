import { memo, type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { compileBlacklists, isBlacklisted } from "../../lib/filters";
import { fmtPct, fmtUsd } from "../../lib/format";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useArrivals } from "../trackers/hooks";
import { QuickBuyButton, WatchStar } from "../trackers/QuickBuyButton";

const NEW_PAIRS = 10;
const identity = (mint: string): string => mint;

/*
 * Compact token row. Anatomy follows Coinbase Advanced's watchlist sidebar rows (avatar + symbol
 * with a sub-stat, numbers right-aligned, star at the end):
 * https://mobbin.com/screens/faec9f03-a00c-4718-ab12-44a3053cdac3
 */
const CompactTokenRow = memo(function CompactTokenRow({ mint, fresh }: { mint: string; fresh?: boolean }) {
  const t = useMarket((s) => s.tokens[mint]);
  if (!t) return null;
  const up = t.change5mPct >= 0;
  return (
    <div className={cn("relative flex h-7 items-center gap-2 px-3 text-label hover:bg-surface-3", fresh && "zf-enter")}>
      <Link to={`/t/${t.mint}`} className="absolute inset-0">
        <span className="sr-only">
          Open {t.symbol}, {t.name}
        </span>
      </Link>
      <TokenAvatar mint={t.mint} symbol={t.symbol} imageUri={t.imageUri} size="xs" />
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate font-semibold text-fg-1">{t.symbol}</span>
        <Age ts={t.createdAt} className="shrink-0 text-fg-3" />
      </span>
      <span className="w-14 shrink-0 text-right font-medium text-fg-1">{fmtUsd(t.marketCapUsd)}</span>
      <span className={cn("w-14 shrink-0 text-right", up ? "text-buy" : "text-sell")}>{fmtPct(t.change5mPct, { signed: true })}</span>
      <span className="flex w-14 shrink-0 justify-end">
        <QuickBuyButton mint={t.mint} symbol={t.symbol} source="discover" />
      </span>
      <WatchStar mint={t.mint} symbol={t.symbol} />
    </div>
  );
});

function Panel({
  title,
  meta,
  action,
  columns,
  children,
  footer,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  /** Show the column labels (only when there are rows). */
  columns: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-md border border-hairline bg-surface-1">
      <header className="flex h-9 items-center gap-2 border-b border-hairline px-3">
        <h2 className="text-heading font-semibold">{title}</h2>
        {meta !== undefined && <span className="text-label text-fg-3">{meta}</span>}
        {action && <span className="ml-auto text-label text-fg-2">{action}</span>}
      </header>
      {columns && (
        <div className="zf-label flex h-6 items-center gap-2 border-b border-hairline px-3">
          <span className="min-w-0 flex-1">Token</span>
          <span className="w-14 shrink-0 text-right">MC</span>
          <span className="w-14 shrink-0 text-right">5m</span>
          <span className="w-14 shrink-0" />
          <span className="w-5 shrink-0" />
        </div>
      )}
      {children}
      {footer}
    </section>
  );
}

/*
 * Watchlist: starred tokens that are in the live set, in starring order. Same panel anatomy as
 * Coinbase Advanced's watchlist (count in the header, star to remove, one-line empty state).
 */
export function WatchlistPanel() {
  const watchlist = useSettings((s) => s.watchlist);
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const tokens = useMarket((s) => s.tokens);
  const present = useMemo(() => watchlist.filter((m) => tokens[m] !== undefined), [watchlist, tokens]);
  const missing = watchlist.length - present.length;

  return (
    <Panel
      title="Watchlist"
      meta={present.length}
      columns={present.length > 0}
      footer={
        missing > 0 ? (
          <div className="flex items-center gap-2 border-t border-hairline px-3 py-2 text-label text-fg-3">
            <span>
              {missing} watched token{missing === 1 ? " is" : "s are"} not in the live set.
            </span>
            <button
              type="button"
              className="ml-auto text-fg-2 hover:text-fg-1"
              onClick={() => {
                const live = useMarket.getState().tokens;
                for (const m of useSettings.getState().watchlist) if (!live[m]) toggleWatch(m);
              }}
            >
              Remove
            </button>
          </div>
        ) : null
      }
    >
      {watchlist.length === 0 ? (
        <p className="px-3 py-3 text-data text-fg-3">Star a token to watch it here.</p>
      ) : present.length === 0 ? null : (
        <ul aria-label="Watched tokens">
          {present.map((m) => (
            <li key={m}>
              <CompactTokenRow mint={m} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/*
 * New pairs: the latest launches from the Pulse "new" column. Anatomy follows Binance Wallet's
 * Meme Rush "New" list (age beside the ticker, market cap right-aligned):
 * https://mobbin.com/screens/f9b4eff0-8083-4e54-913c-51177e462d1d
 */
export function NewPairsPanel() {
  const mints = useMarket((s) => s.columns.new);
  const blacklists = useSettings((s) => s.blacklists);
  const latest = useMemo(() => {
    const compiled = compileBlacklists(blacklists);
    const tokens = useMarket.getState().tokens;
    const out: string[] = [];
    for (const m of mints) {
      const t = tokens[m];
      if (!t || isBlacklisted(t, compiled)) continue;
      out.push(m);
      if (out.length === NEW_PAIRS) break;
    }
    return out;
  }, [mints, blacklists]);
  const isFresh = useArrivals(latest, identity);

  return (
    <Panel
      title="New pairs"
      columns={latest.length > 0}
      action={
        <Link to="/pulse" className="hover:text-fg-1">
          Open Pulse
        </Link>
      }
    >
      {latest.length === 0 ? (
        <p className="px-3 py-3 text-data text-fg-3">Waiting for new launches.</p>
      ) : (
        <ul aria-label="Newest tokens">
          {latest.map((m) => (
            <li key={m}>
              <CompactTokenRow mint={m} fresh={isFresh(m)} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
