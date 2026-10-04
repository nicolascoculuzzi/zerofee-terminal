import { ShieldCheck, Zap } from "lucide-react";
import { useState } from "react";
import { Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { fmtFee } from "../../lib/format";
import { type PresetId, useSettings } from "../../state/settings";
import { LANDING_ORDER, landingInfo } from "./landing";
import { PresetTabs } from "./PresetsSection";
import type { SectionId } from "./sections";
import { Note, RadioRow, Rows, SectionHeader, SubHeader } from "./ui";

type Side = "buy" | "sell";

/*
 * Landing routes per preset and side (DESIGN.md 5.5): radio rows with the route, tip rule and
 * note from SPEC "Landing presets". Reduced and Secure are neutral; only Fast carries colour
 * (warn), because it has sandwich risk (4.1). One-choice rows with short facts after Kraken's
 * order-type picker: https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8
 */
export function LandingSection({
  editing,
  onEditing,
  onNavigate,
}: {
  editing: PresetId;
  onEditing: (id: PresetId) => void;
  onNavigate: (section: SectionId, anchor?: string) => void;
}) {
  const preset = useSettings((s) => s.presets[editing]);
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const [side, setSide] = useState<Side>("buy");
  const exec = preset[side];
  const route = landingInfo(exec.landing);
  const tipLow = exec.tipSol < route.minTipSol;

  return (
    <>
      <SectionHeader
        title="Landing"
        description="How each preset's transactions reach the chain. Buys and sells pick their route separately. The top-bar chip shows the active preset's buy route."
      />
      <PresetTabs editing={editing} onEditing={onEditing} />
      <div role="tabpanel" aria-labelledby={`zf-preset-tab-${editing}`}>
        <SubHeader
          actions={
            <Segmented<Side>
              value={side}
              onChange={setSide}
              label="Side"
              tone={(v) => (v === "buy" ? "buy" : "sell")}
              options={[
                { value: "buy", label: "Buy side" },
                { value: "sell", label: "Sell side" },
              ]}
            />
          }
        >
          {editing} {side === "buy" ? "buys" : "sells"}
        </SubHeader>
        <Rows>
          {LANDING_ORDER.map((id) => {
            const info = landingInfo(id);
            return (
              <RadioRow
                key={id}
                name={`zf-landing-${editing}-${side}`}
                checked={exec.landing === id}
                onSelect={() => setPresetSide(editing, side, { landing: id })}
                title={info.label}
                meta={
                  <span className={cn("flex items-center gap-1 text-label", info.risky ? "text-warn" : "text-fg-2")}>
                    {info.risky ? <Zap className="icon-xs" /> : <ShieldCheck className="icon-xs" />}
                    {info.risky ? "Sandwich risk" : id === "secure" ? "Sandwich protected" : "MEV protected"}
                  </span>
                }
              >
                <span className="block text-fg-2">Route: {info.route}</span>
                <span className="block text-fg-2">Tip: {info.tip}</span>
                <span className={cn("block", info.risky ? "text-warn" : "text-fg-3")}>{info.note}</span>
              </RadioRow>
            );
          })}
        </Rows>
        <div className="mt-2 space-y-1">
          {exec.landing === "fast" && (
            <Note tone="warn">
              Fast sends through every lane with no MEV protection. A bot can buy right before you and sell right after, and the loss grows
              with the size of the trade. Prefer Reduced or Secure unless landing speed matters more.
            </Note>
          )}
          {tipLow && (
            <Note tone="warn">
              The {side} tip ({fmtFee(exec.tipSol)} SOL) is below the {route.label} minimum of {fmtFee(route.minTipSol)} SOL, so the
              transaction may not land.{" "}
              <button
                type="button"
                onClick={() => onNavigate("presets", "execution")}
                className="font-medium text-fg-1 underline-offset-2 hover:underline"
              >
                Edit the tip
              </button>
            </Note>
          )}
        </div>
      </div>
    </>
  );
}
