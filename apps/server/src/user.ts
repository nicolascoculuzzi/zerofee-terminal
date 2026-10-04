/**
 * The accounts layer: Postgres user state, SIWS sessions, the account / settings / alert REST API,
 * alert evaluation and delivery, the wallet tracker and copy trading (src/trackers), and the WebSocket
 * user topics. `createUserLayer` opens (or takes) the database and builds the services;
 * `createApp(cfg, { user })` wires it into the gateway and market.
 */
import type { NonceStore } from "@zerofee/auth";
import type { OrdersSnapshot, TokenSummary, WalletSnapshot } from "@zerofee/protocol";
import { HaltController } from "./admin/halt";
import { DiscordTransport } from "./alerts/discord";
import { Dispatcher, type DispatcherLimits } from "./alerts/dispatcher";
import { AlertEngine, quoteFromSummary } from "./alerts/engine";
import { PushTransport } from "./alerts/push";
import { SecretBox } from "./alerts/secretBox";
import { TelegramApi, TelegramBot, TelegramTransport } from "./alerts/telegram";
import { adminRoutes, auditMeta } from "./api/admin";
import { alertRoutes } from "./api/alerts";
import { authRoutes } from "./api/auth";
import { ApiRouter } from "./api/router";
import { type SettingsHooks, settingsRoutes } from "./api/settings";
import { AdminAuth } from "./auth/admin";
import { OriginPolicy } from "./auth/origin";
import { SessionService } from "./auth/sessions";
import { decodeKey32, type ServerConfig } from "./config";
import { openUserDb, type PgDriver, UserStore } from "./db/pg";
import { RateLimiter } from "./gateway/rateLimit";
import type { UserTopicHandler } from "./gateway/server";
import { logger } from "./log";
import { ArmedOrdersRepo } from "./orders/repo";
import type { CopyExitHook } from "./trackers/copy";
import { TrackerService } from "./trackers/service";

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
  /** Outbound HTTP for Telegram, Discord and push services (tests pass a mock). */
  fetchFn?: typeof fetch;
  nonceStore?: NonceStore;
  /** Replace the wallet snapshot source (tests; the Phase 6 wallet feed). */
  walletSnapshot?: (address: string) => Promise<WalletSnapshot | null>;
  /** Dispatcher rate limits (tests). */
  alertLimits?: Partial<DispatcherLimits>;
  /** Do not start Telegram long polling (tests drive handleUpdate directly). */
  telegramPolling?: boolean;
  /** Armed-orders seam for tab-closed copy exits (the orders engine; tests). */
  copyExits?: CopyExitHook | null;
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
  /** Test notifications per user. */
  test: RateLimiter;
}

/** The `orders` topic snapshot: open orders plus those that changed in the last day. */
const ORDERS_SNAPSHOT_RECENT_MS = 24 * 3_600_000;
const ORDERS_SNAPSHOT_LIMIT = 200;

export class UserLayer {
  readonly store: UserStore;
  /** Armed orders (the engine, orders/, writes them; the `orders` topic snapshot reads them). */
  readonly armedOrders: ArmedOrdersRepo;
  readonly sessions: SessionService;
  readonly origins: OriginPolicy;
  readonly api: ApiRouter;
  readonly limits: UserLimits;
  readonly topics: UserTopicSource;
  readonly wsConnPerUser: number;
  readonly now: () => number;
  readonly alerts: AlertEngine;
  readonly dispatcher: Dispatcher;
  readonly telegram: TelegramBot | null;
  readonly push: PushTransport | null;
  /** Admin kill switch: POST /api/tx refuses while halted; published on the `chain` topic. */
  readonly halt: HaltController;
  readonly adminAuth: AdminAuth | null;
  /** Settings / tracked-wallet change notifications from the REST API. */
  readonly settingsHooks: SettingsHooks;
  /** Wallet tracker matching, the tracked feed and copy trading. */
  readonly trackers: TrackerService;
  /** Tab-closed copy exits: the armed-orders engine once the app attached it. */
  private copyExits: CopyExitHook | null = null;
  /** wallet:<address> snapshots once the app attached the wallet feed (src/wallets/feed.ts). */
  private walletFeed: ((address: string) => Promise<WalletSnapshot | null>) | null = null;
  /** `tracked`, `tracked:<mint>` and `copy` user topics for the gateway. */
  readonly userTopics: Partial<Record<string, UserTopicHandler>>;
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(
    readonly cfg: ServerConfig,
    readonly db: PgDriver,
    private readonly ownsDb: boolean,
    readonly box: SecretBox | null,
    readonly o: UserLayerOverrides = {},
  ) {
    this.now = o.now ?? Date.now;
    this.store = new UserStore(db);
    this.armedOrders = new ArmedOrdersRepo(db);
    const a = cfg.auth;
    const n = cfg.notifications;
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
      admin: new RateLimiter(rl.adminPerMin / 60, Math.max(10, Math.ceil(rl.adminPerMin / 6))),
      test: new RateLimiter(1 / 5, 1),
    };
    this.wsConnPerUser = rl.wsConnPerUser;

