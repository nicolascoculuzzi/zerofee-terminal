import { ArrowDown, ArrowUp, Bell, BellOff, Check, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { memo, type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { shortAddr } from "../../lib/format";
import { useToasts } from "../../state/toasts";
import { MAX_TRACKED_WALLETS, type TrackedWallet, useTrackers } from "../../state/trackers";
import { SearchField } from "./bits";
import { ExportMenu, jsonExportActions } from "./ExportMenu";
import { useRowHeight } from "./hooks";
import { ImportWalletsModal } from "./ImportWalletsModal";
import { WalletGlyph } from "./TradeRow";
import { VirtualList } from "./VirtualList";
import { WalletModal } from "./WalletModal";
import { walletsToJson, walletsToLines } from "./walletImport";

type SortKey = "created" | "name";
type SortDir = "asc" | "desc";

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function removeWithUndo(wallet: TrackedWallet): void {
  const store = useTrackers.getState();
  store.removeWallet(wallet.address);
  useToasts.getState().push({
    kind: "info",
    title: "Wallet removed",
    body: wallet.name,
    action: {
      label: "Undo",
      run: () => {
        const s = useTrackers.getState();
        if (s.addWallet({ address: wallet.address, name: wallet.name, emoji: wallet.emoji, alerts: wallet.alerts })) {
          s.updateWallet(wallet.address, { createdAt: wallet.createdAt });
        }
      },
    },
  });
}

const WalletRow = memo(function WalletRow({
  wallet,
  confirming,
  onEdit,
  onConfirm,
}: {
  wallet: TrackedWallet;
  confirming: boolean;
  onEdit: (w: TrackedWallet) => void;
  onConfirm: (address: string | null) => void;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-xs hover:bg-hover">
      <Age ts={wallet.createdAt} className="w-16 shrink-0 text-dim" />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <WalletGlyph emoji={wallet.emoji} name={wallet.name} />
        <span className="truncate font-medium text-fg">{wallet.name}</span>
        <Link
          to={`/portfolio?wallet=${encodeURIComponent(wallet.address)}`}
          title={`Open ${wallet.address}`}
          className="hidden shrink-0 font-mono text-dim hover:text-fg @sm:inline"
        >
          {shortAddr(wallet.address, 4, 4)}
        </Link>
        <CopyButton text={wallet.address} label={`Copy ${wallet.name}'s address`} />
      </span>
      <span className="flex w-10 shrink-0 justify-center">
        <IconButton
          size="xs"
          active={wallet.alerts}
          label={wallet.alerts ? `Alerts on for ${wallet.name}` : `Alerts off for ${wallet.name}`}
          onClick={() => useTrackers.getState().updateWallet(wallet.address, { alerts: !wallet.alerts })}
        >
          {wallet.alerts ? <Bell className="icon-sm" /> : <BellOff className="icon-sm" />}
        </IconButton>
      </span>
      <span className="flex w-14 shrink-0 items-center justify-end gap-1">
        {confirming ? (
          <>
            <button
              type="button"
              aria-label={`Confirm removing ${wallet.name}`}
              title="Remove"
              onClick={() => {
                onConfirm(null);
                removeWithUndo(wallet);
              }}
              className="flex size-5 items-center justify-center rounded-md text-sell transition-colors hover:bg-sell/10"
            >
              <Check className="icon-sm" />
            </button>
            <IconButton size="xs" label="Keep wallet" onClick={() => onConfirm(null)}>
              <X className="icon-sm" />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton size="xs" label={`Edit ${wallet.name}`} onClick={() => onEdit(wallet)}>
              <Pencil className="icon-sm" />
            </IconButton>
            <IconButton size="xs" label={`Remove ${wallet.name}`} onClick={() => onConfirm(wallet.address)}>
              <Trash2 className="icon-sm" />
            </IconButton>
          </>
        )}
      </span>
    </div>
  );
});

function SortHeader({
  active,
  dir,
  onClick,
  className,
  children,
}: {
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  const Arrow = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? `Sorted ${dir === "asc" ? "ascending" : "descending"}; click to reverse` : "Sort"}
      className={cn("flex items-center gap-1 uppercase hover:text-fg", active && "text-muted", className)}
    >
      {children}
      {active && <Arrow className="icon-xs" />}
    </button>
  );
}

type ModalState = { kind: "add" } | { kind: "edit"; wallet: TrackedWallet } | { kind: "import" } | null;

/*
 * Wallet Manager. Dense records table after Twenty's companies table (toolbar with count and
 * actions, compact header row, inline row actions):
 * https://mobbin.com/screens/f8bd66b5-e935-465b-93d6-cf2f74b3c078
 * Virtualized, so the full 10,000-wallet list stays fast.
 */
export function WalletManager() {
  const wallets = useTrackers((s) => s.wallets);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "created", dir: "desc" });
  const [modal, setModal] = useState<ModalState>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const rowHeight = useRowHeight();
  const full = wallets.length >= MAX_TRACKED_WALLETS;

  const rows = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const list = q ? wallets.filter((w) => w.name.toLowerCase().includes(q) || w.address.toLowerCase().includes(q)) : [...wallets];
    const dir = sort.dir === "asc" ? 1 : -1;
    if (sort.key === "created") list.sort((a, b) => (a.createdAt - b.createdAt) * dir);
    else list.sort((a, b) => collator.compare(a.name, b.name) * dir);
    return list;
  }, [wallets, deferredQuery, sort]);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const onEdit = useCallback((wallet: TrackedWallet) => setModal({ kind: "edit", wallet }), []);
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "name" ? "asc" : "desc" }));

  const exportActions = jsonExportActions({
    filename: "zerofee-wallets.json",
    noun: "wallet",
    count: wallets.length,
    json: () => walletsToJson(useTrackers.getState().wallets),
    lines: { label: "Copy as text lines", text: () => walletsToLines(useTrackers.getState().wallets) },
  });

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
        <SearchField
          className="flex-1 basis-40"
          value={query}
          onChange={setQuery}
          placeholder="Search by name or address"
          label="Search wallets by name or address"
        />
        <span className={cn("text-xs whitespace-nowrap", full ? "text-warn" : "text-dim")} title="Tracked wallets / limit">
          {wallets.length.toLocaleString("en-US")} / {MAX_TRACKED_WALLETS.toLocaleString("en-US")}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="md"
            variant="subtle"
            title="Import"
            icon={<Upload className="icon-sm" />}
            onClick={() => setModal({ kind: "import" })}
          >
            <span className="hidden @lg:inline">Import</span>
          </Button>
          <ExportMenu actions={exportActions} disabled={wallets.length === 0} compactLabel />
          <Button
            size="md"
            variant="primary"
            disabled={full}
            title={full ? "Wallet limit reached" : "Add wallet"}
            icon={<Plus className="icon-sm" />}
            onClick={() => setModal({ kind: "add" })}
          >
            Add wallet
          </Button>
        </div>
      </div>

      <div className="zf-label flex h-6 shrink-0 items-center gap-2 border-b border-line px-3">
        <SortHeader className="w-16 shrink-0" active={sort.key === "created"} dir={sort.dir} onClick={() => toggleSort("created")}>
          Created
        </SortHeader>
        <SortHeader className="min-w-0 flex-1" active={sort.key === "name"} dir={sort.dir} onClick={() => toggleSort("name")}>
          Name
        </SortHeader>
        <span className="w-10 shrink-0 text-center">Alert</span>
        <span className="w-14 shrink-0 text-right">Actions</span>
      </div>

      {wallets.length === 0 ? (
        <p className="px-3 py-4 text-sm text-dim">No wallets yet. Add one, or import a list from GMGN or BullX.</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-4 text-sm text-dim">No wallets match “{deferredQuery.trim()}”.</p>
      ) : (
        <VirtualList
          label="Tracked wallets"
          count={rows.length}
          rowHeight={rowHeight}
          getKey={(i) => rows[i]?.address ?? i}
          renderRow={(i) => {
            const w = rows[i];
            return w ? <WalletRow wallet={w} confirming={confirming === w.address} onEdit={onEdit} onConfirm={setConfirming} /> : null;
          }}
        />
      )}

      <WalletModal
        open={modal?.kind === "add" || modal?.kind === "edit"}
        editing={modal?.kind === "edit" ? modal.wallet : null}
        onClose={() => setModal(null)}
      />
      <ImportWalletsModal open={modal?.kind === "import"} onClose={() => setModal(null)} />
    </div>
  );
}
