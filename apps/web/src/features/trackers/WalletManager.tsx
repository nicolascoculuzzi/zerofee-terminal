import { ArrowUpRight, Bell, BellOff, Copy, ListFilter, MoreHorizontal, Pencil, Trash2, Wallet } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Checkbox, CopyButton, Hotkey } from "../../components/ui/controls";
import { MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { useCssPx } from "../../lib/cssVar";
import { fmtInt, shortAddr } from "../../lib/format";
import { navigateTo } from "../../lib/nav";
import { useToasts } from "../../state/toasts";
import { MAX_TRACKED_WALLETS, type TrackedWallet, useTrackers } from "../../state/trackers";
import { MenuList } from "./ExportMenu";
import { normalizeQuery, walletMatches } from "./feedFilters";
import { MOBILE_ROW_PX, useHoverFocusPause, useIsMobile, useStableOrder } from "./hooks";
import { type SortDir, useTrackerPrefs, type WalletSortKey } from "./prefs";
import { Cell, CursorBar, HeaderCell, HeaderRow, rowTone, SortHeaderCell } from "./table";
import { VirtualGrid } from "./VirtualList";
import { useWalletDialogs } from "./WalletModal";

const walletKey = (w: TrackedWallet): string => w.address;
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** New rows keep the 1,200 ms highlight (DESIGN.md 6.6) after an add or an import. */
const NEW_MS = 1200;

/*
 * Wallet manager columns (DESIGN.md 5.4, 28 / 32 px rows): checkbox · avatar and name (12/500) ·
 * short mono address with copy · alerts bell · Added · Last trade ("Last tx", as 4.9's top
 * traders) · "…". Sized for the 400 px pane: the address cell is exactly 9 mono characters plus
 * the 20 px copy button; on a full-width pane the name column takes the slack.
 */
const COL = {
  check: "w-5",
  name: "min-w-0 flex-1",
  addr: "w-[calc(9ch+24px)] @max-[340px]:hidden",
  alerts: "w-5 justify-center",
  // Exactly the sortable header ("Added" / "Last" plus its 12 px arrow), so the name keeps the slack.
  added: "w-12.5 justify-end",
  last: "w-10 justify-end",
  menu: "w-5 justify-end",
} as const;

// 6 px gaps (not the table's 8) so "Diamond hands"-length names read in full in the 400 px pane.
const ROW = "flex items-center gap-1.5 px-2";

/** Removes wallets in one store write and offers Undo (a toast with an action is allowed, DESIGN.md 4.13). */
export function removeWallets(addresses: readonly string[]): void {
  const drop = new Set(addresses);
  const removed = useTrackers.getState().wallets.filter((w) => drop.has(w.address));
  if (removed.length === 0) return;
  useTrackers.setState((s) => ({ wallets: s.wallets.filter((w) => !drop.has(w.address)) }));
  const first = removed[0];
  useToasts.getState().push({
    kind: "info",
    title: removed.length === 1 && first ? `Removed ${first.name}` : `Removed ${fmtInt(removed.length)} wallets`,
    action: {
      label: "Undo",
      run: () =>
        useTrackers.setState((s) => {
          const have = new Set(s.wallets.map((w) => w.address));
          const back = removed.filter((w) => !have.has(w.address)).slice(0, Math.max(0, MAX_TRACKED_WALLETS - s.wallets.length));
          return { wallets: [...back, ...s.wallets] };
        }),
    },
  });
}

function setAlerts(addresses: ReadonlySet<string>, alerts: boolean): void {
  useTrackers.setState((s) => ({
    wallets: s.wallets.map((w) => (addresses.has(w.address) && w.alerts !== alerts ? { ...w, alerts } : w)),
  }));
}

function toggleAlerts(w: TrackedWallet): void {
  useTrackers.getState().updateWallet(w.address, { alerts: !w.alerts });
}

/** Bell / BellOff 14 px (DESIGN.md 5.4): on reads text-1, off text-3. Not a fill, so a long list stays calm. */
function AlertsToggle({ wallet, tabIndex, touch }: { wallet: TrackedWallet; tabIndex?: number; touch?: boolean }) {
  const label = wallet.alerts ? `Alerts on for ${wallet.name}. Turn off` : `Alerts off for ${wallet.name}. Turn on`;
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-pressed={wallet.alerts}
      aria-label={label}
      title={label}
      onClick={() => toggleAlerts(wallet)}
      className={cn(
        "focus-inset flex shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-surface-3",
        touch ? "size-11" : "size-6",
        wallet.alerts ? "text-fg-1" : "text-fg-3 hover:text-fg-1",
      )}
    >
      {wallet.alerts ? <Bell className="icon-sm" /> : <BellOff className="icon-sm" />}
    </button>
  );
}

