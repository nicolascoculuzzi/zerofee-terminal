import { Crosshair, Users } from "lucide-react";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import type { Order, Position } from "../../protocol";
import { useMarket } from "../../state/market";
import { isOpenOrder } from "../../state/orders";
import { MarketCap } from "../portfolio/quote";
import { CursorBar, colW, rowClass, TABLE, TD, Th } from "../portfolio/table";
import { useRowCursor } from "../portfolio/useRowCursor";
import { DistanceCell, NonceCell, OrderActions, StatusCell, TriggerLabel, useTriggerText } from "./OrderCells";
import { LANE_LABEL, laneTitle, type OrderGroup, sizeText, variantsText } from "./orderText";

export interface OrdersTableProps {
  groups: OrderGroup[];
  labels: Map<string, string>;
  /** Active wallet positions by mint (group header "Holding 1.24M · avg 12.4K"). */
  positions: Map<string, Position>;
  rearming: ReadonlySet<string>;
  selectedId: string | null;
  onSelect: (order: Order) => void;
  onOpen: (order: Order) => void;
  onCancel: (orders: Order[], group?: boolean) => void;
  onRearm: (order: Order) => void;
  empty?: ReactNode;
}

/** Column widths in ch (DESIGN.md 4.20; Type and Actions widened so "Migration sell" and Re-arm + Cancel fit). */
const W = { status: 16, type: 12, distance: 8, size: 12, variants: 8, nonce: 9, lane: 9, armed: 5, actions: 21 } as const;
const COLS = 10;

/** "Holding 1.24M · avg 12.4K" from the active wallet's position in this token. */
function Holding({ position }: { position: Position | undefined }) {
  const supply = useMarket((s) => (position ? (s.tokens[position.mint]?.supply ?? null) : null));
  if (!position || position.holdingTokens <= 0) return <span className="text-fg-3">Not holding</span>;
  const avgSol = supply !== null ? position.avgEntryPriceSol * supply : null;
  return (
    <span className="text-fg-3">
      Holding <Num value={position.holdingTokens} kind="tokens" className="text-fg-2" /> · avg{" "}
      <MarketCap sol={avgSol} className="text-fg-2" unit={false} />
    </span>
  );
}

/** Group header (DESIGN.md 4.20): 28 px, avatar 16, ticker, holding and average entry, "Cancel all for WIF". */
function GroupHeader({ group, position, onCancelAll }: { group: OrderGroup; position: Position | undefined; onCancelAll: () => void }) {
  const Icon = group.key === "kind:copy_buy" ? Users : Crosshair;
  return (
    <tr className="h-header-row bg-surface-2">
      <th scope="rowgroup" colSpan={COLS} className="border-b border-hairline px-2 text-left font-normal">
        <span className="flex min-w-0 items-center gap-2">
          {group.mint ? (
            <TokenAvatar mint={group.mint} symbol={group.symbol} imageUri={null} size="2xs" badge={false} />
          ) : (
            <span className="flex size-4 items-center justify-center rounded-xs bg-surface-3 text-fg-3">
              <Icon className="icon-xs" />
            </span>
          )}
          <span className="font-semibold text-fg-1">{group.symbol}</span>
          {group.mint ? <Holding position={position} /> : <span className="text-fg-3">Signed live in this browser when it fires</span>}
          {group.openCount > 0 && group.mint && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-auto"
              onClick={(e) => {
                e.stopPropagation();
                onCancelAll();
              }}
            >
              Cancel all for {group.symbol}
            </Button>
          )}
        </span>
      </th>
    </tr>
  );
}

interface RowProps {
  order: Order;
  label: string;
  index: number;
  rowRef: (el: HTMLElement | null) => void;
  cursor: boolean;
  focusWithin: boolean;
  selected: boolean;
  rearming: boolean;
  groupSymbol: string;
  onSelect: (order: Order) => void;
  onOpen: (order: Order) => void;
  onCancel: (orders: Order[], group?: boolean) => void;
  onRearm: (order: Order) => void;
  onCancelGroup: () => void;
}

