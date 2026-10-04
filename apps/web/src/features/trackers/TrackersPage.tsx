import { FileDown, MoreHorizontal, Plus, Upload } from "lucide-react";
import { type ReactNode, useDeferredValue, useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { fmtInt } from "../../lib/format";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import { MAX_TRACKED_WALLETS, useTrackers } from "../../state/trackers";
import { SearchField } from "./bits";
import { ExportMenu, jsonExportActions, MenuList } from "./ExportMenu";
import { useIsMobile, useQuickBuyHotkey } from "./hooks";
import { ImportWalletsModal } from "./ImportWalletsModal";
import { LiveTrades } from "./LiveTrades";
import { Monitor } from "./Monitor";
import { WalletPaneToolbar, XPane } from "./Panels";
import { type TrackerPane, type TrackerTab, useTrackerPrefs } from "./prefs";
import { TabBar, type TabDef } from "./TabBar";
import { WalletManager } from "./WalletManager";
import { useWalletDialogs, WalletModal } from "./WalletModal";
import { walletsToJson, walletsToLines } from "./walletImport";

const ID = "trackers";

function walletExportActions() {
  return jsonExportActions({
    filename: "zerofee-wallets.json",
    json: () => walletsToJson(useTrackers.getState().wallets),
    lines: { label: "Copy as text lines", text: () => walletsToLines(useTrackers.getState().wallets) },
  });
}

function searchPlaceholder(tab: TrackerTab | TrackerPane): string {
  if (tab === "x") return "Search posts or handles";
  if (tab === "monitor") return "Search tokens or holders";
  return "Search wallets or tokens";
}

/** Import, Export and Add wallet (DESIGN.md 5.4). Labels drop below 1024 px; the icons carry aria labels. */
function WalletActions() {
  const count = useTrackers((s) => s.wallets.length);
  const full = count >= MAX_TRACKED_WALLETS;
  const dialogs = useWalletDialogs.getState();
  return (
    <>
      <Button size="md" variant="secondary" icon={<Upload />} title="Import wallets" onClick={dialogs.openImport}>
        <span className="max-lg:sr-only">Import</span>
      </Button>
      <ExportMenu actions={walletExportActions()} disabled={count === 0} />
      <Button
        size="md"
        variant="primary"
        icon={<Plus />}
        disabled={full}
        title={full ? `The tracker holds ${fmtInt(MAX_TRACKED_WALLETS)} wallets` : "Add wallet"}
        onClick={dialogs.openAdd}
      >
        <span className="max-lg:sr-only">Add wallet</span>
      </Button>
    </>
  );
}

/** Phones: Add wallet plus an overflow menu for import and export, 44 px targets. */
function MobileActions() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const count = useTrackers((s) => s.wallets.length);
  const dialogs = useWalletDialogs.getState();
  const actions = walletExportActions();
  return (
    <>
      <Button
        size="md"
        variant="primary"
        icon={<Plus />}
        className="max-md:h-11"
        onClick={dialogs.openAdd}
        disabled={count >= MAX_TRACKED_WALLETS}
      >
        Add
      </Button>
      <IconButton ref={anchor} size="md" label="Import and export wallets" className="max-md:size-11" onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={220}>
        <MenuList label="Import and export">
          <MenuItem
            icon={<Upload />}
            onSelect={() => {
              setOpen(false);
              dialogs.openImport();
            }}
          >
            Import wallets
          </MenuItem>
          <MenuSeparator />
          {actions.map((a) => (
            <MenuItem
              key={a.label}
              icon={a.label.startsWith("Download") ? <FileDown /> : a.icon}
              disabled={count === 0}
              onSelect={() => {
                setOpen(false);
                void a.run();
              }}
            >
              {a.label}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}

/**
 * Trackers (DESIGN.md 5.4). A 40 px toolbar: tabs, then search (240 px), Import, Export and Add
 * wallet. From 1280 px the wallet manager stays on the left (400 px) and the tabs pick the right
 * pane (Live trades, Monitor or X); below that one pane shows the chosen tab. Panes tile with
 * 1 px hairlines, no gutters. The search filters what the panes show. Space+B buys the hovered
 * or keyboard-selected row. Layout after Axiom's wallet tracker
 * (docs.axiom.trade/wallet-tracking/adding-wallets); hairline tiling after Coinbase Advanced:
 * https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a
 */
export default function TrackersPage() {
  const wide = useMediaQuery(BREAKPOINT.xl);
  const mobile = useIsMobile();
  const tab = useTrackerPrefs((s) => s.tab);
  const pane = useTrackerPrefs((s) => s.pane);
  const setTab = useTrackerPrefs((s) => s.setTab);
  const walletCount = useTrackers((s) => s.wallets.length);
  const unreadTrades = useTrackers((s) => s.unreadTrades);
  const unreadPosts = useTrackers((s) => s.unreadPosts);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  useQuickBuyHotkey();

  const shown: TrackerTab = wide ? pane : tab;
  const showTrades = (address: string) => {
    setQuery(address);
    setTab("trades");
  };
  const openAdd = () => useWalletDialogs.getState().openAdd();

  const paneTabs: TabDef<TrackerPane>[] = [
    { id: "trades", label: "Live trades", unread: unreadTrades },
    { id: "monitor", label: "Monitor" },
    {
      id: "x",
      label: (
        <>
          <span className="font-semibold">X</span>
          <span className="sr-only">feed</span>
        </>
      ),
      unread: unreadPosts,
      title: "X feed",
    },
  ];
  const walletsTab: TabDef<TrackerTab> = { id: "wallets", label: "Wallets", count: fmtInt(walletCount) };

  let content: ReactNode;
  if (shown === "wallets") content = <WalletManager query={deferredQuery} onShowTrades={showTrades} toolbar={<WalletPaneToolbar />} />;
  else if (shown === "trades") content = <LiveTrades query={deferredQuery} onAddWallet={openAdd} />;
  else if (shown === "monitor") content = <Monitor query={deferredQuery} onAddWallet={openAdd} />;
  else content = <XPane query={deferredQuery} />;

  const search = (
    <SearchField
      value={query}
      onChange={setQuery}
      placeholder={searchPlaceholder(shown)}
      label="Search the trackers"
      mobile={mobile}
      className={mobile ? "min-w-0 flex-1" : "w-60 min-w-30 shrink"}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <h1 className="sr-only">Trackers</h1>
      {mobile ? (
        <div className="shrink-0 border-b border-hairline bg-surface-1">
          <div className="h-11 overflow-x-auto border-b border-hairline px-1">
            <TabBar<TrackerTab> tabs={[walletsTab, ...paneTabs]} value={tab} onChange={setTab} label="Trackers" idPrefix={ID} />
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            {search}
            <MobileActions />
          </div>
        </div>
      ) : (
        // 40 / 44 px, the top bar's height token (the 5.4 toolbar is 40 px at the reference density).
        <div className="flex h-topbar shrink-0 items-stretch border-b border-hairline bg-surface-1">
          {wide ? (
            <>
              {/* 400 px plus its 1 px border, so the border sits exactly over the grid's hairline gap. */}
              <div className="flex w-[401px] shrink-0 items-center gap-1 border-r border-hairline px-4">
                <span className="text-data font-medium text-fg-1">Wallets</span>
                <span className="zf-num text-data text-fg-3">{fmtInt(walletCount)}</span>
              </div>
              <TabBar<TrackerPane> tabs={paneTabs} value={pane} onChange={setTab} label="Right pane" idPrefix={ID} className="px-2" />
            </>
          ) : (
            <TabBar<TrackerTab>
              tabs={[walletsTab, ...paneTabs]}
              value={tab}
              onChange={setTab}
              label="Trackers"
              idPrefix={ID}
              className="px-2"
            />
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2 pr-2 pl-4">
            {search}
            <WalletActions />
          </div>
        </div>
      )}

      <div className={cn("grid min-h-0 flex-1 gap-px bg-hairline", wide ? "grid-cols-[400px_minmax(0,1fr)]" : "grid-cols-1")}>
        {wide && (
          <section aria-label="Wallet manager" className="flex min-h-0 min-w-0 flex-col bg-surface-1">
            <WalletManager query={deferredQuery} onShowTrades={showTrades} toolbar={<WalletPaneToolbar />} />
          </section>
        )}
        <section
          role="tabpanel"
          id={`${ID}-panel-${shown}`}
          aria-labelledby={`${ID}-tab-${shown}`}
          className="flex min-h-0 min-w-0 flex-col bg-surface-1"
        >
          {content}
        </section>
      </div>

      <WalletModal />
      <ImportWalletsModal />
    </div>
  );
}
