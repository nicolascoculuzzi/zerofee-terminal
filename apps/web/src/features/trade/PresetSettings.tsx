import { ArrowDownUp, Check, Coins, Fuel, ShieldCheck, Zap } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtFee } from "../../lib/format";
import { compactLabel } from "../../lib/hotkeys";
import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset } from "../../protocol";
import { PRESET_IDS, type PresetId, useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";

/*
 * Presets P1–P3 and their execution settings (DESIGN.md 4.11 item 6, 4.12): the one-line
 * summary "Slip 20% · Prio 0.0001 · Tip 0.00001 · Reduced" opens the preset editor popover
 * (slippage, priority fee, tip, landing preset with the SPEC route and note; Fast in warn).
 * Summary line after Axiom's trade panel; editor rows after Phantom's slippage sheet:
 * https://mobbin.com/screens/8ad7511a-588d-4b54-8134-672a9209f103
 */

/** P1 / P2 / P3 for the globally active preset (Alt+1/2/3). Switching never toasts. */
export function PresetSwitch({ size = "sm", className }: { size?: "xs" | "sm"; className?: string }) {
  const active = useSettings((s) => s.activePreset);
  const setActive = useSettings((s) => s.setActivePreset);
  const bindings = useSettings((s) => s.hotkeys);
  return (
    <Segmented<PresetId>
      size={size}
      className={className}
      value={active}
      onChange={setActive}
      options={PRESET_IDS.map((p, i) => ({
        value: p,
        label: p,
        title: `Preset ${p} (${compactLabel(bindings[`preset.${i + 1}` as "preset.1"]?.[0])})`,
      }))}
      label="Trade preset"
    />
  );
}

function LandingMark({ landing }: { landing: LandingPreset }) {
  const info = LANDING_INFO[landing];
  return (
    <span className={cn("inline-flex items-center gap-1", info.risky ? "text-warn" : undefined)}>
      {info.risky ? <Zap className="icon-xs" /> : <ShieldCheck className="icon-xs" />}
      {info.label}
    </span>
  );
}

function useEditor() {
  const [open, setOpen] = useState(false);
  return { open, setOpen, toggle: () => setOpen((o) => !o) };
}

/**
 * Trade panel execution summary (DESIGN.md 4.11 item 6): one 24 px row, xs P1|P2|P3 then the
 * settings as compact parts that open the preset editor. At the 288-320 px rail each part is a
 * 12 px icon and its value (slippage, priority fee, tip, then the landing lane's icon), as on
 * Axiom's panel; one tooltip spells them out. From a 352 px container (wide layout, mobile
 * sheet) the words replace the icons: "Slip 20%  Prio 0.0001  Tip 0.00001  Reduced".
 */
export function ExecutionSummary({ side }: { side: "buy" | "sell" }) {
  const settings = useSettings((s) => s.presets[s.activePreset][side]);
  const anchor = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  const lane = LANDING_INFO[settings.landing];
  const prio = fmtFee(settings.priorityFeeSol);
  const tip = fmtFee(settings.tipSol);
  return (
    <div ref={anchor} className="@container">
      <div className="flex h-6 items-center gap-1">
        <PresetSwitch size="xs" className="shrink-0 @max-[21rem]:[&>button]:px-1.5" />
        <Tooltip
          wrapperClassName="ml-auto min-w-0"
          content={
            <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
              <span className="text-fg-3">Slippage</span>
              <span className="zf-num text-right">{settings.slippagePct}%</span>
              <span className="text-fg-3">Priority fee</span>
              <span className="zf-num text-right">{prio} SOL</span>
              <span className="text-fg-3">Tip</span>
              <span className="zf-num text-right">{tip} SOL</span>
              <span className="text-fg-3">Landing</span>
              <span className={cn("text-right", lane.risky && "text-warn")}>{lane.label}</span>
            </span>
          }
        >
          <button
            type="button"
            onClick={editor.toggle}
            aria-expanded={editor.open}
            aria-label={`Edit ${side} settings: slippage ${settings.slippagePct}%, priority fee ${prio} SOL, tip ${tip} SOL, ${lane.label} landing`}
            className="focus-inset zf-num num-dense flex h-5 min-w-0 items-center gap-1 overflow-hidden rounded-xs px-0.5 text-label whitespace-nowrap text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg-1 @min-[22rem]:gap-2 @min-[22rem]:px-1 @min-[22rem]:[font-stretch:normal]"
          >
            <Part icon={<ArrowDownUp />} label="Slip" value={`${settings.slippagePct}%`} />
            <Part icon={<Fuel />} label="Prio" value={prio} />
            <Part icon={<Coins />} label="Tip" value={tip} />
            <span className={cn("inline-flex items-center gap-1", lane.risky ? "text-warn" : "text-fg-3")}>
              {lane.risky ? <Zap className="icon-xs" /> : <ShieldCheck className="icon-xs" />}
              <span className="hidden @min-[22rem]:inline">{lane.label}</span>
            </span>
          </button>
        </Tooltip>
      </div>
      <PresetEditor open={editor.open} onClose={() => editor.setOpen(false)} anchor={anchor} side={side} />
    </div>
  );
}

/** One summary part: a 12 px icon (narrow) or a text-3 word (wide), then the value. */
function Part({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 @min-[22rem]:gap-1">
      <span aria-hidden="true" className="inline-flex text-fg-3 @min-[22rem]:hidden [&>svg]:size-3">
        {icon}
      </span>
      <span className="hidden text-fg-3 @min-[22rem]:inline">{label}</span>
      {value}
    </span>
  );
}

/** One 20 px settings line (Instant Trade): "Slip 20% · Prio 0.0001 · Tip 0.00001 · Reduced". */
export function SettingsLine({ side, className }: { side: "buy" | "sell"; className?: string }) {
  const settings = useSettings((s) => s.presets[s.activePreset][side]);
  const anchor = useRef<HTMLButtonElement>(null);
  const editor = useEditor();
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={editor.toggle}
        aria-expanded={editor.open}
        aria-label={`Edit ${side} settings`}
        className={cn(
          "focus-inset zf-num flex h-5 w-full min-w-0 items-center gap-1 rounded-xs text-left text-label whitespace-nowrap text-fg-3 transition-colors hover:text-fg-1",
          className,
        )}
      >
        <span>Slip {settings.slippagePct}%</span>·<span>Prio {fmtFee(settings.priorityFeeSol)}</span>·
        <span>Tip {fmtFee(settings.tipSol)}</span>·
        <LandingMark landing={settings.landing} />
      </button>
      <PresetEditor open={editor.open} onClose={() => editor.setOpen(false)} anchor={anchor} side={side} />
    </>
  );
}