const OrderRow = memo(function OrderRow({
  order,
  label,
  index,
  rowRef,
  cursor,
  focusWithin,
  selected,
  rearming,
  groupSymbol,
  onSelect,
  onOpen,
  onCancel,
  onRearm,
  onCancelGroup,
}: RowProps) {
  const trigger = useTriggerText(order);
  const open = isOpenOrder(order);
  const muted = order.status === "cancelled";
  const variants = variantsText(order);
  return (
    <tr
      ref={rowRef}
      data-row-index={index}
      tabIndex={cursor ? 0 : -1}
      aria-selected={selected}
      onFocus={() => onSelect(order)}
      onClick={(e) => {
        // Clicks in portaled menus still bubble through React; only clicks inside the row open it.
        if (!e.currentTarget.contains(e.target as Node)) return;
        onSelect(order);
        onOpen(order);
      }}
      className={cn(rowClass({ cursor: cursor && focusWithin, selected, interactive: true }), "h-[calc(var(--zf-row)+4px)]")}
    >
      <td className={cn(TD, "relative")}>
        <CursorBar on={cursor && focusWithin} />
        <StatusCell order={order} />
      </td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : "text-fg-1")}>{label}</td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : open ? "text-fg-1" : "text-fg-2")} title={trigger}>
        <TriggerLabel order={order} />
      </td>
      <td className={cn(TD, "text-right")}>
        <DistanceCell order={order} />
      </td>
      <td className={cn(TD, "truncate", muted ? "text-fg-3" : "text-fg-1")}>{sizeText(order)}</td>
      <td className={cn(TD, "text-right", order.variants > 0 ? "text-fg-2" : "text-fg-3")}>
        <Tooltip content={variants.title} wrapperClassName="justify-end">
          <span className="zf-num">{variants.text}</span>
        </Tooltip>
      </td>
      <td className={TD}>
        <NonceCell order={order} />
      </td>
      <td className={cn(TD, order.landing === "fast" ? "text-warn" : "text-fg-2")}>
        <Tooltip content={laneTitle(order.landing)}>
          <span className="truncate">{LANE_LABEL[order.landing]}</span>
        </Tooltip>
      </td>
      <td className={cn(TD, "text-right")}>
        <Age ts={order.status === "armed" ? order.updatedAt : order.createdAt} />
      </td>
      <td className={cn(TD, "text-right")}>
        <OrderActions
          order={order}
          tabbable={cursor}
          rearming={rearming}
          onCancel={() => onCancel([order])}
          onRearm={() => onRearm(order)}
          onDetails={() => onOpen(order)}
          onCancelGroup={onCancelGroup}
          groupLabel={groupSymbol}
        />
      </td>
    </tr>
  );
});

/*
 * Armed-orders table (DESIGN.md 4.20): a data grid with 28/32 px rows and hairline dividers,
 * grouped by token under 28 px group headers. Columns: Status · Type · Trigger · Distance · Size
 * · Variants · Nonce · Lane · Armed · Actions. Clicking a row opens the detail drawer; Up/Down,
 * Enter, Delete and R work from the keyboard. Group header bars after Linear:
 * https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c
 */
