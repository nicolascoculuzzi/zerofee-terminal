import { create } from "zustand";
import type { Order, OrderStatus } from "../../protocol";
import { useMarket } from "../../state/market";
import { useOrders } from "../../state/orders";

/** One step in an order's life, for the drawer timeline (DESIGN.md 4.20). */
export interface OrderEvent {
  at: number;
  kind: OrderStatus | "rearmed";
  reason: string | null;
  /** Slot when this browser saw the change (null for steps known only from the order record). */
  slot: number | null;
}

interface OrderLogState {
  events: Record<string, OrderEvent[]>;
}

/**
 * The order feed carries the current state only (Order has created/updated/filled times but no
 * attempt log), so the timeline is assembled here: the first sighting adds what the record
 * itself proves (armed at createdAt, the current state at updatedAt), and every status change
 * seen while the app is open is appended with the slot it was observed at.
 */
export const useOrderLog = create<OrderLogState>()(() => ({ events: {} }));

export function firstEvents(o: Order): OrderEvent[] {
  const list: OrderEvent[] = [{ at: o.createdAt, kind: "armed", reason: null, slot: null }];
  if (o.status === "armed") {
    // An armed order touched after creation was re-armed (re-arming is the only way back to armed).
    if (o.updatedAt > o.createdAt + 1000) list.push({ at: o.updatedAt, kind: "rearmed", reason: null, slot: null });
  } else {
    list.push({ at: o.updatedAt, kind: o.status, reason: o.statusReason, slot: null });
  }
  return list;
}

export function nextEvent(prev: OrderStatus, o: Order, slot: number | null): OrderEvent {
  const kind = o.status === "armed" && (prev === "stale" || prev === "failed") ? "rearmed" : o.status;
  return { at: o.updatedAt, kind, reason: o.statusReason, slot };
}

const holder = globalThis as { __zerofeeOrderLog?: boolean };

/** Starts recording once per page load (survives hot reloads without double-subscribing). */
export function startOrderLog(): void {
  if (holder.__zerofeeOrderLog) return;
  holder.__zerofeeOrderLog = true;
  const seen = new Map<string, OrderStatus>();
  const ingest = (byId: Record<string, Order>) => {
    let next: Record<string, OrderEvent[]> | null = null;
    const slot = useMarket.getState().slot || null;
    for (const o of Object.values(byId)) {
      const prev = seen.get(o.id);
      if (prev === o.status) continue;
      next ??= { ...useOrderLog.getState().events };
      next[o.id] = prev === undefined ? (next[o.id] ?? firstEvents(o)) : [...(next[o.id] ?? []), nextEvent(prev, o, slot)];
      seen.set(o.id, o.status);
    }
    if (next) useOrderLog.setState({ events: next });
  };
  ingest(useOrders.getState().byId);
  useOrders.subscribe((s) => ingest(s.byId));
}

/** When the order was handed to a lane (the "Sending" step), if this browser saw it. */
export function sentAt(events: readonly OrderEvent[] | undefined): number | null {
  if (!events) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "submitted") return e.at;
  }
  return null;
}