/** Kept for callers of the previous API: the one-line settings summary for a side. */
export function PresetSettingsRow({ side, className }: { side: "buy" | "sell"; className?: string }) {
  return <SettingsLine side={side} className={className} />;
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-data text-fg-1">{label}</span>
        {hint && <span className="block text-label text-fg-3">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** Preset editor popover: edits the active preset's buy or sell side in place (no save step). */
export function PresetEditor({
  open,
  onClose,
  anchor,
  side: initialSide,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  side: "buy" | "sell";
}) {
  const presetId = useSettings((s) => s.activePreset);
  const [side, setSide] = useState(initialSide);
  const settings = useSettings((s) => s.presets[s.activePreset][side]);
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const openSettings = useUi((s) => s.openSettings);
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    if (open) setSide(initialSide);
  }, [open, initialSide]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 1200);
    return () => clearTimeout(t);
  }, [saved]);

  const patch = (p: Parameters<typeof setPresetSide>[2]) => {
    setPresetSide(presetId, side, p);
    setSaved((n) => n + 1);
  };

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} width={300} padding="form">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-data font-semibold text-fg-1">{presetId} settings</span>
          <span className="text-label text-fg-3" aria-live="off">
            {saved ? "Saved" : ""}
          </span>
          <Segmented<"buy" | "sell">
            size="xs"
            className="ml-auto"
            value={side}
            onChange={setSide}
            tone={(v) => (v === "buy" ? "buy" : "sell")}
            options={[
              { value: "buy", label: "Buy" },
              { value: "sell", label: "Sell" },
            ]}
            label="Side to edit"
          />
        </div>
        <div className="space-y-1">
          <Row label="Max slippage" hint="Price move allowed before the fill">
            <NumberInput
              value={settings.slippagePct}
              onChange={(v) => v !== null && patch({ slippagePct: v })}
              suffix="%"
              min={0}
              max={100}
              step={1}
              className="w-28"
              ariaLabel="Max slippage"
            />
          </Row>
          <Row label="Priority fee">
            <NumberInput
              value={settings.priorityFeeSol}
              onChange={(v) => v !== null && patch({ priorityFeeSol: v })}
              suffix="SOL"
              min={0}
              max={0.1}
              step={0.0001}
              className="w-28"
              ariaLabel="Priority fee in SOL"
            />
          </Row>
          <Row label="Tip">
            <NumberInput
              value={settings.tipSol}
              onChange={(v) => v !== null && patch({ tipSol: v })}
              suffix="SOL"
              min={0}
              max={0.1}
              step={0.00001}
              className="w-28"
              ariaLabel="Tip in SOL"
            />
          </Row>
        </div>
        <div className="space-y-1">
          <div className="zf-label">Landing</div>
          <div role="radiogroup" aria-label="Landing preset" className="space-y-1">
            {(["reduced", "secure", "fast"] as const).map((l) => {
              const info = LANDING_INFO[l];
              const on = settings.landing === l;
              return (
                // biome-ignore lint/a11y/useSemanticElements: radio rows with route and note
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => patch({ landing: l })}
                  className={cn(
                    "focus-inset flex w-full items-start gap-2 rounded-sm border px-2 py-1.5 text-left transition-colors",
                    on ? "border-hairline-strong bg-surface-3" : "border-transparent hover:bg-surface-3",
                  )}
                >
                  <span aria-hidden="true" className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center text-fg-1">
                    {on && <Check className="icon-sm" />}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-data font-medium text-fg-1">
                      <LandingMark landing={l} />
                    </span>
                    <span className="block text-label text-fg-3">{info.route}</span>
                    <span className={cn("block text-label", info.risky ? "text-warn" : "text-fg-3")}>{info.note}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onClose();
            openSettings("presets");
          }}
        >
          Edit amounts and all presets in Settings
        </Button>
      </div>
    </Popover>
  );
}
