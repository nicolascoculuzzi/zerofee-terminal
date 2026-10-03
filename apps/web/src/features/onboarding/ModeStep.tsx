import { Check } from "lucide-react";
import { Button } from "../../components/ui/Button";
import type { TradeMode } from "../../services/tradeService";
import { MODE_INFO, MODES } from "../settings/modes";
import { RadioCard } from "../settings/ui";
import { StepFooter, type StepFrame, StepPanel } from "./parts";

const MODE_META: Record<TradeMode, string> = { instant: "Fastest", direct: "No hot wallet" };

/* Two option cards, one choice (Binance Pool fee-tier anatomy, as in Settings):
   https://mobbin.com/screens/80e8342c-a30d-494d-8ed5-b7ec84e90759 */
export function ModeStep({
  frame,
  mode,
  walletLabel,
  onMode,
  onBack,
  onFinish,
}: {
  frame: StepFrame;
  mode: TradeMode;
  walletLabel: string;
  onMode: (mode: TradeMode) => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  return (
    <StepPanel
      {...frame}
      footer={
        <StepFooter onBack={onBack}>
          <Button size="lg" variant="primary" icon={<Check className="icon-md" />} onClick={onFinish}>
            Finish setup
          </Button>
        </StepFooter>
      }
    >
      <fieldset className="grid gap-2 sm:grid-cols-2">
        <legend className="sr-only">Default trading mode</legend>
        {MODES.map((m) => (
          <RadioCard
            key={m}
            name="zf-onboarding-mode"
            checked={mode === m}
            onSelect={() => onMode(m)}
            title={MODE_INFO[m].label}
            meta={<span className="text-xs text-dim">{MODE_META[m]}</span>}
          >
            <span className="block text-fg">{MODE_INFO[m].summary}</span>
            <span className="block">{MODE_INFO[m].detail}</span>
          </RadioCard>
        ))}
      </fieldset>
      <p className="text-xs text-dim">
        {walletLabel} becomes your active trading wallet. Switch modes any time from the top bar or Settings, Trading.
      </p>
    </StepPanel>
  );
}
