import { ChevronDown, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "../../components/ui/Button";
import { NumberInput } from "../../components/ui/controls";
import { BottomSheet } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { fmtSol, fmtSolShort, fmtTokens } from "../../lib/format";
import { quoteBuy, quoteSell } from "../../lib/quote";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import type { TokenDetail } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { useUi } from "../../state/ui";
import { useActivePosition, useActiveStatus, useWallet } from "../../state/wallet";
import { CostBreakdown } from "../trade/CostBreakdown";
import { buyCost, buyIssue, sellCost, venueShort } from "../trade/tradeMath";

/*
 * Phone trade bar (DESIGN.md 5.8): sticky above the bottom tabs, 64 px: an amount chip (72 px,
 * opens the preset chips), "Buy WIF 0.25" (buy, flexible, 44 px) and "Sell" (sell-tint, 88 px).
 * Sell opens a sheet with 25/50/75/100% chips, Sell initials and the CTA. With "Confirm trades on
 * touch devices" on (default) Buy opens a compact review sheet: the cost summary and one CTA.
 * Sticky Buy above the tab bar after Phantom https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba;
 * an amount-preset grid in a sheet after Cash App https://mobbin.com/screens/3c393e1e-5d4a-4387-874f-281996eead50;
 * a compact confirm after Phantom's review https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2
 */

type Sheet = null | "amount" | "review" | "sell";

const SELL_PCTS = [25, 50, 75, 100];

export function MobileTradeBar({ detail }: { detail: TokenDetail }) {
  const token = detail.summary;
  const mint = token.mint;
  const quickBuy = useSettings((s) => s.quickBuySol);
  const setQuickBuy = useSettings((s) => s.setQuickBuy);
  const presets = useSettings((s) => s.presets[s.activePreset]);
  const confirmOnTouch = useSettings((s) => s.display.confirmOnTouch);
  const caps = useSettings((s) => s.caps);
  const spentToday = useTrades((s) => s.spentToday());
  const position = useActivePosition(mint);
  const status = useActiveStatus();
  const locked = useWallet((s) => s.service.locked && s.mode === "instant");
  const connection = useMarket((s) => s.connection);
  const requestUnlock = useUi((s) => s.requestUnlock);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [sellPct, setSellPct] = useState(50);
  const [costOpen, setCostOpen] = useState(true);
  const holding = position?.holdingTokens ?? 0;
  // null until the wallet feed reports a balance: "–", and no balance check (never a fake 0).
  const available = status ? Math.max(0, status.solBalance - status.reservedSol) : null;
  const feedOk = connection === "live" || connection === "degraded";
  const exec = presets.buy;
  // null until the venue's live fee is known (the live trade engine reads FeeConfig).
  const feeBps = detail.pool?.feeBps ?? detail.curve?.feeBps ?? null;

  const buyQ = useMemo(() => quoteBuy(detail.curve, detail.pool, quickBuy), [detail.curve, detail.pool, quickBuy]);
  const sellQ = useMemo(
    () => (holding > 0 ? quoteSell(detail.curve, detail.pool, (holding * sellPct) / 100) : null),
    [detail.curve, detail.pool, holding, sellPct],
  );
  const issue = buyIssue({
    sol: quickBuy,
    available,
    settings: exec,
    firstBuy: holding <= 0,
    perTradeCap: caps.perTradeSol,
    dailyCap: caps.dailySol,
    spentToday,
  });

  const doBuy = () => {
    setSheet(null);
    // Its own review sheet (with the live quote) already ran when the setting is on.
    void buy({ mint, sol: quickBuy, source: "mobile", reviewed: true });
  };
  const onBuy = () => {
    if (locked) {
      requestUnlock(`Unlock to buy $${token.symbol}`);
      return;
    }
    if (confirmOnTouch) setSheet("review");
    else doBuy();
  };
  const sellLabel = `Sell ${sellPct}%${sellQ ? ` · ~${fmtSol(sellCost(sellQ, presets.sell, feeBps).totalSol)} SOL` : ""}`;

  return (
    <>
      <div className="grid h-16 shrink-0 grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-2 border-t border-hairline bg-surface-1 px-3">
        <button
          type="button"
          onClick={() => setSheet("amount")}
          aria-label={`Buy amount ${fmtSolShort(quickBuy)} SOL, change`}
          className="flex h-11 items-center justify-center gap-1 rounded-sm border border-hairline-strong bg-surface-2 text-body font-semibold text-fg-1"
        >
          <span className="zf-num">{fmtSolShort(quickBuy)}</span>
          <ChevronDown className="icon-xs text-fg-3" />
        </button>
        <Button
          variant={locked ? "secondary" : "buy"}
          size="xl"
          disabled={!feedOk}
          icon={locked ? <Lock /> : undefined}
          onClick={onBuy}
          className="min-w-0"
        >
          <span className="truncate">
            {!feedOk ? "Feed offline" : locked ? "Unlock to trade" : `Buy ${token.symbol} ${fmtSolShort(quickBuy)}`}
          </span>
        </Button>
        <Button variant="sell-tint" size="xl" disabled={holding <= 0 || !feedOk} onClick={() => setSheet("sell")}>
          Sell
        </Button>
      </div>

      <BottomSheet open={sheet === "amount"} onClose={() => setSheet(null)} title="Buy amount">
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-4 gap-2">
            {presets.buyAmounts.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  setQuickBuy(v);
                  setSheet(null);
                }}
                className={cn(
                  "zf-num h-11 rounded-sm border bg-surface-2 text-body font-medium",
                  v === quickBuy ? "border-fg-2 text-fg-1" : "border-hairline text-fg-2",
                )}
              >
                {fmtSolShort(v)}
              </button>
            ))}
          </div>
          <NumberInput
            size="amount"
            value={quickBuy}
            onChange={(v) => v !== null && setQuickBuy(v)}
            suffix="SOL"
            min={0}
            ariaLabel="Custom buy amount in SOL"
          />
          <p className="text-label text-fg-3">Also used by quick-buy pills across the app.</p>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === "review"} onClose={() => setSheet(null)} title={`Buy ${token.symbol}`}>
        <div className="space-y-3 p-3">
          <CostBreakdown
            kind="buy"
            cost={buyCost(buyQ, quickBuy, exec, holding <= 0, feeBps)}
            symbol={token.symbol}
            venue={venueShort(token.venue)}
            route={detail.route ?? null}
            landing={exec.landing}
            slippagePct={exec.slippagePct}
            open={costOpen}
            onToggle={() => setCostOpen((o) => !o)}
          />
          {issue && <p className={cn("text-label", issue.tone === "sell" ? "text-sell" : "text-warn")}>{issue.text}</p>}
          <Button variant="buy" size="xl" className="w-full" disabled={!!issue} onClick={doBuy}>
            {issue ? issue.cta : `Buy ${token.symbol} · ${fmtSolShort(quickBuy)} SOL`}
          </Button>
          <p className="text-label text-fg-3">Turn this review off in Settings, Display: Confirm trades on touch devices.</p>
        </div>
      </BottomSheet>

      <BottomSheet open={sheet === "sell"} onClose={() => setSheet(null)} title={`Sell ${token.symbol}`}>
        <div className="space-y-3 p-3">
          <div className="flex items-center justify-between text-label text-fg-3">
            <span>Holding</span>
            <span className="zf-num text-fg-2">
              {fmtTokens(holding)} {token.symbol} · {fmtSol(position?.valueSol ?? 0)} SOL
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {SELL_PCTS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={sellPct === p}
                onClick={() => setSellPct(p)}
                className={cn(
                  "zf-num h-11 rounded-sm border bg-surface-2 text-body font-medium",
                  sellPct === p ? "border-fg-2 text-fg-1" : "border-hairline text-fg-2",
                )}
              >
                {p}%
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            size="lg"
            className="h-11 w-full"
            disabled={!position || position.boughtSol - position.soldSol <= 0}
            onClick={() => {
              setSheet(null);
              void sellInitials(mint, "mobile");
            }}
          >
            Sell initials · {fmtSol(Math.max(0, (position?.boughtSol ?? 0) - (position?.soldSol ?? 0)))} SOL
          </Button>
          <Button
            variant="sell"
            size="xl"
            className="w-full"
            disabled={holding <= 0}
            onClick={() => {
              setSheet(null);
              void sell({ mint, pct: sellPct, source: "mobile" });
            }}
          >
            {sellLabel}
          </Button>
        </div>
      </BottomSheet>
    </>
  );
}
