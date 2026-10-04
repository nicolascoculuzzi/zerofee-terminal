/**
 * Armed orders in Postgres (schema: db/pg/migrations.ts v2). Rows hold the whole order as validated JSON
 * plus indexed columns; the engine is the only writer of state changes and saves with an optimistic
 * version check. Every change appends to armed_order_events. Same SQL on Bun.sql and PGlite
 * (portability rules in db/pg/driver.ts).
 */
import {
  type ArmedOrder,
  armedJsonReplacer,
  armedJsonReviver,
  armedOrderToJson,
  isAttemptOpen,
  reservationHeld,
  type TriggerState,
} from "@zerofee/core";
import type { NonceSlot, NonceSlotStatus, Order, OrderEventRecord, OrderEventType, OrderStatus } from "@zerofee/protocol";
import { iso, type PgDriver, type Queryable, type Row, toInt, toJson, toMs, toStrOrNull } from "../db/pg/driver";
import { LimitExceededError, lockUser } from "../db/pg/limits";
import { orderView } from "./view";

export interface StoredOrder {
  userId: string;
  order: ArmedOrder;
  triggerState: TriggerState;
  dryRun: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrderEventWrite {
  type: OrderEventType;
  message: string;
  detail?: Record<string, unknown>;
}

/** A nonce account already armed by another account (its authority is someone else's wallet). */
export class NonceSlotTakenError extends Error {
  constructor(readonly accounts: string[]) {
    super(
      `nonce account${accounts.length > 1 ? "s" : ""} ${accounts.join(", ")} belong${accounts.length > 1 ? "" : "s"} to another account`,
    );
    this.name = "NonceSlotTakenError";
  }
}

/** The row changed underneath the engine (another writer): reload before retrying. */
export class StaleOrderVersionError extends Error {
  constructor(readonly orderId: string) {
    super(`armed order ${orderId} was changed by another writer`);
    this.name = "StaleOrderVersionError";
  }
}

const ACTIVE: readonly OrderStatus[] = ["armed", "submitted"];

/** Parses JSON produced with armedJsonReplacer, whichever form the driver returns jsonb in. */
export function reviveArmedJson<T>(v: unknown): T {
  return JSON.parse(typeof v === "string" ? v : JSON.stringify(v), armedJsonReviver) as T;
}

export function stateJson(s: TriggerState): string {
  return JSON.stringify(s, armedJsonReplacer);
}

/** Event details are for people: bigints become decimal strings. */
const plainBigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

const nonceAccountsOf = (o: ArmedOrder) => [...new Set(o.attempts.map((a) => a.nonce.account as string))];

function mapStored(r: Row): StoredOrder {
  return {
    userId: String(r.user_id),
    order: reviveArmedJson<ArmedOrder>(r.data),
    triggerState: reviveArmedJson<TriggerState>(r.trigger_state ?? {}),
    dryRun: r.dry_run === true,
    version: toInt(r.version),
    createdAt: toMs(r.created_at),
    updatedAt: toMs(r.updated_at),
  };
}

function mapEvent(r: Row): OrderEventRecord {
  return {
    id: toInt(r.id),
    at: toMs(r.at),
    type: String(r.type) as OrderEventType,
    status: String(r.status) as OrderStatus,
    message: String(r.message),
    detail: toJson<Record<string, unknown>>(r.detail) ?? {},
  };
}

function mapSlot(r: Row): NonceSlot {
  return {
    nonceAccount: String(r.nonce_account),
    wallet: String(r.wallet),
    status: String(r.status) as NonceSlotStatus,
    nonceValue: toStrOrNull(r.nonce_value),
    orderId: toStrOrNull(r.order_id),
    updatedAt: toMs(r.updated_at),
  };
}

const STORED_COLS = "user_id, data, trigger_state, dry_run, version, created_at, updated_at";

export class ArmedOrdersRepo {
  constructor(private readonly db: PgDriver) {}

