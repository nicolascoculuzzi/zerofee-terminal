import { KeyRound, Lock, LockOpen, LogOut, OctagonX } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { ProgressBar } from "../../components/ui/bits";
import { CopyButton, Hotkey } from "../../components/ui/controls";
import { HoldButton } from "../../components/ui/HoldButton";
import { WalletAvatar } from "../../components/ui/TokenAvatar";
import { fmtDate, fmtFee, fmtInt, fmtSol, shortAddr } from "../../lib/format";
import { useNow } from "../../lib/useNow";
import { getServices } from "../../services";
import type { TradeMode } from "../../services/tradeService";
import type { TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { simulatedSecretKey } from "../onboarding/backupKey";
import { KeyReveal } from "../onboarding/KeyReveal";
import { errorMessage, fmtCountdown, fmtDateTime } from "./format";
import { MODE_INFO, MODES } from "./modes";
import { Block, InlineStatus, Note, RadioRow, Row, Rows, SectionHeader, SelectMenu, SubHeader, Tag, useTransient } from "./ui";
import { WithdrawalDestinations } from "./WithdrawalDestinations";

const PROVIDER_NAME = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" } as const;
const METHOD_LABEL: Record<TradingWallet["unlockMethod"], string> = {
  password: "Passphrase (Argon2id)",
  passkey: "Passkey (WebAuthn PRF)",
};
/** Rent-exempt minimum of an 80-byte durable-nonce account: 1,447,680 lamports. */
const NONCE_RENT_SOL = 0.00144768;

const AUTO_LOCK: { value: string; label: string }[] = [
  { value: "0", label: "Never" },
  { value: "5", label: "5 minutes" },
  { value: "15", label: "15 minutes (default)" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
];

/** "Chrome on macOS" from the user agent, for the session list. Local only. */
function deviceName(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "This browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Key export (DESIGN.md 4.17, 5.5): a 1 s hold-to-confirm whose buttons name both outcomes, an
 * unlock if the keystore is locked, then the reveal flow from onboarding (4.19).
 */
function ExportKey({ wallet, onClose }: { wallet: TradingWallet; onClose: () => void }) {
  const requestUnlock = useUi((s) => s.requestUnlock);
  const balance = useWallet((s) => s.status[wallet.address]?.solBalance ?? null);
  const simulated = getServices().simulated;
  const [stage, setStage] = useState<"confirm" | "reveal">("confirm");

  const confirmed = () => {
    if (useWallet.getState().service.locked) {
      requestUnlock(`Unlock to export ${wallet.label}'s key.`, () => setStage("reveal"));
      return;
    }
    setStage("reveal");
  };

  if (stage === "reveal") {
    return (
      <div className="space-y-3 pb-2">
        <KeyReveal secret={simulatedSecretKey(wallet.id, wallet.address)} wallet={wallet} simulated={simulated} />
        {simulated && <Note>In the live app the isolated signer draws this view in its own window, never this page.</Note>}
        <Button size="sm" variant="secondary" onClick={onClose}>
          Done, hide the key
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2 pb-2">
      <p className="max-w-[72ch] text-label text-fg-2">
        Anyone with this key controls {wallet.label}
        {balance !== null ? ` and its ${fmtSol(balance)} SOL` : ""}. Nobody can freeze it or get it back for you. Never paste it into chat,
        a support DM or another site.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="md" variant="secondary" onClick={onClose} className="max-md:h-11">
          Keep it hidden
        </Button>
        <HoldButton onConfirm={confirmed} className="max-md:h-11">
          Hold to export key
        </HoldButton>
      </div>
    </div>
  );
}

function WalletRow({
  wallet,
  active,
  exporting,
  onExport,
}: {
  wallet: TradingWallet;
  active: boolean;
  exporting: boolean;
  onExport: (open: boolean) => void;
}) {
  const setActive = useWallet((s) => s.setActive);
  const balance = useWallet((s) => s.status[wallet.address]?.solBalance ?? null);
  return (
    <div>
      <Row
        control="wide"
        label={
          <span className="inline-flex items-center gap-2">
            <WalletAvatar seed={wallet.address} label={wallet.label} size={20} />
            {wallet.label}
            {active && <Tag>Active</Tag>}
            {wallet.backedUpAt === null && <Tag tone="warn">Not backed up</Tag>}
          </span>
        }
        help={
          <span className="inline-flex flex-wrap items-center gap-x-1">
            <span className="font-mono text-fg-2">{shortAddr(wallet.address)}</span>
            <CopyButton text={wallet.address} label={`Copy ${wallet.label} address`} />
            <span>
              {[
                balance !== null ? `${fmtSol(balance)} SOL` : null,
                METHOD_LABEL[wallet.unlockMethod],
                wallet.backedUpAt !== null ? `backed up ${fmtDate(wallet.backedUpAt)}` : `created ${fmtDate(wallet.createdAt)}`,
              ]
                .filter(Boolean)
                .map((part) => `· ${part}`)
                .join(" ")}
            </span>
          </span>
        }
      >
        {!active && (
          <Button size="xs" variant="ghost" onClick={() => setActive(wallet.address)}>
            Make active
          </Button>
        )}
        <Button size="xs" variant="secondary" icon={<KeyRound />} aria-expanded={exporting} onClick={() => onExport(!exporting)}>
          Export key
        </Button>
      </Row>
      {exporting && <ExportKey wallet={wallet} onClose={() => onExport(false)} />}
    </div>
  );
}

/*
 * Wallets and security (DESIGN.md 5.5): trading wallets with export, signing mode, keystore and
 * auto-lock, withdrawal destinations, nonce slots, sessions, and a two-column danger zone with
 * written consequences. Danger zone after Mintlify; linked-account chip after OpenSea:
 * https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde
 * https://mobbin.com/flows/5ab8ab32-84d8-4c0b-81a8-9604e657b23e
 */
export function WalletsSection({ initialExport }: { initialExport?: boolean }) {
  const navigate = useNavigate();
  const service = useWallet((s) => s.service);
  const activeAddress = useWallet((s) => s.activeAddress);
  const mode = useWallet((s) => s.mode);
  const setMode = useWallet((s) => s.setMode);
  const nonceSlots = useWallet((s) => (s.activeAddress ? (s.status[s.activeAddress]?.nonceSlots ?? null) : null));
  const defaultMode = useSettings((s) => s.defaultMode);
  const setDefaultMode = useSettings((s) => s.setDefaultMode);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const setAutoLock = useSettings((s) => s.setAutoLock);
  const lockKey = useSettings((s) => s.hotkeys["wallet.lock"]?.[0]);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const closeSettings = useUi((s) => s.closeSettings);
  const openPanic = useUi((s) => s.openPanic);
  const now = useNow();
  const wallets = service.tradingWallets.filter((w) => !w.archived);
  const activeWallet = wallets.find((w) => w.address === activeAddress) ?? wallets[0] ?? null;
  const [exportFor, setExportFor] = useState<string | null>(initialExport && activeWallet ? activeWallet.id : null);
  const [signedOut, setSignedOut] = useTransient<true>(8000);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { connected, session, locked, autoLockAt } = service;

  const go = (to: string) => {
    closeSettings();
    navigate(to);
  };

  const chooseMode = (m: TradeMode) => {
    setDefaultMode(m);
    setMode(m);
  };

  const signOut = async () => {
    setSignOutError(null);
    try {
      await getServices().wallet.disconnect();
      setSignedOut(true);
    } catch (e) {
      setSignOutError(errorMessage(e));
    }
  };

  const free = nonceSlots ? Math.max(0, nonceSlots.total - nonceSlots.used) : 0;

  return (
    <>
      <SectionHeader
        title="Wallets and security"
        description="Keys are generated and encrypted in this browser. zerofee never holds them."
      />

      <SubHeader anchor="wallets">Trading wallets</SubHeader>
      <Rows>
        {wallets.length === 0 ? (
          <Row label="No trading wallet yet" help="Create one to trade in Instant mode.">
            <Button size="xs" variant="secondary" onClick={() => go("/onboarding")}>
              Create a wallet
            </Button>
          </Row>
        ) : (
          wallets.map((w) => (
            <WalletRow
              key={w.id}
              wallet={w}
              active={w.address === activeWallet?.address}
              exporting={exportFor === w.id}
              onExport={(open) => setExportFor(open ? w.id : null)}
            />
          ))
        )}
      </Rows>

      <SubHeader anchor="signing">Signing</SubHeader>
      <Rows>
        {MODES.map((m) => (
          <RadioRow
            key={m}
            name="zf-default-mode"
            checked={defaultMode === m}
            onSelect={() => chooseMode(m)}
            title={`${MODE_INFO[m].label}${m === "instant" ? " (default)" : ""}`}
            meta={mode === m ? <Tag>In use now</Tag> : undefined}
          >
            <span className="block text-fg-2">{MODE_INFO[m].summary}</span>
            <span className="block">{MODE_INFO[m].detail}</span>
          </RadioRow>
        ))}
      </Rows>

      <SubHeader anchor="keystore">Keystore</SubHeader>
      <Rows>
        <Row
          label={
            <span className="inline-flex items-center gap-2">
              {locked ? <Lock className="icon-sm text-fg-3" /> : <LockOpen className="icon-sm text-fg-2" />}
              {locked ? "Locked" : "Unlocked"}
            </span>
          }
          help={
            locked
              ? "Unlock with your passphrase or passkey to trade in Instant mode."
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
            <Button size="xs" variant="secondary" icon={<Lock />} onClick={() => getServices().wallet.lock()} title="Lock now">
              Lock now {lockKey && <Hotkey binding={lockKey} className="ml-1" />}
            </Button>
          )}
        </Row>
        <Row label="Auto-lock" help="Locks the trading key after this long without activity.">
          <SelectMenu value={String(autoLock)} onChange={(v) => setAutoLock(Number(v))} options={AUTO_LOCK} label="Auto-lock" />
        </Row>
        <Row
          label="Unlock method"
          help="Switching between passkey and passphrase re-encrypts the key inside the isolated signer. Not available on simulated wallets."
        >
          {activeWallet ? (
            <span className="text-data text-fg-2">{METHOD_LABEL[activeWallet.unlockMethod]}</span>
          ) : (
            <span className="text-data text-fg-4">–</span>
          )}
        </Row>
      </Rows>

      <WithdrawalDestinations />

      <SubHeader anchor="nonce">Nonce slots</SubHeader>
      <Rows>
        <Row
          label="Durable-nonce slots"
          help={`Each armed order rides on a durable-nonce account holding ${fmtFee(NONCE_RENT_SOL)} SOL of rent, refunded when the slot is closed.`}
        >
          {nonceSlots ? (
            <div className="flex w-full flex-col items-end gap-1">
              <span className="zf-num text-data text-fg-1">
                {fmtInt(nonceSlots.used)} of {fmtInt(nonceSlots.total)} in use
              </span>
              <ProgressBar value={nonceSlots.total > 0 ? nonceSlots.used / nonceSlots.total : 0} color="bg-fg-2" />
              <span className="zf-num text-label text-fg-3">{fmtFee(nonceSlots.total * NONCE_RENT_SOL)} SOL rent</span>
            </div>
          ) : (
            <span className="text-data text-fg-4">–</span>
          )}
        </Row>
        <Row
          label="Reclaim rent"
          help={
            free > 0
              ? `Closes the ${free} free slot${free === 1 ? "" : "s"} and returns ${fmtFee(free * NONCE_RENT_SOL)} SOL. Needs the live signer; the simulation keeps a fixed pool.`
              : "Every slot is in use by an armed order. Cancel orders to free slots."
          }
        >
          <Button size="xs" variant="secondary" disabled>
            Reclaim {free > 0 ? `${fmtFee(free * NONCE_RENT_SOL)} SOL` : "rent"}
          </Button>
        </Row>
      </Rows>

      <SubHeader anchor="sessions" actions={signedOut ? <InlineStatus>Signed out</InlineStatus> : null}>
        Sessions
      </SubHeader>
      <Rows>
        {connected && session ? (
          <>
            <Row
              control="wide"
              label={
                <span className="inline-flex items-center gap-2">
                  {deviceName()} <Tag>This browser</Tag>
                </span>
              }
              help={
                <span className="inline-flex flex-wrap items-center gap-x-1">
                  Signed in with {PROVIDER_NAME[connected.provider]}
                  <span className="font-mono text-fg-2">{shortAddr(connected.address)}</span>
                  <CopyButton text={connected.address} label="Copy connected wallet address" />
                  <span>· {session.expiresAt > now ? `expires in ${fmtCountdown(session.expiresAt - now)}` : "expired"}</span>
                </span>
              }
            >
              <Button size="xs" variant="secondary" icon={<LogOut />} onClick={() => void signOut()}>
                Sign out
              </Button>
            </Row>
            <Block>
              <details className="group">
                <summary className="cursor-pointer text-label text-fg-2 hover:text-fg-1">Session details and signed message</summary>
                <dl className="mt-2 grid grid-cols-[96px_minmax(0,1fr)] gap-x-4 gap-y-1 text-label">
                  <dt className="text-fg-3">Domain</dt>
                  <dd className="truncate font-mono text-fg-2">{session.domain}</dd>
                  <dt className="text-fg-3">Nonce</dt>
                  <dd className="truncate font-mono text-fg-2">{session.nonce}</dd>
                  <dt className="text-fg-3">Issued</dt>
                  <dd className="text-fg-2">{fmtDateTime(session.issuedAt)}</dd>
                  <dt className="text-fg-3">Expires</dt>
                  <dd className="text-fg-2">{fmtDateTime(session.expiresAt)}</dd>
                </dl>
                <pre className="mt-2 overflow-x-auto rounded-sm bg-surface-2 p-3 font-mono text-label whitespace-pre-wrap break-all text-fg-2">
                  {session.message}
                </pre>
              </details>
            </Block>
          </>
        ) : (
          <Row
            label="Not signed in"
            help={connected ? "Sign a message with your wallet to start a session." : "Connect Phantom, Solflare or Backpack and sign in."}
          >
            <Button size="xs" variant="primary" onClick={() => go("/onboarding")}>
              {connected ? "Sign in" : "Connect a wallet"}
            </Button>
          </Row>
        )}
        <Row label="Other devices" help="None. Sessions on other devices appear here with Revoke." />
      </Rows>
      {signOutError && <p className="mt-1 text-label text-sell">{signOutError}</p>}

      <SubHeader anchor="danger">Danger zone</SubHeader>
      <Rows>
        <Row
          label="Panic"
          help="Cancels every armed order with its stored pre-signed cancel and locks the keystore. Re-arm by hand what you still want."
        >
          <Button size="sm" variant="danger" icon={<OctagonX />} onClick={openPanic} className="max-md:h-11">
            Cancel all and lock…
          </Button>
        </Row>
        <Row
          label="Remove trading wallet"
          help={`Removes ${activeWallet?.label ?? "the wallet"} from this browser. Withdraw its SOL first: only your backup can bring it back. Not available on simulated wallets.`}
        >
          <Button size="sm" variant="danger" disabled className="max-md:h-11">
            Remove {activeWallet?.label ?? "wallet"}
          </Button>
        </Row>
      </Rows>
    </>
  );
}
