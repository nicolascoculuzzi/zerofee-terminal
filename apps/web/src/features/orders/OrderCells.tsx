import { Check, Link2, Loader2, MoreHorizontal, RotateCw } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button, IconButton } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtMs, fmtPct, plainDecimal } from "../../lib/format";
import type { Order } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useQuote } from "../portfolio/quote";
import { useOrderQuotes } from "./liveQuotes";
import { canCancel, canRearm, nonceInfo, STATUS_INFO, type StatusTone, triggerDistance, triggerParts, triggerText } from "./orderText";

const DOT: Record<StatusTone, string> = {
  info: "bg-info",
  warn: "bg-warn",
  sell: "bg-sell",
  filled: "",
  muted: "bg-fg-4",
};

/**
 * Status (DESIGN.md 4.20): a 6 px dot and a label (colour never alone, 7.4). Armed in info,
 * Sending in warn with the elapsed time, Filled with a Check and its time to land, Consumed in
 * sell, Needs re-arm in warn with the reason in a tooltip, Cancelled in text-4. Dot + label +
 * duration after Vercel's deployments list: https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54
 */
export function StatusCell({ order }: { order: Order }) {
  const info = STATUS_INFO[order.status];
  const landedMs = order.status === "filled" ? order.fillLatencyMs : null;
  const body = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {info.tone === "filled" ? (
        <Check className="icon-xs shrink-0 text-fg-1" aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[info.tone])} />
      )}
      <span className={cn("truncate", info.tone === "muted" ? "text-fg-4" : "text-fg-1")}>{info.label}</span>
      {order.status === "submitted" && <Age ts={order.updatedAt} className="text-fg-3" />}
      {landedMs !== null && <span className="zf-num text-fg-2">{fmtMs(landedMs)}</span>}
    </span>
  );
  if (order.statusReason && (order.status === "stale" || order.status === "failed")) {
    return <Tooltip content={order.statusReason}>{body}</Tooltip>;
  }
  return body;
}

/**
 * Live market cap, price and supply of an order's token: from the Pulse feed, else from the
 * order-token subscriptions (liveQuotes). Primitive selections, so rows re-render only on change.
 */
export function useLiveToken(mint: string | null): { mcUsd: number | null; priceSol: number | null; supply: number | null } {
  const mcUsd = useMarket((s) => (mint ? (s.tokens[mint]?.marketCapUsd ?? null) : null));
  const priceSol = useMarket((s) => (mint ? (s.tokens[mint]?.priceSol ?? null) : null));
  const supply = useMarket((s) => (mint ? (s.tokens[mint]?.supply ?? null) : null));
  const qMc = useOrderQuotes((s) => (mint ? (s.byMint[mint]?.mcUsd ?? null) : null));
  const qPrice = useOrderQuotes((s) => (mint ? (s.byMint[mint]?.priceSol ?? null) : null));
  const qSupply = useOrderQuotes((s) => (mint ? (s.byMint[mint]?.supply ?? null) : null));
  return { mcUsd: mcUsd ?? qMc, priceSol: priceSol ?? qPrice, supply: supply ?? qSupply };
}

/** Plain-text trigger (titles, aria, dialogs). */
export function useTriggerText(order: Order): string {
  const { quote, solUsd } = useQuote();
  const { supply } = useLiveToken(order.mint);
  return triggerText(order, { quote, solUsd, supply });
}

/** The trigger as shown in cells: words, with a price in subscript-zero notation when the MC can't be derived. */
export function TriggerLabel({ order }: { order: Order }) {
  const { quote, solUsd } = useQuote();
  const { supply } = useLiveToken(order.mint);
  const p = triggerParts(order, { quote, solUsd, supply });
  if (p.kind === "text") return <>{p.text}</>;
  return (
    <>
      {p.words} <Num value={p.priceSol} kind="price" unit="SOL" />
    </>
  );
}

