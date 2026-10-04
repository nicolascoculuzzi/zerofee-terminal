import { Check, ShieldCheck, Zap } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput, Segmented } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
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
 * Trade panel execution summary: the P1|P2|P3 switch with the landing chip, then the fee line.
 * Two rows so every label stays readable at the 288 px rail.
 */
export function ExecutionSummary({ side }: { side: "buy" | "sell" }) {
  const settings = useSettings((s) => s.presets[s.activePreset][side]);
  const anchor = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  return (
    <div ref={anchor} className="space-y-1">
      <div className="flex h-6 items-center gap-2">
        <PresetSwitch size="xs" />
        <button
          type="button"
          onClick={editor.toggle}
          aria-expanded={editor.open}
          title={LANDING_INFO[settings.landing].note}
          className="focus-inset ml-auto flex h-5 items-center rounded-xs px-1 text-label text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg-1"
        >
          <LandingMark landing={settings.landing} />
        </button>
      </div>
      <button
        type="button"
        onClick={editor.toggle}
        aria-expanded={editor.open}
        aria-label={`Edit ${side} settings: slippage ${settings.slippagePct}%, priority fee ${fmtFee(settings.priorityFeeSol)} SOL, tip ${fmtFee(settings.tipSol)} SOL`}
        className="focus-inset flex h-5 w-full items-center gap-2 rounded-xs text-left text-label text-fg-2 transition-colors hover:text-fg-1"
      >
        <SummaryParts slippage={settings.slippagePct} priority={settings.priorityFeeSol} tip={settings.tipSol} />
      </button>
      <PresetEditor open={editor.open} onClose={() => editor.setOpen(false)} anchor={anchor} side={side} />
    </div>
  );
}

function SummaryParts({ slippage, priority, tip }: { slippage: number; priority: number; tip: number }) {
  return (
    <span className="zf-num flex min-w-0 items-center gap-1 truncate">
      <span>
        <span className="text-fg-3">Slip</span> {slippage}%
      </span>
      <span className="text-fg-3">·</span>
      <span>
        <span className="text-fg-3">Prio</span> {fmtFee(priority)}
      </span>
      <span className="text-fg-3">·</span>
      <span>
        <span className="text-fg-3">Tip</span> {fmtFee(tip)}
      </span>
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
