import { ArrowRight, Check, CircleCheck, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/controls";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { getServices } from "../../services";
import type { TradingWallet } from "../../services/walletService";
import { Chip, Field, Note } from "../settings/ui";
import { InlineError, StepFooter, type StepFrame, StepPanel, useAction } from "./parts";

function randomIndex(length: number): number {
  if (length <= 0) return 0;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) % length;
}

/*
 * Backup words in a numbered grid, hidden until revealed, after Phantom's recovery-phrase
 * screen: https://mobbin.com/screens/fa3d1040-f206-4de4-b236-435f1760fd1e
 * Words are masked (not rendered at all) until Reveal, rather than blurred.
 */
export function BackupStep({
  frame,
  wallet,
  phrase,
  backedUp,
  onBusyChange,
  onConfirmed,
  onBack,
  onNext,
}: {
  frame: StepFrame;
  wallet: TradingWallet;
  phrase: string[];
  backedUp: boolean;
  onBusyChange: (busy: boolean) => void;
  onConfirmed: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { busy, error, run } = useAction(onBusyChange);
  const [revealed, setRevealed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [answer, setAnswer] = useState("");
  const [copied, setCopied] = useState(false);
  const [checkIndex] = useState(() => randomIndex(phrase.length));
  const words = useMemo(() => phrase.map((word, i) => ({ n: i + 1, word })), [phrase]);
  const expected = phrase[checkIndex] ?? "";
  const correct = expected !== "" && answer.trim().toLowerCase() === expected.toLowerCase();
  const canContinue = backedUp || (saved && correct);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (await copyText(phrase.join(" "))) setCopied(true);
  };

  const confirm = async () => {
    if (backedUp) {
      onNext();
      return;
    }
    if (!canContinue) return;
    const res = await run(() => getServices().wallet.confirmBackup(wallet.id));
    if (res.ok) onConfirmed();
  };

  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter onBack={onBack} backDisabled={busy}>
          <Button size="lg" variant="primary" disabled={!canContinue || busy} onClick={() => void confirm()}>
            {busy ? "Saving…" : "Continue"} <ArrowRight className="icon-md" />
          </Button>
        </StepFooter>
      }
    >
      <div className="rounded-md border border-hairline">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-3 py-2">
          <Chip tone="warn">MOCK backup: not a real key</Chip>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              icon={revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}
              aria-pressed={revealed}
              onClick={() => setRevealed((r) => !r)}
            >
              {revealed ? "Hide" : "Reveal"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={copied ? <Check className="icon-sm text-buy" /> : <Copy className="icon-sm" />}
              disabled={!revealed}
              onClick={() => void copy()}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
        <ol aria-label={`Backup for ${wallet.label}`} className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
          {words.map((w) => (
            <li key={w.n} className="flex h-7 items-center gap-2 rounded-sm border border-hairline bg-bg px-2 text-data">
              <span className="w-5 text-right font-mono text-label text-fg-3">{w.n}</span>
              {revealed ? (
                <span className="font-mono text-fg-1">{w.word}</span>
              ) : (
                <span className="font-mono text-fg-3">
                  <span aria-hidden="true">•••••</span>
                  <span className="sr-only">Hidden</span>
                </span>
              )}
            </li>
          ))}
        </ol>
        {!revealed && <div className="px-3 pb-3 text-label text-fg-3">Hidden. Check that nobody can see your screen, then reveal.</div>}
      </div>

      {backedUp ? (
        <div className="flex items-center gap-2 text-data text-fg-1">
          <CircleCheck className="icon-sm text-buy" /> Backup confirmed.
        </div>
      ) : (
        <>
          <Field label={`Type word #${checkIndex + 1}`} htmlFor="zf-backup-check" className="sm:w-60">
            <input
              id="zf-backup-check"
              className="zf-input font-mono"
              value={answer}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={answer.trim() !== "" && !correct}
              onChange={(e) => setAnswer(e.target.value)}
            />
            {answer.trim() !== "" && (
              <div className={cn("mt-1 flex items-center gap-1 text-label", correct ? "text-buy" : "text-fg-3")}>
                {correct ? (
                  <>
                    <Check className="icon-xs" /> Correct
                  </>
                ) : (
                  "Not a match yet"
                )}
              </div>
            )}
          </Field>
          <Checkbox
            checked={saved}
            onChange={setSaved}
            label="I saved this backup somewhere safe"
            hint="Anyone with these words controls the trading wallet. Write them down and keep them offline."
          />
        </>
      )}

      <Note tone="warn">Clipboard managers and synced notes can keep what you copy. Writing the words on paper is safer.</Note>

      {error && <InlineError>{error}</InlineError>}
    </StepPanel>
  );
}
