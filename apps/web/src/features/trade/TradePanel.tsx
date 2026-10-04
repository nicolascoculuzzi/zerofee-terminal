import { AlertTriangle, Lock, Wallet } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "../../components/ui/Button";
import { Hotkey, Kbd, Segmented } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { fmtCompact, fmtPriceText, fmtSol, fmtSolShort, fmtTokens } from "../../lib/format";
import { compactLabel } from "../../lib/hotkeys";
import { buyRiskReasons } from "../../lib/metrics";
import { navigateTo } from "../../lib/nav";
import { quoteBuy, quoteSell } from "../../lib/quote";
import { armMigration, armTpSl, buy, sell } from "../../lib/tradeActions";
import type { TokenDetail } from "../../protocol";
import type { TpSlLeg } from "../../services/tradeService";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { useUi } from "../../state/ui";
import { useActivePosition, useActiveStatus, useWallet } from "../../state/wallet";
import { useQuote } from "../token/money";
import { type OrderType, type TradeSide, useTokenUi } from "../token/tokenUi";
import { AmountField, solStep } from "./AmountField";
import { CostBreakdown, type CostKind } from "./CostBreakdown";
import { ExitLadder } from "./ExitLadder";
import { LimitFields, triggerValue } from "./LimitFields";
import { armLimitDraft, defaultLimitPrice } from "./orderDraft";
import { PositionStrip } from "./PositionStrip";
import { ExecutionSummary } from "./PresetSettings";
import { buyCost, buyIssue, type CostLines, maxBuySol, sellCost, venueShort } from "./tradeMath";

/*
 * Trade panel (DESIGN.md 4.11): side, order type, amount (4.7), limit or exit-ladder fields,
 * the execution summary, the cost breakdown with "Platform fee 0", the verb CTA and the
 * position strip. Trade buttons never spin: the transaction toast carries progress (4.13).
 * Layout after Axiom's panel; Buy/Sell CTAs after OKX and Binance:
 * https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae
 * https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c
 * "Available to trade" and Subtotal / Fee / Total after Coinbase Advanced:
 * https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544
 */

const ORDER_TYPES: { id: OrderType; label: string; action: "token.market" | "token.limit" | "token.advanced" }[] = [
  { id: "market", label: "Market", action: "token.market" },
  { id: "limit", label: "Limit", action: "token.limit" },
  { id: "advanced", label: "Advanced", action: "token.advanced" },
];

const PROVIDER: Record<string, string> = { phantom: "Phantom", solflare: "Solflare", backpack: "Backpack" };