/** Row "…" menu: edit, open the wallet's portfolio, its trades, copy, remove (DESIGN.md 4.17 menus). */
function RowMenu({
  wallet,
  tabIndex,
  touch,
  onShowTrades,
}: {
  wallet: TrackedWallet;
  tabIndex?: number;
  touch?: boolean;
  onShowTrades: (address: string) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <>
      <IconButton
        ref={anchor}
        size={touch ? "md" : "xs"}
        tabIndex={tabIndex}
        label={`More actions for ${wallet.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={touch ? "max-md:size-11" : undefined}
      >
        <MoreHorizontal />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={200}>
        <MenuList label={`${wallet.name} actions`}>
          <MenuItem
            icon={<Pencil />}
            hint={<Hotkey binding="Shift+Enter" />}
            onSelect={run(() => useWalletDialogs.getState().openEdit(wallet))}
          >
            Edit wallet
          </MenuItem>
          <MenuItem
            icon={<ArrowUpRight />}
            hint={<Hotkey binding="Enter" />}
            onSelect={run(() => navigateTo(`/portfolio?wallet=${encodeURIComponent(wallet.address)}`))}
          >
            Open portfolio
          </MenuItem>
          <MenuItem icon={<ListFilter />} onSelect={run(() => onShowTrades(wallet.address))}>
            Show its trades
          </MenuItem>
          <MenuItem icon={<Copy />} hint={<Hotkey binding="C" />} onSelect={run(() => void copyText(wallet.address))}>
            Copy address
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} danger onSelect={run(() => removeWallets([wallet.address]))}>
            Remove wallet
          </MenuItem>
        </MenuList>
      </Popover>
    </>
  );
}

interface RowProps {
  wallet: TrackedWallet;
  lastTradeAt: number | null;
  selected: boolean;
  active: boolean;
  onSelect: (address: string, on: boolean) => void;
  onShowTrades: (address: string) => void;
}

/**
 * Wallet manager row. Dense records table with a checkbox column and inline row actions, after
 * Twenty's companies table: https://mobbin.com/screens/36b0d5c8-9550-44ee-b7a0-30f8d10f2eed
 */
const WalletRow = memo(function WalletRow({ wallet, lastTradeAt, selected, active, onSelect, onShowTrades }: RowProps) {
  const tab = active ? 0 : -1;
  const fresh = Date.now() - wallet.createdAt < NEW_MS;
  return (
    <div
      className={cn(ROW, "relative h-full text-data", active && !selected ? "bg-surface-2" : rowTone({ selected }), fresh && "zf-enter")}
    >
      <CursorBar show={active} />
      <Cell className={cn("shrink-0", COL.check)}>
        <Checkbox
          hideLabel
          checked={selected}
          onChange={(on) => onSelect(wallet.address, on)}
          label={`Select ${wallet.name}`}
          tabIndex={tab}
        />
      </Cell>
      <Cell className={cn("items-center gap-1", COL.name)} title={wallet.name}>
        <WalletAvatar seed={wallet.address} label={wallet.name} tag={wallet.emoji} size={16} />
        <span className="truncate font-medium text-fg-1">{wallet.name}</span>
      </Cell>
      <Cell className={cn("shrink-0 items-center gap-1", COL.addr)}>
        <span className="font-mono text-fg-2" title={wallet.address}>
          {shortAddr(wallet.address)}
        </span>
        <CopyButton text={wallet.address} label={`Copy ${wallet.name}'s address (C)`} tabIndex={tab} />
      </Cell>
      <Cell className={cn("shrink-0", COL.alerts)}>
        <AlertsToggle wallet={wallet} tabIndex={tab} />
      </Cell>
      <Cell className={cn("shrink-0", COL.added)}>
        <Age ts={wallet.createdAt} />
      </Cell>
      <Cell className={cn("shrink-0", COL.last)}>{lastTradeAt !== null && <Age ts={lastTradeAt} />}</Cell>
      <Cell className={cn("shrink-0", COL.menu)}>
        <RowMenu wallet={wallet} tabIndex={tab} onShowTrades={onShowTrades} />
      </Cell>
    </div>
  );
});

