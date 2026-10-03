import { ArrowRight, Check, CircleCheck, Eye, EyeOff, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { Field, Note } from "../settings/ui";
import { InlineError, StepFooter, type StepFrame, StepPanel, useAction } from "./parts";
import { MIN_PASSWORD, type PasswordStrength, passwordStrength } from "./password";

const FORM_ID = "zf-create-trading-wallet";
const LABEL_MAX = 24;

const TONE_BG: Record<PasswordStrength["tone"], string> = { neutral: "bg-elev", sell: "bg-sell", warn: "bg-warn", buy: "bg-buy" };
const TONE_TEXT: Record<PasswordStrength["tone"], string> = { neutral: "text-dim", sell: "text-sell", warn: "text-warn", buy: "text-buy" };
const SEGMENTS = [1, 2, 3, 4] as const;

/* Strength bar + label under the field, after Brave Wallet's "Create a Password":
   https://mobbin.com/screens/97d83ee4-cebc-4815-b096-295ea4431a97 */
function StrengthMeter({ strength }: { strength: PasswordStrength }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {SEGMENTS.map((n) => (
          <span key={n} className={cn("h-1 flex-1 rounded-full", strength.score >= n ? TONE_BG[strength.tone] : "bg-elev")} />
        ))}
      </div>
      <span aria-live="polite" className={cn("w-16 text-right text-xs", TONE_TEXT[strength.tone])}>
        {strength.label}
      </span>
    </div>
  );
}

/*
 * Create the trading wallet: label, password + confirm with an encryption note, or a passkey
 * instead. Anatomy after OKX's "Set wallet password":
 * https://mobbin.com/screens/ebd51bdf-709f-46e8-b863-141e132a2315
 */
export function WalletStep({
  frame,
  created,
  autoLockMinutes,
  onBusyChange,
  onCreated,
  onBack,
  onNext,
}: {
  frame: StepFrame;
  created: TradingWallet | null;
  autoLockMinutes: number;
  onBusyChange: (busy: boolean) => void;
  onCreated: (result: { wallet: TradingWallet; phrase: string[] }) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [label, setLabel] = useState("Main");
  const [usePasskey, setUsePasskey] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const strength = passwordStrength(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const valid = label.trim().length > 0 && (usePasskey || (password.length >= MIN_PASSWORD && confirm === password));
  const lockText = autoLockMinutes > 0 ? `after ${autoLockMinutes} min idle` : "when you lock it (auto-lock is off)";

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy) return;
    const res = await run(() =>
      getServices().wallet.createTradingWallet({
        label: label.trim(),
        method: usePasskey ? "passkey" : "password",
        password: usePasskey ? undefined : password,
      }),
    );
    if (!res.ok) return;
    setPassword("");
    setConfirm("");
    onCreated({ wallet: res.value.wallet, phrase: res.value.backupPhrase });
  };

  if (created) {
    return (
      <StepPanel
        {...frame}
        footer={
          <StepFooter onBack={onBack}>
            <Button size="lg" variant="primary" onClick={onNext}>
              Continue <ArrowRight className="icon-md" />
            </Button>
          </StepFooter>
        }
      >
        <div className="flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2">
          <CircleCheck className="icon-sm mt-px text-buy" />
          <div className="min-w-0 text-sm">
            <div className="font-semibold text-fg">{created.label} created</div>
            <div className="font-mono text-xs break-all text-muted">{created.address}</div>
            <div className="text-xs text-dim">
              {created.unlockMethod === "passkey" ? "Unlocks with your passkey" : "Unlocks with your password"} · locks {lockText}
            </div>
          </div>
        </div>
        <p className="text-xs text-dim">To add another trading wallet, finish setup first, then choose New wallet in the wallet menu.</p>
      </StepPanel>
    );
  }

  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter onBack={onBack} backDisabled={busy}>
          <Button type="submit" form={FORM_ID} size="lg" variant="primary" disabled={!valid || busy}>
            {busy ? "Generating and encrypting…" : "Create trading wallet"}
          </Button>
        </StepFooter>
      }
    >
      <form id={FORM_ID} className="space-y-4" onSubmit={(e) => void create(e)}>
        <Field label="Wallet label" htmlFor="zf-tw-label" className="sm:w-60">
          <input
            id="zf-tw-label"
            className="zf-input"
            value={label}
            maxLength={LABEL_MAX}
            autoComplete="off"
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        {!usePasskey && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Password (min ${MIN_PASSWORD} characters)`} htmlFor="zf-tw-password">
              <div className="relative">
                <input
                  id="zf-tw-password"
                  type={show ? "text" : "password"}
                  autoComplete="new-password"
                  className="zf-input pr-8"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={show ? "Hide password" : "Show password"}
                  aria-pressed={show}
                  onClick={() => setShow((s) => !s)}
                  className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-dim hover:text-fg"
                >
                  {show ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
                </button>
              </div>
              <StrengthMeter strength={strength} />
            </Field>
            <Field label="Confirm password" htmlFor="zf-tw-confirm">
              <input
                id="zf-tw-confirm"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                className="zf-input"
                value={confirm}
                aria-invalid={mismatch}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {confirm.length > 0 && (
                <div className={cn("mt-1 flex items-center gap-1 text-xs", mismatch ? "text-sell" : "text-buy")}>
                  {mismatch ? (
                    "Doesn't match"
                  ) : (
                    <>
                      <Check className="icon-xs" /> Matches
                    </>
                  )}
                </div>
              )}
            </Field>
          </div>
        )}

        <label
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors",
            usePasskey ? "border-line-strong bg-elev" : "border-line hover:bg-hover",
          )}
        >
          <input
            type="checkbox"
            checked={usePasskey}
            onChange={(e) => setUsePasskey(e.target.checked)}
            className="mt-px size-3 shrink-0 accent-fg"
          />
          <KeyRound className="icon-md shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-fg">Use a passkey instead</span>
            <span className="block text-xs text-muted">
              Touch ID, Windows Hello or a security key. The key is encrypted with a secret from WebAuthn PRF, so there's no password to
              remember. Simulated here: no system prompt appears.
            </span>
          </span>
        </label>

        <Note tone="info">{`The key is generated in this browser and encrypted with ${usePasskey ? "your passkey (WebAuthn PRF)" : "Argon2id from your password"}. It is never sent to our server, and it locks itself ${lockText}.`}</Note>

        {error && <InlineError>{error}</InlineError>}
      </form>
    </StepPanel>
  );
}
