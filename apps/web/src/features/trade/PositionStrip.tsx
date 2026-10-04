import { Check, Share2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/controls";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtPnlPct, fmtSol, fmtTokens, signClass } from "../../lib/format";
import { sellInitials } from "../../lib/tradeActions";
import type { Position } from "../../protocol";
import { type QuoteCurrency, useSettings } from "../../state/settings";
import { fmtMoney, Money, toQuote, useQuote } from "../token/money";
import { useTickFlash } from "../token/useTickFlash";

/*
 * Position strip (DESIGN.md 4.11 item 9): Bought / Sold / Holding / PnL as micro labels over
 * 12/500 values, PnL in signed colour with the 600 ms text flash (6.6), the global $/SOL quote,
 * "Sell initials" and share. Bought/Sold/Holding/PnL strip after Axiom's trade panel; position
 * card with average cost and PnL after Base: https://mobbin.com/screens/5d35e943-618c-402a-a9e8-2d8addd1f612
 */

function Cell({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-0.5 px-2 first:pl-0">
      <span className="flex items-center justify-between gap-1 text-micro font-medium text-fg-3">
        {label}
        {aside}
      </span>
      <span className="truncate text-data font-medium text-fg-1">{children}</span>
    </div>
  );
}

export function PositionStrip({ mint, symbol, position }: { mint: string; symbol: string; position: Position | null }) {
  const { quote, solUsd } = useQuote();
  const setDisplay = useSettings((s) => s.setDisplay);
  const [copied, setCopied] = useState(false);
  const bought = position?.boughtSol ?? 0;
  const sold = position?.soldSol ?? 0;
  const holding = position?.valueSol ?? 0;
  const pnl = (position?.realizedPnlSol ?? 0) + (position?.unrealizedPnlSol ?? 0);
  const pnlQuote = toQuote(quote, solUsd, { sol: pnl });
  const flash = useTickFlash(position ? pnlQuote : null);
  const pct = fmtPnlPct(pnl, bought);
  const remaining = bought - sold;
  const canSellInitials = !!position && position.holdingTokens > 0 && remaining > 0;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const share = () => {
    if (!position) return;
    const text = `${symbol} PnL ${fmtMoney(quote, pnlQuote, "signed")}${quote === "SOL" ? " SOL" : ""} (${pct}) · bought ${fmtSol(bought)} SOL · holding ${fmtTokens(position.holdingTokens)} · zerofee, 0% platform fee`;
    void copyText(text).then((ok) => setCopied(ok));
  };

  return (
    <section aria-label="Position" className="border-t border-hairline px-3">
      <div className="flex h-8 items-center gap-1">
        <span className="text-data font-semibold text-fg-1">Position</span>
        <Segmented<QuoteCurrency>
          size="xs"
          className="ml-auto"
          value={quote}
          onChange={(q) => setDisplay({ quote: q })}
          options={[
            { value: "USD", label: "$", title: "Values in USD (T then C)" },
            { value: "SOL", label: "SOL", title: "Values in SOL (T then C)" },
          ]}
          label="Quote currency"
        />
        <Button
          variant="ghost"
          size="xs"
          disabled={!canSellInitials}
          title={canSellInitials ? `Sell the ${fmtSol(remaining)} SOL you put in (Space+T)` : "Nothing left to recover"}
          onClick={() => void sellInitials(mint, "token")}
        >
          Sell initials
        </Button>
        <IconButton size="xs" label={copied ? "Copied" : "Copy PnL summary"} disabled={!position} onClick={share}>
          {copied ? <Check /> : <Share2 />}
        </IconButton>
      </div>
      <div className="grid h-12 grid-cols-4 divide-x divide-hairline">
        <Cell label="Bought">
          <Money sol={bought} kind="exact" />
        </Cell>
        <Cell label="Sold">
          <Money sol={sold} kind="exact" />
        </Cell>
        <Cell label="Holding">
          <Money sol={holding} kind="exact" />
        </Cell>
        <Cell label="PnL" aside={<span className={cn("zf-num", signClass(bought > 0 ? pnl : null))}>{pct}</span>}>
          <span key={flash.key} className={cn("zf-num", signClass(pnlQuote), flash.className)}>
            {fmtMoney(quote, pnlQuote, "signed")}
          </span>
        </Cell>
      </div>
    </section>
  );
}
