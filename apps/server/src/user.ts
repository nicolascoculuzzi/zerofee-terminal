/**
 * The accounts layer: Postgres user state, SIWS sessions, the account / settings REST API and the
 * WebSocket user topics. `createUserLayer` opens (or takes) the database and builds the services;
 * `createApp(cfg, { user })` wires it into the gateway.
 */
import type { NonceStore } from "@zerofee/auth";
import type { OrdersSnapshot, WalletSnapshot } from "@zerofee/protocol";
import { authRoutes } from "./api/auth";
import { ApiRouter } from "./api/router";
import { type SettingsHooks, settingsRoutes } from "./api/settings";
import { OriginPolicy } from "./auth/origin";
import { SessionService } from "./auth/sessions";
import type { ServerConfig } from "./config";
import { openUserDb, type PgDriver, UserStore } from "./db/pg";
import { RateLimiter } from "./gateway/rateLimit";
import { logger } from "./log";

const log = logger("user");

/** Snapshot sources for the user WebSocket topics (gateway/server.ts). */
export interface UserTopicSource {
  /** True when the user may watch `address`: their main wallet or a registered trading wallet. */
  canWatchWallet(userId: string, address: string): Promise<boolean>;
  /** Balances and fills of a wallet; null while the wallet feed does not exist yet. */
  walletSnapshot(address: string): Promise<WalletSnapshot | null>;
  ordersSnapshot(userId: string): Promise<OrdersSnapshot>;
}

export interface UserLayerOverrides {
  /** An open, migrated driver (tests). The layer does not close it. */
  db?: PgDriver;
  now?: () => number;
  fetchFn?: typeof fetch;
  nonceStore?: NonceStore;
  /** Replace the wallet snapshot source (tests; the Phase 6 wallet feed). */
  walletSnapshot?: (address: string) => Promise<WalletSnapshot | null>;
}

export interface UserLimits {
  /** Nonce + sign-in per IP. */
  auth: RateLimiter;
  /** Authenticated API calls per user. */
  user: RateLimiter;
  /** POST /api/tx per user. */
  tx: RateLimiter;
  /** Admin endpoints per IP. */
  admin: RateLimiter;
}

export class UserLayer {
  readonly store: UserStore;
  readonly sessions: SessionService;
  readonly origins: OriginPolicy;
  readonly api: ApiRouter;
  readonly limits: UserLimits;
  readonly topics: UserTopicSource;
  readonly wsConnPerUser: number;
  readonly now: () => number;
  /** Settings / tracked-wallet change notifications from the REST API (the alert engine subscribes). */
  readonly settingsHooks: SettingsHooks = {};
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    readonly cfg: ServerConfig,
    readonly db: PgDriver,
    private readonly ownsDb: boolean,
    readonly o: UserLayerOverrides = {},
  ) {
    this.now = o.now ?? Date.now;
    this.store = new UserStore(db);
    const a = cfg.auth;
    this.origins = new OriginPolicy(a.allowedOrigins);
    this.sessions = new SessionService({
      store: this.store,
      domain: a.siwsDomain,
      uri: a.publicOrigin,
      cookieName: a.cookieName,
      ttlMs: a.sessionTtlMs,
      maxPerUser: a.maxSessionsPerUser,
      nonceStore: o.nonceStore,
      now: this.now,
    });
    const rl = cfg.rateLimit;
    this.limits = {
      auth: new RateLimiter(rl.authPerMin / 60, Math.max(5, Math.ceil(rl.authPerMin / 3))),
      user: new RateLimiter(rl.userPerSec, rl.userBurst),
      tx: new RateLimiter(rl.txPerSec, rl.txPerSec * 2),
      admin: new RateLimiter(1, 10),
    };
    this.wsConnPerUser = rl.wsConnPerUser;
    this.api = new ApiRouter({ sessions: this.sessions, origins: this.origins, limits: this.limits, admin: null });
    this.api.add(authRoutes(this.sessions));
    this.api.add(settingsRoutes(this.store, this.now, this.settingsHooks));
    const store = this.store;
    this.topics = {
      canWatchWallet: (userId, address) => store.users.ownsWallet(userId, address),
      walletSnapshot: o.walletSnapshot ?? (async () => null),
      ordersSnapshot: async (userId) => ({ orders: await store.users.listOrders(userId) }),
    };
  }

  start(): void {
    const every = (ms: number, what: string, fn: () => Promise<unknown>) =>
      this.timers.push(setInterval(() => void fn().catch((e) => log.warn(`${what} failed: ${e instanceof Error ? e.message : e}`)), ms));
    every(3_600_000, "session purge", () => this.sessions.purge());
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.ownsDb) await this.db.close();
  }
}

/** Opens the user database (Bun.sql or PGlite per config, migrated) and builds the layer. */
export async function createUserLayer(cfg: ServerConfig, o: UserLayerOverrides = {}): Promise<UserLayer> {
  const db = o.db ?? (await openUserDb(cfg.userDb));
  return new UserLayer(cfg, db, !o.db, o);
}