/** Phone row (64 px): 44 px checkbox, avatar 24, name over the address and last trade, bell and menu at 44 px. */
const MobileWalletRow = memo(function MobileWalletRow({ wallet, lastTradeAt, selected, onSelect, onShowTrades }: Omit<RowProps, "active">) {
  return (
    <div className={cn("relative flex h-full items-center gap-2 pr-1 pl-3", selected && "bg-surface-3")}>
      <Checkbox hideLabel touch checked={selected} onChange={(on) => onSelect(wallet.address, on)} label={`Select ${wallet.name}`} />
      <WalletAvatar seed={wallet.address} label={wallet.name} tag={wallet.emoji} size={24} />
      <Cell className="min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-amount font-medium text-fg-1">{wallet.name}</span>
        <span className="flex min-w-0 items-center gap-2 text-data text-fg-2">
          <span className="truncate font-mono">{shortAddr(wallet.address)}</span>
          {lastTradeAt !== null && (
            <span className="flex shrink-0 items-center gap-1 text-fg-3">
              Last trade <Age ts={lastTradeAt} />
            </span>
          )}
        </span>
      </Cell>
      <AlertsToggle wallet={wallet} touch />
      <RowMenu wallet={wallet} touch onShowTrades={onShowTrades} />
    </div>
  );
});

const DEFAULT_DIR: Record<WalletSortKey, SortDir> = { name: "asc", added: "desc", lastTrade: "desc" };

/**
 * Wallet manager pane. Virtualised, so the full 10,000-wallet list stays fast. Checking rows
 * turns the header into a selection bar (bulk alerts and remove), after Webflow's CMS table:
 * https://mobbin.com/screens/c5300942-26fe-47a0-a0af-a5c8237e5e21
 */
