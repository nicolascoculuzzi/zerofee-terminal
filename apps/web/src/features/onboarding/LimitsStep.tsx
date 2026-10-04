import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { fmtFee } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset } from "../../protocol";
import type { ExecutionSettings } from "../../services/tradeService";
import { useSettings } from "../../state/settings";
import { Row, Rows } from "../settings/ui";
import { StepActions, type StepFrame, StepHeader } from "./parts";

const AUTO_LOCK = [
  { value: "5", label: "5 min" },
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "0", label: "Never" },
] as const;
type AutoLock = (typeof AUTO_LOCK)[number]["value"];

/** P1's execution settings, editable in place (both sides share one landing route here). */
function PresetEditor() {
  const p1 = useSettings((s) => s.presets.P1);
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const pair = (label: string, unit: string, key: "slippagePct" | "priorityFeeSol" | "tipSol", max: number) => (
    <Row label={label}>
      <div className="grid w-full grid-cols-2 gap-2">
        {(["buy", "sell"] as const).map((side) => (
          <NumberInput
            key={side}
            value={p1[side][key]}
            onChange={(v) => {
              if (v === null) return;
              const patch: Partial<ExecutionSettings> = {};
              patch[key] = v;
              setPresetSide("P1", side, patch);
            }}
            min={0}
            max={max}
            suffix={unit}
            ariaLabel={`P1 ${side} ${label}, ${unit}`}
            className="max-md:h-11"
          />
        ))}
      </div>
    </Row>
  );
  return (
    <div className="mt-2">
      <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-x-4 text-label font-medium text-fg-3 max-sm:hidden">
        <span />
        <span className="grid grid-cols-2 gap-2 text-right">
          <span>Buy</span>
          <span>Sell</span>
        </span>
      </div>
      <Rows>
        {pair("Slippage", "%", "slippagePct", 100)}
        {pair("Priority fee", "SOL", "priorityFeeSol", 1)}
        {pair("Tip", "SOL", "tipSol", 1)}
        <Row label="Landing" help={LANDING_INFO[p1.buy.landing].note}>
          <Segmented<LandingPreset>
            value={p1.buy.landing}
            onChange={(landing) => {
              setPresetSide("P1", "buy", { landing });
              setPresetSide("P1", "sell", { landing });
            }}
            label="P1 landing route"
            className="w-full max-md:h-11"
            options={(["reduced", "secure", "fast"] as const).map((id) => ({ value: id, label: LANDING_INFO[id].label }))}
          />
        </Row>
      </Rows>
    </div>
  );
}

/*
 * Limits (DESIGN.md 4.19 step 5): per-trade cap (5 SOL), daily cap (50 SOL) and auto-lock
 * (15 min), each with help, then a summary of the default preset P1 with an "Edit" link.
 * Rows with help under each label after Buffer: https://mobbin.com/screens/8f4e0968-f06d-4fef-a1f1-f714b1f5c5e7
 */
export function LimitsStep({ frame, onDone }: { frame: StepFrame; onDone: () => void }) {
  const caps = useSettings((s) => s.caps);
  const setCaps = useSettings((s) => s.setCaps);
  const autoLock = useSettings((s) => s.autoLockMinutes);
  const setAutoLock = useSettings((s) => s.setAutoLock);
  const p1 = useSettings((s) => s.presets.P1);
  const [editing, setEditing] = useState(false);
  const lockValue: AutoLock = AUTO_LOCK.find((o) => Number(o.value) === autoLock)?.value ?? "15";
  const landing = LANDING_INFO[p1.buy.landing];

  return (
    <>
      <StepHeader frame={frame} />
      <Rows>
        <Row label="Per-trade cap" help="The largest single buy the signer will sign." htmlFor="zf-ob-cap">
          <NumberInput
            id="zf-ob-cap"
            value={caps.perTradeSol}
            onChange={(v) => v !== null && v > 0 && setCaps({ perTradeSol: v })}
            min={0.001}
            step={(v) => (v < 1 ? 0.01 : 0.1)}
            suffix="SOL"
            ariaLabel="Per-trade cap, SOL"
            className="w-full max-md:h-11"
          />
        </Row>
        <Row label="Daily cap" help="All buys in a day. Resets at local midnight." htmlFor="zf-ob-daily">
          <NumberInput
            id="zf-ob-daily"
            value={caps.dailySol}
            onChange={(v) => v !== null && v > 0 && setCaps({ dailySol: v })}
            min={0.001}
            step={1}
            suffix="SOL"
            ariaLabel="Daily cap, SOL"
            className="w-full max-md:h-11"
          />
        </Row>
        <Row label="Auto-lock" help="Locks the trading key after this long without activity.">
          <Segmented<AutoLock>
            value={lockValue}
            onChange={(v) => setAutoLock(Number(v))}
            label="Auto-lock"
            className="w-full max-md:h-11"
            options={AUTO_LOCK.map((o) => ({ value: o.value, label: o.label }))}
          />
        </Row>
      </Rows>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-data font-medium text-fg-1">Default preset · P1 {p1.label}</span>
          <button
            type="button"
            aria-expanded={editing}
            onClick={() => setEditing((e) => !e)}
            className="text-data font-medium text-fg-1 underline-offset-2 hover:underline max-md:min-h-11"
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
        {editing ? (
          <PresetEditor />
        ) : (
          <p className="mt-0.5 text-label text-fg-3">
            Slippage {p1.buy.slippagePct}% buy · {p1.sell.slippagePct}% sell · priority fee {fmtFee(p1.buy.priorityFeeSol)} SOL · tip{" "}
            {fmtFee(p1.buy.tipSol)} SOL · {landing.label} landing. P2 and P3 are in Settings.
          </p>
        )}
      </div>

      <StepActions>
        <Button size="xl" variant="primary" onClick={onDone}>
          Use these limits <ArrowRight />
        </Button>
      </StepActions>
    </>
  );
}
