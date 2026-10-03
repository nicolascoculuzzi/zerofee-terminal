import { ArrowDownUp, Coins, Gauge, ShieldAlert, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { cn } from "../../lib/cn";
import { fmtSolShort } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset } from "../../protocol";
import { PRESET_IDS, type PresetId, useSettings } from "../../state/settings";

/** P1 / P2 / P3 switch for the globally active preset. */
export function PresetSwitch({ size = "sm", className }: { size?: "xs" | "sm"; className?: string }) {
  const active = useSettings((s) => s.activePreset);
  const setActive = useSettings((s) => s.setActivePreset);
  return (
    <Segmented<PresetId>
      size={size}
      className={className}
      value={active}
      onChange={setActive}
      options={PRESET_IDS.map((p) => ({ value: p, label: p, title: `Preset ${p}` }))}
      label="Trade preset"
    />
  );
}

/**
 * One-line summary of the active preset for a side (slippage · priority fee · tip · landing),
 * click to edit. The line format follows Axiom's trade-panel settings line; the editor popover
 * follows Coinbase Advanced's compact form fields.
 */
export function PresetSettingsRow({ side, className }: { side: "buy" | "sell"; className?: string }) {
  const presetId = useSettings((s) => s.activePreset);
  const settings = useSettings((s) => s.presets[s.activePreset][side]);
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const landing = LANDING_INFO[settings.landing];
  const LandingIcon = landing.risky ? ShieldAlert : ShieldCheck;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn("flex h-6 w-full items-center gap-3 rounded-md px-1 text-xs text-muted hover:bg-hover hover:text-fg", className)}
        title={`Edit ${presetId} ${side} settings`}
      >
        <span className="flex items-center gap-1" title="Max slippage">
          <ArrowDownUp className="icon-xs" />
          {settings.slippagePct}%
        </span>
        <span className="flex items-center gap-1" title="Priority fee (SOL)">
          <Gauge className="icon-xs" />
          {fmtSolShort(settings.priorityFeeSol)}
        </span>
        <span className="flex items-center gap-1" title="Tip (SOL)">
          <Coins className="icon-xs" />
          {fmtSolShort(settings.tipSol)}
        </span>
        <span className={cn("ml-auto flex items-center gap-1", landing.risky && "text-warn")} title={landing.note}>
          <LandingIcon className="icon-xs" />
          {landing.label}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={288}>
        <div className="space-y-2 p-1">
          <div className="text-sm font-semibold">
            {presetId} · {side === "buy" ? "Buy" : "Sell"} settings
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm">
            <span className="text-muted">Max slippage</span>
            <NumberInput
              value={settings.slippagePct}
              onChange={(v) => setPresetSide(presetId, side, { slippagePct: v ?? 0 })}
              suffix="%"
              min={0}
              max={1000}
              alignRight
              className="w-28"
              ariaLabel="Max slippage"
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm">
            <span className="text-muted">Priority fee</span>
            <NumberInput
              value={settings.priorityFeeSol}
              onChange={(v) => setPresetSide(presetId, side, { priorityFeeSol: v ?? 0 })}
              suffix="SOL"
              min={0}
              alignRight
              className="w-28"
              ariaLabel="Priority fee in SOL"
            />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-sm">
            <span className="text-muted">Tip</span>
            <NumberInput
              value={settings.tipSol}
              onChange={(v) => setPresetSide(presetId, side, { tipSol: v ?? 0 })}
              suffix="SOL"
              min={0}
              alignRight
              className="w-28"
              ariaLabel="Tip in SOL"
            />
          </div>
          <div className="space-y-1">
            <span className="zf-label">Landing</span>
            <Segmented<LandingPreset>
              className="w-full"
              value={settings.landing}
              onChange={(landingPreset) => setPresetSide(presetId, side, { landing: landingPreset })}
              options={(["reduced", "secure", "fast"] as const).map((l) => ({
                value: l,
                label: LANDING_INFO[l].label,
                title: LANDING_INFO[l].note,
              }))}
              label="Landing preset"
            />
            <p className={cn("text-xs", landing.risky ? "text-warn" : "text-dim")}>{landing.note}</p>
          </div>
        </div>
      </Popover>
    </>
  );
}
