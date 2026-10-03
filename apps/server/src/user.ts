/**
 * The accounts layer: Postgres user state, SIWS sessions, the account / settings / alert REST API,
 * alert evaluation and delivery, and the WebSocket user topics. `createUserLayer` opens (or takes) the
 * database and builds the services; `createApp(cfg, { user })` wires it into the gateway and market.
 */
import type { NonceStore } from "@zerofee/auth";
import type { OrdersSnapshot, TokenSummary, WalletSnapshot } from "@zerofee/protocol";
import { DiscordTransport } from "./alerts/discord";
import { Dispatcher, type DispatcherLimits } from "./alerts/dispatcher";
import { AlertEngine, quoteFromSummary } from "./alerts/engine";
import { PushTransport } from "./alerts/push";
import { SecretBox } from "./alerts/secretBox";
import { TelegramApi, TelegramBot, TelegramTransport } from "./alerts/telegram";
import { alertRoutes } from "./api/alerts";
import { authRoutes } from "./api/auth";
import { ApiRouter } from "./api/router";
import { type SettingsHooks, settingsRoutes } from "./api/settings";
import { OriginPolicy } from "./auth/origin";
import { SessionService } from "./auth/sessions";
import { decodeKey32, type ServerConfig } from "./config";
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
  /** Outbound HTTP for Telegram, Discord and push services (tests pass a mock). */
  fetchFn?: typeof fetch;
  nonceStore?: NonceStore;
  /** Replace the wallet snapshot source (tests; the Phase 6 wallet feed). */
  walletSnapshot?: (address: string) => Promise<WalletSnapshot | null>;
  /** Dispatcher rate limits (tests). */
  alertLimits?: Partial<DispatcherLimits>;
  /** Do not start Telegram long polling (tests drive handleUpdate directly). */
  telegramPolling?: boolean;
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

export class UserLayer {
  readonly store: UserStore;
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
  /** Settings / tracked-wallet change notifications from the REST API. */
  readonly settingsHooks: SettingsHooks;
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
      admin: new RateLimiter(1, 10),
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
      },
      trackedChanged: (userId) => {
        void this.alerts.reloadTracked(userId).catch((e) => log.warn(`tracked-wallet index reload failed: ${e}`));
      },
    };

    this.api = new ApiRouter({ sessions: this.sessions, origins: this.origins, limits: this.limits, admin: null });
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
    const store = this.store;
    this.topics = {
      canWatchWallet: (userId, address) => store.users.ownsWallet(userId, address),
      walletSnapshot: o.walletSnapshot ?? (async () => null),
      ordersSnapshot: async (userId) => ({ orders: await store.users.listOrders(userId) }),
    };
  }

  /** Loads state that must be in memory before serving (alert index). */
  async init(): Promise<void> {
    await this.alerts.load();
    const n = this.cfg.notifications;
    log.info(
      `alert channels: push ${this.push ? "on" : "off (VAPID keys)"}, telegram ${this.telegram ? (n.telegramWebhookSecret ? "on (webhook)" : "on (polling)") : "off (TELEGRAM_BOT_TOKEN)"}, ` +
        `discord ${this.box ? "on" : "off (CHANNEL_ENCRYPTION_KEY)"}`,
    );
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
    if (this.telegram && !n.telegramWebhookSecret && this.o.telegramPolling !== false) this.telegram.startPolling();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.telegram?.stopPolling();
    await this.dispatcher.stop();
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
