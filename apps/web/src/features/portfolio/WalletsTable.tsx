import { KeyRound } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { Modal } from "../../components/ui/Modal";
import { Num } from "../../components/ui/Num";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSol, shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { Money } from "./quote";
import { colW, TABLE, TD, Th } from "./table";

/**
 * Key export confirm (DESIGN.md 1.7, 4.17): the title names the action, one sentence of
 * consequence, both outcomes on the buttons, and the action needs a 1 s hold. The key itself
 * is only ever shown by the isolated signer (SPEC), never on this page.
 */
function ExportKeyDialog({ wallet, balance, onClose }: { wallet: TradingWallet; balance: number; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  const simulated = getServices().simulated;
  return (
    <Modal
      open
      onClose={onClose}
      width={400}
      title={`Export the ${wallet.label} key?`}
      footer={
        held ? (
          <div className="flex justify-end">
            <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
              Done
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="md" onClick={onClose} data-autofocus>
              Keep key hidden
            </Button>
            <HoldButton onConfirm={() => setHeld(true)}>Hold to export key</HoldButton>
          </div>
        )
      }
    >
      {held ? (
        <p className="text-body text-fg-1">
          {simulated
            ? "This is a simulated wallet: there is no real key to export."
            : "The signer window now shows the key. It never appears on this page; close that window when you're done."}
        </p>
      ) : (
        <p className="text-body text-fg-1">
          Anyone who sees this key controls {wallet.label} and its {fmtSol(balance)} SOL. It opens in the isolated signer's window, never on
          this page.
        </p>
      )}
    </Modal>
  );
}

function Actions({ wallet, active, onExport }: { wallet: TradingWallet; active: boolean; onExport: () => void }) {
  const openFund = useUi((s) => s.openFund);
  const setActive = useWallet((s) => s.setActive);
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {active ? (
        <>
          <Button size="xs" variant="secondary" onClick={() => openFund("fund")}>
            Fund
          </Button>
          <Button size="xs" variant="secondary" onClick={() => openFund("withdraw")}>
            Withdraw
          </Button>
        </>
      ) : (
        <Tooltip content={`Trade from ${wallet.label}; Fund and Withdraw act on the active wallet`}>
          <Button size="xs" variant="secondary" onClick={() => setActive(wallet.address)}>
            Make active
          </Button>
        </Tooltip>
      )}
      <Button size="xs" variant="ghost" icon={<KeyRound />} onClick={onExport}>
        Export key
      </Button>
      {/* aria-disabled (not disabled) so the reason stays reachable by hover and focus. */}
      <Tooltip content="Archiving runs in the signer; simulated wallets can't be archived">
        <button
          type="button"
          aria-disabled="true"
          className="inline-flex h-5 cursor-not-allowed items-center rounded-sm px-1.5 text-label font-medium text-fg-4"
        >
          Archive
        </button>
      </Tooltip>
    </span>
  );
}

const W = { address: 15, balance: 11, holdings: 16, reserved: 10, actions: 34 } as const;

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

  const dialog = exporting && (
    <ExportKeyDialog wallet={exporting} balance={status[exporting.address]?.solBalance ?? 0} onClose={() => setExporting(null)} />
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
                <Num value={holdings} kind="count" className="text-fg-3" /> <Money sol={value} unit={false} />
              </td>
              <td className={cn(TD, "text-right")}>
                {st && st.reservedSol > 0 ? (
                  <Link to="/orders" className="hover:underline" title="Open armed orders">
                    <Money sol={st.reservedSol} unit={false} quote="SOL" />
                  </Link>
                ) : (
                  <Money sol={st?.reservedSol ?? null} unit={false} quote="SOL" className="text-fg-3" />
                )}
              </td>
              <td className={cn(TD, "text-right")}>
                <Actions wallet={w} active={active} onExport={() => setExporting(w)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dialog}
    </div>
  );
}
