import { Check, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Checkbox, NumberInput, Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn, uid } from "../../lib/cn";
import { fmtPct, fmtPnlPct, fmtPriceText, fmtSignedSol, fmtSol, fmtSolShort, fmtTokens, fmtUsd } from "../../lib/format";
import { quoteBuy, quoteSell } from "../../lib/quote";
import { armMigration, armTpSl, buy, placeLimit, sell } from "../../lib/tradeActions";
import type { TokenDetail } from "../../protocol";
import type { TpSlLeg } from "../../services/tradeService";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { useActivePosition, useActiveStatus, useWallet } from "../../state/wallet";
import { useTokenUi } from "../token/tokenUi";
import { PresetSettingsRow, PresetSwitch } from "./PresetSettings";

/*
 * Order form anatomy: Kraken Pro (Buy/Sell switch, order-type tabs, labelled inputs, % slider,
 * TP/SL, fee estimate, full-width coloured CTA) https://mobbin.com/screens/ed2976fc-9aa3-45bd-a5af-5f42f8fb76e0
 * and Coinbase Advanced (label-left / value-right inputs, quick chips, Subtotal/Fee/Total rows)
 * https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08. Field set follows Axiom's
 * Market / Limit / Advanced panel; every cost line is shown, including the 0 platform fee.
 */

type Side = "buy" | "sell";
type Tab = "market" | "limit" | "advanced";
const NETWORK_FEE_SOL = 0.000005;

interface LadderRow extends TpSlLeg {
  id: string;
}

function Row({ label, children, tone }: { label: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-label">
      <span className="text-fg-3">{label}</span>
      <span className={cn("text-right", tone ?? "text-fg-1")}>{children}</span>
    </div>
  );
}

/** Editable amount presets (pencil toggles edit mode). */
function AmountPresets({
  values,
  unit,
  onPick,
  onEdit,
  activeValue,
}: {
  values: number[];
  unit: "SOL" | "%";
  onPick: (v: number) => void;
  onEdit: (values: number[]) => void;
  activeValue: number | null;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <div className="grid flex-1 grid-cols-4 gap-1">
        {values.map((v, i) =>
          editing ? (
            <NumberInput
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed four preset slots
              key={i}
              value={v}
              onChange={(n) => {
                const next = [...values];
                next[i] = n ?? 0;
                onEdit(next);
              }}
              min={0}
              className="h-6 px-1"
              inputClassName="text-center"
              ariaLabel={`Preset ${i + 1}`}
            />
          ) : (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed four preset slots
              key={i}
              type="button"
              onClick={() => onPick(v)}
              className={cn(
                "h-6 rounded-sm border text-label font-medium",
                activeValue === v ? "border-hairline-strong bg-surface-3 text-fg-1" : "border-hairline text-fg-2 hover:text-fg-1",
              )}
            >
              {unit === "SOL" ? fmtSolShort(v) : `${v}%`}
            </button>
          ),
        )}
      </div>
      <button
        type="button"
        aria-label={editing ? "Done editing presets" : "Edit amount presets"}
        title={editing ? "Done" : "Edit presets"}
        onClick={() => setEditing((e) => !e)}
        className="flex size-6 items-center justify-center rounded-sm text-fg-3 hover:bg-surface-3 hover:text-fg-1"
      >
        {editing ? <Check className="icon-sm" /> : <Pencil className="icon-sm" />}
      </button>
    </div>
  );
}