/** Distance (DESIGN.md 4.20): signed % from the live MC to the trigger, in text-2, because a distance is not PnL. */
export function DistanceCell({ order }: { order: Order }) {
  const live = useLiveToken(order.mint);
  const d = triggerDistance(order, live);
  if (!d) return <span className="text-fg-4">–</span>;
  if (d.crossed) return <span className="text-fg-2">At trigger</span>;
  return (
    <span role="img" aria-label={`${plainDecimal(d.pct)} percent to trigger`} className="zf-num text-fg-2">
      {fmtPct(d.pct, { signed: true })}
    </span>
  );
}

export function NonceCell({ order }: { order: Order }) {
  const n = nonceInfo(order);
  return (
    <Tooltip content={n.title}>
      <span className={cn("zf-num inline-flex items-center gap-1", n.text === "None" ? "text-fg-3" : "text-fg-2")}>
        {n.text}
        {n.shared && <Link2 className="icon-xs" aria-label="OCO-shared nonce" />}
      </span>
    </Tooltip>
  );
}

function useBinding(action: "orders.cancel" | "orders.rearm"): string | undefined {
  return useSettings((s) => s.hotkeys[action]?.[0]);
}

/**
 * Actions (DESIGN.md 4.20): "Cancel" (danger xs), "Re-arm" (secondary xs), "…". Re-arming shows
 * a 14 px spinner in place of its icon while the browser re-signs (an in-flight action).
 */
export function OrderActions({
  order,
  tabbable,
  rearming,
  onCancel,
  onRearm,
  onDetails,
  onCancelGroup,
  groupLabel,
}: {
  order: Order;
  tabbable: boolean;
  rearming: boolean;
  onCancel: () => void;
  onRearm: () => void;
  onDetails: () => void;
  /** "Cancel all for WIF" in the menu (grouped table only). */
  onCancelGroup?: () => void;
  groupLabel?: string;
}) {
  const cancelKey = useBinding("orders.cancel");
  const rearmKey = useBinding("orders.rearm");
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {canRearm(order) && (
        <Tooltip
          content={
            <span className="inline-flex items-center gap-2">
              Re-sign against fresh accounts <Hotkey binding={rearmKey} />
            </span>
          }
        >
          <Button
            size="xs"
            variant="secondary"
            tabIndex={tabbable ? 0 : -1}
            disabled={rearming}
            icon={rearming ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RotateCw />}
            onClick={(e) => {
              e.stopPropagation();
              onRearm();
            }}
          >
            Re-arm
          </Button>
        </Tooltip>
      )}
      {canCancel(order) && (
        <Tooltip
          content={
            <span className="inline-flex items-center gap-2">
              Fire the pre-signed cancel <Hotkey binding={cancelKey} />
            </span>
          }
        >
          <Button
            size="xs"
            variant="danger"
            tabIndex={tabbable ? 0 : -1}
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </Button>
        </Tooltip>
      )}
      <RowMenu order={order} tabbable={tabbable} onDetails={onDetails} onCancelGroup={onCancelGroup} groupLabel={groupLabel} />
    </span>
  );
}

/** "…" menu (DESIGN.md 4.17): details, open the token, cancel all for the token. */
function RowMenu({
  order,
  tabbable,
  onDetails,
  onCancelGroup,
  groupLabel,
}: {
  order: Order;
  tabbable: boolean;
  onDetails: () => void;
  onCancelGroup?: () => void;
  groupLabel?: string;
}) {
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const go = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <>
      <IconButton
        ref={anchor}
        size="xs"
        label={`More actions for this ${order.symbol} order`}
        tabIndex={tabbable ? 0 : -1}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={220}>
        <div role="menu" aria-label="Order actions">
          <MenuItem onSelect={go(onDetails)} hint={<Hotkey binding="Enter" />}>
            Details
          </MenuItem>
          {order.mint && <MenuItem onSelect={go(() => navigate(`/t/${order.mint}`))}>Open {order.symbol}</MenuItem>}
          {onCancelGroup && groupLabel && (
            <>
              <MenuSeparator />
              <MenuItem danger onSelect={go(onCancelGroup)}>
                Cancel all for {groupLabel}
              </MenuItem>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}
