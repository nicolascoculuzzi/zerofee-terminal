/** Wallet tracker lists (up to 10,000 wallets per user, SPEC P0). */
import type { TrackedWallet, TrackedWalletAlerts } from "@zerofee/protocol";
import { iso, type PgDriver, type Queryable, type Row, toJson, toMs } from "./driver";
import { assertWithinLimit, lockUser } from "./limits";

/** A fully specified row to write (the API layer fills defaults). */
export interface TrackedWalletWrite {
  address: string;
  label: string;
  emoji: string;
  tags: string[];
  alerts: TrackedWalletAlerts;
}

export interface TrackedWalletUpdate {
  label?: string;
  emoji?: string;
  tags?: string[];
  alerts?: Partial<TrackedWalletAlerts>;
}

/** One alerting entry of the in-memory index (union of every user's list). */
export interface AlertingWallet {
  userId: string;
  address: string;
  label: string;
  emoji: string;
  alerts: TrackedWalletAlerts;
}

const COLS = "address, label, emoji, tags, alert_buy, alert_sell, alert_create, alert_min_sol, created_at, updated_at";

function mapTracked(r: Row): TrackedWallet {
  return {
    address: String(r.address),
    label: String(r.label),
    emoji: String(r.emoji),
    tags: toJson<string[]>(r.tags) ?? [],
    alerts: { buy: r.alert_buy === true, sell: r.alert_sell === true, create: r.alert_create === true, minSol: Number(r.alert_min_sol) },
    createdAt: toMs(r.created_at),
    updatedAt: toMs(r.updated_at),
  };
}

function toRecord(w: TrackedWalletWrite) {
  return {
    address: w.address,
    label: w.label,
    emoji: w.emoji,
    tags: w.tags,
    alert_buy: w.alerts.buy,
    alert_sell: w.alerts.sell,
    alert_create: w.alerts.create,
    alert_min_sol: w.alerts.minSol,
  };
}

export class TrackedWalletsRepo {
  constructor(private readonly db: PgDriver) {}

  async list(userId: string): Promise<TrackedWallet[]> {
    const rows = await this.db.query(`SELECT ${COLS} FROM tracked_wallets WHERE user_id = $1::uuid ORDER BY created_at, address`, [userId]);
    return rows.map(mapTracked);
  }

  async get(userId: string, address: string): Promise<TrackedWallet | null> {
    const rows = await this.db.query(`SELECT ${COLS} FROM tracked_wallets WHERE user_id = $1::uuid AND address = $2`, [userId, address]);
    return rows[0] ? mapTracked(rows[0]) : null;
  }

