import { useMemo } from "react";
import { useOrders } from "../../state/orders";
import { OrdersList } from "../orders/OrdersList";

/** Orders tab on the token page: the Armed Orders list filtered to this token. */
export function TokenOrders({ mint }: { mint: string }) {
  const byId = useOrders((s) => s.byId);
  const orders = useMemo(() => Object.values(byId).filter((o) => o.mint === mint), [byId, mint]);
  return (
    <div className="h-full overflow-auto">
      {orders.length === 0 ? (
        <div className="px-3 py-4 text-sm text-dim">No orders on this token. Use the Limit or Advanced tab to arm one.</div>
      ) : (
        <OrdersList orders={orders} compact />
      )}
    </div>
  );
}
