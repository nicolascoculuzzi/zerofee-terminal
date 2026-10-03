import { ArrowUpRight, ListFilter, Wallet, X } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { IconButton } from "../../components/ui/Button";
import { XGlyph } from "../../components/ui/bits";
import { normalizeHandle } from "../../lib/filters";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { useSettings } from "../../state/settings";
import { useTrackedMap, useTrackers } from "../../state/trackers";
import { PauseStatus } from "./bits";
import { filterTrades, tokenBlocker, tradeFiltersActive } from "./feedFilters";
import { useArrivals, useHoverPause, useMarkRead } from "./hooks";
import { PostItem, postId } from "./PostItem";
import { useTrackerPrefs } from "./prefs";
import { useVisiblePosts } from "./socialActions";
import { TradeRow, tradeId } from "./TradeRow";

const DOCK_TRADES = 30;
const DOCK_POSTS = 20;

/*
 * Floating dock panel. Anatomy follows Kraken Pro's Activity side panel (title row, compact list,
 * "see all" link) and Coinbase Advanced's watchlist sidebar; flat bg-surface-1 with a strong hairline,
 * no shadow:
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 * https://mobbin.com/screens/faec9f03-a00c-4718-ab12-44a3053cdac3
 */
function DockPanel({
  title,
  icon,
  extra,
  status,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  extra?: ReactNode;
  status: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="@container pointer-events-auto flex max-h-[50vh] w-85 flex-col overflow-hidden rounded-md border border-hairline-strong bg-surface-1"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline pr-1 pl-3">
        <span className="flex text-fg-2">{icon}</span>
        <h2 className="text-data font-semibold">{title}</h2>
        {extra}
        <span className="ml-auto">{status}</span>
        <Link
          to="/trackers"
          className="flex h-6 items-center gap-1 rounded-sm px-1 text-label text-fg-2 hover:bg-surface-3 hover:text-fg-1"
          title="Open the Trackers page"
        >
          Trackers
          <ArrowUpRight className="icon-xs" />
        </Link>
        <IconButton label={`Close ${title}`} onClick={onClose}>
          <X className="icon-sm" />
        </IconButton>
      </header>
      {children}
    </section>
  );
}

function TradesDock() {
  const live = useTrackers((s) => s.live);
  const tracked = useTrackedMap();
  const filters = useTrackerPrefs((s) => s.trades);
  const blacklists = useSettings((s) => s.blacklists);
  const setDocks = useSettings((s) => s.setDocks);
  const items = useMemo(() => filterTrades(live, filters, tokenBlocker(blacklists)).slice(0, DOCK_TRADES), [live, filters, blacklists]);
  const { shown, paused, pending, bind } = useHoverPause(items);
  const isFresh = useArrivals(live, tradeId);
  useMarkRead("trades");
  const filtered = tradeFiltersActive(filters);
  return (
    <DockPanel
      title="Live trades"
      icon={<Wallet className="icon-sm" />}
      extra={
        filtered ? (
          <span className="flex text-fg-3" title="Live Trades filters from the Trackers page apply here">
            <ListFilter className="icon-sm" />
          </span>
        ) : null
      }
      status={<PauseStatus paused={paused} pending={pending} />}
      onClose={() => setDocks({ tracker: false })}
    >
      <div className="min-h-0 flex-1 overflow-y-auto" {...bind}>
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-data text-fg-3">
            {live.length === 0 ? "Waiting for tracked wallets to trade." : "No trades match the filters."}
          </p>
        ) : (
          shown.map((item) => (
            <TradeRow key={item.trade.id} item={item} wallet={tracked.get(item.trade.maker)} fresh={isFresh(item.trade.id)} />
          ))
        )}
      </div>
    </DockPanel>
  );
}

function SocialDock() {
  const setDocks = useSettings((s) => s.setDocks);
  const scope = useTrackerPrefs((s) => s.feedScope);
  const { posts, visible, tracked } = useVisiblePosts(scope);
  const items = useMemo(() => visible.slice(0, DOCK_POSTS), [visible]);
  const { shown, paused, pending, bind } = useHoverPause(items);
  const isFresh = useArrivals(posts, postId);
  useMarkRead("posts");
  return (
    <DockPanel
      title="Social"
      icon={<XGlyph />}
      status={<PauseStatus paused={paused} pending={pending} />}
      onClose={() => setDocks({ social: false })}
    >
      <div className="min-h-0 flex-1 overflow-y-auto" {...bind}>
        {shown.length === 0 ? (
          <p className="px-3 py-3 text-data text-fg-3">{posts.length === 0 ? "Waiting for posts." : "No posts match your feed toggles."}</p>
        ) : (
          shown.map((post) => (
            <PostItem key={post.id} post={post} fresh={isFresh(post.id)} compact tracked={tracked.has(normalizeHandle(post.handle))} />
          ))
        )}
      </div>
    </DockPanel>
  );
}

/**
 * Wallet-tracker and social docks, bottom-left above the status bar (desktop only). The status
 * bar buttons toggle `docks.tracker` / `docks.social`; both open sit side by side.
 */
export function TrackerDock() {
  const docks = useSettings((s) => s.docks);
  const desktop = useMediaQuery(BREAKPOINT.md);
  if (!desktop || (!docks.tracker && !docks.social)) return null;
  return (
    <div className="pointer-events-none fixed bottom-statusbar left-0 z-dock flex items-end gap-2 p-2">
      {docks.tracker && <TradesDock />}
      {docks.social && <SocialDock />}
    </div>
  );
}
