import { create } from "zustand";
import type { Order, OrdersDelta } from "../protocol";

export interface OrdersState {
  byId: Record<string, Order>;
  loaded: boolean;
  setAll(orders: Order[]): void;
  /** Returns the previous version of each changed order (for status-change toasts). */
  apply(delta: OrdersDelta): { order: Order; prev: Order | undefined }[];
}

export const useOrders = create<OrdersState>()((set, get) => ({
  byId: {},
  loaded: false,
  setAll(orders) {
    set({ byId: Object.fromEntries(orders.map((o) => [o.id, o])), loaded: true });
  },
  apply(delta) {
    const byId = { ...get().byId };
    const changes: { order: Order; prev: Order | undefined }[] = [];
    for (const id of delta.remove) delete byId[id];
    for (const o of delta.upsert) {
      changes.push({ order: o, prev: byId[o.id] });
      byId[o.id] = o;
    }
    set({ byId });
    return changes;
  },
}));

export const OPEN_STATUSES: ReadonlySet<Order["status"]> = new Set(["armed", "submitted", "stale"]);

export function isOpenOrder(o: Order): boolean {
  return OPEN_STATUSES.has(o.status);
}
