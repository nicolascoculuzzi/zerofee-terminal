import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox, NumberInput, Segmented } from "../../components/ui/controls";
import { uid } from "../../lib/cn";
import { MINUS } from "../../lib/format";
import type { QuoteCurrency } from "../../state/settings";
import type { LadderLeg, LadderMode } from "../token/tokenUi";
import { FormattedInput } from "./FormattedInput";
import { fmtTrigger } from "./LimitFields";
import { ladderNonceSlots } from "./tradeMath";

/*
 * Advanced: the exit ladder (DESIGN.md 4.11 item 5): 28 px rows [TP1] [+50%] [sell 25%] [x],
 * "+ Add take profit", an SL row, quick chips +25% / +50% / +100%, a "% PnL | MC" mode, and the
 * nonce note. TP/SL chips with a mode toggle after Phantom's auto close:
 * https://mobbin.com/screens/279487cb-c28e-4e7a-9581-8d41e4f89e06
 */

const QUICK = [25, 50, 100];

export function ExitLadder({
  ladder,
  onChange,
  mode,
  onMode,
  oco,
  onOco,
  refMc,
  quote,
  afterBuy,
  migration,
}: {
  ladder: LadderLeg[];
  onChange: (ladder: LadderLeg[]) => void;
  mode: LadderMode;
  onMode: (m: LadderMode) => void;
  oco: boolean;
  onOco: (on: boolean) => void;
  /** Reference MC (entry, or current for a new buy) in the quote, for MC mode. */
  refMc: number;
  quote: QuoteCurrency;
  /** True when the ladder arms after the buy fills (buy side); false = on the current position. */
  afterBuy: boolean;
  migration: { on: boolean; pct: number | null; onToggle: (on: boolean) => void; onPct: (v: number | null) => void } | null;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const tps = ladder.filter((l) => l.kind === "take_profit");
  const sls = ladder.filter((l) => l.kind === "stop_loss");
  const update = (id: string, patch: Partial<LadderLeg>) => onChange(ladder.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const remove = (id: string) => onChange(ladder.filter((l) => l.id !== id));
  const orders = ladder.length + (migration?.on ? 1 : 0);
  const slots = ladderNonceSlots(ladder, oco) + (migration?.on ? 1 : 0);
  const usd = quote === "USD";

  const row = (leg: LadderLeg, label: string) => {
    const tp = leg.kind === "take_profit";
    const mcValue = refMc * (tp ? 1 + leg.triggerPct / 100 : 1 - leg.triggerPct / 100);
    return (
      <div
        key={leg.id}
        onFocusCapture={() => tp && setFocusId(leg.id)}
        className="grid h-7 grid-cols-[28px_minmax(0,1fr)_56px_20px] items-center gap-1"
      >
        <span className="text-label font-medium text-fg-2">{label}</span>
        {mode === "pct" ? (
          <NumberInput
            value={leg.triggerPct}
            onChange={(v) => update(leg.id, { triggerPct: Math.max(0, Math.min(tp ? 100_000 : 99, v ?? 0)) })}
            prefix={<span className="text-data">{tp ? "+" : MINUS}</span>}
            suffix="%"
            min={0}
            step={5}
            ariaLabel={`${label} trigger, % from entry`}
          />
        ) : (
          <FormattedInput
            value={Math.max(0, mcValue)}
            format={(v) => fmtTrigger(v, "mc", quote)}
            onChange={(v) => {
              if (!(refMc > 0)) return;
              const pct = tp ? (v / refMc - 1) * 100 : (1 - v / refMc) * 100;
              update(leg.id, { triggerPct: Math.max(0, Math.round(pct * 10) / 10) });
            }}
            onStep={(d) => update(leg.id, { triggerPct: Math.max(0, leg.triggerPct + (tp ? d : -d) * 2) })}
            prefix={usd ? "$" : undefined}
            suffix="MC"
            ariaLabel={`${label} trigger market cap`}
          />
        )}
        <NumberInput
          value={leg.sellPct}
          onChange={(v) => update(leg.id, { sellPct: Math.max(0, Math.min(100, v ?? 0)) })}
          suffix="%"
          min={0}
          max={100}
          step={5}
          ariaLabel={`${label} share of the holding to sell`}
        />
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          onClick={() => remove(leg.id)}
          className="flex size-5 items-center justify-center rounded-xs text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg-1"
        >
          <X className="icon-xs" />
        </button>
      </div>
    );
  };

  const target = tps.find((l) => l.id === focusId) ?? tps[tps.length - 1];

  return (
    <div className="space-y-1">
      <div className="flex h-5 items-center justify-between">
        <span className="zf-label">Exit ladder</span>
        <Segmented<LadderMode>
          size="xs"
          value={mode}
          onChange={onMode}
          options={[
            { value: "pct", label: "% PnL" },
            { value: "mc", label: "MC" },
          ]}
          label="Trigger as % from entry or as market cap"
        />
      </div>
      <div className="grid grid-cols-[28px_minmax(0,1fr)_56px_20px] gap-1 text-micro text-fg-3" aria-hidden="true">
        <span />
        <span className="text-right">{mode === "pct" ? "From entry" : "Market cap"}</span>
        <span className="text-right">Sell</span>
        <span />
      </div>
      {tps.map((l, i) => row(l, `TP${i + 1}`))}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="xs"
          icon={<Plus />}
          onClick={() => onChange([...tps, { id: uid("leg"), kind: "take_profit", triggerPct: 200, sellPct: 25 }, ...sls])}
        >
          Add take profit
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              disabled={!target}
              onClick={() => target && update(target.id, { triggerPct: q })}
              title={target ? `Set ${tps.length > 1 ? `TP${tps.indexOf(target) + 1}` : "the take profit"} to +${q}%` : undefined}
              className="zf-num h-5 rounded-sm border border-hairline bg-surface-2 px-1.5 text-label font-medium text-fg-2 transition-colors hover:text-fg-1 disabled:text-fg-4"
            >
              +{q}%
            </button>
          ))}
        </div>
      </div>
      {sls.map((l) => row(l, "SL"))}
      {sls.length === 0 && (
        <Button
          variant="ghost"
          size="xs"
          icon={<Plus />}
          onClick={() => onChange([...ladder, { id: uid("leg"), kind: "stop_loss", triggerPct: 30, sellPct: 100 }])}
        >
          Add stop loss
        </Button>
      )}
      <Checkbox
        checked={oco}
        onChange={onOco}
        label="Pair each TP with the SL (OCO)"
        hint="Paired orders share one durable nonce: when one lands, the other can't."
        className="pt-1"
      />
      {migration && (
        <div className="flex items-center gap-2 pt-1">
          <Checkbox checked={migration.on} onChange={migration.onToggle} label="Also sell on migration" />
          <NumberInput
            value={migration.pct}
            onChange={migration.onPct}
            suffix="%"
            min={1}
            max={100}
            step={5}
            disabled={!migration.on}
            className="ml-auto w-20"
            ariaLabel="Share to sell when the coin migrates"
          />
        </div>
      )}
      <p className="pt-1 text-label text-fg-3">
        {orders === 0
          ? "Add a level to arm exits."
          : `Arms ${orders} order${orders === 1 ? "" : "s"} on ${slots} nonce slot${slots === 1 ? "" : "s"} ${
              afterBuy ? "after the buy fills" : "on your position"
            }.`}
      </p>
    </div>
  );
}
