import { RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Hotkey, NumberInput } from "../../components/ui/controls";
import { fmtFee, fmtSolShort, fmtUsd } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { ExecutionSettings } from "../../services/tradeService";
import { useMarket } from "../../state/market";
import { DEFAULT_PRESETS, PRESET_IDS, type PresetId, type TradePreset, useSettings } from "../../state/settings";
import { BASE_FEE_SOL, landingInfo } from "./landing";
import type { SectionId } from "./sections";
import { InlineStatus, Note, Row, Rows, SectionHeader, SubHeader, Tag, type Tone, UnderlineTabs, useTransient } from "./ui";

type Side = "buy" | "sell";
type AmountKey = "buyAmounts" | "sellPcts" | "instantBuy" | "instantSellPct" | "instantSellSol";

const SLOTS = [0, 1, 2, 3] as const;
const LABEL_MAX = 12;

const AMOUNT_ROWS: { key: AmountKey; label: string; help: string; unit: "SOL" | "%" }[] = [
  { key: "buyAmounts", label: "Trade panel buys", help: "SOL, the four chips under the amount", unit: "SOL" },
  { key: "sellPcts", label: "Trade panel sells", help: "Percent of the position", unit: "%" },
  { key: "instantBuy", label: "Instant Trade buys", help: "SOL", unit: "SOL" },
  { key: "instantSellPct", label: "Instant Trade sells", help: "Percent of the position", unit: "%" },
  { key: "instantSellSol", label: "Instant Trade sells", help: "SOL worth of the position", unit: "SOL" },
];

export function perTradeCost(s: ExecutionSettings): number {
  return s.priorityFeeSol + s.tipSol + BASE_FEE_SOL;
}

/**
 * P1 / P2 / P3 tabs, shared by Presets and Landing (the preset editor and "its Landing tab",
 * DESIGN.md 4.1). The active preset carries a neutral "Active" tag.
 */
export function PresetTabs({ editing, onEditing }: { editing: PresetId; onEditing: (id: PresetId) => void }) {
  const presets = useSettings((s) => s.presets);
  const activePreset = useSettings((s) => s.activePreset);
  const setActivePreset = useSettings((s) => s.setActivePreset);
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-hairline">
      <UnderlineTabs<PresetId>
        bare
        value={editing}
        onChange={onEditing}
        label="Preset to edit"
        idPrefix="zf-preset-tab"
        options={PRESET_IDS.map((id) => ({
          value: id,
          label: (
            <>
              {id}
              <span className="font-normal text-fg-3">{presets[id].label || DEFAULT_PRESETS[id].label}</span>
            </>
          ),
        }))}
      />
      <div className="flex h-panel-header items-center gap-2">
        {editing === activePreset ? (
          <Tag>Active preset</Tag>
        ) : (
          <Button size="xs" variant="secondary" onClick={() => setActivePreset(editing)}>
            Make {editing} active
          </Button>
        )}
      </div>
    </div>
  );
}

function sideWarnings(side: Side, exec: ExecutionSettings): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  const route = landingInfo(exec.landing);
  const name = side === "buy" ? "Buys" : "Sells";
  if (exec.slippagePct > 50) out.push({ tone: "warn", text: `${name}: slippage above 50% can fill far from the quote.` });
  if (exec.slippagePct < 1) out.push({ tone: "neutral", text: `${name}: below 1% slippage, trades on fast-moving coins often fail.` });
  if (exec.tipSol < route.minTipSol) {
    out.push({
      tone: "warn",
      text: `${name}: the tip is below the ${route.label} route's minimum of ${fmtFee(route.minTipSol)} SOL, so the transaction may not land.`,
    });
  }
  return out;
}

function PairInputs({
  buy,
  sell,
  onBuy,
  onSell,
  unit,
  min,
  max,
  label,
}: {
  buy: number;
  sell: number;
  onBuy: (v: number) => void;
  onSell: (v: number) => void;
  unit: string;
  min: number;
  max: number;
  label: string;
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-2">
      <NumberInput
        value={buy}
        onChange={(v) => v !== null && onBuy(v)}
        min={min}
        max={max}
        suffix={unit}
        ariaLabel={`Buy ${label}, ${unit}`}
      />
      <NumberInput
        value={sell}
        onChange={(v) => v !== null && onSell(v)}
        min={min}
        max={max}
        suffix={unit}
        ariaLabel={`Sell ${label}, ${unit}`}
      />
    </div>
  );
}

