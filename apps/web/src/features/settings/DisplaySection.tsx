import { RotateCcw, Volume2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { MetricLabel } from "../../components/ui/bits";
import { Hotkey, NumberInput, Segmented, Switch } from "../../components/ui/controls";
import type { HotkeyAction } from "../../lib/hotkeys";
import { bandsText, RISK_DEFAULTS, RISK_LETTER, type RiskKey, type RiskThresholds } from "../../lib/metrics";
import { playTone } from "../../lib/sound";
import { type ColourVision, type Density, type QuoteCurrency, type Theme, type ToastPosition, useSettings } from "../../state/settings";
import { InlineStatus, Row, Rows, SectionHeader, SelectMenu, Slider, SubHeader, useTransient } from "./ui";

const TOAST_POSITIONS: { value: ToastPosition; label: string }[] = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-center", label: "Top centre" },
];

const RISK_KEYS: RiskKey[] = ["top10", "dev", "snipers", "insiders", "bundlers"];
const RISK_NAME: Record<RiskKey, string> = {
  top10: "Top 10 holders",
  dev: "Dev holdings",
  snipers: "Snipers",
  insiders: "Insiders",
  bundlers: "Bundlers",
};

function KeyHint({ action }: { action: HotkeyAction }) {
  const binding = useSettings((s) => s.hotkeys[action]?.[0]);
  if (!binding) return null;
  return (
    <>
      {" "}
      <Hotkey binding={binding} className="align-middle" /> toggles it.
    </>
  );
}

function sameThresholds(a: RiskThresholds, b: RiskThresholds): boolean {
  return RISK_KEYS.every((k) => a[k][0] === b[k][0] && a[k][1] === b[k][1]);
}

/** One min/max row: the amber band starts at the first value, red at the second (DESIGN.md 3.11). */
function ThresholdRow({ k }: { k: RiskKey }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const setDisplay = useSettings((s) => s.setDisplay);
  const [saved0, saved1] = thresholds[k];
  const [draft, setDraft] = useState<[number | null, number | null]>([saved0, saved1]);
  // Follow outside changes (Reset, another tab) while keeping an invalid draft visible.
  useEffect(() => setDraft([saved0, saved1]), [saved0, saved1]);
  const [mid, high] = draft;
  const valid = mid !== null && high !== null && mid > 0 && high > mid && high <= 100;

  const update = (next: [number | null, number | null]) => {
    setDraft(next);
    const [m, h] = next;
    if (m !== null && h !== null && m > 0 && h > m && h <= 100) {
      setDisplay({ riskThresholds: { ...useSettings.getState().display.riskThresholds, [k]: [m, h] } });
    }
  };

  const label: ReactNode = (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className="inline-flex size-4 items-center justify-center rounded-xs bg-surface-3 text-micro font-medium text-fg-3"
      >
        {RISK_LETTER[k]}
      </span>
      <MetricLabel metric={k} bands={bandsText(k, thresholds)}>
        {RISK_NAME[k]}
      </MetricLabel>
    </span>
  );
  return (
    <Row
      label={label}
      help={
        valid ? (
          bandsText(k, thresholds)
        ) : (
          <span className="text-sell">Amber must start below red, and red at 100% or less. The saved bands stay until this is fixed.</span>
        )
      }
    >
      <div className="grid w-full grid-cols-2 gap-2">
        <NumberInput
          value={mid}
          onChange={(v) => update([v, high])}
          min={0}
          max={100}
          step={1}
          suffix="%"
          invalid={!valid}
          ariaLabel={`${RISK_NAME[k]}: amber from, percent`}
        />
        <NumberInput
          value={high}
          onChange={(v) => update([mid, v])}
          min={0}
          max={100}
          step={1}
          suffix="%"
          invalid={!valid}
          ariaLabel={`${RISK_NAME[k]}: red from, percent`}
        />
      </div>
    </Row>
  );
}

