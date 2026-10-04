import type { ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { BottomSheet } from "../components/ui/Modal";
import { cn } from "../lib/cn";
import { fmtFee, fmtSolShort } from "../lib/format";
import { LANDING_INFO } from "../lib/landing";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex h-10 items-center justify-between gap-4 border-hairline px-3 not-first:border-t">
      <span className="text-body text-fg-3">{label}</span>
      <span className={cn("zf-num text-body", className ?? "text-fg-1")}>{children}</span>
    </div>
  );
}

function Sol({ value }: { value: string }) {
  return (
    <>
      {value}
      <span className="ml-1 text-fg-3">SOL</span>
    </>
  );
}

/**
 * Touch review sheet (DESIGN.md 5.8 "Confirm on touch"): every buy tapped on a touch screen (Pulse pills,
 * Discover, trackers, search) stops here for a compact cost summary with one CTA. Friction proportional to
 * mis-tap risk; Settings > Display turns it off. The amount leads, the execution settings sit in one
 * hairline panel of 40 px touch rows, then the CTA names the trade. After Phantom's swap review
 * (https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2) and quick-sell confirm
 * (https://mobbin.com/screens/3fad6a3a-9806-46de-810b-ed318e331d59).
 */
export function TradeReviewSheet() {
  const pending = useUi((s) => s.tradeReview);
  const setTradeReview = useUi((s) => s.setTradeReview);
  const presetId = pending?.request.preset ?? "P1";
  const preset = useSettings((s) => s.presets[presetId]);
  const settings = preset.buy;
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setTradeReview(null);
  };
  const r = pending?.request;
  const amount = r ? fmtSolShort(r.sol) : "";
  const landing = LANDING_INFO[settings.landing];

  return (
    <BottomSheet open={!!pending} onClose={() => answer(false)} title={r ? `Buy ${r.symbol}` : ""}>
      {r && (
        <div className="px-4 pt-3 pb-4">
          <div className="zf-label">You pay</div>
          <div className="zf-num mt-0.5 text-display-2 font-semibold text-fg-1">
            {amount}
            <span className="ml-1.5 text-title font-medium text-fg-3">SOL</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-md border border-hairline bg-surface-1">
            <div className="flex h-8 items-center justify-between border-b border-hairline px-3 text-data">
              <span className="font-medium text-fg-2">Preset {presetId}</span>
              <span className="text-fg-3">{preset.label}</span>
            </div>
            <Row label="Slippage">{settings.slippagePct}%</Row>
            <Row label="Priority fee">
              <Sol value={fmtFee(settings.priorityFeeSol)} />
            </Row>
            <Row label="Tip">
              <Sol value={fmtFee(settings.tipSol)} />
            </Row>
            <Row label="Landing" className={landing.risky ? "text-warn" : "text-fg-1"}>
              {landing.label}
            </Row>
            <Row label="Platform fee">0</Row>
          </div>
          <Button variant="buy" size="xl" className="mt-4 w-full" onClick={() => answer(true)}>
            Buy {r.symbol} · {amount} SOL
          </Button>
          <p className="mt-3 text-label text-fg-3">Turn this review off in Settings, under Display.</p>
        </div>
      )}
    </BottomSheet>
  );
}
