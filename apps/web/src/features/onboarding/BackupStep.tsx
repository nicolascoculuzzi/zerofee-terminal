import { ArrowRight, Check } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { pickPositions, simulatedSecretKey } from "./backupKey";
import { KeyReveal } from "./KeyReveal";
import { InlineError, Spinner, StepActions, type StepFrame, StepHeader, useAction } from "./parts";

/** "7, 19 and 41". */
function listPositions(positions: number[]): string {
  if (positions.length < 2) return positions.join("");
  return `${positions.slice(0, -1).join(", ")} and ${positions[positions.length - 1]}`;
}

/*
 * Back up (DESIGN.md 4.19 step 4): the key masked until held to reveal, Copy and an encrypted
 * download, then "Enter characters 7, 19 and 41 of your key" in three 32 × 32 inputs. "I saved
 * it" stays disabled until they match; this step can't be skipped (SPEC).
 * Characters at given positions after Lloyds; "OK, I saved it" after Phantom:
 * https://mobbin.com/screens/4a81b310-337b-404b-8e19-efc674b8ca31
 * https://mobbin.com/screens/fa3d1040-f206-4de4-b236-435f1760fd1e
 */
export function BackupStep({
  frame,
  wallet,
  backedUp,
  onBusyChange,
  onConfirmed,
  onNext,
}: {
  frame: StepFrame;
  wallet: TradingWallet;
  backedUp: boolean;
  onBusyChange: (busy: boolean) => void;
  onConfirmed: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const secret = useMemo(() => simulatedSecretKey(wallet.id, wallet.address), [wallet.id, wallet.address]);
  const [positions] = useState(() => pickPositions(secret.length));
  const [chars, setChars] = useState<string[]>(() => positions.map(() => ""));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const simulated = getServices().simulated;
  const correct = positions.map((p, i) => chars[i] === secret[p - 1]);
  const verified = correct.every(Boolean);
  const filled = chars.every((c) => c !== "");

  const setChar = (i: number, value: string) => {
    const ch = value.trim().slice(-1);
    setChars((prev) => prev.map((c, j) => (j === i ? ch : c)));
    if (ch && i < positions.length - 1) inputs.current[i + 1]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === "Backspace" && !chars[i] && i > 0) {
      e.preventDefault();
      inputs.current[i - 1]?.focus();
    } else if (e.key === "ArrowLeft" && i > 0) inputs.current[i - 1]?.focus();
    else if (e.key === "ArrowRight" && i < positions.length - 1) inputs.current[i + 1]?.focus();
  };

  const confirm = async () => {
    if (backedUp) {
      onNext();
      return;
    }
    if (!verified) return;
    const res = await run(() => getServices().wallet.confirmBackup(wallet.id));
    if (res.ok) onConfirmed();
  };

  return (
    <>
      <StepHeader frame={frame} />
      <KeyReveal secret={secret} wallet={wallet} simulated={simulated} spaceAnywhere />

      <div className="mt-6 border-t border-hairline pt-4">
        {backedUp ? (
          <p className="flex items-center gap-2 text-data text-fg-1">
            <Check className="icon-xs text-buy" /> Backup verified.
          </p>
        ) : (
          <fieldset>
            <legend className="text-data font-medium text-fg-1">Enter characters {listPositions(positions)} of your key</legend>
            <p className="mt-0.5 text-label text-fg-3">
              Counting from 1, case-sensitive. This checks you saved the whole key, not just copied it.
            </p>
            <div className="mt-3 flex items-end gap-3">
              {positions.map((p, i) => (
                <label key={p} className="flex flex-col items-center gap-1">
                  <span className="zf-num text-label text-fg-3">{p}</span>
                  <input
                    ref={(el) => {
                      inputs.current[i] = el;
                    }}
                    value={chars[i] ?? ""}
                    onChange={(e) => setChar(i, e.target.value)}
                    onKeyDown={(e) => onKeyDown(e, i)}
                    onFocus={(e) => e.currentTarget.select()}
                    maxLength={2}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-label={`Character ${p} of your key`}
                    aria-invalid={chars[i] !== "" && !correct[i]}
                    className={cn(
                      "size-8 rounded-sm border bg-surface-2 text-center font-mono text-body font-medium text-fg-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus max-md:size-11",
                      chars[i] !== "" && !correct[i] ? "border-sell" : "border-hairline-strong",
                    )}
                  />
                </label>
              ))}
              <span aria-live="polite" className="flex h-8 items-center gap-1 text-label max-md:h-11">
                {verified ? (
                  <>
                    <Check className="icon-xs text-buy" />
                    <span className="text-fg-1">Matches</span>
                  </>
                ) : filled ? (
                  <span className="text-sell">Not a match. Check the key again.</span>
                ) : null}
              </span>
            </div>
          </fieldset>
        )}
      </div>
      {error && <InlineError>{error}</InlineError>}

      <StepActions>
        <Button size="xl" variant="primary" disabled={(!backedUp && !verified) || busy} onClick={() => void confirm()}>
          {busy && <Spinner />}
          {backedUp ? (
            <>
              Continue to limits <ArrowRight />
            </>
          ) : (
            "I saved it"
          )}
        </Button>
      </StepActions>
    </>
  );
}
