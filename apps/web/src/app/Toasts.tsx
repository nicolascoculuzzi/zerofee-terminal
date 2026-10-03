import { AlertTriangle, CheckCircle2, ChevronDown, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { CopyButton } from "../components/ui/controls";
import { cn } from "../lib/cn";
import { fmtMs, fmtSol, fmtTokens } from "../lib/format";
import { useSettings } from "../state/settings";
import { type Toast, useToasts } from "../state/toasts";
import { type ClientTrade, useTrades } from "../state/trades";
import { LatencyBreakdownView } from "./StatusBar";

const STAGES: { key: ClientTrade["stage"]; label: string }[] = [
  { key: "built", label: "Built" },
  { key: "signed", label: "Signed" },
  { key: "received", label: "Received" },
  { key: "sent", label: "Sent" },
  { key: "landed", label: "Landed" },
];

const ORDER: ClientTrade["stage"][] = ["clicked", "built", "signed", "received", "sent", "landed"];

function TradeToastBody({ trade }: { trade: ClientTrade }) {
  const [open, setOpen] = useState(false);
  const verb = trade.side === "buy" ? "Buy" : "Sell";
  const idx = ORDER.indexOf(trade.stage);
  const fill = trade.receipt?.fill;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        {trade.status === "pending" && <LoaderCircle size={13} className="animate-spin text-accent" />}
        {trade.status === "confirmed" && <CheckCircle2 size={13} className="text-buy" />}
        {trade.status === "failed" && <XCircle size={13} className="text-sell" />}
        <span className={cn(trade.side === "buy" ? "text-buy" : "text-sell")}>{verb}</span>
        <span className="truncate">
          ${trade.symbol} · {trade.label}
        </span>
      </div>
      {trade.status === "pending" && (
        <div className="mt-1.5 flex gap-1">
          {STAGES.map((s, i) => (
            <span
              key={s.key}
              className={cn("h-1 flex-1 rounded-full", idx >= i + 1 ? "bg-accent" : idx === i ? "zf-live-dot bg-accent/50" : "bg-elev")}
              title={s.label}
            />
          ))}
        </div>
      )}
      {trade.status === "confirmed" && trade.receipt && (
        <div className="mt-0.5 text-[11px] text-muted">
          {fill &&
            (fill.side === "buy"
              ? `${fmtTokens(fill.tokenAmount)} tokens for ${fmtSol(fill.solAmount)} SOL`
              : `${fmtTokens(fill.tokenAmount)} tokens → ${fmtSol(fill.solAmount)} SOL`)}{" "}
          · landed in <span className="font-semibold text-fg">{fmtMs(trade.receipt.latency.landedMs)}</span>
        </div>
      )}
      {trade.status === "failed" && <div className="mt-0.5 text-[11px] text-sell/90">{trade.error ?? "Failed"}</div>}
      {trade.receipt && (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-dim">
          {trade.receipt.signature && (
            <span className="flex items-center gap-0.5 font-mono">
              {trade.receipt.signature.slice(0, 10)}…
              <CopyButton text={trade.receipt.signature} label="Copy signature" size={10} />
            </span>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} className="ml-auto flex items-center gap-0.5 hover:text-fg">
            Latency <ChevronDown size={10} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        </div>
      )}
      {open && trade.receipt && (
        <div className="mt-2 border-t border-line pt-2">
          <LatencyBreakdownView latency={trade.receipt.latency} status={trade.receipt.status} />
        </div>
      )}
    </div>
  );
}

const ToastItem = memo(function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const trade = useTrades((s) => (toast.tradeId ? s.items.find((t) => t.id === toast.tradeId) : undefined));
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (toast.ttl === null || hover) return;
    const remaining = Math.max(500, toast.ttl - (Date.now() - toast.createdAt));
    const t = setTimeout(() => dismiss(toast.id), remaining);
    return () => clearTimeout(t);
  }, [toast.ttl, toast.createdAt, toast.id, dismiss, hover]);

  const icon =
    toast.kind === "success" ? (
      <CheckCircle2 size={14} className="text-buy" />
    ) : toast.kind === "error" ? (
      <XCircle size={14} className="text-sell" />
    ) : toast.kind === "warn" ? (
      <AlertTriangle size={14} className="text-warn" />
    ) : (
      <Info size={14} className="text-info" />
    );

  return (
    <div
      role="status"
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      className={cn(
        "pointer-events-auto flex w-[320px] max-w-[calc(100vw-24px)] gap-2 rounded-lg border bg-panel p-2.5 shadow-pop",
        trade?.status === "failed" || toast.kind === "error"
          ? "border-sell/30"
          : trade?.status === "confirmed" || toast.kind === "success"
            ? "border-buy/25"
            : toast.kind === "warn"
              ? "border-warn/30"
              : "border-line-strong",
      )}
    >
      {trade ? (
        <TradeToastBody trade={trade} />
      ) : (
        <>
          <div className="pt-0.5">{icon}</div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold">{toast.title}</div>
            {toast.body && <div className="mt-0.5 break-words text-[11px] text-muted">{toast.body}</div>}
            {toast.action && (
              <button
                type="button"
                className="mt-1 text-[11px] font-semibold text-accent hover:underline"
                onClick={() => {
                  toast.action?.run();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
        className="self-start rounded p-0.5 text-dim hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
});

const POSITION: Record<string, string> = {
  "top-right": "top-14 right-3 items-end",
  "bottom-right": "bottom-10 right-3 items-end flex-col-reverse",
  "bottom-left": "bottom-10 left-3 items-start flex-col-reverse",
  "top-center": "top-14 left-1/2 -translate-x-1/2 items-center",
};

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const position = useSettings((s) => s.display.toastPosition);
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed z-[180] flex flex-col gap-2 max-md:bottom-16",
        POSITION[position] ?? POSITION["bottom-right"],
      )}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
