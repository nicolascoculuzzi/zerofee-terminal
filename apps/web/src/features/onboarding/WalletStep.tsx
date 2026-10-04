import { ArrowRight, Check, Eye, EyeOff } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { TradingWallet, UnlockMethod } from "../../services/walletService";
import { InlineError, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";
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
  const [method, setMethod] = useState<UnlockMethod>("passkey");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const checks = passphraseChecks(passphrase);
  const matches = confirm.length > 0 && confirm === passphrase;
  const valid = method === "passkey" || (checks.every((c) => c.met) && matches);
  const simulated = getServices().simulated;
  const lockText = autoLockMinutes > 0 ? `after ${autoLockMinutes} minutes without activity` : "only when you lock it";

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
        <div className="border-y border-hairline py-3">
          <div className="flex items-center gap-2 text-data font-medium text-fg-1">
            <Check className="icon-xs" /> {created.label} created
          </div>
          <div className="mt-1 font-mono text-data break-all text-fg-2">{created.address}</div>
          <div className="mt-1 text-label text-fg-3">
            Unlocks with your {created.unlockMethod === "passkey" ? "passkey" : "passphrase"} and locks {lockText}.
          </div>
        </div>
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
        <Segmented<UnlockMethod>
          value={method}
          onChange={setMethod}
          label="Unlock method"
          className="w-full max-md:h-11"
          options={[
            { value: "passkey", label: "Passkey (recommended)" },
            { value: "password", label: "Passphrase" },
          ]}
        />

        {method === "passkey" ? (
          <p className="mt-4 text-body text-fg-2">
            Touch ID, Windows Hello or a security key unlocks the wallet. The key is encrypted with a secret from WebAuthn PRF, so there is
            nothing to remember or type.{simulated && " Simulated: no system prompt appears."}
          </p>
        ) : (
          <div className="mt-4 space-y-3">
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

        <p className="mt-4 text-label text-fg-3">The key is generated and encrypted in this browser. zerofee never receives it.</p>
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
