/**
 * The trade engine (LiveTradeService: packages/core builders, the signer firewall glue, armed orders) is the
 * largest part of the live data layer and is not needed to show the first screen. This stand-in loads it on
 * the first trade call, or earlier through `preload()` once the page is idle, so the first Pulse rows never
 * wait for it. Every TradeService method is async already, so callers see no difference.
 */
import type { TradeService } from "../tradeService";

export interface LazyTradeService extends TradeService {
  /** Starts loading the engine (idempotent); a failed load is retried on the next call. */
  preload(): Promise<TradeService>;
}

export function lazyTradeService(load: () => Promise<TradeService>): LazyTradeService {
  let pending: Promise<TradeService> | null = null;
  const get = (): Promise<TradeService> => {
    pending ??= load().catch((e: unknown) => {
      pending = null;
      throw e;
    });
    return pending;
  };
  return {
    preload: get,
    buy: (request, onProgress) => get().then((t) => t.buy(request, onProgress)),
    sell: (request, onProgress) => get().then((t) => t.sell(request, onProgress)),
    placeLimit: (request) => get().then((t) => t.placeLimit(request)),
    armTpSl: (request) => get().then((t) => t.armTpSl(request)),
    armMigration: (request) => get().then((t) => t.armMigration(request)),
    cancel: (orderId) => get().then((t) => t.cancel(orderId)),
    rearm: (orderId) => get().then((t) => t.rearm(orderId)),
    panic: () => get().then((t) => t.panic()),
  };
}

export { whenIdle } from "../../lib/whenIdle";
