import { Segmented } from "../../components/ui/controls";
import { fmtInt } from "../../lib/format";
import { useTrackers } from "../../state/trackers";
import { MetaCount, PaneToolbar, ToolbarSep } from "./bits";
import { CustomizeFeed } from "./CustomizeFeed";
import { useTrackerPrefs, type XView } from "./prefs";
import { SocialFeed } from "./SocialFeed";
import { WalletCount } from "./WalletManager";

/** X tab: the live feed, or the handle list with its switches. */
export function XPane({ query }: { query: string }) {
  const view = useTrackerPrefs((s) => s.xView);
  const setView = useTrackerPrefs((s) => s.setXView);
  const handles = useTrackers((s) => s.handles.length);
  const start = (
    <>
      <Segmented<XView>
        size="xs"
        value={view}
        onChange={setView}
        label="X view"
        className="max-md:h-13"
        options={[
          { value: "feed", label: "Feed" },
          {
            value: "handles",
            label: (
              <span className="flex items-center gap-1">
                Handles <span className="zf-num text-fg-3">{fmtInt(handles)}</span>
              </span>
            ),
          },
        ]}
      />
      <ToolbarSep />
    </>
  );
  return view === "feed" ? <SocialFeed query={query} toolbarStart={start} /> : <CustomizeFeed query={query} toolbarStart={start} />;
}

/** Wallet pane toolbar (28 px): count against the limit and how many have alerts on. */
export function WalletPaneToolbar() {
  const alerts = useTrackers((s) => s.wallets.reduce((n, w) => n + (w.alerts ? 1 : 0), 0));
  return (
    <PaneToolbar>
      <WalletCount />
      <ToolbarSep />
      <MetaCount>{alerts === 1 ? "1 with alerts on" : `${fmtInt(alerts)} with alerts on`}</MetaCount>
    </PaneToolbar>
  );
}
