/** Users, sessions, trading wallets and (read-only for now) armed orders. */
import type { Order, OrderKind, OrderStatus, OrderTrigger, TradingWallet } from "@zerofee/protocol";
import { iso, type PgDriver, type Row, toInt, toJson, toMs, toStrOrNull } from "./driver";
import { assertWithinLimit, lockUser } from "./limits";

export interface UserRecord {
  id: string;
  wallet: string;
  createdAt: number;
  lastLoginAt: number;
}

export interface SessionRecord {
  id: string;
  userId: string;
  wallet: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

const USER_COLS = "id, wallet, created_at, last_login_at";

function mapUser(r: Row): UserRecord {
  return { id: String(r.id), wallet: String(r.wallet), createdAt: toMs(r.created_at), lastLoginAt: toMs(r.last_login_at) };
}

function mapTradingWallet(r: Row): TradingWallet {
  return { publicKey: String(r.public_key), label: String(r.label), createdAt: toMs(r.created_at) };
}

export class UsersRepo {
  constructor(private readonly db: PgDriver) {}

  /** Creates the user on first sign-in, otherwise records the login. */
  async upsertOnLogin(wallet: string, now: number): Promise<UserRecord> {
    const rows = await this.db.query(
      `INSERT INTO users (id, wallet, created_at, last_login_at) VALUES ($1::uuid, $2, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (wallet) DO UPDATE SET last_login_at = EXCLUDED.last_login_at
       RETURNING ${USER_COLS}`,
      [crypto.randomUUID(), wallet, iso(now)],
    );
    return mapUser(rows[0] as Row);
  }

