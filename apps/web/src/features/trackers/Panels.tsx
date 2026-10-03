import type { ReactNode } from "react";
import { XGlyph } from "../../components/ui/bits";
import { cn } from "../../lib/cn";
import { useTrackers } from "../../state/trackers";
import { CustomizeFeed } from "./CustomizeFeed";
import { LiveTrades } from "./LiveTrades";
import { Monitor } from "./Monitor";
import { useTrackerPrefs, type WalletTab, type XTab } from "./prefs";
import { SocialFeed } from "./SocialFeed";
import { TabBar } from "./TabBar";
import { WalletManager } from "./WalletManager";

function PanelShell({ label, header, children, className }: { label: string; header: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label={label}
      className={cn("@container flex min-h-0 min-w-0 flex-col rounded-md border border-hairline bg-surface-1", className)}
    >
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-hairline px-3">{header}</header>
      {children}
    </section>
  );
}

/** Wallet tracker: Wallet Manager | Live Trades | Monitor. */
export function WalletTracker({ className }: { className?: string }) {
  const tab = useTrackerPrefs((s) => s.walletTab);
  const setTab = useTrackerPrefs((s) => s.setWalletTab);
  const unread = useTrackers((s) => s.unreadTrades);
  return (
    <PanelShell
      label="Wallet tracker"
      className={className}
      header={
        <>
          <h2 className="hidden text-heading font-semibold whitespace-nowrap @2xl:block">Wallet tracker</h2>
          <TabBar<WalletTab>
            label="Wallet tracker views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "manager", label: "Wallet Manager" },
              { id: "trades", label: "Live Trades", badge: unread },
              { id: "monitor", label: "Monitor" },
            ]}
          />
        </>
      }
    >
      {tab === "manager" && <WalletManager />}
      {tab === "trades" && <LiveTrades />}
      {tab === "monitor" && <Monitor />}
    </PanelShell>
  );
}

/** X tracker: Live feed | Customize Feed. */
export function XTracker({ className }: { className?: string }) {
  const tab = useTrackerPrefs((s) => s.xTab);
  const setTab = useTrackerPrefs((s) => s.setXTab);
  const unread = useTrackers((s) => s.unreadPosts);
  return (
    <PanelShell
      label="X tracker"
      className={className}
      header={
        <>
          <h2 className="hidden items-center gap-1 text-heading font-semibold whitespace-nowrap @lg:flex">
            <XGlyph /> tracker
          </h2>
          <TabBar<XTab>
            label="X tracker views"
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "feed", label: "Live feed", badge: unread },
              { id: "customize", label: "Customize Feed" },
            ]}
          />
        </>
      }
    >
      {tab === "feed" ? <SocialFeed /> : <CustomizeFeed />}
    </PanelShell>
  );
}