    // alert delivery
    const fetchFn = o.fetchFn ?? fetch;
    const tgApi = n.telegramBotToken ? new TelegramApi(n.telegramBotToken, fetchFn) : null;
    this.push =
      n.vapidPublicKey && n.vapidPrivateKey
        ? new PushTransport({ publicKey: n.vapidPublicKey, privateKey: n.vapidPrivateKey, subject: n.vapidSubject, fetchFn })
        : null;
    this.dispatcher = new Dispatcher({
      store: this.store,
      transports: {
        push: this.push,
        telegram: tgApi ? new TelegramTransport(tgApi) : null,
        discord: box ? new DiscordTransport(fetchFn) : null,
      },
      box,
      appUrl: a.publicOrigin,
      now: this.now,
      limits: o.alertLimits,
    });
    this.alerts = new AlertEngine({ store: this.store, notify: (x) => this.dispatcher.notify(x), appUrl: a.publicOrigin, now: this.now });
    this.trackers = new TrackerService({
      cfg: cfg.trackers,
      db,
      store: this.store,
      alerts: this.alerts,
      now: this.now,
      // Late-bound: the orders engine is built with the app (createApp attaches it).
      exits: { leaderSold: (ev) => (this.copyExits ?? o.copyExits)?.leaderSold(ev) ?? false },
    });
    this.userTopics = this.trackers.topicHandlers();
    this.telegram = tgApi
      ? new TelegramBot({
          api: tgApi,
          store: this.store,
          username: n.telegramBotUsername,
          now: this.now,
          onChange: (users) => {
            for (const u of users) this.dispatcher.invalidate(u);
          },
        })
      : null;
    this.settingsHooks = {
      settingsChanged: (userId, s) => {
        this.alerts.setPrefs(userId, s.notifications);
        this.dispatcher.setDigestSeconds(userId, s.notifications.digestSeconds);
        this.trackers.settingsChanged(userId, s);
      },
      trackedChanged: (userId) => {
        void this.alerts.reloadTracked(userId).catch((e) => log.warn(`tracked-wallet index reload failed: ${e}`));
        void this.trackers.reloadTracked(userId).catch((e) => log.warn(`tracker index reload failed: ${e}`));
      },
      blacklistChanged: (userId) => this.trackers.blacklistChanged(userId),
    };

