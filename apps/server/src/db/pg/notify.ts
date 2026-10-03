/** Alerts, notification channels, push subscriptions and delivery records. */
import type {
  Alert,
  AlertDelivery,
  AlertPriority,
  AlertRepeat,
  AlertType,
  ChannelKind,
  ChannelStatus,
  DeliverySource,
  DeliveryStatus,
  NotificationChannel,
  PushSubscriptionInfo,
  TokenAlertParams,
} from "@zerofee/protocol";
import { iso, type PgDriver, type Row, toBytes, toInt, toJson, toMs, toMsOrNull, toStrOrNull } from "./driver";
import { assertWithinLimit, lockUser } from "./limits";

/** A validated alert to write (defaults filled by the API layer). */
export interface AlertWrite {
  type: AlertType;
  params: TokenAlertParams;
  channels: ChannelKind[];
  priority: AlertPriority;
  repeat: AlertRepeat;
  cooldownSec: number;
  enabled: boolean;
  note: string;
}

/** An enabled alert with its owner, as the engine loads it. */
export interface AlertRule extends Alert {
  userId: string;
  armed: boolean;
}

export interface TelegramTarget {
  kind: "telegram";
  id: string;
  chatId: string;
}
export interface DiscordTarget {
  kind: "discord";
  id: string;
  /** AES-256-GCM blob; the dispatcher decrypts it right before sending. */
  webhookEnc: Uint8Array;
}
export interface PushTarget {
  kind: "push";
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export type DeliveryTarget = TelegramTarget | DiscordTarget | PushTarget;

export interface DeliveryWrite {
  userId: string;
  alertId: string | null;
  source: DeliverySource;
  channel: ChannelKind;
  targetId: string | null;
  priority: AlertPriority;
  status: DeliveryStatus;
  title: string;
  digestCount: number;
  error: string | null;
  createdAt: number;
}

const ALERT_COLS =
  "id, user_id, type, params, channels, priority, repeat, cooldown_sec, enabled, armed, note, last_fired_at, fire_count, created_at, updated_at";

function mapAlert(r: Row): AlertRule {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    type: String(r.type) as AlertType,
    params: toJson<TokenAlertParams>(r.params),
    channels: toJson<ChannelKind[]>(r.channels),
    priority: String(r.priority) as AlertPriority,
    repeat: String(r.repeat) as AlertRepeat,
    cooldownSec: toInt(r.cooldown_sec),
    enabled: r.enabled === true,
    armed: r.armed === true,
    note: String(r.note),
    lastFiredAt: toMsOrNull(r.last_fired_at),
    fireCount: toInt(r.fire_count),
    createdAt: toMs(r.created_at),
    updatedAt: toMs(r.updated_at),
  };
}

/** Strips server-only fields before an alert leaves the API. */
export function publicAlert(a: AlertRule): Alert {
  const { userId: _u, armed: _a, ...rest } = a;
  return rest;
}

const CHANNEL_COLS = "id, kind, label, status, target_hint, last_error, created_at";

function mapChannel(r: Row): NotificationChannel {
  return {
    id: String(r.id),
    kind: String(r.kind) as "telegram" | "discord",
    label: String(r.label),
    target: String(r.target_hint),
    status: String(r.status) as ChannelStatus,
    lastError: toStrOrNull(r.last_error),
    createdAt: toMs(r.created_at),
  };
}

export class NotifyRepo {
  constructor(private readonly db: PgDriver) {}

  // alerts -------------------------------------------------------------------------------------

  async listAlerts(userId: string): Promise<AlertRule[]> {
    const rows = await this.db.query(`SELECT ${ALERT_COLS} FROM alerts WHERE user_id = $1::uuid ORDER BY created_at, id`, [userId]);
    return rows.map(mapAlert);
  }

  async getAlert(userId: string, id: string): Promise<AlertRule | null> {
    const rows = await this.db.query(`SELECT ${ALERT_COLS} FROM alerts WHERE user_id = $1::uuid AND id = $2::uuid`, [userId, id]);
    return rows[0] ? mapAlert(rows[0]) : null;
  }

