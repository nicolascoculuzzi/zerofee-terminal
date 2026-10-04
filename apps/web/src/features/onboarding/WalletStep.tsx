import { ArrowRight, Check, Eye, EyeOff, Fingerprint, KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { shortAddr } from "../../lib/format";
import { getServices } from "../../services";
import type { TradingWallet, UnlockMethod } from "../../services/walletService";
import { useWallet } from "../../state/wallet";
import { InlineError, Panel, PanelRow, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";
import { passphraseChecks } from "./password";

const FORM_ID = "zf-create-trading-wallet";
const WALLET_LABEL = "Main";

/*
 * Trading wallet (DESIGN.md 4.19 step 3): "Passkey (recommended) | Passphrase". The passphrase
 * path has a confirm field and a live checklist whose checks turn buy as they're met.
 * Live requirement checklist after Marcus: https://mobbin.com/screens/2fb82752-386b-4dbd-a84d-49c5b75eab7e
 */
export function WalletStep({
  frame,
  created,
  autoLockMinutes,
  onBusyChange,
  onCreated,
  onNext,
}: {
  frame: StepFrame;
  created: TradingWallet | null;
  autoLockMinutes: number;
  onBusyChange: (busy: boolean) => void;
  onCreated: (wallet: TradingWallet) => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const { simulated, features } = getServices();
  // The live signer is passphrase-only for now, and its keystore holds every trading wallet: a second
  // wallet joins the existing keystore under its passphrase instead of a new one.
  const existing = useWallet((s) => !simulated && s.service.tradingWallets.length > 0);
  const [method, setMethod] = useState<UnlockMethod>(features.passkey ? "passkey" : "password");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const checks = passphraseChecks(passphrase);
  const matches = confirm.length > 0 && confirm === passphrase;
  const valid = method === "passkey" || (existing ? passphrase.length > 0 : checks.every((c) => c.met) && matches);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    const res = await run(() =>
      getServices().wallet.createTradingWallet({
        label: WALLET_LABEL,
        method,
        password: method === "password" ? passphrase : undefined,
      }),
    );
    if (!res.ok) return;
    setPassphrase("");
    setConfirm("");
    onCreated(res.value.wallet);
  };

  if (created) {
    return (
      <>
        <StepHeader frame={frame} />
        <Panel>
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-2.5 text-data font-medium text-fg-1">
            <Check className="icon-xs text-buy" /> {created.label} wallet created
          </div>
          <PanelRow label="Address">
            <span className="inline-flex items-center gap-1 font-mono text-fg-2">
              {shortAddr(created.address)}
              <CopyButton text={created.address} label="Copy trading wallet address" />
            </span>
          </PanelRow>
          <PanelRow label="Unlocks with">{created.unlockMethod === "passkey" ? "Passkey" : "Passphrase"}</PanelRow>
          <PanelRow label="Auto-lock">{autoLockMinutes > 0 ? `After ${autoLockMinutes} min idle` : "Only when you lock it"}</PanelRow>
        </Panel>
        <StepActions>
          <Button size="xl" variant="primary" onClick={onNext}>
            Continue to back up <ArrowRight />
          </Button>
        </StepActions>
      </>
    );
  }

  return (
    <>
      <StepHeader frame={frame} />
      <form id={FORM_ID} onSubmit={(e) => void create(e)}>
        {features.passkey && !existing && <MethodPicker value={method} onChange={setMethod} />}

        {existing ? (
          <div className="space-y-2">
            <p className="text-body text-fg-2">
              The new wallet joins the keystore you already have in this browser and unlocks with the same passphrase.
            </p>
            <label htmlFor="zf-tw-pass" className="zf-label mb-1 block">
              Keystore passphrase
            </label>
            <input
              id="zf-tw-pass"
              type="password"
              autoComplete="current-password"
              className="zf-input max-md:h-11 max-md:text-title"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </div>
        ) : method === "passkey" ? (
          simulated && <p className="mt-3 text-label text-fg-3">Simulated: no system prompt appears.</p>
        ) : (
          <div className={cn("space-y-3", features.passkey && "mt-4")}>
            <div>
              <label htmlFor="zf-tw-pass" className="zf-label mb-1 block">
                Passphrase
              </label>
              <div className="relative">
                <input
                  id="zf-tw-pass"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  className="zf-input pr-9 max-md:h-11 max-md:text-title"
                  value={passphrase}
                  aria-describedby="zf-tw-checks"
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={show ? "Hide passphrase" : "Show passphrase"}
                  aria-pressed={show}
                  onClick={() => setShow((s) => !s)}
                  className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-fg-3 hover:text-fg-1"
                >
                  {show ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="zf-tw-confirm" className="zf-label mb-1 block">
                Confirm passphrase
              </label>
              <input
                id="zf-tw-confirm"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                className="zf-input max-md:h-11 max-md:text-title"
                value={confirm}
                aria-invalid={confirm.length > 0 && !matches}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <ul id="zf-tw-checks" aria-live="polite" className="space-y-1 text-label">
              {[...checks, { id: "match", label: "Both entries match", met: matches }].map((c) => (
                <li key={c.id} className={cn("flex items-center gap-2", c.met ? "text-fg-1" : "text-fg-3")}>
                  <Check className={cn("icon-xs", c.met ? "text-buy" : "text-fg-4")} />
                  {c.label}
                  <span className="sr-only">{c.met ? ", met" : ", not met yet"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="mt-4 flex gap-2 text-label text-fg-3">
          <ShieldCheck className="icon-xs mt-px shrink-0" />
          The key is generated and encrypted in this browser. zerofee never receives it.
        </p>
        {error && <InlineError>{error}</InlineError>}

        <StepActions>
          <Button type="submit" form={FORM_ID} size="xl" variant="primary" disabled={!valid || busy}>
            {busy && <Spinner />}
            {busy ? "Creating wallet" : "Create wallet"}
          </Button>
        </StepActions>
      </form>
    </>
  );
}

const METHODS: { value: UnlockMethod; icon: typeof Fingerprint; title: string; tag?: string; body: string }[] = [
  {
    value: "passkey",
    icon: Fingerprint,
    title: "Passkey",
    tag: "Recommended",
    body: "Touch ID, Windows Hello or a security key. Nothing to remember or type.",
  },
  { value: "password", icon: KeyRound, title: "Passphrase", body: "A passphrase you type to unlock. 12 characters or more." },
];

/** Passkey | Passphrase as two radio rows with a one-line consequence each (DESIGN.md 4.19 step 3). */
function MethodPicker({ value, onChange }: { value: UnlockMethod; onChange: (m: UnlockMethod) => void }) {
  return (
    <div role="radiogroup" aria-label="Unlock method" className="grid gap-2">
      {METHODS.map((m) => {
        const on = value === m.value;
        const Icon = m.icon;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a radio row with icon, title and description
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(m.value)}
            className={cn(
              "flex items-start gap-3 rounded-md border px-3 py-3 text-left transition-colors",
              on ? "border-fg-3 bg-surface-2" : "border-hairline hover:border-hairline-strong hover:bg-surface-2",
            )}
          >
            <Icon className={cn("icon-md mt-px shrink-0", on ? "text-fg-1" : "text-fg-3")} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-body font-medium text-fg-1">
                {m.title}
                {m.tag && <span className="rounded-xs bg-surface-3 px-1 text-micro font-medium text-fg-2">{m.tag}</span>}
              </span>
              <span className="mt-0.5 block text-label text-fg-3">{m.body}</span>
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                on ? "border-accent bg-accent" : "border-hairline-strong",
              )}
            >
              {on && <span className="size-1.5 rounded-full bg-ink" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
