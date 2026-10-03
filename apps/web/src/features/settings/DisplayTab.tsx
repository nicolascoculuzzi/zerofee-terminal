import { Moon, Sun, Volume2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Segmented, Switch } from "../../components/ui/controls";
import { playTone } from "../../lib/sound";
import { type Theme, type ToastPosition, useSettings } from "../../state/settings";
import { Group, Row, TabHeader } from "./ui";

const TOAST_POSITIONS: { value: ToastPosition; label: string }[] = [
  { value: "top-right", label: "Top right" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-center", label: "Top center" },
];

/*
 * Appearance and feed display. Anatomy follows Google Drive's settings (grouped choices with
 * hairline separators) and Graphite's label/description rows with right-hand controls:
 * https://mobbin.com/screens/c026c57c-8eba-4d55-b68f-d99ebc4416f3
 * https://mobbin.com/screens/102736c8-9a2a-4185-a155-025f1c0b3217
 */
export function DisplayTab() {
  const display = useSettings((s) => s.display);
  const setDisplay = useSettings((s) => s.setDisplay);
  const volumePct = Math.round(display.soundVolume * 100);

  return (
    <>
      <TabHeader title="Display" description="How the terminal looks and sounds. Saved in this browser." />

      <Group title="Appearance">
        <Row label="Theme">
          <Segmented<Theme>
            value={display.theme}
            onChange={(theme) => setDisplay({ theme })}
            options={[
              {
                value: "dark",
                label: (
                  <span className="flex items-center gap-1">
                    <Moon className="icon-sm" /> Dark
                  </span>
                ),
              },
              {
                value: "light",
                label: (
                  <span className="flex items-center gap-1">
                    <Sun className="icon-sm" /> Light
                  </span>
                ),
              },
            ]}
            label="Theme"
          />
        </Row>
        <Row label="Metric colours" hint="Colour risk metrics (top 10, dev, snipers, insiders) by threshold: low, medium, high.">
          <Switch checked={display.metricColors} onChange={(metricColors) => setDisplay({ metricColors })} label="Metric colours" />
        </Row>
        <Row label="Toast position" htmlFor="zf-toast-position">
          <select
            id="zf-toast-position"
            className="zf-input w-auto"
            value={display.toastPosition}
            onChange={(e) => {
              const next = TOAST_POSITIONS.find((p) => p.value === e.target.value);
              if (next) setDisplay({ toastPosition: next.value });
            }}
          >
            {TOAST_POSITIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Row>
      </Group>

      <Group title="Pulse">
        <Row label="Compact cards" hint="Shorter token cards, more tokens per screen.">
          <Switch checked={display.compactCards} onChange={(compactCards) => setDisplay({ compactCards })} label="Compact cards" />
        </Row>
        <Row label="Bonding progress ring" hint="Ring around each token image showing bonding-curve progress.">
          <Switch
            checked={display.showProgressRing}
            onChange={(showProgressRing) => setDisplay({ showProgressRing })}
            label="Bonding progress ring"
          />
        </Row>
        <Row label="Large quick-buy buttons" hint="Bigger quick-buy buttons on token cards.">
          <Switch
            checked={display.largeQuickBuy}
            onChange={(largeQuickBuy) => setDisplay({ largeQuickBuy })}
            label="Large quick-buy buttons"
          />
        </Row>
        <Row
          label="Refresh rate"
          hint="How often Pulse lists repaint. Lower is calmer and lighter on the CPU; new tokens are never dropped."
          htmlFor="zf-pulse-hz"
        >
          <input
            id="zf-pulse-hz"
            type="range"
            min={4}
            max={10}
            step={1}
            value={display.pulseHz}
            onChange={(e) => setDisplay({ pulseHz: Number(e.target.value) })}
            className="w-32 accent-fg"
          />
          <span className="w-12 text-right font-mono text-data text-fg-1">{display.pulseHz} Hz</span>
        </Row>
      </Group>

      <Group title="Sound">
        <Row label="Alert volume" hint="New-token, fill and tracked-wallet alerts. Turn alerts on per Pulse column." htmlFor="zf-volume">
          <input
            id="zf-volume"
            type="range"
            min={0}
            max={100}
            step={5}
            value={volumePct}
            onChange={(e) => setDisplay({ soundVolume: Number(e.target.value) / 100 })}
            className="w-32 accent-fg"
          />
          <span className="w-12 text-right font-mono text-data text-fg-1">{volumePct === 0 ? "Off" : `${volumePct}%`}</span>
          <Button
            size="xs"
            variant="secondary"
            icon={<Volume2 className="icon-sm" />}
            disabled={volumePct === 0}
            onClick={() => playTone("new", display.soundVolume)}
          >
            Test
          </Button>
        </Row>
      </Group>
    </>
  );
}