    // kill switch + operator endpoints (every admin call is audited, failed authentication included)
    this.halt = new HaltController(this.store, this.now);
    this.adminAuth = cfg.adminToken ? new AdminAuth(cfg.adminToken) : null;
    this.api = new ApiRouter({
      sessions: this.sessions,
      origins: this.origins,
      limits: this.limits,
      admin: this.adminAuth,
      onAdminDenied: async (c) => {
        await this.store.audit.append({
          at: this.now(),
          ...auditMeta(c, "unauthenticated"),
          action: "auth_failed",
          target: c.url.pathname,
          ok: false,
          detail: { method: c.req.method, hadAuthorization: c.req.headers.has("authorization") },
        });
      },
    });
    this.api.add(adminRoutes(this.store, this.halt, this.now));
    this.api.add(authRoutes(this.sessions));
    this.api.add(settingsRoutes(this.store, this.now, this.settingsHooks));
    this.api.add(
      alertRoutes({
        store: this.store,
        now: this.now,
        engine: this.alerts,
        dispatcher: this.dispatcher,
        telegram: this.telegram,
        telegramWebhookSecret: n.telegramWebhookSecret,
        box,
        vapidPublicKey: this.push?.publicKey ?? null,
        testLimiter: this.limits.test,
      }),
    );
    this.api.add(this.trackers.routes());
    const store = this.store;
    this.topics = {
      canWatchWallet: (userId, address) => store.users.ownsWallet(userId, address),
      walletSnapshot: (address) => (o.walletSnapshot ?? this.walletFeed ?? (async () => null))(address),
      ordersSnapshot: async (userId) => ({
        orders: await this.armedOrders.listViews(userId, {
          scope: "open",
          limit: ORDERS_SNAPSHOT_LIMIT,
          sinceMs: this.now() - ORDERS_SNAPSHOT_RECENT_MS,
        }),
      }),
    };
  }

  /** Loads state that must be in memory before serving (kill switch, alert index). */
  async init(): Promise<void> {
    await this.halt.load();
    await this.alerts.load();
    await this.trackers.load();
    if (!this.adminAuth) log.info("admin endpoints disabled (set ADMIN_TOKEN to enable /api/admin)");
    const n = this.cfg.notifications;
    log.info(
      `alert channels: push ${this.push ? "on" : "off (VAPID keys)"}, telegram ${this.telegram ? (n.telegramWebhookSecret ? "on (webhook)" : "on (polling)") : "off (TELEGRAM_BOT_TOKEN)"}, ` +
        `discord ${this.box ? "on" : "off (CHANNEL_ENCRYPTION_KEY)"}`,
    );
  }

  /** The wallet:<address> feed (createApp builds it with the RPC client and the gateway). A test override wins. */
  attachWalletFeed(snapshot: (address: string) => Promise<WalletSnapshot | null>): void {
    this.walletFeed = snapshot;
  }

  /** The armed-orders engine fires tab-closed copy exits (createApp, when the engine runs). */
  attachCopyExits(hook: CopyExitHook): void {
    this.copyExits = hook;
  }

  /** Live market prices for alert evaluation (createApp). */
  attachMarket(summary: (mint: string) => TokenSummary | null): void {
    this.alerts.attachQuotes((mint) => quoteFromSummary(summary(mint)));
  }

  start(): void {
    const every = (ms: number, what: string, fn: () => unknown) =>
      this.timers.push(
        setInterval(() => {
          try {
            void Promise.resolve(fn()).catch((e) => log.warn(`${what} failed: ${e instanceof Error ? e.message : e}`));
          } catch (e) {
            log.warn(`${what} failed: ${e instanceof Error ? e.message : e}`);
          }
        }, ms),
      );
    const n = this.cfg.notifications;
    every(n.alertSweepMs, "alert sweep", () => this.alerts.sweep());
    every(3_600_000, "session purge", () => this.sessions.purge());
    every(3_600_000, "link code purge", () => this.store.notify.purgeExpiredLinks(this.now()));
    every(6 * 3_600_000, "delivery purge", () => this.store.notify.purgeDeliveries(this.now() - n.deliveryRetentionDays * 86_400_000));
    this.dispatcher.start();
    this.trackers.start();
    if (this.telegram && !n.telegramWebhookSecret && this.o.telegramPolling !== false) this.telegram.startPolling();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.telegram?.stopPolling();
    await this.dispatcher.stop();
    await this.trackers.stop();
    if (this.ownsDb) await this.db.close();
  }
}

/** Opens the user database (Bun.sql or PGlite per config, migrated), builds the layer and loads it. */
export async function createUserLayer(cfg: ServerConfig, o: UserLayerOverrides = {}): Promise<UserLayer> {
  const db = o.db ?? (await openUserDb(cfg.userDb));
  try {
    const key = cfg.notifications.channelKey;
    const box = key ? await SecretBox.create(decodeKey32("CHANNEL_ENCRYPTION_KEY", key)) : null;
    const layer = new UserLayer(cfg, db, !o.db, box, o);
    await layer.init();
    return layer;
  } catch (e) {
    if (!o.db) await db.close().catch(() => {});
    throw e;
  }
}