/** Two right-aligned values under the Buy / Sell captions. */
function Pair({ buy, sell, strong }: { buy: string; sell: string; strong?: boolean }) {
  const cls = strong ? "font-semibold text-fg-1" : "text-fg-2";
  return (
    <div className="zf-num grid w-full grid-cols-2 gap-2 text-right text-data">
      <span className={cls}>{buy}</span>
      <span className={cls}>{sell}</span>
    </div>
  );
}

function SideCaptions() {
  return (
    <div className="grid w-50 grid-cols-2 gap-2 text-right text-label font-medium text-fg-3 max-sm:hidden">
      <span>Buy</span>
      <span>Sell</span>
    </div>
  );
}

function AmountRow({ id, preset, row }: { id: PresetId; preset: TradePreset; row: (typeof AMOUNT_ROWS)[number] }) {
  const setPreset = useSettings((s) => s.setPreset);
  const update = (slot: number, v: number | null) => {
    if (v === null) return;
    const next = SLOTS.map((i) => preset[row.key][i] ?? 0);
    next[slot] = v;
    const patch: Partial<TradePreset> = {};
    patch[row.key] = next;
    setPreset(id, patch);
  };
  return (
    <Row label={row.label} help={row.help} control="wide">
      <div className="grid w-full grid-cols-4 gap-1 sm:w-60">
        {SLOTS.map((slot) => (
          <NumberInput
            key={slot}
            value={preset[row.key][slot] ?? null}
            onChange={(v) => update(slot, v)}
            min={row.unit === "%" ? 1 : 0}
            max={row.unit === "%" ? 100 : undefined}
            ariaLabel={`${row.label}, button ${slot + 1}, ${row.unit}`}
          />
        ))}
      </div>
    </Row>
  );
}

/*
 * Preset editor (DESIGN.md 5.5 "Presets"): per-side slippage, priority fee and tip in Buy / Sell
 * columns, the cost per trade with "Platform fee 0", and the amount grids.
 * Fee rows with an info line per cost after Uniswap's review:
 * https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5
 */
