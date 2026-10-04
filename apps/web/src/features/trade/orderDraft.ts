import { placeLimit } from "../../lib/tradeActions";
import type { Order, OrderTrigger, TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { type TradeSide, type TriggerMetric, useTokenUi } from "../token/tokenUi";

/*
 * The limit-order draft shared by the trade panel's Limit tab and the chart's dashed draggable
 * line (DESIGN.md 4.10, 4.11): one value in SOL per token, armed from the panel CTA or with
 * Enter on the line's handle chip.
 */

/** Default draft for a fresh limit: buy the dip (−20%) or sell the pump (+50%); null while the price is unknown. */
export function defaultLimitPrice(side: TradeSide, current: number | null): number | null {
  return current === null ? null : current * (side === "buy" ? 0.8 : 1.5);
}

/** Order trigger for a draft: market-cap triggers are in USD (protocol), price triggers in SOL. */
export function limitTrigger(priceSol: number, current: number, metric: TriggerMetric, supply: number, solUsd: number): OrderTrigger {
  return {
    metric,
    direction: priceSol < current ? "below" : "above",
    value: metric === "mc" ? priceSol * supply * solUsd : priceSol,
  };
}

/** Arms the current draft for `token`; on success a fresh draft replaces it. */
export async function armLimitDraft(token: TokenSummary): Promise<Order | null> {
  const ui = useTokenUi.getState();
  const settings = useSettings.getState();
  const solUsd = useMarket.getState().solUsd;
  const current = token.priceSol;
  const priceSol = ui.limitPriceSol ?? defaultLimitPrice(ui.side, current);
  // Unknown price (null: the quote has no known SOL value): no trigger direction or level to arm.
  if (current === null || priceSol === null) return null;
  const sol = ui.buySol ?? settings.quickBuySol;
  const order = await placeLimit({
    mint: token.mint,
    side: ui.side,
    trigger: limitTrigger(priceSol, current, ui.triggerMetric, token.supply, solUsd),
    size: ui.side === "buy" ? { kind: "sol", sol } : { kind: "pct", pct: ui.sellPct ?? 100 },
  });
  if (order) useTokenUi.getState().setLimitPriceSol(defaultLimitPrice(useTokenUi.getState().side, current));
  return order;
}