/*
 * Display (DESIGN.md 5.5): theme, density, colour vision, quote, Pulse insert mode, toasts, risk
 * thresholds, sound, touch confirmation. Label/description rows with right-hand controls after
 * Buffer's preferences: https://mobbin.com/screens/8f4e0968-f06d-4fef-a1f1-f714b1f5c5e7
 */
export function DisplaySection() {
  const display = useSettings((s) => s.display);
  const setDisplay = useSettings((s) => s.setDisplay);
  const [thresholdsReset, setThresholdsReset] = useTransient<RiskThresholds>(6000);
  const volumePct = Math.round(display.soundVolume * 100);
  const customBands = !sameThresholds(display.riskThresholds, RISK_DEFAULTS);

  return (
    <>
      <SectionHeader title="Display" description="How the terminal looks and sounds. Saved in this browser as you change it." />

      <SubHeader>Appearance</SubHeader>
      <Rows>
        <Row anchor="theme" label="Theme" help="System follows your operating system.">
          <Segmented<Theme>
            value={display.theme}
            onChange={(theme) => setDisplay({ theme })}
            label="Theme"
            className="w-full max-md:h-11"
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
              { value: "system", label: "System" },
            ]}
          />
        </Row>
        <Row
          anchor="density"
          label="Density"
          help={
            <>
              Auto is compact on a desktop with a mouse and comfortable on touch.
              <KeyHint action="density.toggle" />
            </>
          }
        >
          <Segmented<Density>
            value={display.density}
            onChange={(density) => setDisplay({ density })}
            label="Density"
            className="w-full max-md:h-11"
            options={[
              { value: "auto", label: "Auto" },
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </Row>
        <Row
          anchor="cvd"
          label="Colour vision"
          help="Blue/orange replaces green and red for buy and sell, for red-green colour blindness. Sides stay written as B/S and signs stay on changes."
        >
          <Segmented<ColourVision>
            value={display.cvd}
            onChange={(cvd) => setDisplay({ cvd })}
            label="Colour vision"
            className="w-full max-md:h-11"
            options={[
              { value: "default", label: "Green/red" },
              { value: "blue-orange", label: "Blue/orange" },
            ]}
          />
        </Row>
        <Row
          anchor="quote"
          label="Quote currency"
          help={
            <>
              Market caps, liquidity, volume, values and PnL. Amounts you enter are always SOL.
              <KeyHint action="quote.toggle" />
            </>
          }
        >
          <Segmented<QuoteCurrency>
            value={display.quote}
            onChange={(quote) => setDisplay({ quote })}
            label="Quote currency"
            className="w-full max-md:h-11"
            options={[
              { value: "USD", label: "USD" },
              { value: "SOL", label: "SOL" },
            ]}
          />
        </Row>
        <Row anchor="toasts" label="Toast position" help="Where trade progress and order events appear. Phones always use the top.">
          <SelectMenu<ToastPosition>
            value={display.toastPosition}
            onChange={(toastPosition) => setDisplay({ toastPosition })}
            options={TOAST_POSITIONS}
            label="Toast position"
            className="max-md:h-11"
          />
        </Row>
      </Rows>

      <SubHeader anchor="insert">Pulse</SubHeader>
      <Rows>
        <Row label="Insert mode" help="Live adds new tokens at the feed rate. Calm adds them at most once per second, in batches.">
          <Segmented<"live" | "calm">
            value={display.insertMode}
            onChange={(insertMode) => setDisplay({ insertMode })}
            label="Pulse insert mode"
            className="w-full max-md:h-11"
            options={[
              { value: "live", label: "Live" },
              { value: "calm", label: "Calm" },
            ]}
          />
        </Row>
        <Row
          label="Refresh rate"
          help="How often Pulse lists repaint. Lower is calmer and lighter on the CPU; new tokens are never dropped."
        >
          <Slider
            value={display.pulseHz}
            min={4}
            max={10}
            step={1}
            ticks={[4, 5, 6, 7, 8, 9, 10]}
            onChange={(pulseHz) => setDisplay({ pulseHz })}
            label="Pulse refresh rate"
            valueText={`${display.pulseHz} Hz`}
          />
          <span className="zf-num w-12 shrink-0 text-right text-data text-fg-1">{display.pulseHz} Hz</span>
        </Row>
        <Row
          label="Colour risk chips"
          help="Low, mid and high bands in green, amber and red. Off: every chip is neutral; the numbers stay."
        >
          <Switch checked={display.metricColors} onChange={(metricColors) => setDisplay({ metricColors })} label="Colour risk chips" />
        </Row>
        <Row label="Bonding progress ring" help="A ring around each token image showing bonding-curve progress.">
          <Switch
            checked={display.showProgressRing}
            onChange={(showProgressRing) => setDisplay({ showProgressRing })}
            label="Bonding progress ring"
          />
        </Row>
        <Row label="Large quick-buy pills" help="Bigger quick-buy pills on token cards.">
          <Switch
            checked={display.largeQuickBuy}
            onChange={(largeQuickBuy) => setDisplay({ largeQuickBuy })}
            label="Large quick-buy pills"
          />
        </Row>
      </Rows>

      <SubHeader
        anchor="risk"
        actions={
          thresholdsReset ? (
            <InlineStatus
              onUndo={() => {
                setDisplay({ riskThresholds: thresholdsReset });
                setThresholdsReset(null);
              }}
            >
              Defaults restored
            </InlineStatus>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              icon={<RotateCcw />}
              disabled={!customBands}
              onClick={() => {
                setThresholdsReset(display.riskThresholds);
                setDisplay({ riskThresholds: RISK_DEFAULTS });
              }}
            >
              Reset
            </Button>
          )
        }
      >
        Risk thresholds
      </SubHeader>
      <p className="max-w-[72ch] pb-2 text-label text-fg-3">
        Where each risk chip turns amber and red, judged on the value the chip shows. Chip tooltips always show the bands in use.
      </p>
      <div className="grid h-6 grid-cols-[minmax(0,1fr)_200px] items-center gap-x-4 text-label font-medium text-fg-3 max-sm:hidden">
        <span>Metric</span>
        <span className="grid grid-cols-2 gap-2 text-right">
          <span>Amber from</span>
          <span>Red from</span>
        </span>
      </div>
      <Rows>
        {RISK_KEYS.map((k) => (
          <ThresholdRow key={k} k={k} />
        ))}
      </Rows>

      <SubHeader anchor="sound">Sound</SubHeader>
      <Rows>
        <Row label="Volume" help="New-token, fill and tracked-wallet sounds. Turn sounds on per Pulse column.">
          <Slider
            value={volumePct}
            min={0}
            max={100}
            step={5}
            ticks={[0, 25, 50, 75, 100]}
            onChange={(v) => setDisplay({ soundVolume: v / 100 })}
            label="Sound volume"
            valueText={volumePct === 0 ? "Off" : `${volumePct}%`}
          />
          <span className="zf-num w-9 shrink-0 text-right text-data text-fg-1">{volumePct === 0 ? "Off" : `${volumePct}%`}</span>
          <Button
            size="xs"
            variant="secondary"
            icon={<Volume2 />}
            disabled={volumePct === 0}
            onClick={() => playTone("new", display.soundVolume)}
            className="max-md:h-11"
          >
            Test sound
          </Button>
        </Row>
      </Rows>

      <SubHeader anchor="touch">Touch</SubHeader>
      <Rows>
        <Row
          label="Confirm trades on touch devices"
          help="On phones and tablets, tapping Buy opens a short review with the cost before anything is signed."
        >
          <Switch
            checked={display.confirmOnTouch}
            onChange={(confirmOnTouch) => setDisplay({ confirmOnTouch })}
            label="Confirm trades on touch devices"
          />
        </Row>
      </Rows>
    </>
  );
}
