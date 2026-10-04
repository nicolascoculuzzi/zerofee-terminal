import { ArrowUpRight, ListFilter, Wallet, X } from "lucide-react";
import { type ReactNode, useCallback, useMemo } from "react";
import { Link } from "react-router";
import { IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { copyText } from "../../lib/clipboard";
import { useCssPx } from "../../lib/cssVar";
import { navigateTo } from "../../lib/nav";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import type { TrackedTrade } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useTrackedMap, useTrackers } from "../../state/trackers";
import { PausedChip } from "./bits";
import { filterTrades, tokenBlocker } from "./feedFilters";
import { useInsertions, useLivePause, useMarkRead } from "./hooks";
import { postId } from "./PostItem";
import { tradeFiltersActive, useTrackerPrefs } from "./prefs";
import { PostList } from "./SocialFeed";
import { useVisiblePosts } from "./socialActions";
import { TradeHeader, TradeRow, tradeId, tradeMint } from "./TradeRow";
import { VirtualGrid } from "./VirtualList";

const DOCK_TRADES = 60;
const DOCK_POSTS = 30;

/*
 * Floating dock (DESIGN.md 5.4): 360 × 420 px, 6 px radius, the floating surface with a
 * hairline-strong border and e2, z-dock, bottom-left above the status bar (Axiom's tracker
 * placement). Header 28 px like the Instant Trade window (4.12). Movable widget panels with a
 * title row after Kraken Pro: https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7
 */
function DockPanel({
  title,
  icon,
  extra,
  paused,
  onClose,
  children,
}: {
  title: string;
  icon: ReactNode;
  extra?: ReactNode;
  paused: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="@container pointer-events-auto flex h-105 max-h-[calc(100dvh-var(--zf-topbar)-var(--zf-statusbar)-16px)] w-90 flex-col overflow-hidden rounded-md border border-hairline-strong bg-floating shadow-e2"
    >
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-hairline pr-1 pl-2">
        <span className="flex text-fg-3">{icon}</span>
        <h2 className="text-data font-semibold text-fg-1">{title}</h2>
        {extra}
        <PausedChip paused={paused} />
        <Link
          to="/trackers"
          className="ml-auto flex h-5 items-center gap-1 rounded-xs px-1 text-label text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
          title="Open the Trackers page (G then T)"
        >
          Trackers
          <ArrowUpRight className="icon-xs" />
        </Link>
        <IconButton label={`Close ${title}`} onClick={onClose}>
          <X />
        </IconButton>
      </header>
      {children}
    </section>
  );
}

function TradesDock() {
  const live = useTrackers((s) => s.live);
  const walletCount = useTrackers((s) => s.wallets.length);
  const tracked = useTrackedMap();
  const filters = useTrackerPrefs((s) => s.trades);
  const blacklists = useSettings((s) => s.blacklists);
  const setDocks = useSettings((s) => s.setDocks);
  const dense = useCssPx("--zf-row-dense", 20);
  const items = useMemo(() => filterTrades(live, filters, tokenBlocker(blacklists)).slice(0, DOCK_TRADES), [live, filters, blacklists]);
  const { shown, paused, pending, bind, release } = useLivePause(items, tradeId);
  const isFresh = useInsertions(shown, tradeId);
  useMarkRead("trades");
  const open = useCallback((item: TrackedTrade, how: { newTab: boolean }) => {
    const to = `/t/${item.token.mint}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((item: TrackedTrade) => void copyText(item.token.mint), []);
  return (
    <DockPanel
      title="Live trades"
      icon={<Wallet className="icon-sm" />}
      paused={paused}
      extra={
        tradeFiltersActive(filters) ? (
          <span className="flex text-fg-3" title="The Live trades filters from the Trackers page apply here">
            <ListFilter className="icon-xs" />
          </span>
        ) : null
      }
      onClose={() => setDocks({ tracker: false })}
    >
      <VirtualGrid
        items={shown}
        getKey={tradeId}
        rowHeight={dense}
        label="Trades by tracked wallets"
        header={<TradeHeader />}
        empty={
          <EmptyState
            className="text-balance"
            title={walletCount === 0 ? "No wallets tracked" : live.length === 0 ? "No trades yet" : "No trades match the filters"}
            body={walletCount === 0 ? "Add wallets on the Trackers page." : "New trades appear within about a second of landing."}
          />
        }
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        mintOf={tradeMint}
        renderRow={(item, { active }) => (
          <TradeRow item={item} wallet={tracked.get(item.trade.maker)} fresh={isFresh(item.trade.id)} active={active} floating />
        )}
      />
    </DockPanel>
  );
}

function SocialDock() {
  const setDocks = useSettings((s) => s.setDocks);
  const scope = useTrackerPrefs((s) => s.feedScope);
  const { posts, visible, tracked } = useVisiblePosts(scope);
  const items = useMemo(() => visible.slice(0, DOCK_POSTS), [visible]);
  const { shown, paused, pending, bind, release } = useLivePause(items, postId);
  useMarkRead("posts");
  return (
    <DockPanel
      title="X feed"
      icon={<span className="flex w-3.5 justify-center text-data font-semibold">X</span>}
      extra={<span className="text-label text-fg-3">{scope === "mine" ? "My list" : "All posts"}</span>}
      paused={paused}
      onClose={() => setDocks({ social: false })}
    >
      <PostList
        posts={shown}
        tracked={tracked}
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        compact
        floating
        label="X posts"
        empty={
          <EmptyState
            className="text-balance"
            title={posts.length === 0 ? "No posts yet" : "No posts match your switches"}
            body="Manage handles on the Trackers page, X tab."
          />
        }
      />
    </DockPanel>
  );
}

/**
 * Wallet-tracker and X docks (desktop only; the status-bar toggles set `docks.tracker` and
 * `docks.social`). With both open they sit side by side, 8 px apart.
 */
export function TrackerDock() {
  const docks = useSettings((s) => s.docks);
  const desktop = useMediaQuery(BREAKPOINT.md);
  if (!desktop || (!docks.tracker && !docks.social)) return null;
  return (
    <div className="pointer-events-none fixed bottom-[calc(var(--zf-statusbar)+8px)] left-2 z-dock flex items-end gap-2">
      {docks.tracker && <TradesDock />}
      {docks.social && <SocialDock />}
    </div>
  );
}
