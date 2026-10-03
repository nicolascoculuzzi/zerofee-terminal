import { Zap } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { BottomSheet } from "../../components/ui/Modal";
import { fmtSolShort } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import type { TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { useActivePosition } from "../../state/wallet";
import { TradePanel } from "../trade/TradePanel";

/**
 * Sticky Buy/Sell bar for narrow screens (Phantom token page: full-width CTA above the tab bar
 * https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba); "Trade" opens the full panel in a sheet.
 */
export function MobileTradeBar({ detail }: { detail: TokenDetail }) {
  const quickBuy = useSettings((s) => s.quickBuySol);
  const open = useUi((s) => s.mobileTradeOpen);
  const setOpen = useUi((s) => s.setMobileTradeOpen);
  const position = useActivePosition(detail.summary.mint);
  return (
    <>
      <div className="grid shrink-0 grid-cols-[1fr_1fr_auto] gap-2 border-t border-hairline bg-surface-1 p-2">
        <Button
          variant="buy"
          size="lg"
          icon={<Zap className="icon-sm" />}
          onClick={() => void buy({ mint: detail.summary.mint, sol: quickBuy, source: "mobile" })}
        >
          Buy {fmtSolShort(quickBuy)} SOL
        </Button>
        <Button variant="sell" size="lg" disabled={!position || position.holdingTokens <= 0} onClick={() => setOpen(true)}>
          Sell
        </Button>
        <Button variant="secondary" size="lg" onClick={() => setOpen(true)}>
          Trade
        </Button>
      </div>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={`Trade ${detail.summary.symbol}`}>
        <TradePanel detail={detail} />
      </BottomSheet>
    </>
  );
}
