import { Check, Copy, Download, Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { copyText, downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { isTypingTarget } from "../../lib/hotkeys";
import { useMediaQuery } from "../../lib/useMediaQuery";
import type { TradingWallet } from "../../services/walletService";
import { Tag, useTransient } from "../settings/ui";
import { keyGroups } from "./backupKey";

const REVEAL_MS = 600;

/**
 * "Hold to reveal" (DESIGN.md 4.19): the fill grows over 600 ms while the pointer, Space or
 * Enter is held; releasing early cancels. Secondary styling: the step's primary action is
 * "I saved it". With reduced motion the label changes instead of the fill.
 */
function HoldToReveal({ onReveal, spaceAnywhere }: { onReveal: () => void; spaceAnywhere: boolean }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [progress, setProgress] = useState(0);
  const startedAt = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;

  const stop = useCallback(() => {
    startedAt.current = null;
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    setProgress(0);
  }, []);

  const tick = useCallback(() => {
    if (startedAt.current === null) return;
    const p = Math.min(1, (performance.now() - startedAt.current) / REVEAL_MS);
    setProgress(p);
    if (p >= 1) {
      stop();
      revealRef.current();
      return;
    }
    raf.current = requestAnimationFrame(tick);
  }, [stop]);

  const begin = useCallback(() => {
    if (startedAt.current !== null) return;
    startedAt.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => stop, [stop]);

  // "or hold Space": anywhere on the step, except in fields and on other controls.
  useEffect(() => {
    if (!spaceAnywhere) return;
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (isTypingTarget(target) || target?.closest("button, a, [role='slider'], [role='switch'], [role='radio']")) return;
      e.preventDefault();
      begin();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", stop);
    };
  }, [spaceAnywhere, begin, stop]);

  const holding = progress > 0;
  return (
    <button
      type="button"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      className="relative inline-flex h-7 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-sm border border-hairline-strong bg-surface-3 px-2.5 text-data font-medium text-fg-1 select-none hover:bg-surface-3-hover max-md:h-11"
    >
      {!reduced && (
        <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-hairline-strong" style={{ width: `${progress * 100}%` }} />
      )}
      <Eye className="icon-sm relative" />
      <span className="relative">{holding ? "Keep holding" : "Hold to reveal"}</span>
    </button>
  );
}

function backupFile(wallet: TradingWallet): string {
  return JSON.stringify(
    {
      app: "zerofee",
      kind: "trading-wallet-backup",
      v: 1,
      simulated: true,
      wallet: {
        label: wallet.label,
        address: wallet.address,
        unlock: wallet.unlockMethod,
        createdAt: new Date(wallet.createdAt).toISOString(),
      },
      note: "Simulated wallet: there is no real key to encrypt. The live signer writes the key here encrypted with your passphrase (Argon2id) or passkey (WebAuthn PRF).",
    },
    null,
    2,
  );
}

/**
 * The trading key, masked with "•" (never blurred) until held to reveal, shown in mono 13/500 in
 * 4-character blocks with 4 px gaps; Copy copies it without the grouping. Secret hidden until
 * revealed, copy disabled until then, after MoonPay and Family:
 * https://mobbin.com/screens/948ec472-ffa7-464e-b166-0ca51ee60fc6
 * https://mobbin.com/flows/3b9d8526-346d-4f7e-a778-6d35de6de9de
 */
export function KeyReveal({
  secret,
  wallet,
  simulated,
  spaceAnywhere = false,
  onRevealedChange,
}: {
  secret: string;
  wallet: TradingWallet;
  simulated: boolean;
  /** Onboarding: hold Space anywhere on the step. Settings: only on the button. */
  spaceAnywhere?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useTransient<true>(1200);
  const groups = keyGroups(secret);

  const setShown = (shown: boolean) => {
    setRevealed(shown);
    onRevealedChange?.(shown);
  };

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="zf-label">Private key · {wallet.label}</span>
        {simulated && <Tag tone="warn">Simulated, not a real key</Tag>}
      </div>
      <div className="flex flex-wrap gap-x-1 gap-y-1 rounded-sm bg-surface-2 p-3 font-mono text-body font-medium break-all">
        {/* Screen readers get the key in one piece (or "hidden"), not the display groups. */}
        <span className="sr-only">{revealed ? `Private key for ${wallet.label}: ${secret}` : "Private key, hidden"}</span>
        {groups.map((g, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length display groups of one string
          <span key={i} aria-hidden="true" className={revealed ? "text-fg-1" : "text-fg-3"}>
            {revealed ? g : "•".repeat(g.length)}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {revealed ? (
          <Button size="md" variant="ghost" icon={<EyeOff />} onClick={() => setShown(false)} className="max-md:h-11">
            Hide
          </Button>
        ) : (
          <HoldToReveal onReveal={() => setShown(true)} spaceAnywhere={spaceAnywhere} />
        )}
        <Button
          size="md"
          variant="secondary"
          icon={copied ? <Check /> : <Copy />}
          disabled={!revealed}
          aria-label={copied ? "Copied" : "Copy key"}
          onClick={() => {
            void copyText(secret).then((ok) => ok && setCopied(true));
          }}
          className="max-md:h-11"
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="md"
          variant="ghost"
          icon={<Download />}
          onClick={() => downloadText(`zerofee-${wallet.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-backup.json`, backupFile(wallet))}
          className="max-md:h-11"
        >
          Download encrypted backup (.json)
        </Button>
      </div>
      <p className={cn("mt-2 text-label text-fg-3")}>
        {revealed
          ? "Clipboard managers and synced notes keep what you copy. Writing it on paper is safer."
          : `Check that nobody can see your screen, then hold the button${spaceAnywhere ? " or Space" : ""} for 0.6 s.`}
      </p>
    </div>
  );
}