export function OrdersTable({
  groups,
  labels,
  positions,
  rearming,
  selectedId,
  onSelect,
  onOpen,
  onCancel,
  onRearm,
  empty,
}: OrdersTableProps) {
  const flat = useMemo(() => groups.flatMap((g) => g.orders), [groups]);
  const indexOf = useMemo(() => new Map(flat.map((o, i) => [o.id, i])), [flat]);
  const [focusWithin, setFocusWithin] = useState(false);
  const cursor = useRowCursor(flat.length, {
    onOpen: (i) => {
      const o = flat[i];
      if (o) onOpen(o);
    },
  });
  const { setCursor } = cursor;
  const selectRow = useCallback(
    (order: Order) => {
      setCursor(indexOf.get(order.id) ?? 0);
      onSelect(order);
    },
    [setCursor, indexOf, onSelect],
  );
  const minWidth = `calc(${Object.values(W).reduce((a, b) => a + b, 0) + 16}ch + ${COLS * 16}px)`;

  if (flat.length === 0) return <>{empty}</>;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className={TABLE} style={{ minWidth }} aria-label="Armed orders">
        <colgroup>
          <col style={colW(W.status)} />
          <col style={colW(W.type)} />
          <col />
          <col style={colW(W.distance)} />
          <col style={colW(W.size)} />
          <col style={colW(W.variants)} />
          <col style={colW(W.nonce)} />
          <col style={colW(W.lane)} />
          <col style={colW(W.armed)} />
          <col style={colW(W.actions)} />
        </colgroup>
        <thead>
          <tr>
            <Th>Status</Th>
            <Th>Type</Th>
            <Th>Trigger</Th>
            <Th align="right" title="Signed % from the live market cap to the trigger">
              Distance
            </Th>
            <Th>Size</Th>
            <Th align="right" title="Pre-signed min-out variants">
              Variants
            </Th>
            <Th>Nonce</Th>
            <Th>Lane</Th>
            <Th align="right">Armed</Th>
            <Th align="right">
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody
            key={g.key}
            onKeyDown={cursor.onKeyDown}
            onFocus={() => setFocusWithin(true)}
            onBlur={(e) => {
              const next = e.relatedTarget as Node | null;
              if (!e.currentTarget.closest("table")?.contains(next)) setFocusWithin(false);
            }}
          >
            <GroupHeader group={g} position={g.mint ? positions.get(g.mint) : undefined} onCancelAll={() => onCancel(g.orders, true)} />
            {g.orders.map((o) => {
              const index = indexOf.get(o.id) ?? 0;
              return (
                <OrderRow
                  key={o.id}
                  order={o}
                  label={labels.get(o.id) ?? o.kind}
                  index={index}
                  rowRef={cursor.rowRef(index)}
                  cursor={index === cursor.cursor}
                  focusWithin={focusWithin}
                  selected={o.id === selectedId}
                  rearming={rearming.has(o.id)}
                  groupSymbol={g.symbol}
                  onSelect={selectRow}
                  onOpen={onOpen}
                  onCancel={onCancel}
                  onRearm={onRearm}
                  onCancelGroup={() => onCancel(g.orders, true)}
                />
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** Mobile armed orders: two-line rows (status, type and size; trigger and distance), tap for details. */
export function OrdersMobileList({
  groups,
  labels,
  onOpen,
  empty,
}: {
  groups: OrderGroup[];
  labels: Map<string, string>;
  onOpen: (order: Order) => void;
  empty?: ReactNode;
}) {
  if (groups.length === 0) return <>{empty}</>;
  return (
    <div>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.symbol}>
          <h3 className="flex h-8 items-center gap-2 border-b border-hairline bg-surface-2 px-3 text-data font-semibold text-fg-1">
            {g.mint && <TokenAvatar mint={g.mint} symbol={g.symbol} imageUri={null} size="2xs" badge={false} />}
            {g.symbol}
          </h3>
          <ul>
            {g.orders.map((o) => (
              <li key={o.id} className="border-b border-hairline">
                <MobileRow order={o} label={labels.get(o.id) ?? o.kind} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MobileRow({ order, label, onOpen }: { order: Order; label: string; onOpen: (order: Order) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(order)}
      className="flex min-h-14 w-full flex-col justify-center gap-1 px-3 py-2 text-left active:bg-surface-2"
    >
      <span className="flex w-full items-center gap-2 text-data">
        <StatusCell order={order} />
        <span className="text-fg-2">· {label}</span>
        <span className="ml-auto text-fg-1">{sizeText(order)}</span>
      </span>
      <span className="flex w-full items-center gap-2 text-label">
        <span className="min-w-0 truncate text-fg-2">
          <TriggerLabel order={order} />
        </span>
        <DistanceCell order={order} />
        <Age ts={order.createdAt} className="ml-auto text-fg-3" />
      </span>
    </button>
  );
}
