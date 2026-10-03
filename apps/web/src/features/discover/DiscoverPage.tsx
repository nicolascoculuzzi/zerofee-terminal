import { NewPairsPanel, WatchlistPanel } from "./SidePanels";
import { TrendingSection } from "./Trending";

/*
 * Discover: the trending table with a narrow right column for the watchlist and new pairs, after
 * Kraken Pro's home (markets module beside a narrower column of side modules):
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 * From xl up each column scrolls on its own; below that the page scrolls as one column and the
 * trending header sticks to the top.
 */
export default function DiscoverPage() {
  return (
    <div className="h-full overflow-y-auto xl:overflow-hidden">
      <div className="flex flex-col gap-2 p-2 xl:h-full xl:flex-row">
        <TrendingSection className="xl:min-h-0 xl:flex-1" />
        <aside className="flex flex-col gap-2 xl:w-96 xl:shrink-0 xl:overflow-y-auto" aria-label="Watchlist and new pairs">
          <WatchlistPanel />
          <NewPairsPanel />
        </aside>
      </div>
    </div>
  );
}