/** Underline tabs for the order type (28 px; roving tabindex, Left/Right, Home/End). */
function OrderTypeTabs({ value, onChange }: { value: OrderType; onChange: (t: OrderType) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const bindings = useSettings((s) => s.hotkeys);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = ORDER_TYPES.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % ORDER_TYPES.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + ORDER_TYPES.length) % ORDER_TYPES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ORDER_TYPES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = ORDER_TYPES[next];
    if (t) {
      onChange(t.id);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="tablist" aria-label="Order type" onKeyDown={onKey} className="flex h-7 items-stretch gap-1 border-b border-hairline">
      {ORDER_TYPES.map((t, i) => {
        const active = t.id === value;
        const key = bindings[t.action]?.[0];
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={key ? `${t.label} (${compactLabel(key)})` : t.label}
            onClick={() => onChange(t.id)}
            className={cn(
              "focus-inset relative px-2 text-data font-medium transition-colors",
              active ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {t.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

interface Cta {
  label: string;
  variant: "buy" | "sell" | "secondary";
  disabled: boolean;
  icon?: ReactNode;
  run?: () => void;
  note?: string;
}

export function TradePanel({ detail, layout = "rail" }: { detail: TokenDetail; layout?: "rail" | "wide" }) {
  const token = detail.summary;
  const mint = token.mint;
  const ui = useTokenUi(
    useShallow((s) => ({
      side: s.side,
      orderType: s.orderType,
      buySol: s.buySol,
      sellPct: s.sellPct,
      sellSol: s.sellSol,
      sellUnit: s.sellUnit,
      triggerMetric: s.triggerMetric,
      limitPriceSol: s.limitPriceSol,
      ladder: s.ladder,
      ladderMode: s.ladderMode,
      oco: s.oco,
      costOpen: s.costOpen,
      setSide: s.setSide,
      setOrderType: s.setOrderType,
      setBuySol: s.setBuySol,
      setSellPct: s.setSellPct,
      setSellSol: s.setSellSol,
      setSellUnit: s.setSellUnit,
      setTriggerMetric: s.setTriggerMetric,
      setLimitPriceSol: s.setLimitPriceSol,
      setLadder: s.setLadder,
      setLadderMode: s.setLadderMode,
      setOco: s.setOco,
      setCostOpen: s.setCostOpen,
    })),
  );
  const presetId = useSettings((s) => s.activePreset);
  const preset = useSettings((s) => s.presets[s.activePreset]);
  const setPreset = useSettings((s) => s.setPreset);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const caps = useSettings((s) => s.caps);
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const quickKey = useSettings((s) => s.hotkeys["buy.quick"]?.[0]);
  const buyKey = useSettings((s) => s.hotkeys["token.sideBuy"]?.[0]);
  const sellKey = useSettings((s) => s.hotkeys["token.sideSell"]?.[0]);
  const spentToday = useTrades((s) => s.spentToday());
  const status = useActiveStatus();
  const position = useActivePosition(mint);
  const activeAddress = useWallet((s) => s.activeAddress);
  const mode = useWallet((s) => s.mode);
  const locked = useWallet((s) => s.service.locked);
  const provider = useWallet((s) => s.service.connected?.provider ?? "phantom");
  const connection = useMarket((s) => s.connection);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const openSettings = useUi((s) => s.openSettings);
  const { quote, solUsd } = useQuote();
  const [focusWithin, setFocusWithin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [migrationOn, setMigrationOn] = useState(false);
  const [migrationPct, setMigrationPct] = useState<number | null>(25);

  const side = ui.side;
  const orderType = ui.orderType;
  const exec = preset[side];
  // null until the venue's live fee is known (the live trade engine reads FeeConfig).
  const feeBps = detail.pool?.feeBps ?? detail.curve?.feeBps ?? null;
  const venue = venueShort(token.venue);
  // null until the wallet feed reports a balance: "–", and no balance check (never a fake 0).
  const available = status ? Math.max(0, status.solBalance - status.reservedSol) : null;
  const holding = position?.holdingTokens ?? 0;
  const firstBuy = holding <= 0;
  const feedOk = connection === "live" || connection === "degraded";
  const onCurve = token.migratedAt === null && !!detail.curve && !detail.curve.complete;
  const buySol = ui.buySol ?? quickBuy;
  const sellPct = ui.sellPct;
  const sellSol = ui.sellSol;
  const sellUnit = orderType === "market" ? ui.sellUnit : "pct";

  // Limit draft: seeded when the Limit tab opens; the chart draws and drags it.
  const priceRef = useRef(token.priceSol);
  priceRef.current = token.priceSol;
  useEffect(() => {
    if (orderType === "limit" && useTokenUi.getState().limitPriceSol === null) {
      const seed = defaultLimitPrice(useTokenUi.getState().side, priceRef.current);
      if (seed !== null) useTokenUi.getState().setLimitPriceSol(seed);
    }
  }, [orderType]);
  // NaN while the price is unknown: the limit fields read "–" and arming refuses (armLimitDraft).
  const limitPrice = ui.limitPriceSol ?? defaultLimitPrice(side, token.priceSol) ?? Number.NaN;

  const sellTokens =
    sellUnit === "pct"
      ? (holding * (sellPct ?? 0)) / 100
      : token.priceSol !== null && token.priceSol > 0
        ? Math.min(holding, (sellSol ?? 0) / token.priceSol)
        : 0;

  const buyQuote = useMemo(
    () => (side === "buy" && buySol > 0 ? quoteBuy(detail.curve, detail.pool, buySol) : null),
    [side, buySol, detail.curve, detail.pool],
  );
  const sellQuote = useMemo(
    () => (side === "sell" && sellTokens > 0 ? quoteSell(detail.curve, detail.pool, sellTokens) : null),
    [side, sellTokens, detail.curve, detail.pool],
  );

  const legs: TpSlLeg[] = ui.ladder
    .filter((l) => l.triggerPct > 0 && l.sellPct > 0)
    .map(({ kind, triggerPct, sellPct: pct }) => ({ kind, triggerPct, sellPct: pct }));
  const exitCount = legs.length + (migrationOn && onCurve ? 1 : 0);

  let costKind: CostKind;
  let cost: CostLines;
  if (side === "buy") {
    costKind = orderType === "limit" ? "limitBuy" : "buy";
    cost = buyCost(orderType === "limit" ? null : buyQuote, buySol, exec, firstBuy, feeBps);
  } else {
    costKind = orderType === "limit" ? "limitSell" : orderType === "advanced" ? "ladder" : "sell";
    cost = sellCost(sellQuote, exec, feeBps);
  }

  const issue =
    side === "buy"
      ? buyIssue({
          sol: ui.buySol ?? quickBuy,
          available,
          settings: exec,
          firstBuy,
          perTradeCap: caps.perTradeSol,
          dailyCap: caps.dailySol,
          spentToday,
        })
      : null;

  // ---- actions ----
  const submitMarket = () => {
    if (side === "buy") void buy({ mint, sol: buySol, source: "token" });
    else if (sellUnit === "pct" && sellPct) void sell({ mint, pct: sellPct, source: "token" });
    else if (sellUnit === "sol" && sellSol) void sell({ mint, solValue: sellSol, source: "token" });
  };

  const submitLimit = async () => {
    setBusy(true);
    try {
      await armLimitDraft(token);
    } finally {
      setBusy(false);
    }
  };

  const submitAdvanced = async () => {
    setBusy(true);
    try {
      if (side === "buy") {
        const receipts = await buy({ mint, sol: buySol, source: "token" });
        const fill = receipts.find((r) => r.status === "confirmed")?.fill;
        if (fill) {
          if (legs.length > 0) await armTpSl({ mint, entryPriceSol: fill.priceSol, legs, oco: ui.oco });
          if (migrationOn && onCurve && migrationPct) await armMigration({ mint, side: "sell", size: { kind: "pct", pct: migrationPct } });
        }
      } else if (position && position.avgEntryPriceSol > 0) {
        if (legs.length > 0) await armTpSl({ mint, entryPriceSol: position.avgEntryPriceSol, legs, oco: ui.oco });
        if (migrationOn && onCurve && migrationPct) await armMigration({ mint, side: "sell", size: { kind: "pct", pct: migrationPct } });
      }
    } finally {
      setBusy(false);
    }
  };

  // ---- CTA ----
  const sym = token.symbol;
  const wallet = PROVIDER[provider] ?? "your wallet";
  const direct = mode === "direct";
  const limitText = (() => {
    const v = triggerValue(limitPrice, ui.triggerMetric, quote, token.supply, solUsd);
    if (ui.triggerMetric === "price") return `${quote === "USD" ? "$" : ""}${fmtPriceText(v)}`;
    return quote === "USD" ? fmtCompact(v) : `${fmtSol(v)} SOL`;
  })();

  let cta: Cta;
  if (!activeAddress) {
    cta = { label: "Connect wallet", variant: "secondary", disabled: false, icon: <Wallet />, run: () => navigateTo("/onboarding") };
  } else if (locked && (!direct || orderType !== "market")) {
    cta = {
      label: "Unlock to trade",
      variant: "secondary",
      disabled: false,
      icon: <Lock />,
      run: () => requestUnlock(`Unlock to trade $${sym}`),
    };
  } else if (!feedOk) {
    cta = { label: "Feed offline", variant: side, disabled: true };
  } else if (side === "buy") {
    if (!(buySol > 0)) cta = { label: "Enter an amount", variant: "buy", disabled: true };
    else if (issue) cta = { label: issue.cta, variant: "buy", disabled: true };
    else if (orderType === "market")
      cta = {
        label: direct ? `Buy in ${wallet} · ${fmtSolShort(buySol)} SOL` : `Buy ${sym} · ${fmtSolShort(buySol)} SOL`,
        variant: "buy",
        disabled: false,
        run: submitMarket,
        note: direct ? "Approve in your wallet" : undefined,
      };
    else if (orderType === "limit")
      cta = {
        label: `Arm limit buy · ${fmtSolShort(buySol)} SOL @ ${limitText}`,
        variant: "buy",
        disabled: busy,
        run: () => void submitLimit(),
      };
    else
      cta = {
        label: `Buy ${sym} · ${fmtSolShort(buySol)} SOL${exitCount > 0 ? ` + ${exitCount} exit${exitCount === 1 ? "" : "s"}` : ""}`,
        variant: "buy",
        disabled: busy,
        run: () => void submitAdvanced(),
        note: direct ? "Approve in your wallet" : undefined,
      };
  } else if (holding <= 0) {
    cta = { label: `No ${sym} to sell`, variant: "sell", disabled: true };
  } else if (orderType === "advanced") {
    cta =
      exitCount === 0
        ? { label: "Add an exit level", variant: "sell", disabled: true }
        : {
            label: `Arm ${exitCount} exit order${exitCount === 1 ? "" : "s"}`,
            variant: "sell",
            disabled: busy || !(position && position.avgEntryPriceSol > 0),
            run: () => void submitAdvanced(),
          };
  } else if (sellUnit === "pct" ? !(sellPct && sellPct > 0) : !(sellSol && sellSol > 0)) {
    cta = { label: "Enter an amount", variant: "sell", disabled: true };
  } else if (orderType === "limit") {
    cta = {
      label: `Arm limit sell · ${fmtSolShort(sellPct ?? 0)}% @ ${limitText}`,
      variant: "sell",
      disabled: busy,
      run: () => void submitLimit(),
    };
  } else {
    const receive = sellQuote ? ` · ~${fmtSol(cost.totalSol)} SOL` : "";
    const amount = sellUnit === "pct" ? `${fmtSolShort(sellPct ?? 0)}%` : `${fmtSolShort(sellSol ?? 0)} SOL`;
    cta = {
      label: direct ? `Sell in ${wallet} · ${amount}` : `Sell ${amount}${receive}`,
      variant: "sell",
      disabled: false,
      run: submitMarket,
      note: direct ? "Approve in your wallet" : undefined,
    };
  }
  const fire = () => {
    if (!cta.disabled) cta.run?.();
  };

  const risk = side === "buy" ? buyRiskReasons(token, thresholds) : [];

  // ---- sections ----
  const amount =
    side === "buy" ? (
      <AmountField
        inputId="trade-amount"
        value={ui.buySol ?? quickBuy}
        onChange={ui.setBuySol}
        unit="SOL"
        step={solStep}
        presets={preset.buyAmounts}
        presetLabel={fmtSolShort}
        onSavePresets={(v) => setPreset(presetId, { buyAmounts: v })}
        issue={issue}
        onIssueAction={() => openSettings("trading")}
        onEnter={fire}
        ariaLabel="Buy amount in SOL"
        right={
          <>
            Bal <span className="zf-num text-fg-2">{fmtSol(available)}</span> SOL ·
            <button
              type="button"
              disabled={available === null}
              onClick={() => available !== null && ui.setBuySol(maxBuySol(available, exec, firstBuy))}
              className="font-medium text-fg-1 hover:underline"
              title="Leaves the reserve for fees, tip and rent"
            >
              Max
            </button>
          </>
        }
      />
    ) : (
      <AmountField
        inputId="trade-amount"
        value={sellUnit === "pct" ? sellPct : sellSol}
        onChange={sellUnit === "pct" ? ui.setSellPct : ui.setSellSol}
        unit={sellUnit === "pct" ? "%" : "SOL"}
        step={sellUnit === "pct" ? 1 : solStep}
        max={sellUnit === "pct" ? 100 : undefined}
        presets={sellUnit === "pct" ? preset.sellPcts : preset.instantSellSol}
        presetLabel={(v) => (sellUnit === "pct" ? `${fmtSolShort(v)}%` : fmtSolShort(v))}
        onSavePresets={(v) => setPreset(presetId, sellUnit === "pct" ? { sellPcts: v } : { instantSellSol: v })}
        onEnter={fire}
        ariaLabel={sellUnit === "pct" ? "Share of the holding to sell" : "SOL value to sell"}
        right={
          <>
            Bal <span className="zf-num text-fg-2">{fmtTokens(holding)}</span> {sym} ·
            <button
              type="button"
              onClick={() => {
                ui.setSellUnit("pct");
                ui.setSellPct(100);
              }}
              className="font-medium text-fg-1 hover:underline"
            >
              Max
            </button>
            {orderType === "market" && (
              <Segmented<"pct" | "sol">
                size="xs"
                className="ml-1"
                value={sellUnit}
                onChange={ui.setSellUnit}
                options={[
                  { value: "pct", label: "%" },
                  { value: "sol", label: "SOL" },
                ]}
                label="Sell amount unit"
              />
            )}
          </>
        }
      />
    );

  const refPrice = side === "sell" && position && position.avgEntryPriceSol > 0 ? position.avgEntryPriceSol : token.priceSol;
  const refMcQuote = refPrice === null ? Number.NaN : triggerValue(refPrice, "mc", quote, token.supply, solUsd);

  const fields = (
    <>
      {orderType === "limit" && (
        <LimitFields
          token={token}
          priceSol={limitPrice}
          onPriceSol={ui.setLimitPriceSol}
          metric={ui.triggerMetric}
          onMetric={ui.setTriggerMetric}
          quote={quote}
          solUsd={solUsd}
          onEnter={fire}
        />
      )}
      {orderType === "advanced" && (
        <ExitLadder
          ladder={ui.ladder}
          onChange={ui.setLadder}
          mode={ui.ladderMode}
          onMode={ui.setLadderMode}
          oco={ui.oco}
          onOco={ui.setOco}
          refMc={refMcQuote}
          quote={quote}
          afterBuy={side === "buy"}
          migration={onCurve ? { on: migrationOn, pct: migrationPct, onToggle: setMigrationOn, onPct: setMigrationPct } : null}
        />
      )}
    </>
  );

  const summary = (
    <>
      <ExecutionSummary side={side} />
      <CostBreakdown
        kind={costKind}
        cost={cost}
        symbol={sym}
        venue={venue}
        route={detail.route ?? null}
        landing={exec.landing}
        slippagePct={exec.slippagePct}
        open={ui.costOpen}
        onToggle={() => ui.setCostOpen(!ui.costOpen)}
      />
      {risk.length > 0 && (
        <p className="flex items-start gap-1 text-label text-warn">
          <AlertTriangle className="icon-xs mt-px shrink-0" />
          <span>{risk.join(" · ")}. Buys wait on a 3 s confirm.</span>
        </p>
      )}
      <div>
        <Button
          variant={cta.variant}
          size="xl"
          className="w-full"
          disabled={cta.disabled}
          aria-busy={busy || undefined}
          icon={cta.icon}
          onClick={fire}
        >
          <span className="truncate">{cta.label}</span>
        </Button>
        <div className="flex h-4 items-center justify-center gap-1 pt-1 text-label text-fg-3">
          {cta.note ? (
            <span>{cta.note}</span>
          ) : (
            <span className={cn("flex items-center gap-1", !(focusWithin && !cta.disabled && cta.variant !== "secondary") && "invisible")}>
              <Kbd>Enter</Kbd>
              {side === "buy" && orderType === "market" && quickKey && (
                <>
                  or <Hotkey binding={quickKey} />
                </>
              )}
            </span>
          )}
        </div>
      </div>
    </>
  );

  const head = (
    <>
      <Segmented<TradeSide>
        size="side"
        className="w-full"
        value={side}
        onChange={ui.setSide}
        tone={(v) => (v === "buy" ? "buy" : "sell")}
        options={[
          { value: "buy", label: "Buy", title: `Buy (${compactLabel(buyKey)})` },
          { value: "sell", label: "Sell", title: `Sell (${compactLabel(sellKey)})` },
        ]}
        label="Side"
      />
      <OrderTypeTabs value={orderType} onChange={ui.setOrderType} />
    </>
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tracks focus-within for the Enter hint only
    <div
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      {layout === "wide" ? (
        <div className="grid grid-cols-2 gap-6 p-3">
          <div className="space-y-2">
            {head}
            {amount}
            {fields}
          </div>
          <div className="space-y-2">
            {summary}
            <PositionStrip mint={mint} symbol={sym} position={position} />
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2 p-3">
            {head}
            {amount}
            {fields}
            {summary}
          </div>
          <PositionStrip mint={mint} symbol={sym} position={position} />
        </>
      )}
    </div>
  );
}