  /**
   * Upserts many wallets in one statement. On conflict, label / emoji / tags are replaced; alert flags
   * are replaced only when `overwriteAlerts` (single add with explicit flags), so importing a list
   * never silently turns alerts off. mode=replace first deletes wallets missing from `wallets`.
   */
  async upsertMany(
    userId: string,
    wallets: TrackedWalletWrite[],
    o: { now: number; max: number; replace?: boolean; overwriteAlerts?: boolean },
  ): Promise<{ added: number; updated: number; removed: number }> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      let removed = 0;
      if (o.replace) {
        const keep = JSON.stringify(wallets.map((w) => w.address));
        removed = (
          await tx.query(
            `DELETE FROM tracked_wallets WHERE user_id = $1::uuid
             AND address NOT IN (SELECT value FROM jsonb_array_elements_text($2::text::jsonb))
             RETURNING address`,
            [userId, keep],
          )
        ).length;
      }
      const { added, updated } = await upsert(tx, userId, wallets, o.now, o.overwriteAlerts === true);
      await assertWithinLimit(tx, "tracked_wallets", userId, o.max, "tracked wallets");
      return { added, updated, removed };
    });
  }

  async update(userId: string, address: string, patch: TrackedWalletUpdate, now: number): Promise<TrackedWallet | null> {
    const sets: string[] = ["updated_at = $3::timestamptz"];
    const params: unknown[] = [userId, address, iso(now)];
    const add = (col: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.label !== undefined) add("label", patch.label);
    if (patch.emoji !== undefined) add("emoji", patch.emoji);
    if (patch.tags !== undefined) add("tags", JSON.stringify(patch.tags), "::jsonb");
    if (patch.alerts?.buy !== undefined) add("alert_buy", patch.alerts.buy);
    if (patch.alerts?.sell !== undefined) add("alert_sell", patch.alerts.sell);
    if (patch.alerts?.create !== undefined) add("alert_create", patch.alerts.create);
    if (patch.alerts?.minSol !== undefined) add("alert_min_sol", patch.alerts.minSol, "::double precision");
    const rows = await this.db.query(
      `UPDATE tracked_wallets SET ${sets.join(", ")} WHERE user_id = $1::uuid AND address = $2 RETURNING ${COLS}`,
      params,
    );
    return rows[0] ? mapTracked(rows[0]) : null;
  }

  async remove(userId: string, address: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM tracked_wallets WHERE user_id = $1::uuid AND address = $2 RETURNING address", [
      userId,
      address,
    ]);
    return rows.length > 0;
  }

  /** Every alerting entry of every user (or one user's), for the in-memory index. */
  async listAlerting(userId?: string): Promise<AlertingWallet[]> {
    const rows = await this.db.query(
      `SELECT user_id, address, label, emoji, alert_buy, alert_sell, alert_create, alert_min_sol
       FROM tracked_wallets WHERE (alert_buy OR alert_sell OR alert_create) ${userId ? "AND user_id = $1::uuid" : ""}`,
      userId ? [userId] : [],
    );
    return rows.map((r) => ({
      userId: String(r.user_id),
      address: String(r.address),
      label: String(r.label),
      emoji: String(r.emoji),
      alerts: { buy: r.alert_buy === true, sell: r.alert_sell === true, create: r.alert_create === true, minSol: Number(r.alert_min_sol) },
    }));
  }
}

async function upsert(
  tx: Queryable,
  userId: string,
  wallets: TrackedWalletWrite[],
  now: number,
  overwriteAlerts: boolean,
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  // Chunks keep each statement's JSON parameter small (10,000 wallets ~ 1.5 MB).
  for (let i = 0; i < wallets.length; i += 1_000) {
    const chunk = wallets.slice(i, i + 1_000).map(toRecord);
    const rows = await tx.query(
      `INSERT INTO tracked_wallets (user_id, address, label, emoji, tags, alert_buy, alert_sell, alert_create, alert_min_sol, created_at, updated_at)
       SELECT $1::uuid, r.address, r.label, r.emoji, r.tags, r.alert_buy, r.alert_sell, r.alert_create, r.alert_min_sol,
              $3::timestamptz, $3::timestamptz
       FROM jsonb_to_recordset($2::text::jsonb) AS r(address text, label text, emoji text, tags jsonb, alert_buy boolean,
                                                alert_sell boolean, alert_create boolean, alert_min_sol double precision)
       ON CONFLICT (user_id, address) DO UPDATE SET
         label = EXCLUDED.label, emoji = EXCLUDED.emoji, tags = EXCLUDED.tags, updated_at = EXCLUDED.updated_at,
         alert_buy = CASE WHEN $4 THEN EXCLUDED.alert_buy ELSE tracked_wallets.alert_buy END,
         alert_sell = CASE WHEN $4 THEN EXCLUDED.alert_sell ELSE tracked_wallets.alert_sell END,
         alert_create = CASE WHEN $4 THEN EXCLUDED.alert_create ELSE tracked_wallets.alert_create END,
         alert_min_sol = CASE WHEN $4 THEN EXCLUDED.alert_min_sol ELSE tracked_wallets.alert_min_sol END
       RETURNING (xmax = 0) AS inserted`,
      [userId, JSON.stringify(chunk), iso(now), overwriteAlerts],
    );
    for (const r of rows) {
      if (r.inserted === true) added++;
      else updated++;
    }
  }
  return { added, updated };
}
