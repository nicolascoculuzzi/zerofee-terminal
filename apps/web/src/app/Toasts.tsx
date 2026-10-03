import { AlertTriangle, ArrowUpRight, Check, ChevronDown, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { CopyButton } from "../components/ui/controls";
import { cn } from "../lib/cn";
import { fmtFee, fmtInt, fmtMs, fmtSol, fmtTokens, shortAddr } from "../lib/format";
import { useMediaQuery } from "../lib/useMediaQuery";
import { useNow } from "../lib/useNow";
import { useSettings } from "../state/settings";
import { type Toast, useToasts } from "../state/toasts";
import { type ClientTrade, useTrades } from "../state/trades";
import { LatencyBreakdownView } from "./Latency";

/*
 * Transaction toasts (DESIGN.md 4.13): one toast per trade, updated in place from pending to
 * landed or failed. Verb phrase, stages with milliseconds, signature row, latency expander and
 * a 2px stage bar. Phantom's in-progress then past-tense pair:
 * https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4
 * Solflare's Transaction ID and Explorer rows: https://mobbin.com/flows/3a34df63-f2e0-454d-8a1a-d95d5fd95f4c
 */

const STAGE_LABEL: { key: "built" | "signed" | "sent"; label: string }[] = [
  { key: "built", label: "Built" },
  { key: "signed", label: "Signed" },
  { key: "sent", label: "Sent" },
];

/** Stage bar segments: built, signed, sent, landed. */
const BAR: ClientTrade["stage"][] = ["built", "signed", "sent", "landed"];
const RANK: Record<ClientTrade["stage"], number> = { clicked: 0, built: 1, signed: 2, received: 2, sent: 3, landed: 4, failed: 0 };

function verbPhrase(t: ClientTrade): { verb: string; rest: string; tone: "buy" | "sell" | "fail" } {
  const fill = t.receipt?.fill;
  if (t.status === "failed")
    return { verb: t.side === "buy" ? "Buy failed" : "Sell failed", rest: t.error ? ` · ${t.error}` : "", tone: "fail" };
  if (t.status === "confirmed" && fill) {
    return t.side === "buy"
      ? { verb: "Bought", rest: ` ${fmtTokens(fill.tokenAmount)} ${t.symbol} for ${fmtSol(fill.solAmount)} SOL`, tone: "buy" }
      : { verb: "Sold", rest: ` ${fmtTokens(fill.tokenAmount)} ${t.symbol} for ${fmtSol(fill.solAmount)} SOL`, tone: "sell" };
  }
  return t.side === "buy"
    ? { verb: "Buying", rest: ` ${t.symbol} · ${t.label}`, tone: "buy" }
    : { verb: "Selling", rest: ` ${t.label} of ${t.symbol}`, tone: "sell" };
}

function Elapsed({ from }: { from: number }) {
  const now = useNow();
  return <span className="zf-num ml-auto shrink-0 text-fg-2">{fmtMs(Math.max(0, now - from))}</span>;
}

function TradeToastBody({ trade, onDismiss }: { trade: ClientTrade; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const { verb, rest, tone } = verbPhrase(trade);
  const receipt = trade.receipt;
  const fill = receipt?.fill;
  const rank = RANK[trade.stage];
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2 pr-6 text-body font-semibold text-fg-1">
        <span className="mt-0.5 flex shrink-0 [&_svg]:size-3.5">
          {trade.status === "pending" && <LoaderCircle className="animate-spin text-fg-2" />}
          {trade.status === "confirmed" && <Check className="text-fg-1" />}
          {trade.status === "failed" && <XCircle className="text-sell" />}
        </span>
        <span className="min-w-0">
          <span className={tone === "buy" ? "text-buy" : tone === "sell" ? "text-sell" : "text-sell"}>{verb}</span>
          {rest}
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-5.5 text-label text-fg-2">
        {trade.status === "pending" && (
          <>
            <span className="min-w-0 truncate">
              {STAGE_LABEL.filter((s) => trade.stageAt?.[s.key] !== undefined)
                .map((s) => `${s.label} ${fmtMs(trade.stageAt?.[s.key])}`)
                .concat(rank >= 3 ? ["Landing…"] : [])
                .join(" · ") || "Building…"}
            </span>
            <Elapsed from={trade.startedAt} />
          </>
        )}
        {trade.status === "confirmed" && receipt && (
          <span className="truncate">
            Landed in {fmtMs(receipt.latency.landedMs)}
            {receipt.latency.slot !== null && ` · slot ${fmtInt(receipt.latency.slot)}`}
            {trade.landing && ` · ${trade.landing}`}
          </span>
        )}
        {trade.status === "failed" && (
          <span className="truncate">
            {fill?.fees
              ? `Fee ${fmtFee(fill.fees.baseFeeSol + fill.fees.priorityFeeSol)} SOL charged`
              : trade.amountSol !== undefined
                ? `${fmtSol(trade.amountSol)} SOL not spent`
                : "Nothing was spent"}
          </span>
        )}
      </div>

      {receipt && (
        <div className="mt-1 flex items-center gap-2 pl-5.5 text-label text-fg-3">
          {receipt.signature && (
            <span className="flex items-center gap-0.5">
              <span className="font-mono">{shortAddr(receipt.signature)}</span>
              <CopyButton text={receipt.signature} label="Copy signature" />
            </span>
          )}
          {receipt.signature && (
            <span className="flex items-center gap-0.5" title="Explorer links are off on simulated data">
              Solscan <ArrowUpRight className="icon-xs" />
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="ml-auto flex items-center gap-0.5 transition-colors hover:text-fg-1"
          >
            Latency <ChevronDown className={cn("icon-xs", open && "rotate-180")} />
          </button>
        </div>
      )}

      {open && receipt && (
        <div className="mt-2 border-t border-hairline pt-2">
          <LatencyBreakdownView latency={receipt.latency} status={receipt.status} />
        </div>
      )}

      {trade.status === "failed" && trade.retry && (
        <div className="mt-2 flex gap-2 pl-5.5">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              onDismiss();
              trade.retry?.();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {trade.status === "pending" && (
        <div className="absolute inset-x-0 bottom-0 flex h-0.5 gap-px" aria-hidden="true">
          {BAR.map((s, i) => (
            <span key={s} className={cn("flex-1", rank > i ? "bg-fg-2" : rank === i ? "bg-fg-3" : "bg-transparent")} />
          ))}
        </div>
      )}
    </div>
  );
}

const ToastItem = memo(function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const trade = useTrades((s) => (toast.tradeId ? s.items.find((t) => t.id === toast.tradeId) : undefined));
  const [hold, setHold] = useState(false);

  useEffect(() => {
    if (toast.ttl === null || hold) return;
    const remaining = Math.max(500, toast.ttl - (Date.now() - toast.createdAt));
    const t = setTimeout(() => dismiss(toast.id), remaining);
    return () => clearTimeout(t);
  }, [toast.ttl, toast.createdAt, toast.id, dismiss, hold]);

  const icon =
    toast.kind === "success" ? (
      <Check className="text-fg-1" />
    ) : toast.kind === "error" ? (
      <XCircle className="text-sell" />
    ) : toast.kind === "warn" ? (
      <AlertTriangle className="text-warn" />
    ) : (
      <Info className="text-fg-3" />
    );

  // Live regions only on transaction toasts: status for pending and landed, alert for failed.
  const live = trade ? (trade.status === "failed" ? { role: "alert" } : { role: "status", "aria-live": "polite" as const }) : {};
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus pause the dismiss timer
    <div
      {...live}
      onPointerEnter={() => setHold(true)}
      onPointerLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={() => setHold(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          dismiss(toast.id);
        }
      }}
      className={cn(
        "zf-in-sheet pointer-events-auto relative flex w-[340px] max-w-[calc(100vw-24px)] gap-2 overflow-hidden rounded-md border bg-floating px-3 py-2.5 shadow-e2",
        trade?.status === "failed" ? "border-sell-edge" : "border-hairline-strong",
      )}
    >
      {trade ? (
        <TradeToastBody trade={trade} onDismiss={() => dismiss(toast.id)} />
      ) : (
        <>
          <span className="mt-0.5 flex shrink-0 [&_svg]:size-3.5">{icon}</span>
          <div className="min-w-0 flex-1 pr-6">
            <div className="text-body font-semibold text-fg-1">{toast.title}</div>
            {toast.body && <div className="mt-0.5 break-words text-label text-fg-2">{toast.body}</div>}
            {toast.action && (
              <Button
                size="xs"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </Button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss (Esc)"
        onClick={() => dismiss(toast.id)}
        className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-xs text-fg-3 transition-colors hover:text-fg-1"
      >
        <X className="icon-xs" />
      </button>
    </div>
  );
});

/** 12px from the edges; the bottom offset clears the 24px status bar. */
const POSITION: Record<string, string> = {
  "top-right": "top-13 right-3 items-end",
  "bottom-right": "bottom-9 right-3 items-end flex-col-reverse",
  "bottom-left": "bottom-9 left-3 items-start flex-col-reverse",
  "top-center": "top-13 left-1/2 -translate-x-1/2 items-center",
};

const MAX_VISIBLE = 4;

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const position = useSettings((s) => s.display.toastPosition);
  const mobile = useMediaQuery("(max-width: 767px)");
  // Mobile toasts appear top-centre under the header (DESIGN.md 5.8).
  const pos = mobile ? "top-13 left-1/2 -translate-x-1/2 items-center" : (POSITION[position] ?? POSITION["bottom-right"]);
  const visible = toasts.slice(-MAX_VISIBLE);
  const hidden = toasts.length - visible.length;
  return (
    <div className={cn("pointer-events-none fixed z-toast flex flex-col gap-2", pos)}>
      {visible.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
      {hidden > 0 && (
        <span className="pointer-events-auto rounded-xs border border-hairline-strong bg-floating px-2 py-0.5 text-label text-fg-2 shadow-e1">
          +{hidden} more
        </span>
      )}
    </div>
  );
}