export function PresetsSection({
  editing,
  onEditing,
  onNavigate,
}: {
  editing: PresetId;
  onEditing: (id: PresetId) => void;
  onNavigate: (section: SectionId, anchor?: string) => void;
}) {
  const preset = useSettings((s) => s.presets[editing]);
  const setPreset = useSettings((s) => s.setPreset);
  const setPresetSide = useSettings((s) => s.setPresetSide);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  const hotkeys = useSettings((s) => s.hotkeys);
  const solUsd = useMarket((s) => s.solUsd);
  const [resetDone, setResetDone] = useTransient<{ id: PresetId; previous: TradePreset }>(6000);

  const warnings = [...sideWarnings("buy", preset.buy), ...sideWarnings("sell", preset.sell)];
  const switchKeys = (["preset.1", "preset.2", "preset.3"] as const).map((a) => hotkeys[a]?.[0]).filter((b): b is string => !!b);
  const buyCost = perTradeCost(preset.buy);
  const sellCost = perTradeCost(preset.sell);

  const reset = () => {
    const previous = useSettings.getState().presets[editing];
    setPreset(editing, DEFAULT_PRESETS[editing]);
    setResetDone({ id: editing, previous });
  };

  return (
    <>
      <SectionHeader
        title="Presets"
        description={
          <>
            Slippage, fees and button amounts for P1 to P3. Switch the active preset from the top bar
            {switchKeys.length > 0 && " or with "}
            {switchKeys.map((b, i) => (
              <span key={b}>
                {i > 0 && " "}
                <Hotkey binding={b} className="align-middle" />
              </span>
            ))}
            .
          </>
        }
      />
      <PresetTabs editing={editing} onEditing={onEditing} />
      <div role="tabpanel" aria-labelledby={`zf-preset-tab-${editing}`}>
        <Rows>
          <Row label="Name" help={`Shown on the preset switch, up to ${LABEL_MAX} characters.`} htmlFor="zf-preset-label">
            <input
              id="zf-preset-label"
              className="zf-input"
              value={preset.label}
              maxLength={LABEL_MAX}
              onChange={(e) => setPreset(editing, { label: e.target.value })}
              onBlur={(e) => {
                if (!e.target.value.trim()) setPreset(editing, { label: DEFAULT_PRESETS[editing].label });
              }}
            />
          </Row>
          <Row label="Reset" help={`Back to the ${DEFAULT_PRESETS[editing].label} defaults for ${editing}.`}>
            {resetDone && resetDone.id === editing ? (
              <InlineStatus
                onUndo={() => {
                  setPreset(resetDone.id, resetDone.previous);
                  setResetDone(null);
                }}
              >
                Reset
              </InlineStatus>
            ) : (
              <Button size="xs" variant="ghost" icon={<RotateCcw />} onClick={reset}>
                Reset {editing}
              </Button>
            )}
          </Row>
        </Rows>

        <SubHeader anchor="execution" actions={<SideCaptions />}>
          Execution
        </SubHeader>
        <Rows>
          <Row label="Slippage" help="How far the fill may move from the quote before the trade fails.">
            <PairInputs
              label="slippage"
              unit="%"
              min={0.1}
              max={100}
              buy={preset.buy.slippagePct}
              sell={preset.sell.slippagePct}
              onBuy={(v) => setPresetSide(editing, "buy", { slippagePct: v })}
              onSell={(v) => setPresetSide(editing, "sell", { slippagePct: v })}
            />
          </Row>
          <Row label="Priority fee" help="Paid to the validator on top of the 0.000005 SOL base fee.">
            <PairInputs
              label="priority fee"
              unit="SOL"
              min={0}
              max={1}
              buy={preset.buy.priorityFeeSol}
              sell={preset.sell.priorityFeeSol}
              onBuy={(v) => setPresetSide(editing, "buy", { priorityFeeSol: v })}
              onSell={(v) => setPresetSide(editing, "sell", { priorityFeeSol: v })}
            />
          </Row>
          <Row label="Tip" help="Paid to the landing route. Each route has a minimum.">
            <PairInputs
              label="tip"
              unit="SOL"
              min={0}
              max={1}
              buy={preset.buy.tipSol}
              sell={preset.sell.tipSol}
              onBuy={(v) => setPresetSide(editing, "buy", { tipSol: v })}
              onSell={(v) => setPresetSide(editing, "sell", { tipSol: v })}
            />
          </Row>
          <Row
            label="Landing route"
            help={
              <>
                How the transaction reaches the chain.{" "}
                <button
                  type="button"
                  onClick={() => onNavigate("landing")}
                  className="font-medium text-fg-1 underline-offset-2 hover:underline"
                >
                  Change in Landing
                </button>
              </>
            }
          >
            <Pair buy={LANDING_INFO[preset.buy.landing].label} sell={LANDING_INFO[preset.sell.landing].label} />
          </Row>
        </Rows>
        {warnings.length > 0 && (
          <div className="mt-2 space-y-1">
            {warnings.map((w) => (
              <Note key={w.text} tone={w.tone}>
                {w.text}
              </Note>
            ))}
          </div>
        )}

        <SubHeader anchor="cost" actions={<SideCaptions />}>
          Cost per trade, SOL
        </SubHeader>
        <Rows>
          <Row label="Priority fee">
            <Pair buy={fmtFee(preset.buy.priorityFeeSol)} sell={fmtFee(preset.sell.priorityFeeSol)} />
          </Row>
          <Row label="Tip">
            <Pair buy={fmtFee(preset.buy.tipSol)} sell={fmtFee(preset.sell.tipSol)} />
          </Row>
          <Row label="Base fee" help="5,000 lamports per signature.">
            <Pair buy={fmtFee(BASE_FEE_SOL)} sell={fmtFee(BASE_FEE_SOL)} />
          </Row>
          <Row label="Platform fee" help="zerofee adds nothing.">
            <Pair buy="0" sell="0" strong />
          </Row>
          <Row label="Estimated cost" help={`About ${fmtUsd(buyCost * solUsd)} per buy and ${fmtUsd(sellCost * solUsd)} per sell.`}>
            <Pair buy={fmtFee(buyCost)} sell={fmtFee(sellCost)} strong />
          </Row>
        </Rows>
        <p className="mt-2 max-w-[72ch] text-label text-fg-3">
          Venue fees come on top: pump.fun charges 1.25% per side on the bonding curve, and no terminal can remove it. Calm markets need far
          less than the 0.002 to 0.022 SOL per side many terminals default to.
        </p>

        <SubHeader anchor="amounts">Button amounts for {editing}</SubHeader>
        <Rows>
          {AMOUNT_ROWS.map((row) => (
            <AmountRow key={row.key} id={editing} preset={preset} row={row} />
          ))}
        </Rows>
      </div>

      <SubHeader anchor="quickbuy">Quick buy</SubHeader>
      <Rows>
        <Row
          label="Global quick-buy amount"
          help={`The pills on Pulse, search and trackers buy ${fmtSolShort(quickBuy)} SOL. Pulse columns can override it.`}
        >
          <NumberInput
            value={quickBuy}
            onChange={(v) => v !== null && setQuickBuy(v)}
            min={0}
            suffix="SOL"
            step={(v) => (v < 1 ? 0.01 : 0.1)}
            ariaLabel="Global quick-buy amount, SOL"
            className="w-full"
          />
        </Row>
      </Rows>
    </>
  );
}
