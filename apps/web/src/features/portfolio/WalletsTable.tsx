import { KeyRound } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { Modal } from "../../components/ui/Modal";
import { Num } from "../../components/ui/Num";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSol, shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { ExportedKeyView } from "../onboarding/ExportedKeyView";
import { Money } from "./quote";
import { colW, TABLE, TD, Th } from "./table";

/**
 * Key export (DESIGN.md 1.7, 4.17): the title names the action, one sentence of consequence, both
 * outcomes on the buttons and a 1 s hold (after an unlock if the keystore is locked), then the
 * reveal view from onboarding (4.19). The live signer draws that view in its own window.
 */
function ExportKeyDialog({ wallet, balance, onClose }: { wallet: TradingWallet; balance: number; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const simulated = getServices().simulated;
  const confirmed = () => {
    if (useWallet.getState().service.locked) requestUnlock(`Unlock to export ${wallet.label}'s key.`, () => setHeld(true));
    else setHeld(true);
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={held ? `${wallet.label} key` : `Export the ${wallet.label} key?`}
      footer={
        held ? (
          <div className="flex justify-end">
            <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
              Done, hide the key
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
              Keep key hidden
            </Button>
            <HoldButton onConfirm={confirmed}>Hold to export key</HoldButton>
          </div>
        )
      }
    >
      {held ? (
        <ExportedKeyView wallet={wallet} simulated={simulated} />
      ) : (
        <p className="text-body text-fg-1">
          Anyone who sees this key controls {wallet.label} and its {fmtSol(balance)} SOL. Nobody can freeze it or get it back for you.
        </p>
      )}
    </Modal>
  );
}

/** Archive confirm: the consequence in one sentence; the service refuses while SOL or orders remain. */
function ArchiveDialog({ wallet, onClose }: { wallet: TradingWallet; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      await getServices().wallet.archiveTradingWallet(wallet.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title={`Archive ${wallet.label}?`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
            Keep wallet
          </Button>
          <Button variant="danger" size="md" disabled={busy} onClick={() => void archive()}>
            Archive {wallet.label}
          </Button>
        </div>
      }
    >
      <p className="text-body text-fg-1">
        {wallet.label} leaves every wallet list and picker. Its key stays in the signer, and your backup restores it.
      </p>
      {error && <p className="mt-2 text-label text-sell">{error}</p>}
    </Modal>
  );
}

function Actions({
  wallet,
  active,
  onExport,
  onArchive,
}: {
  wallet: TradingWallet;
  active: boolean;
  onExport: () => void;
  onArchive: () => void;
}) {
  const openFund = useUi((s) => s.openFund);
  const setActive = useWallet((s) => s.setActive);
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {!active && (
        <Button size="xs" variant="ghost" onClick={() => setActive(wallet.address)}>
          Make active
        </Button>
      )}
      <Button size="xs" variant="secondary" onClick={() => openFund("fund", wallet.address)}>
        Fund
      </Button>
      <Button size="xs" variant="secondary" onClick={() => openFund("withdraw", wallet.address)}>
        Withdraw
      </Button>
      <Button size="xs" variant="ghost" icon={<KeyRound />} onClick={onExport}>
        Export key
      </Button>
      <Button size="xs" variant="ghost" onClick={onArchive}>
        Archive
      </Button>
    </span>
  );
}

const W = { address: 15, balance: 11, holdings: 16, reserved: 10, actions: 48 } as const;

/*
 * Wallets tab (DESIGN.md 5.3): label, address, balance, holdings, SOL reserved by armed orders,
 * and actions (Fund, Withdraw, Export with hold-to-confirm, Archive). Balance, available and
 * allocation per account after Coinbase's portfolio table:
 * https://mobbin.com/screens/114d6f6f-395f-40b6-a271-bebd604f0b73
 * Destructive actions with written consequences after Mintlify's danger zone:
 * https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde
 */
export function WalletsTable({ mobile, empty }: { mobile: boolean; empty?: ReactNode }) {
  const tradingWallets = useWallet((s) => s.service.tradingWallets);
  const activeAddress = useWallet((s) => s.activeAddress);
  const status = useWallet((s) => s.status);
  const [exporting, setExporting] = useState<TradingWallet | null>(null);
  const [archiving, setArchiving] = useState<TradingWallet | null>(null);
  const wallets = useMemo(() => tradingWallets.filter((w) => !w.archived), [tradingWallets]);

  const rows = wallets.map((w) => {
    const st = status[w.address];
    let holdings = 0;
    let value = 0;
    for (const p of st?.positions ?? []) {
      if (p.closed || p.holdingTokens <= 0) continue;
      holdings++;
      value += p.valueSol;
    }
    return { wallet: w, st, holdings, value, active: w.address === activeAddress };
  });

  const dialog = (
    <>
      {exporting && (
        <ExportKeyDialog wallet={exporting} balance={status[exporting.address]?.solBalance ?? 0} onClose={() => setExporting(null)} />
      )}
      {archiving && <ArchiveDialog wallet={archiving} onClose={() => setArchiving(null)} />}
    </>
  );

  if (wallets.length === 0) return <>{empty}</>;

  if (mobile) {
    return (
      <>
        <ul aria-label="Trading wallets">
          {rows.map(({ wallet: w, st, holdings, value, active }) => (
            <li key={w.id} className="flex min-h-14 flex-col justify-center gap-1 border-b border-hairline px-3 py-2">
              <div className="flex items-center gap-2">
                <WalletAvatar seed={w.address} label={w.label} size={20} />
                <span className="min-w-0 flex-1 truncate text-body font-semibold text-fg-1">{w.label}</span>
                {active && (
                  <span className="inline-flex h-4 shrink-0 items-center rounded-xs border border-fg-1 px-1 text-micro font-semibold text-fg-1">
                    ACTIVE
                  </span>
                )}
                <span className="text-body font-semibold">
                  <Money sol={st?.solBalance ?? null} quote="SOL" />
                </span>
              </div>
              <div className="flex items-center gap-2 text-label text-fg-3">
                <span className="font-mono">{shortAddr(w.address)}</span>
                <span className="ml-auto">
                  {fmtCount(holdings)} held · <Money sol={value} />
                </span>
              </div>
            </li>
          ))}
        </ul>
        {dialog}
      </>
    );
  }

  return (
    <div className="min-h-0 overflow-auto">
      <table
        className={TABLE}
        aria-label="Trading wallets"
        style={{ minWidth: `calc(${W.address + W.balance + W.holdings + W.reserved + W.actions + 16}ch + 96px)` }}
      >
        <colgroup>
          <col />
          <col style={colW(W.address)} />
          <col style={colW(W.balance)} />
          <col style={colW(W.holdings)} />
          <col style={colW(W.reserved)} />
          <col style={colW(W.actions)} />
        </colgroup>
        <thead>
          <tr>
            <Th>Wallet</Th>
            <Th>Address</Th>
            <Th align="right">Balance SOL</Th>
            <Th align="right">Holdings</Th>
            <Th align="right" title="SOL held back for armed orders' pre-signed buys, fees and tips">
              Reserved SOL
            </Th>
            <Th align="right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ wallet: w, st, holdings, value, active }) => (
            <tr key={w.id} className={cn("h-[calc(var(--zf-row)+4px)] hover:bg-surface-2")}>
              <td className={TD}>
                <Link
                  to={active ? "/portfolio" : `/portfolio?wallet=${encodeURIComponent(w.address)}`}
                  className="group flex min-w-0 items-center gap-2"
                  title={active ? "Your active trading wallet" : `View ${w.label}'s positions`}
                >
                  <WalletAvatar seed={w.address} label={w.label} size={16} />
                  <span className="truncate font-medium text-fg-1 group-hover:underline">{w.label}</span>
                  {active && (
                    <span className="inline-flex h-4 shrink-0 items-center rounded-xs border border-fg-1 px-1 text-micro font-semibold text-fg-1">
                      ACTIVE
                    </span>
                  )}
                </Link>
              </td>
              <td className={TD}>
                <span className="inline-flex items-center gap-1 font-mono text-fg-2" title={w.address}>
                  {shortAddr(w.address)}
                  <CopyButton text={w.address} label={`Copy ${w.label} address`} />
                </span>
              </td>
              <td className={cn(TD, "text-right")}>
                <Money sol={st?.solBalance ?? null} unit={false} quote="SOL" />
              </td>
              <td className={cn(TD, "text-right")}>
                {/* An empty wallet shows nothing here rather than "0 $0.00". */}
                {holdings > 0 && (
                  <>
                    <Num value={holdings} kind="count" className="text-fg-3" /> <Money sol={value} unit={false} />
                  </>
                )}
              </td>
              <td className={cn(TD, "text-right")}>
                {st && st.reservedSol > 0 ? (
                  <Link to="/orders" className="hover:underline" title="Open armed orders">
                    <Money sol={st.reservedSol} unit={false} quote="SOL" />
                  </Link>
                ) : null}
              </td>
              <td className={cn(TD, "text-right")}>
                <Actions wallet={w} active={active} onExport={() => setExporting(w)} onArchive={() => setArchiving(w)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dialog}
    </div>
  );
}
