import { Button } from "../components/ui/Button";
import { BottomSheet } from "../components/ui/Modal";
import { cn } from "../lib/cn";
import { fmtFee, fmtSolShort } from "../lib/format";
import { LANDING_INFO } from "../lib/landing";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

function Line({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex h-7 items-center justify-between text-body">
      <span className="text-fg-3">{label}</span>
      <span className={cn("zf-num", className ?? "text-fg-2")}>{value}</span>
    </div>
  );
}

/**
 * Touch review sheet (DESIGN.md 5.8 "Confirm on touch"): every buy tapped on a touch screen
 * (Pulse pills, Discover, trackers, search) stops here for a compact cost summary with one CTA.
 * Friction proportional to mis-tap risk; Settings > Display turns it off. Compact confirmation
 * after Phantom's review: https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2
 */
export function TradeReviewSheet() {
  const pending = useUi((s) => s.tradeReview);
  const setTradeReview = useUi((s) => s.setTradeReview);
  const presetId = pending?.request.preset ?? "P1";
  const settings = useSettings((s) => s.presets[presetId].buy);
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setTradeReview(null);
  };
  const r = pending?.request;
  const amount = r ? fmtSolShort(r.sol) : "";
  const landing = LANDING_INFO[settings.landing];
  const label = r ? `Buy ${r.symbol} · ${amount} SOL` : "";

  return (
    <BottomSheet open={!!pending} onClose={() => answer(false)} title={label}>
      {r && (
        <div className="px-4 pt-2 pb-4">
          <Line label="Amount" value={`${amount} SOL`} className="font-semibold text-fg-1" />
          <Line label={`Slippage (${presetId})`} value={`${settings.slippagePct}%`} />
          <Line label="Priority fee" value={`${fmtFee(settings.priorityFeeSol)} SOL`} />
          <Line label="Tip" value={`${fmtFee(settings.tipSol)} SOL`} />
          <Line label="Landing" value={landing.label} className={landing.risky ? "text-warn" : "text-fg-2"} />
          <Line label="Platform fee" value="0" className="text-fg-1" />
          <Button variant="buy" size="xl" className="mt-3 w-full" onClick={() => answer(true)}>
            {label}
          </Button>
          <p className="mt-2 text-label text-fg-3">Review before buying is on for touch screens. Turn it off in Settings under Display.</p>
        </div>
      )}
    </BottomSheet>
  );
}