export function WalletManager({
  query,
  onShowTrades,
  toolbar,
}: {
  query: string;
  onShowTrades: (address: string) => void;
  toolbar?: ReactNode;
}) {
  const wallets = useTrackers((s) => s.wallets);
  const live = useTrackers((s) => s.live);
  const sort = useTrackerPrefs((s) => s.walletSort);
  const setSort = useTrackerPrefs((s) => s.setWalletSort);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const mobile = useIsMobile();
  const rowPx = useCssPx("--zf-row", 24) + 4;
  const q = normalizeQuery(query);

  // Latest tracked trade per wallet (the feed is newest first).
  const lastTrade = useMemo(() => {
    const m = new Map<string, number>();
    for (const { trade } of live) if (!m.has(trade.maker)) m.set(trade.maker, trade.ts);
    return m;
  }, [live]);
  const lastRef = useRef(lastTrade);
  lastRef.current = lastTrade;

  const filtered = useMemo(() => (q ? wallets.filter((w) => walletMatches(w, q)) : wallets), [wallets, q]);
  // Sorting by last trade follows the feed (throttled to one re-sort per 2 s by useStableOrder).
  const resortSignal = sort.key === "lastTrade" ? lastTrade : null;
  const items = useMemo(() => (resortSignal ? [...filtered] : filtered), [filtered, resortSignal]);
  const compare = useMemo(() => {
    const sign = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "name") return (a: TrackedWallet, b: TrackedWallet) => collator.compare(a.name, b.name) * sign;
    if (sort.key === "added") return (a: TrackedWallet, b: TrackedWallet) => (a.createdAt - b.createdAt) * sign;
    return (a: TrackedWallet, b: TrackedWallet) => ((lastRef.current.get(a.address) ?? 0) - (lastRef.current.get(b.address) ?? 0)) * sign;
  }, [sort]);
  // Hover or focus pauses re-sorts only; adds and removes still show at once.
  const { paused, bind } = useHoverFocusPause();
  const rows = useStableOrder(items, walletKey, compare, paused);

  // Drop selections that no longer exist (removed elsewhere).
  const liveSelected = useMemo(() => {
    if (selected.size === 0) return selected;
    const have = new Set(wallets.map((w) => w.address));
    const next = new Set([...selected].filter((a) => have.has(a)));
    return next.size === selected.size ? selected : next;
  }, [selected, wallets]);

  const onSelect = useCallback((address: string, on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(address);
      else next.delete(address);
      return next;
    });
  }, []);
  const visibleSelected = rows.filter((w) => liveSelected.has(w.address)).length;
  const allVisible = rows.length > 0 && visibleSelected === rows.length;
  const selectAll = (on: boolean) => setSelected(on ? new Set([...liveSelected, ...rows.map((w) => w.address)]) : new Set());

  const open = useCallback((w: TrackedWallet, how: { details: boolean; newTab: boolean }) => {
    if (how.details) {
      useWalletDialogs.getState().openEdit(w);
      return;
    }
    const to = `/portfolio?wallet=${encodeURIComponent(w.address)}`;
    if (how.newTab) window.open(to, "_blank", "noopener");
    else navigateTo(to);
  }, []);
  const copy = useCallback((w: TrackedWallet) => void copyText(w.address), []);

  // Phones get 44 px targets in the selection bar (DESIGN.md 5.8).
  const selectionBar = (
    <HeaderRow className={cn(ROW, "max-md:h-11 max-md:pl-3")}>
      <HeaderCell raw className={cn(COL.check, "max-md:w-11")}>
        <Checkbox
          hideLabel
          touch={mobile}
          checked={allVisible}
          indeterminate={!allVisible && liveSelected.size > 0}
          onChange={selectAll}
          label={allVisible ? "Clear selection" : `Select all ${fmtInt(rows.length)} wallets`}
        />
      </HeaderCell>
      <HeaderCell raw className="min-w-0 flex-1 gap-2">
        <span className="zf-num shrink-0 font-medium text-fg-1">{fmtInt(liveSelected.size)} selected</span>
        <IconButton
          size="xs"
          className="max-md:size-11"
          label="Turn alerts on for the selected wallets"
          onClick={() => setAlerts(liveSelected, true)}
        >
          <Bell />
        </IconButton>
        <IconButton
          size="xs"
          className="max-md:size-11"
          label="Turn alerts off for the selected wallets"
          onClick={() => setAlerts(liveSelected, false)}
        >
          <BellOff />
        </IconButton>
        <Button
          size="xs"
          variant="danger"
          icon={<Trash2 />}
          className="max-md:h-11"
          onClick={() => {
            removeWallets([...liveSelected]);
            setSelected(new Set());
          }}
        >
          Remove wallets
        </Button>
        <Button size="xs" variant="ghost" className="ml-auto max-md:h-11" onClick={() => setSelected(new Set())}>
          Clear selection
        </Button>
      </HeaderCell>
    </HeaderRow>
  );

  const header =
    liveSelected.size > 0 ? (
      selectionBar
    ) : (
      <HeaderRow className={ROW}>
        <HeaderCell raw className={COL.check}>
          <Checkbox hideLabel checked={false} onChange={selectAll} label={`Select all ${fmtInt(rows.length)} wallets`} />
        </HeaderCell>
        <SortHeaderCell k="name" label="Wallet" sort={sort} onSort={setSort} defaultDir={DEFAULT_DIR.name} className={COL.name} />
        <HeaderCell className={COL.addr}>Address</HeaderCell>
        <HeaderCell className={COL.alerts} align="center" title="Alerts: sound and a toast when the wallet trades">
          <Bell className="icon-xs" aria-label="Alerts" />
        </HeaderCell>
        <SortHeaderCell k="added" label="Added" sort={sort} onSort={setSort} className={COL.added} align="right" />
        <SortHeaderCell
          k="lastTrade"
          label="Last"
          sort={sort}
          onSort={setSort}
          className={COL.last}
          align="right"
          define={{ label: "Last trade", text: "Age of the wallet's most recent trade in the tracked feed." }}
        />
        <HeaderCell className={COL.menu} />
      </HeaderRow>
    );

  const empty =
    wallets.length === 0 ? (
      <EmptyState
        className="text-balance"
        icon={<Wallet />}
        title="No wallets tracked yet"
        body="Add a wallet, or import a list from GMGN, BullX or a zerofee export."
        action={
          <Button size="sm" variant="secondary" onClick={() => useWalletDialogs.getState().openAdd()}>
            Add wallet
          </Button>
        }
      />
    ) : (
      <EmptyState className="text-balance" title={`No wallets match “${query.trim()}”`} body="Search by name or address." />
    );

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      {toolbar}
      <VirtualGrid
        items={rows}
        getKey={walletKey}
        rowHeight={mobile ? MOBILE_ROW_PX : rowPx}
        label="Tracked wallets"
        header={mobile && liveSelected.size === 0 ? undefined : header}
        empty={empty}
        bind={bind}
        onOpen={open}
        onCopy={copy}
        isSelected={(w) => liveSelected.has(w.address)}
        renderRow={(w, { active }) =>
          mobile ? (
            <MobileWalletRow
              wallet={w}
              lastTradeAt={lastTrade.get(w.address) ?? null}
              selected={liveSelected.has(w.address)}
              onSelect={onSelect}
              onShowTrades={onShowTrades}
            />
          ) : (
            <WalletRow
              wallet={w}
              lastTradeAt={lastTrade.get(w.address) ?? null}
              selected={liveSelected.has(w.address)}
              active={active}
              onSelect={onSelect}
              onShowTrades={onShowTrades}
            />
          )
        }
      />
    </div>
  );
}

/** "10 of 10,000 wallets", in warn when the tracker is full. */
export function WalletCount() {
  const count = useTrackers((s) => s.wallets.length);
  const full = count >= MAX_TRACKED_WALLETS;
  return (
    <span className={cn("zf-num shrink-0 text-label", full ? "text-warn" : "text-fg-3")} title="Tracked wallets and the limit">
      {fmtInt(count)} of {fmtInt(MAX_TRACKED_WALLETS)}
      {full ? " · full" : ""}
    </span>
  );
}