  async createAlert(userId: string, a: AlertWrite, now: number, max: number): Promise<AlertRule> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO alerts (id, user_id, type, params, channels, priority, repeat, cooldown_sec, enabled, armed, note, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::text::jsonb, $5::text::jsonb, $6, $7, $8, $9, true, $10, $11::timestamptz, $11::timestamptz)
         RETURNING ${ALERT_COLS}`,
        [
          crypto.randomUUID(),
          userId,
          a.type,
          JSON.stringify(a.params),
          JSON.stringify(a.channels),
          a.priority,
          a.repeat,
          a.cooldownSec,
          a.enabled,
          a.note,
          iso(now),
        ],
      );
      await assertWithinLimit(tx, "alerts", userId, max, "alerts");
      return mapAlert(rows[0] as Row);
    });
  }

  /** Replaces the editable fields. Changing the condition or re-enabling re-arms the alert. */
  async updateAlert(userId: string, id: string, a: AlertWrite, rearm: boolean, now: number): Promise<AlertRule | null> {
    const rows = await this.db.query(
      `UPDATE alerts SET params = $3::text::jsonb, channels = $4::text::jsonb, priority = $5, repeat = $6, cooldown_sec = $7, enabled = $8,
              note = $9, armed = CASE WHEN $10 THEN true ELSE armed END, updated_at = $11::timestamptz
       WHERE user_id = $1::uuid AND id = $2::uuid
       RETURNING ${ALERT_COLS}`,
      [
        userId,
        id,
        JSON.stringify(a.params),
        JSON.stringify(a.channels),
        a.priority,
        a.repeat,
        a.cooldownSec,
        a.enabled,
        a.note,
        rearm,
        iso(now),
      ],
    );
    return rows[0] ? mapAlert(rows[0]) : null;
  }

  async deleteAlert(userId: string, id: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM alerts WHERE user_id = $1::uuid AND id = $2::uuid RETURNING id", [userId, id])).length > 0;
  }

  /** Every enabled alert (engine start-up). */
  async listEnabledAlerts(): Promise<AlertRule[]> {
    return (await this.db.query(`SELECT ${ALERT_COLS} FROM alerts WHERE enabled`)).map(mapAlert);
  }

  /** Records a firing: once-alerts are disabled, rearm-alerts disarmed until the condition clears. */
  async recordFire(id: string, now: number, disable: boolean): Promise<void> {
    await this.db.query(
      `UPDATE alerts SET last_fired_at = $2::timestamptz, fire_count = fire_count + 1, armed = false,
              enabled = CASE WHEN $3 THEN false ELSE enabled END, updated_at = $2::timestamptz
       WHERE id = $1::uuid`,
      [id, iso(now), disable],
    );
  }

  async setArmed(id: string, armed: boolean): Promise<void> {
    await this.db.query("UPDATE alerts SET armed = $2 WHERE id = $1::uuid", [id, armed]);
  }

  // notification channels ----------------------------------------------------------------------

  async listChannels(userId: string): Promise<NotificationChannel[]> {
    const rows = await this.db.query(`SELECT ${CHANNEL_COLS} FROM notification_channels WHERE user_id = $1::uuid ORDER BY created_at, id`, [
      userId,
    ]);
    return rows.map(mapChannel);
  }

  /** A pending Telegram link: the bot activates it when it sees `/start <code>`. */
  async createTelegramLink(userId: string, codeHash: string, expiresAt: number, now: number, max: number): Promise<string> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      // One pending code per user at a time.
      await tx.query("DELETE FROM notification_channels WHERE user_id = $1::uuid AND kind = 'telegram' AND status = 'pending'", [userId]);
      const id = crypto.randomUUID();
      await tx.query(
        `INSERT INTO notification_channels (id, user_id, kind, label, status, telegram_link_code_hash, telegram_link_expires_at,
                                            target_hint, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'telegram', 'Telegram', 'pending', $3, $4::timestamptz, 'waiting for /start', $5::timestamptz, $5::timestamptz)`,
        [id, userId, codeHash, iso(expiresAt), iso(now)],
      );
      await assertWithinLimit(tx, "notification_channels", userId, max, "notification channels");
      return id;
    });
  }

  /**
   * Consumes a link code (single use) and binds the chat. Returns null for unknown or expired codes.
   * Linking a chat that the user already linked reactivates that row instead.
   */
  async consumeTelegramLink(
    codeHash: string,
    chatId: string,
    chatLabel: string,
    now: number,
  ): Promise<{ userId: string; channelId: string; wallet: string } | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `DELETE FROM notification_channels
         WHERE telegram_link_code_hash = $1 AND status = 'pending' AND telegram_link_expires_at > $2::timestamptz
         RETURNING id, user_id`,
        [codeHash, iso(now)],
      );
      const pending = rows[0];
      if (!pending) return null;
      const userId = String(pending.user_id);
      const linked = await tx.query(
        `INSERT INTO notification_channels (id, user_id, kind, label, status, telegram_chat_id, target_hint, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'telegram', 'Telegram', 'active', $3, $4, $5::timestamptz, $5::timestamptz)
         ON CONFLICT (user_id, telegram_chat_id) WHERE telegram_chat_id IS NOT NULL
         DO UPDATE SET status = 'active', target_hint = EXCLUDED.target_hint, last_error = NULL, failure_count = 0,
                       updated_at = EXCLUDED.updated_at
         RETURNING id, (SELECT wallet FROM users WHERE users.id = notification_channels.user_id) AS wallet`,
        [String(pending.id), userId, chatId, chatLabel, iso(now)],
      );
      const r = linked[0] as Row;
      return { userId, channelId: String(r.id), wallet: String(r.wallet) };
    });
  }

  /** /stop from the chat, or the bot was blocked: disable every channel bound to it. Returns affected users. */
  async disableTelegramChat(chatId: string, reason: string, now: number): Promise<string[]> {
    const rows = await this.db.query(
      `UPDATE notification_channels SET status = 'disabled', last_error = $2, updated_at = $3::timestamptz
       WHERE kind = 'telegram' AND telegram_chat_id = $1 AND status <> 'disabled'
       RETURNING user_id`,
      [chatId, reason, iso(now)],
    );
    return [...new Set(rows.map((r) => String(r.user_id)))];
  }

  async createDiscordChannel(
    userId: string,
    c: { id: string; label: string; webhookEnc: Uint8Array; webhookHash: string; hint: string },
    now: number,
    max: number,
  ): Promise<NotificationChannel> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO notification_channels (id, user_id, kind, label, status, discord_webhook_enc, discord_webhook_hash, target_hint,
                                            created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'discord', $3, 'active', $4, $5, $6, $7::timestamptz, $7::timestamptz)
         RETURNING ${CHANNEL_COLS}`,
        [c.id, userId, c.label, c.webhookEnc, c.webhookHash, c.hint, iso(now)],
      );
      await assertWithinLimit(tx, "notification_channels", userId, max, "notification channels");
      return mapChannel(rows[0] as Row);
    });
  }

  /** A channel with its delivery target (for test sends). */
  async getChannelTarget(userId: string, id: string): Promise<DeliveryTarget | null> {
    const rows = await this.db.query(
      `SELECT id, kind, telegram_chat_id, discord_webhook_enc FROM notification_channels
       WHERE user_id = $1::uuid AND id = $2::uuid AND status = 'active'`,
      [userId, id],
    );
    const r = rows[0];
    return r ? channelTarget(r) : null;
  }

  async deleteChannel(userId: string, id: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM notification_channels WHERE user_id = $1::uuid AND id = $2::uuid RETURNING id", [
      userId,
      id,
    ]);
    return rows.length > 0;
  }

  async channelFailed(id: string, error: string, disable: boolean, now: number): Promise<void> {
    await this.db.query(
      `UPDATE notification_channels SET last_error = $2, failure_count = failure_count + 1,
              status = CASE WHEN $3 THEN 'disabled' ELSE status END, updated_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [id, error.slice(0, 300), disable, iso(now)],
    );
  }

  async channelOk(id: string): Promise<void> {
    await this.db.query("UPDATE notification_channels SET last_error = NULL, failure_count = 0 WHERE id = $1::uuid AND failure_count > 0", [
      id,
    ]);
  }

  async purgeExpiredLinks(now: number): Promise<number> {
    const rows = await this.db.query(
      "DELETE FROM notification_channels WHERE status = 'pending' AND telegram_link_expires_at < $1::timestamptz RETURNING id",
      [iso(now)],
    );
    return rows.length;
  }

  /** The user's active targets of the given kinds. */
  async targets(userId: string, kinds: readonly ChannelKind[]): Promise<DeliveryTarget[]> {
    const out: DeliveryTarget[] = [];
    const wantChannels = kinds.filter((k) => k !== "push");
    if (wantChannels.length) {
      const rows = await this.db.query(
        `SELECT id, kind, telegram_chat_id, discord_webhook_enc FROM notification_channels
         WHERE user_id = $1::uuid AND status = 'active' AND kind IN (SELECT value FROM jsonb_array_elements_text($2::text::jsonb))
         ORDER BY created_at`,
        [userId, JSON.stringify(wantChannels)],
      );
      for (const r of rows) {
        const t = channelTarget(r);
        if (t) out.push(t);
      }
    }
    if (kinds.includes("push")) {
      const rows = await this.db.query(
        "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1::uuid ORDER BY created_at",
        [userId],
      );
      for (const r of rows)
        out.push({ kind: "push", id: String(r.id), endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth) });
    }
    return out;
  }

  // push subscriptions -------------------------------------------------------------------------

  async listPush(userId: string): Promise<PushSubscriptionInfo[]> {
    const rows = await this.db.query(
      "SELECT id, endpoint, created_at, last_success_at FROM push_subscriptions WHERE user_id = $1::uuid ORDER BY created_at",
      [userId],
    );
    return rows.map(mapPush);
  }

  /**
   * Stores a browser subscription. Endpoints are unique: re-subscribing from the same browser (or a
   * browser handed to another account) moves the endpoint to this user.
   */
  async upsertPush(
    userId: string,
    s: { endpoint: string; p256dh: string; auth: string; userAgentHash: string | null },
    now: number,
    max: number,
  ): Promise<PushSubscriptionInfo> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent_hash, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                                             user_agent_hash = EXCLUDED.user_agent_hash, failure_count = 0
         RETURNING id, endpoint, created_at, last_success_at`,
        [crypto.randomUUID(), userId, s.endpoint, s.p256dh, s.auth, s.userAgentHash, iso(now)],
      );
      await assertWithinLimit(tx, "push_subscriptions", userId, max, "push subscriptions");
      return mapPush(rows[0] as Row);
    });
  }

  async getPushTarget(userId: string, id: string): Promise<PushTarget | null> {
    const rows = await this.db.query(
      "SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1::uuid AND id = $2::uuid",
      [userId, id],
    );
    const r = rows[0];
    return r ? { kind: "push", id: String(r.id), endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth) } : null;
  }

  async deletePushByEndpoint(userId: string, endpoint: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM push_subscriptions WHERE user_id = $1::uuid AND endpoint = $2 RETURNING id", [
      userId,
      endpoint,
    ]);
    return rows.length > 0;
  }

  /** The push service said the subscription is gone (404/410). */
  async deletePushById(id: string): Promise<void> {
    await this.db.query("DELETE FROM push_subscriptions WHERE id = $1::uuid", [id]);
  }

  async pushOk(id: string, now: number): Promise<void> {
    await this.db.query("UPDATE push_subscriptions SET last_success_at = $2::timestamptz, failure_count = 0 WHERE id = $1::uuid", [
      id,
      iso(now),
    ]);
  }

  async pushFailed(id: string): Promise<void> {
    await this.db.query("UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1::uuid", [id]);
  }

  // deliveries ---------------------------------------------------------------------------------

  /** Batch insert. Rows whose user vanished are skipped; deleted alerts become alert_id NULL. */
  async recordDeliveries(rows: DeliveryWrite[]): Promise<void> {
    if (!rows.length) return;
    const records = rows.map((d) => ({
      id: crypto.randomUUID(),
      user_id: d.userId,
      alert_id: d.alertId,
      source: d.source,
      channel: d.channel,
      target_id: d.targetId,
      priority: d.priority,
      status: d.status,
      title: d.title.slice(0, 200),
      digest_count: d.digestCount,
      error: d.error?.slice(0, 300) ?? null,
      created_at: iso(d.createdAt),
    }));
    await this.db.query(
      `INSERT INTO alert_deliveries (id, user_id, alert_id, source, channel, target_id, priority, status, title, digest_count, error, created_at)
       SELECT r.id, r.user_id, (SELECT a.id FROM alerts a WHERE a.id = r.alert_id), r.source, r.channel, r.target_id, r.priority,
              r.status, r.title, r.digest_count, r.error, r.created_at
       FROM jsonb_to_recordset($1::text::jsonb) AS r(id uuid, user_id uuid, alert_id uuid, source text, channel text, target_id uuid,
                                                priority text, status text, title text, digest_count integer, error text,
                                                created_at timestamptz)
       WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id)`,
      [JSON.stringify(records)],
    );
  }

  async listDeliveries(userId: string, limit: number): Promise<AlertDelivery[]> {
    const rows = await this.db.query(
      `SELECT id, alert_id, source, channel, status, title, digest_count, error, created_at FROM alert_deliveries
       WHERE user_id = $1::uuid ORDER BY created_at DESC, id LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      alertId: toStrOrNull(r.alert_id),
      source: String(r.source) as DeliverySource,
      channel: String(r.channel) as ChannelKind,
      status: String(r.status) as DeliveryStatus,
      title: String(r.title),
      digestCount: toInt(r.digest_count),
      error: toStrOrNull(r.error),
      createdAt: toMs(r.created_at),
    }));
  }

  async purgeDeliveries(before: number): Promise<number> {
    return (await this.db.query("DELETE FROM alert_deliveries WHERE created_at < $1::timestamptz RETURNING id", [iso(before)])).length;
  }

  /** Counts for the admin user lookup (no addresses, no contents). */
  async countsFor(userId: string): Promise<{ alerts: number; channels: number }> {
    const rows = await this.db.query(
      `SELECT (SELECT count(*) FROM alerts WHERE user_id = $1::uuid) AS alerts,
              (SELECT count(*) FROM notification_channels WHERE user_id = $1::uuid) AS channels`,
      [userId],
    );
    return { alerts: toInt(rows[0]?.alerts ?? 0), channels: toInt(rows[0]?.channels ?? 0) };
  }
}

function channelTarget(r: Row): DeliveryTarget | null {
  if (r.kind === "telegram" && r.telegram_chat_id !== null && r.telegram_chat_id !== undefined) {
    return { kind: "telegram", id: String(r.id), chatId: String(r.telegram_chat_id) };
  }
  if (r.kind === "discord" && r.discord_webhook_enc)
    return { kind: "discord", id: String(r.id), webhookEnc: toBytes(r.discord_webhook_enc) };
  return null;
}

function mapPush(r: Row): PushSubscriptionInfo {
  let endpointHost = "";
  try {
    endpointHost = new URL(String(r.endpoint)).host;
  } catch {
    endpointHost = "";
  }
  return { id: String(r.id), endpointHost, createdAt: toMs(r.created_at), lastSuccessAt: toMsOrNull(r.last_success_at) };
}