function PositionStrip({ detail }: { detail: TokenDetail }) {
  const position = useActivePosition(detail.summary.mint);
  const solUsd = useMarket((s) => s.solUsd);
  const [usd, setUsd] = useState(false);
  const v = (sol: number) => (usd ? fmtUsd(sol * solUsd) : `${fmtSol(sol)}`);
  const bought = position?.boughtSol ?? 0;
  const sold = position?.soldSol ?? 0;
  const holding = position?.valueSol ?? 0;
  const pnl = (position?.realizedPnlSol ?? 0) + (position?.unrealizedPnlSol ?? 0);
  return (
    <div className="grid grid-cols-4 border-t border-hairline">
      {[
        { label: "Bought", value: v(bought), tone: "text-buy" },
        { label: "Sold", value: v(sold), tone: "text-sell" },
        { label: "Holding", value: v(holding), tone: "text-fg-1" },
      ].map((c) => (
        <div key={c.label} className="flex flex-col items-center justify-center gap-1 border-r border-hairline py-2">
          <span className="zf-label">{c.label}</span>
          <span className={cn("text-data font-medium", c.tone)}>{c.value}</span>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setUsd((u) => !u)}
        className="flex flex-col items-center justify-center gap-1 py-2 hover:bg-surface-3"
        title="Toggle SOL / USD"
      >
        <span className="zf-label">PnL {usd ? "USD" : "SOL"}</span>
        <span className={cn("text-data font-medium", pnl >= 0 ? "text-buy" : "text-sell")}>
          {usd ? fmtUsd(pnl * solUsd) : fmtSignedSol(pnl)}
          <span className="ml-1 text-micro">{fmtPnlPct(pnl, bought)}</span>
        </span>
      </button>
    </div>
  );
}

export function TradePanel({ detail }: { detail: TokenDetail }) {
  const token = detail.summary;
  const [side, setSide] = useState<Side>("buy");
  const [tab, setTab] = useState<Tab>("market");
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const presetId = useSettings((s) => s.activePreset);
  const setPreset = useSettings((s) => s.setPreset);
  const status = useActiveStatus();
  const position = useActivePosition(token.mint);
  const mode = useWallet((s) => s.mode);
  const solUsd = useMarket((s) => s.solUsd);
  const pending = useTrades((s) => s.items.some((t) => t.mint === token.mint && t.side === side && t.status === "pending"));
  const limit = useTokenUi((s) => s.limit);
  const setLimit = useTokenUi((s) => s.setLimit);

  const [buySol, setBuySol] = useState<number | null>(preset.buyAmounts[1] ?? 0.25);
  const [sellPct, setSellPct] = useState<number | null>(preset.sellPcts[3] ?? 100);
  const [trigger, setTrigger] = useState<"mc" | "price">("mc");
  const [ladder, setLadder] = useState<LadderRow[]>(() => [
    { id: uid("leg"), kind: "take_profit", triggerPct: 100, sellPct: 50 },
    { id: uid("leg"), kind: "take_profit", triggerPct: 300, sellPct: 50 },
    { id: uid("leg"), kind: "stop_loss", triggerPct: 40, sellPct: 100 },
  ]);
  const [oco, setOco] = useState(true);
  const [migrationSell, setMigrationSell] = useState(false);
  const [migrationPct, setMigrationPct] = useState<number | null>(25);
  const [busy, setBusy] = useState(false);

  const holding = position?.holdingTokens ?? 0;
  const available = status ? Math.max(0, status.solBalance - status.reservedSol) : 0;
  const onCurve = token.migratedAt === null;
  const settings = preset[side];

  // The Limit tab drives the chart's draggable target line (seeded from the price when it opens).
  const priceRef = useRef(token.priceSol);
  priceRef.current = token.priceSol;
  useEffect(() => {
    if (tab === "limit") {
      const current = useTokenUi.getState().limit;
      setLimit({ active: true, side, priceSol: current.priceSol ?? priceRef.current * (side === "buy" ? 0.8 : 1.5) });
    } else setLimit({ active: false });
  }, [tab, side, setLimit]);
  useEffect(() => () => setLimit({ active: false, priceSol: null }), [setLimit]);

  const buyQuote = useMemo(
    () => (side === "buy" && buySol ? quoteBuy(detail.curve, detail.pool, buySol) : null),
    [side, buySol, detail.curve, detail.pool],
  );
  const sellTokens = (holding * (sellPct ?? 0)) / 100;
  const sellQuote = useMemo(
    () => (side === "sell" ? quoteSell(detail.curve, detail.pool, sellTokens) : null),
    [side, sellTokens, detail.curve, detail.pool],
  );
  const extra = settings.priorityFeeSol + settings.tipSol;

  const limitPrice = limit.priceSol ?? token.priceSol;
  const limitValue = trigger === "mc" ? limitPrice * token.supply * solUsd : limitPrice;
  const distancePct = token.priceSol > 0 ? (limitPrice / token.priceSol - 1) * 100 : 0;
  const setLimitFromValue = (v: number | null) => {
    if (v === null || v <= 0) return;
    setLimit({ priceSol: trigger === "mc" ? v / (token.supply * solUsd) : v });
  };

  const submitMarket = async () => {
    if (side === "buy") {
      if (buySol) await buy({ mint: token.mint, sol: buySol, source: "token" });
    } else if (sellPct) await sell({ mint: token.mint, pct: sellPct, source: "token" });
  };

  const submitLimit = async () => {
    setBusy(true);
    await placeLimit({
      mint: token.mint,
      side,
      trigger: { metric: trigger, direction: limitPrice < token.priceSol ? "below" : "above", value: limitValue },
      size: side === "buy" ? { kind: "sol", sol: buySol ?? 0 } : { kind: "pct", pct: sellPct ?? 100 },
    });
    setBusy(false);
  };

  const legs: TpSlLeg[] = ladder
    .filter((l) => l.triggerPct > 0 && l.sellPct > 0)
    .map(({ kind, triggerPct, sellPct: pct }) => ({ kind, triggerPct, sellPct: pct }));

  const submitAdvanced = async () => {
    setBusy(true);
    if (side === "buy" && buySol) {
      const receipts = await buy({ mint: token.mint, sol: buySol, source: "token" });
      const fill = receipts.find((r) => r.status === "confirmed")?.fill;
      if (fill) {
        if (legs.length > 0) await armTpSl({ mint: token.mint, entryPriceSol: fill.priceSol, legs, oco });
        if (migrationSell && onCurve && migrationPct)
          await armMigration({ mint: token.mint, side: "sell", size: { kind: "pct", pct: migrationPct } });
      }
    } else if (side === "sell" && migrationSell && onCurve && migrationPct) {
      await armMigration({ mint: token.mint, side: "sell", size: { kind: "pct", pct: migrationPct } });
    }
    setBusy(false);
  };

  const armOnPosition = async () => {
    if (!position || position.avgEntryPriceSol <= 0) return;
    setBusy(true);
    await armTpSl({ mint: token.mint, entryPriceSol: position.avgEntryPriceSol, legs, oco });
    setBusy(false);
  };

  const ctaVariant = side === "buy" ? "buy" : "sell";
  const amountValid = side === "buy" ? (buySol ?? 0) > 0 : (sellPct ?? 0) > 0 && holding > 0;

  return (
    <div className="flex flex-col">
      <div className="space-y-3 p-3">
        <Segmented<Side>
          className="w-full"
          value={side}
          onChange={setSide}
          tone={(v) => (v === "buy" ? "buy" : "sell")}
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
          label="Side"
        />
        <div className="flex border-b border-hairline">
          {(["market", "limit", "advanced"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "-mb-px border-b-2 px-2 pb-2 text-data font-medium capitalize",
                tab === t ? "border-fg-1 text-fg-1" : "border-transparent text-fg-2 hover:text-fg-1",
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "limit" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="zf-label">Trigger on</span>
              <Segmented<"mc" | "price">
                size="xs"
                value={trigger}
                onChange={setTrigger}
                options={[
                  { value: "mc", label: "Market cap" },
                  { value: "price", label: "Price" },
                ]}
                label="Limit trigger"
              />
            </div>
            <NumberInput
              value={Number(limitValue.toPrecision(5))}
              onChange={setLimitFromValue}
              prefix={<span className="text-label">{trigger === "mc" ? "Target MC $" : "Target price"}</span>}
              suffix={trigger === "price" ? "SOL" : undefined}
              alignRight
              ariaLabel="Limit target"
            />
            <input
              type="range"
              min={-99}
              max={100}
              step={1}
              value={Math.max(-99, Math.min(100, Math.round(distancePct)))}
              onChange={(e) => setLimit({ priceSol: token.priceSol * (1 + Number(e.target.value) / 100) })}
              className="w-full accent-fg"
              aria-label="Distance from current price"
            />
            <Row label="Distance from current">
              <span className={distancePct >= 0 ? "text-buy" : "text-sell"}>{fmtPct(distancePct, { signed: true })}</span>
            </Row>
          </div>
        )}

        {side === "buy" ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-label">
              <span className="zf-label">Amount</span>
              <span className="text-fg-3">
                Available <span className="text-fg-1">{fmtSol(available)} SOL</span>
              </span>
            </div>
            <NumberInput
              value={buySol}
              onChange={setBuySol}
              suffix="SOL"
              min={0}
              alignRight
              className="h-8"
              onEnter={() => tab === "market" && amountValid && void submitMarket()}
              ariaLabel="Buy amount in SOL"
            />
            <AmountPresets
              values={preset.buyAmounts}
              unit="SOL"
              activeValue={buySol}
              onPick={setBuySol}
              onEdit={(v) => setPreset(presetId, { buyAmounts: v })}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-label">
              <span className="zf-label">Amount</span>
              <span className="text-fg-3">
                Holding <span className="text-fg-1">{fmtTokens(holding)}</span>
                {position && position.valueSol > 0 && <span> · {fmtSol(position.valueSol)} SOL</span>}
              </span>
            </div>
            <NumberInput
              value={sellPct}
              onChange={setSellPct}
              suffix="%"
              min={0}
              max={100}
              alignRight
              className="h-8"
              onEnter={() => tab === "market" && amountValid && void submitMarket()}
              ariaLabel="Sell percentage"
            />
            <AmountPresets
              values={preset.sellPcts}
              unit="%"
              activeValue={sellPct}
              onPick={setSellPct}
              onEdit={(v) => setPreset(presetId, { sellPcts: v })}
            />
          </div>
        )}

        {tab === "advanced" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="zf-label">Exit ladder (TP / SL)</span>
              <button
                type="button"
                onClick={() => setLadder((l) => [...l, { id: uid("leg"), kind: "take_profit", triggerPct: 50, sellPct: 25 }])}
                className="flex items-center gap-1 text-label text-fg-2 hover:text-fg-1"
              >
                <Plus className="icon-xs" /> Add level
              </button>
            </div>
            {ladder.map((row) => (
              <div key={row.id} className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1">
                <Segmented<"take_profit" | "stop_loss">
                  size="xs"
                  value={row.kind}
                  onChange={(kind) => setLadder((l) => l.map((x) => (x.id === row.id ? { ...x, kind } : x)))}
                  tone={(v) => (v === "take_profit" ? "buy" : "sell")}
                  options={[
                    { value: "take_profit", label: "TP" },
                    { value: "stop_loss", label: "SL" },
                  ]}
                  label="Leg type"
                />
                <NumberInput
                  value={row.triggerPct}
                  onChange={(v) => setLadder((l) => l.map((x) => (x.id === row.id ? { ...x, triggerPct: v ?? 0 } : x)))}
                  prefix={<span className="text-micro">{row.kind === "take_profit" ? "+" : "−"}</span>}
                  suffix="%"
                  min={0}
                  alignRight
                  className="h-6"
                  ariaLabel="Trigger distance from entry"
                />
                <NumberInput
                  value={row.sellPct}
                  onChange={(v) => setLadder((l) => l.map((x) => (x.id === row.id ? { ...x, sellPct: v ?? 0 } : x)))}
                  prefix={<span className="text-micro">sell</span>}
                  suffix="%"
                  min={0}
                  max={100}
                  alignRight
                  className="h-6"
                  ariaLabel="Share of holding to sell"
                />
                <button
                  type="button"
                  aria-label="Remove level"
                  onClick={() => setLadder((l) => l.filter((x) => x.id !== row.id))}
                  className="flex size-6 items-center justify-center text-fg-3 hover:text-sell"
                >
                  <Trash2 className="icon-sm" />
                </button>
              </div>
            ))}
            <Checkbox
              checked={oco}
              onChange={setOco}
              label="Pair each TP with an SL (OCO)"
              hint="A TP and its SL share one durable nonce: when one lands the other can't."
            />
            {onCurve && (
              <div className="flex items-center gap-2">
                <Checkbox checked={migrationSell} onChange={setMigrationSell} label="Sell on migration" />
                <NumberInput
                  value={migrationPct}
                  onChange={setMigrationPct}
                  suffix="%"
                  min={1}
                  max={100}
                  alignRight
                  className="ml-auto h-6 w-20"
                  ariaLabel="Migration sell share"
                />
              </div>
            )}
            <p className="text-micro text-fg-3">Exits are pre-signed on durable nonces and run with this tab closed.</p>
          </div>
        )}

        <div className="space-y-1 rounded-sm border border-hairline bg-surface-2 p-2">
          {side === "buy" ? (
            <>
              <Row label="You receive">{buyQuote ? `≈ ${fmtTokens(buyQuote.tokens)} ${token.symbol}` : "–"}</Row>
              <Row label="Price impact" tone={buyQuote && buyQuote.impactPct > 10 ? "text-warn" : undefined}>
                {buyQuote ? fmtPct(buyQuote.impactPct) : "–"}
              </Row>
              <Row label={`Venue fee (${((detail.pool?.feeBps ?? detail.curve?.feeBps ?? 125) / 100).toFixed(2)}%)`}>
                {buyQuote ? `${fmtSol(buyQuote.venueFeeSol)} SOL` : "–"}
              </Row>
            </>
          ) : (
            <>
              <Row label="You receive">{sellQuote ? `≈ ${fmtSol(sellQuote.sol)} SOL` : "–"}</Row>
              <Row label="Price impact" tone={sellQuote && sellQuote.impactPct > 10 ? "text-warn" : undefined}>
                {sellQuote ? fmtPct(sellQuote.impactPct) : "–"}
              </Row>
              <Row label="Venue fee">{sellQuote ? `${fmtSol(sellQuote.venueFeeSol)} SOL` : "–"}</Row>
            </>
          )}
          <Row label="Priority + tip">{fmtSol(extra)} SOL</Row>
          <Row label="Network fee">{fmtSol(NETWORK_FEE_SOL)} SOL</Row>
          <Row
            label={
              <Tooltip content="zerofee charges no platform fee. Venue fees go to the launchpad or AMM; tips and priority fees go to the network.">
                <span className="cursor-help underline decoration-hairline-strong decoration-dotted underline-offset-2">Platform fee</span>
              </Tooltip>
            }
            tone="text-buy"
          >
            0.000 SOL
          </Row>
          {tab === "limit" && (
            <Row label="Reserved while armed">
              {side === "buy" ? `${fmtSol((buySol ?? 0) + extra + 0.002)} SOL` : `${fmtSol(extra + 0.001)} SOL`}
            </Row>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <PresetSwitch size="xs" />
            <PresetSettingsRow side={side} className="flex-1" />
          </div>
        </div>

        {tab === "market" && (
          <Button variant={ctaVariant} size="lg" className="w-full" disabled={!amountValid} onClick={() => void submitMarket()}>
            {pending && <LoaderCircle className="icon-sm animate-spin" />}
            {side === "buy" ? `Buy ${token.symbol}` : `Sell ${sellPct ?? 0}% ${token.symbol}`}
          </Button>
        )}
        {tab === "limit" && (
          <Button variant={ctaVariant} size="lg" className="w-full" disabled={!amountValid || busy} onClick={() => void submitLimit()}>
            {busy && <LoaderCircle className="icon-sm animate-spin" />}
            {side === "buy" ? "Buy" : "Sell"} @ {trigger === "mc" ? `${fmtUsd(limitValue)} MC` : `${fmtPriceText(limitValue)} SOL`}
          </Button>
        )}
        {tab === "advanced" && (
          <div className="space-y-2">
            {side === "buy" ? (
              <Button variant="buy" size="lg" className="w-full" disabled={!amountValid || busy} onClick={() => void submitAdvanced()}>
                {busy && <LoaderCircle className="icon-sm animate-spin" />}
                Buy {buySol ? fmtSolShort(buySol) : 0} SOL + arm {legs.length + (migrationSell && onCurve ? 1 : 0)} exits
              </Button>
            ) : (
              <Button
                variant="sell"
                size="lg"
                className="w-full"
                disabled={!migrationSell || !onCurve || holding <= 0 || busy}
                onClick={() => void submitAdvanced()}
              >
                Arm migration sell
              </Button>
            )}
            {holding > 0 && legs.length > 0 && (
              <Button variant="secondary" size="md" className="w-full" disabled={busy} onClick={() => void armOnPosition()}>
                Arm ladder on current position (entry {fmtPriceText(position?.avgEntryPriceSol ?? 0)} SOL)
              </Button>
            )}
          </div>
        )}
        <p className="text-micro text-fg-3">
          {mode === "instant"
            ? "Instant mode: the trading wallet in this browser signs, no popup."
            : "Direct mode: approve each trade in your connected wallet."}
        </p>
      </div>
      <PositionStrip detail={detail} />
    </div>
  );
}
