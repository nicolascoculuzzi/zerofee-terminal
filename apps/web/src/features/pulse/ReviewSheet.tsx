import { Button } from "../../components/ui/Button";
import { BottomSheet } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { fmtFee, fmtSolShort } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import { buy } from "../../lib/tradeActions";
import { useSettings } from "../../state/settings";
import { tokenFor } from "./actions";
import { usePulseUi } from "./store";

function Line({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="flex h-7 items-center justify-between text-body">
      <span className="text-fg-3">{label}</span>
      <span className={cn("zf-num", className ?? "text-fg-2")}>{value}</span>
    </div>
  );
}

/**
 * Review sheet for touch screens (DESIGN.md 5.8 "Confirm on touch"): with the setting on, a tap
 * on a Pulse pill opens this compact cost summary with one CTA instead of buying at once.
 * Friction proportional to mis-tap risk; Settings > Display turns it off. Compact confirmation
 * after Phantom's review: https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2
 */
export function ReviewSheet() {
  const target = usePulseUi((s) => s.review);
  const sol = useSettings((s) => (target ? (s.columns[target.column].quickBuySol ?? s.quickBuySol) : 0));
  const presetId = useSettings((s) => (target ? (s.columns[target.column].preset ?? s.activePreset) : s.activePreset));
  const settings = useSettings((s) => s.presets[presetId].buy);
  const close = () => usePulseUi.getState().openReview(null);
  const t = target ? tokenFor(target.mint) : undefined;
  const amount = fmtSolShort(sol);
  const landing = LANDING_INFO[settings.landing];
  const label = t ? `Buy ${t.symbol} · ${amount} SOL` : "";

  return (
    <BottomSheet open={!!t} onClose={close} title={label}>
      {t && target && (
        <div className="px-4 pt-2 pb-4">
          <Line label="Amount" value={`${amount} SOL`} className="font-semibold text-fg-1" />
          <Line label={`Slippage (${presetId})`} value={`${settings.slippagePct}%`} />
          <Line label="Priority fee" value={`${fmtFee(settings.priorityFeeSol)} SOL`} />
          <Line label="Tip" value={`${fmtFee(settings.tipSol)} SOL`} />
          <Line label="Landing" value={landing.label} className={landing.risky ? "text-warn" : "text-fg-2"} />
          <Line label="Platform fee" value="0" className="text-fg-1" />
          <Button
            variant="buy"
            size="xl"
            className="mt-3 w-full"
            onClick={() => {
              close();
              void buy({ mint: target.mint, sol, preset: presetId, source: "pulse" });
            }}
          >
            {label}
          </Button>
          <p className="mt-2 text-label text-fg-3">Review before buying is on for touch screens. Turn it off in Settings under Display.</p>
        </div>
      )}
    </BottomSheet>
  );
}