  async byId(id: string): Promise<UserRecord | null> {
    const rows = await this.db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1::uuid`, [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async byWallet(wallet: string): Promise<UserRecord | null> {
    const rows = await this.db.query(`SELECT ${USER_COLS} FROM users WHERE wallet = $1`, [wallet]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async count(): Promise<number> {
    return toInt((await this.db.query("SELECT count(*) AS n FROM users"))[0]?.n ?? 0);
  }

  // -------------------------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------------------------

  /** Stores a new session (by token hash) and revokes the user's oldest live sessions beyond `maxActive`. */
  async createSession(s: {
    userId: string;
    tokenHash: string;
    expiresAt: number;
    userAgentHash: string | null;
    now: number;
    maxActive: number;
  }): Promise<SessionRecord> {
    return this.db.transaction(async (tx) => {
      const id = crypto.randomUUID();
      const rows = await tx.query(
        `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, user_agent_hash)
         VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::timestamptz, $4::timestamptz, $6)
         RETURNING id, user_id, created_at, expires_at, last_seen_at,
                   (SELECT wallet FROM users WHERE users.id = sessions.user_id) AS wallet`,
        [id, s.tokenHash, s.userId, iso(s.now), iso(s.expiresAt), s.userAgentHash],
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = $3::timestamptz
         WHERE id IN (
           SELECT id FROM sessions
           WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > $3::timestamptz
           ORDER BY created_at DESC, id
           OFFSET $2
         )`,
        [s.userId, s.maxActive, iso(s.now)],
      );
      return mapSession(rows[0] as Row);
    });
  }

  /** The live (not revoked, not expired) session for a token hash. */
  async findSession(tokenHash: string, now: number): Promise<SessionRecord | null> {
    const rows = await this.db.query(
      `SELECT s.id, s.user_id, s.created_at, s.expires_at, s.last_seen_at, u.wallet
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2::timestamptz`,
      [tokenHash, iso(now)],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async touchSession(id: string, now: number): Promise<void> {
    await this.db.query("UPDATE sessions SET last_seen_at = $2::timestamptz WHERE id = $1::uuid", [id, iso(now)]);
  }

  async revokeSession(id: string, now: number): Promise<boolean> {
    const rows = await this.db.query(
      "UPDATE sessions SET revoked_at = $2::timestamptz WHERE id = $1::uuid AND revoked_at IS NULL RETURNING id",
      [id, iso(now)],
    );
    return rows.length > 0;
  }

  /** Revokes every live session of the user; returns their ids. */
  async revokeAllSessions(userId: string, now: number): Promise<string[]> {
    const rows = await this.db.query(
      "UPDATE sessions SET revoked_at = $2::timestamptz WHERE user_id = $1::uuid AND revoked_at IS NULL RETURNING id",
      [userId, iso(now)],
    );
    return rows.map((r) => String(r.id));
  }

  /** Live sessions, of one user or of everyone. */
  async activeSessionCount(now: number, userId?: string): Promise<number> {
    const rows = userId
      ? await this.db.query(
          "SELECT count(*) AS n FROM sessions WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2::timestamptz",
          [userId, iso(now)],
        )
      : await this.db.query("SELECT count(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > $1::timestamptz", [iso(now)]);
    return toInt(rows[0]?.n ?? 0);
  }

  /** Deletes sessions that expired or were revoked before `before`. */
  async purgeSessions(before: number): Promise<number> {
    const rows = await this.db.query(
      "DELETE FROM sessions WHERE expires_at < $1::timestamptz OR revoked_at < $1::timestamptz RETURNING id",
      [iso(before)],
    );
    return rows.length;
  }

  // -------------------------------------------------------------------------------------------
  // trading wallets (public keys + labels only)
  // -------------------------------------------------------------------------------------------

  async listTradingWallets(userId: string): Promise<TradingWallet[]> {
    const rows = await this.db.query(
      "SELECT public_key, label, created_at FROM trading_wallets WHERE user_id = $1::uuid ORDER BY created_at, public_key",
      [userId],
    );
    return rows.map(mapTradingWallet);
  }

  /** Adds a trading wallet (or relabels it when `label` is given). */
  async upsertTradingWallet(
    userId: string,
    publicKey: string,
    label: string | undefined,
    now: number,
    max: number,
  ): Promise<TradingWallet> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO trading_wallets (id, user_id, public_key, label, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz)
         ON CONFLICT (user_id, public_key) DO UPDATE SET label = CASE WHEN $6 THEN EXCLUDED.label ELSE trading_wallets.label END
         RETURNING public_key, label, created_at`,
        [crypto.randomUUID(), userId, publicKey, label ?? "", iso(now), label !== undefined],
      );
      await assertWithinLimit(tx, "trading_wallets", userId, max, "trading wallets");
      return mapTradingWallet(rows[0] as Row);
    });
  }

  async setTradingWalletLabel(userId: string, publicKey: string, label: string): Promise<TradingWallet | null> {
    const rows = await this.db.query(
      "UPDATE trading_wallets SET label = $3 WHERE user_id = $1::uuid AND public_key = $2 RETURNING public_key, label, created_at",
      [userId, publicKey, label],
    );
    return rows[0] ? mapTradingWallet(rows[0]) : null;
  }

  async deleteTradingWallet(userId: string, publicKey: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM trading_wallets WHERE user_id = $1::uuid AND public_key = $2 RETURNING id", [
      userId,
      publicKey,
    ]);
    return rows.length > 0;
  }

  /** True when `address` is the user's main wallet or one of their trading wallets (wallet: topic access). */
  async ownsWallet(userId: string, address: string): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 AS ok FROM users WHERE id = $1::uuid AND wallet = $2
       UNION ALL
       SELECT 1 AS ok FROM trading_wallets WHERE user_id = $1::uuid AND public_key = $2
       LIMIT 1`,
      [userId, address],
    );
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------------------------
  // armed orders: read-only until the Phase 5 engine writes them
  // -------------------------------------------------------------------------------------------

  async listOrders(userId: string, limit = 500): Promise<Order[]> {
    const rows = await this.db.query(
      `SELECT o.id, o.kind, o.status, o.mint, o.side, o.amount, o.trigger, o.signature, o.error, o.created_at, o.updated_at,
              n.nonce_account
       FROM armed_orders o LEFT JOIN nonce_slots n ON n.id = o.nonce_slot_id
       WHERE o.user_id = $1::uuid
       ORDER BY o.created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as OrderKind,
      status: String(r.status) as OrderStatus,
      mint: String(r.mint),
      side: String(r.side) as "buy" | "sell",
      amount: String(r.amount),
      trigger: toJson<OrderTrigger>(r.trigger),
      nonceAccount: toStrOrNull(r.nonce_account),
      signature: toStrOrNull(r.signature),
      createdAt: toMs(r.created_at),
      updatedAt: toMs(r.updated_at),
      error: toStrOrNull(r.error),
    }));
  }
}

function mapSession(r: Row): SessionRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    wallet: String(r.wallet),
    createdAt: toMs(r.created_at),
    expiresAt: toMs(r.expires_at),
    lastSeenAt: toMs(r.last_seen_at),
  };
}
