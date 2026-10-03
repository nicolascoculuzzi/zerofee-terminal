import { ArrowRight, KeyRound, Lock, LockOpen, LogOut, Siren } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { CopyButton, Segmented } from "../../components/ui/controls";
import { fmtDate, shortAddr } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { errorMessage, fmtCountdown, fmtDateTime } from "./format";
import { Chip, Group, Note, Row, TabHeader } from "./ui";

const AUTO_LOCK = ["0", "5", "15", "30", "60"] as const;
type AutoLockOption = (typeof AUTO_LOCK)[number];

const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;

const METHOD_LABEL: Record<TradingWallet["unlockMethod"], string> = {
  password: "Password (Argon2id)",
  passkey: "Passkey (WebAuthn PRF)",
};

/*
 * Trading-wallet row with an "Export key" action, after Phantom's account screen
 * ("Show Private Key" row): https://mobbin.com/screens/08d5387a-14ca-43a0-b90b-0fd910a7588d
 */
function WalletRow({ wallet, exportOpen, onToggleExport }: { wallet: TradingWallet; exportOpen: boolean; onToggleExport: () => void }) {
  const simulated = getServices().simulated;
  return (
    <div className="px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-data font-semibold text-fg-1">{wallet.label}</span>
            {wallet.backedUpAt !== null ? (
              <Chip tone="buy">Backed up {fmtDate(wallet.backedUpAt)}</Chip>
            ) : (
              <Chip tone="warn">Not backed up</Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-label text-fg-2">
            <span className="inline-flex items-center gap-1 font-mono">
              {shortAddr(wallet.address, 6, 6)}
              <CopyButton text={wallet.address} label={`Copy ${wallet.label} address`} />
            </span>
            <span>{METHOD_LABEL[wallet.unlockMethod]}</span>
            <span className="text-fg-3">Created {fmtDate(wallet.createdAt)}</span>
          </div>
        </div>
        <Button size="xs" variant="secondary" icon={<KeyRound className="icon-sm" />} aria-expanded={exportOpen} onClick={onToggleExport}>
          Export key
        </Button>
      </div>
      {exportOpen && (
        <Note tone="info" className="mt-2">
          Key export runs only inside the isolated signer, never in this page: you unlock there with your{" "}
          {wallet.unlockMethod === "passkey" ? "passkey" : "password"}, and the key is shown in the signer's own window.{" "}
          {simulated
            ? "It isn't available on simulated wallets: there is no real key to export."
            : "Never paste it into chat, support DMs or any other site."}
        </Note>
      )}
    </div>
  );
}

/*
 * Security settings. Anatomy follows Kraken's security page (sign-in rows with a value and an
 * action on the right, auto sign-out) and Coinbase's active sessions list:
 * https://mobbin.com/screens/9171ec76-128d-4006-bed9-8b254cc841e7
 * https://mobbin.com/screens/a2147ea5-3c8d-4995-833a-6b4cdab9fb39
 */
export function SecurityTab() {
  const navigate = useNavigate();
  const service = useWallet((s) => s.service);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const setAutoLock = useSettings((s) => s.setAutoLock);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const closeSettings = useUi((s) => s.closeSettings);
  const now = useNow();
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const wallets = service.tradingWallets.filter((w) => !w.archived);
  const { connected, session, locked, autoLockAt } = service;
  const autoLockValue: AutoLockOption = AUTO_LOCK.find((v) => Number(v) === autoLock) ?? "15";

  const go = (to: string) => {
    closeSettings();
    navigate(to);
  };

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await getServices().wallet.disconnect();
      useToasts.getState().push({ kind: "info", title: "Wallet disconnected", body: "Sign in again to trade with your wallet." });
    } catch (e) {
      useToasts.getState().push({ kind: "error", title: "Couldn't disconnect", body: errorMessage(e) });
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <>
      <TabHeader title="Security" description="Your keys stay in this browser. The operator never holds them." />

      <Group title="Keystore">
        <Row
          label={
            <span className="flex items-center gap-2">
              {locked ? <Lock className="icon-sm text-fg-2" /> : <LockOpen className="icon-sm text-fg-2" />}
              {locked ? "Locked" : "Unlocked"}
            </span>
          }
          hint={
            locked
              ? "Unlock with your password or passkey to trade in Instant mode."
              : autoLockAt !== null
                ? `Locks in ${fmtCountdown(autoLockAt - now)} without activity.`
                : "Stays unlocked until you lock it."
          }
        >
          {locked ? (
            <Button size="xs" variant="primary" onClick={() => requestUnlock("Unlock your trading wallet.")}>
              Unlock
            </Button>
          ) : (
            <Button size="xs" variant="secondary" icon={<Lock className="icon-sm" />} onClick={() => getServices().wallet.lock()}>
              Lock now
            </Button>
          )}
        </Row>
        <Row label="Auto-lock" hint="Locks the trading key after this long without activity. 15 min is the default.">
          <Segmented<AutoLockOption>
            value={autoLockValue}
            onChange={(v) => setAutoLock(Number(v))}
            options={AUTO_LOCK.map((v) => ({ value: v, label: v === "0" ? "Never" : `${v} min` }))}
            label="Auto-lock timer"
          />
        </Row>
      </Group>

      <Group title="Trading wallets" description="Generated and encrypted in this browser; never sent to the server.">
        {wallets.length === 0 ? (
          <Row label="No trading wallet yet" hint="Create one to trade in Instant mode.">
            <Button size="xs" variant="secondary" onClick={() => go("/onboarding")}>
              Create wallet
            </Button>
          </Row>
        ) : (
          wallets.map((w) => (
            <WalletRow
              key={w.id}
              wallet={w}
              exportOpen={exportFor === w.id}
              onToggleExport={() => setExportFor((cur) => (cur === w.id ? null : w.id))}
            />
          ))
        )}
      </Group>

      <Group title="Connected wallet and session" description="Sign-In With Solana: no password or email.">
        {connected ? (
          <>
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {PROVIDER_NAME[connected.provider]}
                  <span className="inline-flex items-center gap-1 font-mono text-label text-fg-2">
                    {shortAddr(connected.address, 6, 6)}
                    <CopyButton text={connected.address} label="Copy connected wallet address" />
                  </span>
                </span>
              }
              hint="Approves funding, direct-mode trades and new withdrawal destinations."
            >
              <Button
                size="xs"
                variant="secondary"
                icon={<LogOut className="icon-sm" />}
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            </Row>
            {session ? (
              <div className="px-3 py-2">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-data text-fg-1">Session</span>
                  {session.expiresAt > now ? (
                    <Chip tone="buy">Signed in · {fmtCountdown(session.expiresAt - now)} left</Chip>
                  ) : (
                    <Chip tone="warn">Expired</Chip>
                  )}
                </div>
                <dl className="space-y-1 text-label">
                  {[
                    { k: "Domain", v: session.domain },
                    { k: "Nonce", v: session.nonce },
                    { k: "Issued at", v: fmtDateTime(session.issuedAt) },
                    { k: "Expires", v: fmtDateTime(session.expiresAt) },
                  ].map((item) => (
                    <div key={item.k} className="flex justify-between gap-4">
                      <dt className="text-fg-2">{item.k}</dt>
                      <dd className="min-w-0 truncate text-right font-mono text-fg-1">{item.v}</dd>
                    </div>
                  ))}
                </dl>
                <details className="mt-2">
                  <summary className="cursor-pointer text-label text-fg-2 hover:text-fg-1">Signed message</summary>
                  <pre className="mt-2 overflow-x-auto rounded-sm border border-hairline bg-bg p-2 font-mono text-label whitespace-pre-wrap break-all text-fg-2">
                    {session.message}
                  </pre>
                </details>
              </div>
            ) : (
              <Row label="Not signed in" hint="Sign a message with your wallet to start a session.">
                <Button size="xs" variant="secondary" onClick={() => go("/onboarding")}>
                  Sign in
                </Button>
              </Row>
            )}
          </>
        ) : (
          <Row label="No wallet connected" hint="Connect Phantom, Solflare or Backpack and sign in.">
            <Button size="xs" variant="primary" onClick={() => go("/onboarding")}>
              Connect wallet
            </Button>
          </Row>
        )}
      </Group>

      <Group title="Kill switch">
        <Row
          label={
            <span className="flex items-center gap-2">
              <Siren className="icon-sm text-sell" /> Panic
            </span>
          }
          hint="Cancels every armed order with its pre-signed cancel and locks the keystore."
        >
          <button
            type="button"
            onClick={() => go("/orders")}
            className="inline-flex items-center gap-1 text-data text-fg-1 underline underline-offset-2 hover:text-fg-2"
          >
            Open Armed orders <ArrowRight className="icon-sm" />
          </button>
        </Row>
      </Group>
    </>
  );
}
