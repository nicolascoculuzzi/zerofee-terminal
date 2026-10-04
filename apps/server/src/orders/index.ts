/**
 * Armed orders, server side: builds the engine, the intake and the REST routes from the app's pieces
 * (market state, account resolver, program accounts, chain publisher, RPC, the accounts layer and the
 * gateway's `orders` topic). createApp wires it when the accounts layer is present and ORDERS_ENABLED.
 */
import type { AddressesByLookupTableAddress } from "@solana/kit";
import type { ArmedOrder } from "@zerofee/core";
import type { ChainState, OrdersDelta, ProgramAccountsResponse } from "@zerofee/protocol";
import type { PoolInfo } from "../accounts/resolver";
import type { Route } from "../api/router";
import { withDefaults } from "../api/settings";
import type { ServerConfig } from "../config";
import { RateLimiter } from "../gateway/rateLimit";
import type { MarketState } from "../market/state";
import type { UserLayer } from "../user";
import type { RpcClient } from "../util/rpc";
import { type ChainReader, RpcChainReader } from "./chain";
import { OrderEngine } from "./engine";
import { OrderIntake } from "./intake";
import { DryRunSubmitter, LiveSubmitter, liveLanes, type Submitter } from "./lanes";
import { MarketStateView, type OrderMarket, ProgramStateCache } from "./market";
import { ArmedOrdersRepo } from "./repo";
import { orderRoutes } from "./routes";

export { OrderEngine } from "./engine";
export { IntakeError, OrderIntake } from "./intake";
export { ArmedOrdersRepo } from "./repo";

export interface OrderServiceOverrides {
  /** Replaces the lanes (tests use recording or loopback-only lanes; DRY_RUN never sends regardless). */
  submitter?: Submitter;
  chain?: ChainReader;
  market?: OrderMarket;
  lookupTables?: AddressesByLookupTableAddress;
  interfaceVersion?: () => string;
  now?: () => number;
  /** false: no background loops (tests call pollNonces / sweep / checkStaleness themselves). */
  timers?: boolean;
}

export interface OrderServiceDeps {
  cfg: ServerConfig;
  user: UserLayer;
  market: MarketState;
  pools: ReadonlyMap<string, PoolInfo>;
  programAccounts: { get(): ProgramAccountsResponse | null } | null;
  chain: { readonly state: ChainState } | null;
  rpc: RpcClient;
  publish(userId: string, delta: OrdersDelta): void;
  fetchFn?: typeof fetch;
  overrides?: OrderServiceOverrides;
}

export interface OrderService {
  engine: OrderEngine;
  intake: OrderIntake;
  repo: ArmedOrdersRepo;
  routes: Route[];
  /** Loads the open orders and starts the loops. */
  start(): Promise<void>;
}

export function createOrderService(d: OrderServiceDeps): OrderService {
  const o = d.overrides ?? {};
  const now = o.now ?? d.user.now;
  const repo = new ArmedOrdersRepo(d.user.db);
  const chain = o.chain ?? new RpcChainReader(d.rpc);
  const market =
    o.market ??
    new MarketStateView({ market: d.market, pools: d.pools, programs: new ProgramStateCache(d.programAccounts), chain: d.chain });
  // DRY_RUN=true never constructs a sending lane, whatever the overrides say.
  const submitter: Submitter = d.cfg.dryRun
    ? new DryRunSubmitter(chain)
    : (o.submitter ??
      new LiveSubmitter(
        liveLanes({
          jitoRegion: d.cfg.landing.jitoRegion,
          jitoUuid: d.cfg.landing.jitoUuid,
          heliusRegion: d.cfg.landing.heliusRegion,
          heliusApiKey: d.cfg.landing.heliusApiKey,
          cancelRpcUrl: d.cfg.orders.cancelRpcUrl ?? d.cfg.rpcUrl,
          fetchFn: d.fetchFn,
        }),
      ));
  const engine = new OrderEngine({
    cfg: d.cfg.orders,
    repo,
    market,
    chain,
    submitter,
    publish: d.publish,
    notify: (ev) => d.user.alerts.onOrderEvent(ev),
    halt: d.user.halt,
    baseMintOfPool: (pool) => d.pools.get(pool)?.baseMint ?? d.market.raydiumBaseMint(pool),
    ...(o.lookupTables ? { lookupTables: o.lookupTables } : {}),
    ...(o.interfaceVersion ? { interfaceVersion: o.interfaceVersion } : {}),
    now,
  });
  const store = d.user.store;
  const intake = new OrderIntake({
    engine,
    repo,
    chain,
    ownsWallet: (userId, address) => store.users.ownsWallet(userId, address),
    maxTradeSol: async (userId) => withDefaults(await store.prefs.getSettings(userId)).maxTradeSol,
    halt: d.user.halt,
    initialState: (order: ArmedOrder) => (order.trigger.type === "migration" && market.migrated(order.mint) ? { migrated: true } : {}),
    now,
  });
  const routes = orderRoutes({ engine, intake, repo, intakeLimiter: new RateLimiter(1, 10), now });
  return { engine, intake, repo, routes, start: () => engine.start({ timers: o.timers !== false }) };
}
