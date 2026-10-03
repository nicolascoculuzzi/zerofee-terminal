import { Segmented } from "../../components/ui/controls";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { useTrackers } from "../../state/trackers";
import { UnreadBadge } from "./bits";
import { WalletTracker, XTracker } from "./Panels";
import { type MobilePanel, useTrackerPrefs } from "./prefs";

/*
 * Trackers page: wallet tracker (≈60%) beside the X tracker (≈40%), like Kraken Pro's home where
 * the markets table sits next to a narrower activity column:
 * https://mobbin.com/screens/fe204312-8607-4018-b0dd-a36dc71f4978
 * Below the lg breakpoint the two panels become tabs, and only the visible one is mounted (so
 * only it marks its feed as read).
 */
export default function TrackersPage() {
  const wide = useMediaQuery(BREAKPOINT.lg);
  const panel = useTrackerPrefs((s) => s.mobilePanel);
  const setPanel = useTrackerPrefs((s) => s.setMobilePanel);
  const unreadTrades = useTrackers((s) => s.unreadTrades);
  const unreadPosts = useTrackers((s) => s.unreadPosts);

  if (wide) {
    return (
      <div className="flex h-full min-h-0 gap-2 p-2">
        <WalletTracker className="flex-3" />
        <XTracker className="flex-2" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Segmented<MobilePanel>
        value={panel}
        onChange={setPanel}
        className="w-full"
        label="Tracker"
        options={[
          {
            value: "wallets",
            label: (
              <span className="flex items-center justify-center gap-1">
                Wallet tracker {panel !== "wallets" && <UnreadBadge count={unreadTrades} />}
              </span>
            ),
          },
          {
            value: "x",
            label: (
              <span className="flex items-center justify-center gap-1">
                X tracker {panel !== "x" && <UnreadBadge count={unreadPosts} />}
              </span>
            ),
          },
        ]}
      />
      {panel === "wallets" ? <WalletTracker className="flex-1" /> : <XTracker className="flex-1" />}
    </div>
  );
}