  /**
   * Inserts a batch atomically. Locks the user row, so a user's concurrent intakes serialize; refuses
   * (LimitExceededError) when the user would hold more than `maxActive` armed/submitted orders, and
   * (NonceSlotTakenError) when a nonce account was armed by another account. Claims the slots and
   * appends an "armed" event per order.
   */
  async insertBatch(
    userId: string,
    items: readonly { order: ArmedOrder; triggerState: TriggerState }[],
    o: { now: number; maxActive: number },
  ): Promise<StoredOrder[]> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const active = toInt(
        (
          await tx.query(
            "SELECT count(*) AS n FROM armed_orders WHERE user_id = $1::uuid AND status IN (SELECT jsonb_array_elements_text($2::text::jsonb))",
            [userId, JSON.stringify(ACTIVE)],
          )
        )[0]?.n ?? 0,
      );
      if (active + items.length > o.maxActive) throw new LimitExceededError("open armed orders", o.maxActive);
      const out: StoredOrder[] = [];
      for (const { order, triggerState } of items) {
        const view = orderView(order, triggerState, { createdAt: o.now, updatedAt: o.now, dryRun: false });
        await tx.query(
          `INSERT INTO armed_orders (id, user_id, wallet, mint, kind, side, status, open, oco_group, nonce_accounts, data, view,
                                     trigger_state, signature, status_reason, dry_run, version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::text::jsonb, $11::text::jsonb, $12::text::jsonb,
                   $13::text::jsonb, NULL, NULL, false, 0, $14::timestamptz, $14::timestamptz)`,
          [
            order.id,
            userId,
            order.wallet,
            order.mint,
            order.kind,
            order.side,
            order.status,
            reservationHeld(order),
            order.ocoGroup ?? null,
            JSON.stringify(nonceAccountsOf(order)),
            armedOrderToJson(order),
            JSON.stringify(view),
            stateJson(triggerState),
            iso(o.now),
          ],
        );
        await this.claimSlots(tx, userId, order, o.now);
        await this.insertEvents(
          tx,
          order.id,
          order.status,
          [{ type: "armed", message: "armed", detail: { attempts: order.attempts.length } }],
          o.now,
        );
        out.push({ userId, order, triggerState, dryRun: false, version: 0, createdAt: o.now, updatedAt: o.now });
      }
      return out;
    });
  }

  private async claimSlots(tx: Queryable, userId: string, order: ArmedOrder, now: number): Promise<void> {
    const taken: string[] = [];
    for (const a of order.attempts) {
      const rows = await tx.query(
        `INSERT INTO nonce_slots (nonce_account, user_id, wallet, status, nonce_value, order_id, created_at, updated_at)
         VALUES ($1, $2::uuid, $3, 'in-use', $4, $5::uuid, $6::timestamptz, $6::timestamptz)
         ON CONFLICT (nonce_account) DO UPDATE
           SET status = 'in-use', wallet = EXCLUDED.wallet, nonce_value = EXCLUDED.nonce_value, order_id = EXCLUDED.order_id,
               updated_at = EXCLUDED.updated_at
           WHERE nonce_slots.user_id = EXCLUDED.user_id
         RETURNING nonce_account`,
        [a.nonce.account, userId, order.wallet, a.nonce.value, order.id, iso(now)],
      );
      if (!rows.length) taken.push(a.nonce.account);
    }
    if (taken.length) throw new NonceSlotTakenError([...new Set(taken)]);
  }

  private async insertEvents(
    tx: Queryable,
    orderId: string,
    status: OrderStatus,
    events: readonly OrderEventWrite[],
    now: number,
  ): Promise<void> {
    for (const e of events) {
      await tx.query(
        `INSERT INTO armed_order_events (order_id, at, type, status, message, detail)
         VALUES ($1::uuid, $2::timestamptz, $3, $4, $5, $6::text::jsonb)`,
        [orderId, iso(now), e.type, status, e.message.slice(0, 2_000), JSON.stringify(e.detail ?? {}, plainBigints)],
      );
    }
  }

  /**
   * Saves the engine's new state of an order and appends `events`. `version` is the version the engine
   * loaded; a mismatch throws StaleOrderVersionError. Releases the nonce slots the order no longer holds
   * (no open attempt of an open order of the user is bound to them). Returns the new version.
   */
  async saveState(
    stored: Pick<StoredOrder, "userId" | "order" | "triggerState" | "dryRun" | "version" | "createdAt">,
    events: readonly OrderEventWrite[],
    now: number,
  ): Promise<number> {
    const { order } = stored;
    const view = orderView(order, stored.triggerState, { createdAt: stored.createdAt, updatedAt: now, dryRun: stored.dryRun });
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE armed_orders
         SET status = $3, open = $4, data = $5::text::jsonb, view = $6::text::jsonb, trigger_state = $7::text::jsonb,
             signature = $8, status_reason = $9, dry_run = $10, version = version + 1, updated_at = $11::timestamptz
         WHERE id = $1::uuid AND version = $2
         RETURNING version`,
        [
          order.id,
          stored.version,
          order.status,
          reservationHeld(order),
          armedOrderToJson(order),
          JSON.stringify(view),
          stateJson(stored.triggerState),
          view.signature,
          order.statusReason ?? null,
          stored.dryRun,
          iso(now),
        ],
      );
      if (!rows[0]) throw new StaleOrderVersionError(order.id);
      await this.insertEvents(tx, order.id, order.status, events, now);
      // Slots of attempts that closed: free them unless another open order of the user still holds them.
      for (const a of order.attempts) {
        if (isAttemptOpen(a)) continue;
        await tx.query(
          `UPDATE nonce_slots SET status = 'free', order_id = NULL, updated_at = $3::timestamptz
           WHERE nonce_account = $1 AND user_id = $2::uuid AND status = 'in-use'
             AND NOT EXISTS (
               SELECT 1 FROM armed_orders o
               WHERE o.user_id = $2::uuid AND o.open AND o.nonce_accounts @> jsonb_build_array($1::text)
                 AND o.id <> $4::uuid
             )`,
          [a.nonce.account, stored.userId, iso(now), order.id],
        );
      }
      return toInt(rows[0].version);
    });
  }

  /** Trailing high-water marks and sticky trigger flags (no version bump: the engine serializes per order). */
  async saveTriggerState(stored: Pick<StoredOrder, "order" | "triggerState" | "dryRun" | "createdAt" | "updatedAt">): Promise<void> {
    const view = orderView(stored.order, stored.triggerState, {
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      dryRun: stored.dryRun,
    });
    await this.db.query("UPDATE armed_orders SET trigger_state = $2::text::jsonb, view = $3::text::jsonb WHERE id = $1::uuid", [
      stored.order.id,
      stateJson(stored.triggerState),
      JSON.stringify(view),
    ]);
  }

  async appendEvents(orderId: string, status: OrderStatus, events: readonly OrderEventWrite[], now: number): Promise<void> {
    if (!events.length) return;
    await this.db.transaction((tx) => this.insertEvents(tx, orderId, status, events, now));
  }

  async get(id: string): Promise<StoredOrder | null> {
    const rows = await this.db.query(`SELECT ${STORED_COLS} FROM armed_orders WHERE id = $1::uuid`, [id]);
    return rows[0] ? mapStored(rows[0]) : null;
  }

  /** Every order the engine must watch: a nonce is still unconsumed (start-up). */
  async loadOpen(): Promise<StoredOrder[]> {
    return (await this.db.query(`SELECT ${STORED_COLS} FROM armed_orders WHERE open ORDER BY created_at`)).map(mapStored);
  }

  async view(userId: string, id: string): Promise<Order | null> {
    const rows = await this.db.query("SELECT view FROM armed_orders WHERE id = $1::uuid AND user_id = $2::uuid", [id, userId]);
    return rows[0] ? toJson<Order>(rows[0].view) : null;
  }

  /**
   * The user's orders, newest first. `open`: armed/submitted orders and orders whose nonces are still
   * held, plus (with `sinceMs`) orders updated after that time.
   */
  async listViews(userId: string, o: { scope: "open" | "all"; limit: number; sinceMs?: number }): Promise<Order[]> {
    const rows =
      o.scope === "all"
        ? await this.db.query("SELECT view FROM armed_orders WHERE user_id = $1::uuid ORDER BY created_at DESC, id LIMIT $2", [
            userId,
            o.limit,
          ])
        : await this.db.query(
            `SELECT view FROM armed_orders
             WHERE user_id = $1::uuid AND (open OR status IN ('armed', 'submitted') OR ($3::boolean AND updated_at > $4::timestamptz))
             ORDER BY created_at DESC, id LIMIT $2`,
            [userId, o.limit, o.sinceMs !== undefined, iso(o.sinceMs ?? 0)],
          );
    return rows.map((r) => toJson<Order>(r.view));
  }

  async events(orderId: string, limit = 500): Promise<OrderEventRecord[]> {
    const rows = await this.db.query(
      "SELECT id, at, type, status, message, detail FROM armed_order_events WHERE order_id = $1::uuid ORDER BY id LIMIT $2",
      [orderId, limit],
    );
    return rows.map(mapEvent);
  }

  async countActive(userId: string): Promise<number> {
    const rows = await this.db.query(
      "SELECT count(*) AS n FROM armed_orders WHERE user_id = $1::uuid AND status IN ('armed', 'submitted')",
      [userId],
    );
    return toInt(rows[0]?.n ?? 0);
  }

  async slots(userId: string): Promise<NonceSlot[]> {
    const rows = await this.db.query(
      "SELECT nonce_account, wallet, status, nonce_value, order_id, updated_at FROM nonce_slots WHERE user_id = $1::uuid ORDER BY nonce_account",
      [userId],
    );
    return rows.map(mapSlot);
  }

  /** Nonce accounts of `accounts` that another account armed first. */
  async slotsOwnedByOthers(userId: string, accounts: readonly string[]): Promise<string[]> {
    if (!accounts.length) return [];
    const rows = await this.db.query(
      `SELECT s.nonce_account FROM nonce_slots s JOIN jsonb_array_elements_text($2::text::jsonb) AS a(acc) ON s.nonce_account = a.acc
       WHERE s.user_id <> $1::uuid`,
      [userId, JSON.stringify(accounts)],
    );
    return rows.map((r) => String(r.nonce_account));
  }

  /** The monitor saw a slot's value (or its absence). */
  async observeSlot(account: string, o: { value: string | null; missing: boolean; now: number }): Promise<void> {
    await this.db.query(
      `UPDATE nonce_slots
       SET nonce_value = COALESCE($2, nonce_value), status = CASE WHEN $3 THEN 'missing' WHEN status = 'missing' THEN 'free' ELSE status END,
           updated_at = $4::timestamptz
       WHERE nonce_account = $1`,
      [account, o.value, o.missing, iso(o.now)],
    );
  }
}
