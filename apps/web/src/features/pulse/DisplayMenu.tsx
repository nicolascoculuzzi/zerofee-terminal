import { ChevronDown, LayoutList } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Segmented, Switch } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { type Density, type PulseLayout, useSettings } from "../../state/settings";
import { ToolbarButton } from "./ToolbarButton";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 py-0.5">
      <span className="min-w-0">
        <span className="block text-data text-fg-1">{label}</span>
        {hint && <span className="block text-label text-fg-3">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

const FIELDS: { key: keyof PulseLayout["cardFields"]; label: string; hint?: string }[] = [
  { key: "socials", label: "Socials" },
  { key: "counters", label: "Holders and pro traders" },
  { key: "miniChart", label: "Mini chart", hint: "Columns 600 px and wider" },
  { key: "feesNetBuy", label: "Fees and net buy", hint: "Columns 600 px and wider" },
];

/**
 * Display popover (DESIGN.md 5.1): which card fields show, the bonding ring, card density and
 * the list refresh rate. Switch rows after Kraken's widget toggles:
 * https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7
 */
export function DisplayMenu() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const fields = useSettings((s) => s.pulseLayout.cardFields);
  const setPulseLayout = useSettings((s) => s.setPulseLayout);
  const display = useSettings((s) => s.display);
  const setDisplay = useSettings((s) => s.setDisplay);

  return (
    <>
      <ToolbarButton ref={anchor} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <LayoutList />
        Display
        <ChevronDown className="text-fg-3" />
      </ToolbarButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={280} padding="form">
        <div className="zf-group-label pb-1">Card fields</div>
        {FIELDS.map((f) => (
          <Row key={f.key} label={f.label} hint={f.hint}>
            <Switch checked={fields[f.key]} onChange={(on) => setPulseLayout({ cardFields: { ...fields, [f.key]: on } })} label={f.label} />
          </Row>
        ))}
        <Row label="Bonding progress ring">
          <Switch
            checked={display.showProgressRing}
            onChange={(showProgressRing) => setDisplay({ showProgressRing })}
            label="Bonding progress ring"
          />
        </Row>
        <div className="mt-2 border-t border-hairline pt-2">
          <div className="zf-label mb-1">Density</div>
          <Segmented<Density>
            size="xs"
            className="w-full"
            value={display.density}
            onChange={(density) => setDisplay({ density })}
            options={[
              { value: "auto", label: "Auto" },
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
            label="Card density"
          />
          <div className="zf-label mt-2 mb-1">List refresh</div>
          <Segmented<string>
            size="xs"
            className="w-full"
            value={String(display.pulseHz)}
            onChange={(v) => setDisplay({ pulseHz: Number(v) })}
            options={["4", "6", "8", "10"].map((v) => ({ value: v, label: `${v} Hz` }))}
            label="List refresh rate"
          />
        </div>
      </Popover>
    </>
  );
}
