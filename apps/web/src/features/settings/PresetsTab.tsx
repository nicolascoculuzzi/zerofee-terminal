import { RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey, NumberInput, Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import type { ExecutionSettings } from "../../services/tradeService";
import { useMarket } from "../../state/market";
import { DEFAULT_PRESETS, PRESET_IDS, type PresetId, type TradePreset, useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { fmtFee, fmtUsdSmall } from "./format";
import { BASE_FEE_SOL, LANDING_ORDER, landingInfo } from "./landing";
import { Chip, Field, Group, Note, RadioCard, Row, TabHeader, type Tone } from "./ui";

type Side = "buy" | "sell";
type AmountKey = "buyAmounts" | "sellPcts" | "instantBuy" | "instantSellPct" | "instantSellSol";

const SLOTS = [0, 1, 2, 3] as const;

const AMOUNT_ROWS: { key: AmountKey; label: string; unit: "SOL" | "%" }[] = [
  { key: "buyAmounts", label: "Trade panel buys", unit: "SOL" },
  { key: "sellPcts", label: "Trade panel sells", unit: "%" },
  { key: "instantBuy", label: "Instant Trade buys", unit: "SOL" },
  { key: "instantSellPct", label: "Instant Trade sells", unit: "%" },
  { key: "instantSellSol", label: "Instant Trade sells", unit: "SOL" },
];

const LABEL_MAX = 12;

function perTradeCost(s: ExecutionSettings): number {
  return s.priorityFeeSol + s.tipSol + BASE_FEE_SOL;
}

function sideWarnings(side: Side, exec: ExecutionSettings): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  const route = landingInfo(exec.landing);
  if (exec.slippagePct > 50) out.push({ tone: "warn", text: `Slippage above 50%: a ${side} can fill far from the quote.` });
  if (exec.slippagePct < 1) out.push({ tone: "neutral", text: `Below 1% slippage, ${side}s on fast-moving coins often fail.` });
  if (exec.tipSol < route.minTipSol) {
    out.push({
      tone: "warn",
      text: `Tip is below the ${route.label} route's minimum (${fmtFee(route.minTipSol)} SOL), so the transaction may not land.`,
    });
  }
  if (perTradeCost(exec) >= 0.002) {
    out.push({
      tone: "neutral",
      text: "Calm markets need far less. Typical terminal defaults of 0.002–0.022 SOL per side are 100–1,000× what's needed.",
    });
  }
  return out;
}

/*
 * Execution settings for one side of a preset: labelled numeric fields with a unit suffix,
 * after Binance's copy-trading settings form and Uniswap's max-slippage row:
 * https://mobbin.com/screens/9b4d92a6-44eb-4d18-8048-cb2dd5c651eb
 * https://mobbin.com/screens/27a28483-1083-427e-adc8-3bb9bf189a10
 */
function SideEditor({ id, side, exec }: { id: PresetId; side: Side; exec: ExecutionSettings }) {
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const set = (patch: Partial<ExecutionSettings>) => setPresetSide(id, side, patch);
  const warnings = sideWarnings(side, exec);
  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Slippage">
          <NumberInput
            value={exec.slippagePct}
            onChange={(v) => {
              if (v !== null) set({ slippagePct: v });
            }}
            min={0.1}
            max={100}
            suffix="%"
            alignRight
            ariaLabel={`${side} slippage, percent`}
          />
        </Field>
        <Field label="Priority fee">
          <NumberInput
            value={exec.priorityFeeSol}
            onChange={(v) => {
              if (v !== null) set({ priorityFeeSol: v });
            }}
            min={0}
            max={1}
            suffix="SOL"
            alignRight
            ariaLabel={`${side} priority fee, SOL`}
          />
        </Field>
        <Field label="Tip">
          <NumberInput
            value={exec.tipSol}
            onChange={(v) => {
              if (v !== null) set({ tipSol: v });
            }}
            min={0}
            max={1}
            suffix="SOL"
            alignRight
            ariaLabel={`${side} tip, SOL`}
          />
        </Field>
      </div>
      {warnings.length > 0 && (
        <div className="space-y-2">
          {warnings.map((w) => (
            <Note key={w.text} tone={w.tone}>
              {w.text}
            </Note>
          ))}
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="zf-label mb-1">Landing route</legend>
        {LANDING_ORDER.map((l) => {
          const info = landingInfo(l);
          const low = !info.risky;
          return (
            <RadioCard
              key={l}
              name={`zf-landing-${id}-${side}`}
              checked={exec.landing === l}
              onSelect={() => set({ landing: l })}
              title={info.label}
              meta={
                <span className={cn("flex items-center gap-1 text-xs", low ? "text-buy" : "text-warn")}>
                  {low ? <ShieldCheck className="icon-sm" /> : <TriangleAlert className="icon-sm" />}
                  {info.riskLabel}
                </span>
              }
            >
              <span className="block">Route: {info.route}</span>
              <span className="block">Tip rule: {info.tip}</span>
              <span className="block text-dim">{info.note}</span>
            </RadioCard>
          );
        })}
      </fieldset>
      {exec.landing === "fast" && (
        <Note tone="warn">
          Sandwich risk: Fast sends through every lane with no MEV protection. A bot can buy right before you and sell right after, and the
          loss grows with the size of the buy. Prefer Reduced or Secure unless landing speed matters more.
        </Note>
      )}
    </div>
  );
}

/* Fee breakdown with right-aligned numbers and a totals row (QuickBooks usage table anatomy):
   https://mobbin.com/screens/4dfea91b-6902-4da1-8625-7306df994417 */
function CostTable({ preset }: { preset: TradePreset }) {
  const solUsd = useMarket((s) => s.solUsd);
  const rows = [
    { label: "Priority fee", buy: preset.buy.priorityFeeSol, sell: preset.sell.priorityFeeSol },
    { label: "Tip", buy: preset.buy.tipSol, sell: preset.sell.tipSol },
    { label: "Base fee", buy: BASE_FEE_SOL, sell: BASE_FEE_SOL },
  ];
  const buyTotal = perTradeCost(preset.buy);
  const sellTotal = perTradeCost(preset.sell);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-line">
          <th scope="col" className="zf-label px-3 py-2 text-left font-normal">
            SOL per trade
          </th>
          <th scope="col" className="zf-label px-3 py-2 text-right font-normal">
            Buy
          </th>
          <th scope="col" className="zf-label px-3 py-2 text-right font-normal">
            Sell
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="px-3 py-1 text-left font-normal text-muted">
              {r.label}
            </th>
            <td className="px-3 py-1 text-right font-mono">{fmtFee(r.buy)}</td>
            <td className="px-3 py-1 text-right font-mono">{fmtFee(r.sell)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-line">
          <th scope="row" className="px-3 pt-2 text-left font-semibold">
            Estimated cost
          </th>
          <td className="px-3 pt-2 text-right font-mono font-semibold">{fmtFee(buyTotal)}</td>
          <td className="px-3 pt-2 text-right font-mono font-semibold">{fmtFee(sellTotal)}</td>
        </tr>
        <tr className="text-xs text-dim">
          <th scope="row" className="px-3 pb-2 text-left font-normal">
            In USD
          </th>
          <td className="px-3 pb-2 text-right">{fmtUsdSmall(buyTotal * solUsd)}</td>
          <td className="px-3 pb-2 text-right">{fmtUsdSmall(sellTotal * solUsd)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function AmountsEditor({ id, preset }: { id: PresetId; preset: TradePreset }) {
  const setPreset = useSettings((s) => s.setPreset);
  const update = (key: AmountKey, slot: number, v: number | null) => {
    if (v === null) return;
    const next = SLOTS.map((i) => preset[key][i] ?? 0);
    next[slot] = v;
    const patch: Partial<TradePreset> = {};
    patch[key] = next;
    setPreset(id, patch);
  };
  return (
    <>
      {AMOUNT_ROWS.map((r) => (
        <div key={r.key} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
          <div className="text-sm text-fg sm:w-40 sm:shrink-0">
            {r.label} <span className="text-dim">({r.unit})</span>
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-4 gap-1">
            {SLOTS.map((slot) => (
              <NumberInput
                key={slot}
                value={preset[r.key][slot] ?? null}
                onChange={(v) => update(r.key, slot, v)}
                min={r.unit === "%" ? 1 : 0}
                max={r.unit === "%" ? 100 : undefined}
                alignRight
                ariaLabel={`${r.label}, button ${slot + 1}, ${r.unit}`}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/*
 * Preset editor: P1–P3 switch, then a Buy/Sell side switch over the execution fields, a fee
 * table and the amount grids. Segmented-mode-over-form anatomy after Binance's copy-trading
 * settings: https://mobbin.com/screens/9b4d92a6-44eb-4d18-8048-cb2dd5c651eb
 */
export function PresetsTab() {
  const activePreset = useSettings((s) => s.activePreset);
  const presets = useSettings((s) => s.presets);
  const setPreset = useSettings((s) => s.setPreset);
  const setActivePreset = useSettings((s) => s.setActivePreset);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  const hotkeys = useSettings((s) => s.hotkeys);
  const [editing, setEditing] = useState<PresetId>(activePreset);
  const [side, setSide] = useState<Side>("buy");
  const preset = presets[editing];
  const switchKeys = (["preset.1", "preset.2", "preset.3"] as const).flatMap((a) => {
    const binding = hotkeys[a]?.[0];
    return binding ? [{ action: a, binding }] : [];
  });

  const reset = () => {
    const id = editing;
    const previous = useSettings.getState().presets[id];
    setPreset(id, DEFAULT_PRESETS[id]);
    useToasts.getState().push({
      kind: "info",
      title: `${id} reset to defaults`,
      action: { label: "Undo", run: () => useSettings.getState().setPreset(id, previous) },
    });
  };

  return (
    <>
      <TabHeader
        title="Trade presets"
        description={
          <>
            Slippage, fees, landing route and button amounts for P1 to P3. Switch the active preset from the top bar
            {switchKeys.length > 0 && " or with "}
            {switchKeys.map((k, i) => (
              <Fragment key={k.action}>
                {i > 0 && " "}
                <Hotkey binding={k.binding} className="align-middle" />
              </Fragment>
            ))}
            .
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Segmented<PresetId>
          value={editing}
          onChange={setEditing}
          options={PRESET_IDS.map((id) => ({ value: id, label: `${id} · ${presets[id].label || DEFAULT_PRESETS[id].label}` }))}
          label="Preset to edit"
        />
        <div className="flex items-center gap-2">
          {editing === activePreset ? (
            <Chip tone="info">Active preset</Chip>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setActivePreset(editing)}>
              Make active
            </Button>
          )}
          <Button size="xs" variant="ghost" icon={<RotateCcw className="icon-sm" />} onClick={reset}>
            Reset preset
          </Button>
        </div>
      </div>

      <Group>
        <Row label="Name" hint={`Shown on the preset switch (up to ${LABEL_MAX} characters).`} htmlFor="zf-preset-label">
          <input
            id="zf-preset-label"
            className="zf-input sm:w-40"
            value={preset.label}
            maxLength={LABEL_MAX}
            onChange={(e) => setPreset(editing, { label: e.target.value })}
            onBlur={(e) => {
              if (!e.target.value.trim()) setPreset(editing, { label: DEFAULT_PRESETS[editing].label });
            }}
          />
        </Row>
      </Group>

      <Group
        title="Execution"
        description="Each side has its own slippage, fees and landing route."
        extra={
          <Segmented<Side>
            value={side}
            onChange={setSide}
            options={[
              { value: "buy", label: "Buy side" },
              { value: "sell", label: "Sell side" },
            ]}
            tone={(v) => (v === "buy" ? "buy" : "sell")}
            label="Side to edit"
          />
        }
      >
        <SideEditor key={`${editing}-${side}`} id={editing} side={side} exec={preset[side]} />
      </Group>

      <Group title="Cost per trade" description="What the chain charges on top of your trade size, before venue fees.">
        <CostTable preset={preset} />
        <div className="px-3 py-2 text-xs text-muted">
          Venue fees come on top: pump.fun takes 1.25% per side on the bonding curve, and no terminal can remove it. zerofee adds 0%.
        </div>
      </Group>

      <Group title="Button amounts" description={`Amount buttons for ${editing} in the trade panel and the Instant Trade window.`}>
        <AmountsEditor id={editing} preset={preset} />
      </Group>

      <Group title="Quick buy">
        <Row label="Global quick-buy amount" hint="Used by quick-buy buttons on Pulse, search and trackers. Pulse columns can override it.">
          <NumberInput
            value={quickBuy}
            onChange={(v) => {
              if (v !== null) setQuickBuy(v);
            }}
            min={0}
            suffix="SOL"
            alignRight
            className="w-32"
            ariaLabel="Global quick-buy amount, SOL"
          />
        </Row>
      </Group>
    </>
  );
}
