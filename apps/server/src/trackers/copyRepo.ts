/**
 * Copy-trading persistence (migration v2): copy_tasks (config, server-kept positions, counters) and
 * copy_signals (every signal pushed plus a rate-limited log of skipped leader trades). Same driver rules
 * as db/pg (portable across PGlite and Bun.sql): JSON in through `::text::jsonb`, timestamps as ISO.
 */
import type { CopySignal, CopySignalStatus, CopyTaskConfig, CopyTaskStatus } from "@zerofee/protocol";
import { iso, type PgDriver, type Row, toInt, toJson, toMs, toMsOrNull, toStrOrNull } from "../db/pg/driver";
import { assertWithinLimit, lockUser } from "../db/pg/limits";

/** An open copy position as stored in copy_tasks.state. */
export interface StoredPosition {
  mint: string;
  symbol: string;
  tokens: string;
  costSol: number;
  buys: number;
  openedAt: number;
  realizedPnlSol: number;
  /** Estimated leader balance in the token (base units), for proportional copy sells. */
  leaderTokens: string | null;
}

export interface StoredState {
  positions: StoredPosition[];
}

/** Decision counters as stored in copy_tasks.stats (lifetime of the task). */
export interface StoredStats {
  buySignals: number;
  sellSignals: number;
  executed: number;
  failed: number;
  declined: number;
  expired: number;
  revoked: number;
  skipped: number;
  skippedByReason: Record<string, number>;
  realizedPnlSol: number;
  lastSignalAt: number | null;
}

export const emptyStats = (): StoredStats => ({
  buySignals: 0,
  sellSignals: 0,
  executed: 0,
  failed: 0,
  declined: 0,
  expired: 0,
  revoked: 0,
  skipped: 0,
  skippedByReason: {},
  realizedPnlSol: 0,
  lastSignalAt: null,
});

export interface CopyTaskRow {
  id: string;
  userId: string;
  leader: string;
  label: string;
  status: CopyTaskStatus;
  pausedReason: string | null;
  config: CopyTaskConfig;
  state: StoredState;
  stats: StoredStats;
  createdAt: number;
  updatedAt: number;
}

export interface TaskSpend {
  spentSol: number;
  spentTodaySol: number;
  buysToday: number;
}

const TASK_COLS = "id, user_id, leader, label, status, paused_reason, config, state, stats, created_at, updated_at";

function mapTask(r: Row): CopyTaskRow {
  const state = toJson<Partial<StoredState> | null>(r.state) ?? {};
  const stats = toJson<Partial<StoredStats> | null>(r.stats) ?? {};
  return {
    id: String(r.id),
    userId: String(r.user_id),
    leader: String(r.leader),
    label: String(r.label),
    status: String(r.status) as CopyTaskStatus,
    pausedReason: toStrOrNull(r.paused_reason),
    config: toJson<CopyTaskConfig>(r.config),
    state: { positions: Array.isArray(state.positions) ? state.positions : [] },
    stats: { ...emptyStats(), ...stats, skippedByReason: { ...(stats.skippedByReason ?? {}) } },
    createdAt: toMs(r.created_at),
    updatedAt: toMs(r.updated_at),
  };
}

function mapSignal(r: Row): CopySignal {
  const detail = toJson<CopySignal>(r.detail);
  return {
    ...detail,
    id: String(r.id),
    taskId: String(r.task_id),
    status: String(r.status) as CopySignalStatus,
    reason: toStrOrNull(r.reason),
    signature: toStrOrNull(r.signature),
    filledSol: r.filled_sol === null || r.filled_sol === undefined ? null : Number(r.filled_sol),
    filledTokens: toStrOrNull(r.filled_tokens),
    confirmed: r.confirmed === true,
    resolvedAt: toMsOrNull(r.resolved_at),
  };
}

export class CopyRepo {
  constructor(private readonly db: PgDriver) {}

  // tasks --------------------------------------------------------------------------------------

  /** Every task (start-up), or one user's. */
  async listTasks(userId?: string): Promise<CopyTaskRow[]> {
    const rows = userId
      ? await this.db.query(`SELECT ${TASK_COLS} FROM copy_tasks WHERE user_id = $1::uuid ORDER BY created_at, id`, [userId])
      : await this.db.query(`SELECT ${TASK_COLS} FROM copy_tasks ORDER BY created_at, id`);
    return rows.map(mapTask);
  }

  async getTask(userId: string, id: string): Promise<CopyTaskRow | null> {
    const rows = await this.db.query(`SELECT ${TASK_COLS} FROM copy_tasks WHERE user_id = $1::uuid AND id = $2::uuid`, [userId, id]);
    return rows[0] ? mapTask(rows[0]) : null;
  }

  /** Creates a task; the per-user cap rolls the insert back (LimitExceededError), a second task on one leader is a 409. */
  async createTask(
    userId: string,
    t: { leader: string; label: string; status: CopyTaskStatus; config: CopyTaskConfig },
    now: number,
    max: number,
  ): Promise<CopyTaskRow> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO copy_tasks (id, user_id, leader, label, status, paused_reason, config, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text::jsonb, $8::timestamptz, $8::timestamptz)
         RETURNING ${TASK_COLS}`,
        [
          crypto.randomUUID(),
          userId,
          t.leader,
          t.label,
          t.status,
          t.status === "paused" ? "user" : null,
          JSON.stringify(t.config),
          iso(now),
        ],
      );
      await assertWithinLimit(tx, "copy_tasks", userId, max, "copy tasks");
      return mapTask(rows[0] as Row);
    });
  }

  async updateTask(
    userId: string,
    id: string,
    patch: { label?: string; config?: CopyTaskConfig; status?: CopyTaskStatus; pausedReason?: string | null },
    now: number,
  ): Promise<CopyTaskRow | null> {
    const sets: string[] = ["updated_at = $3::timestamptz"];
    const params: unknown[] = [userId, id, iso(now)];
    const add = (col: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.label !== undefined) add("label", patch.label);
    if (patch.config !== undefined) add("config", JSON.stringify(patch.config), "::text::jsonb");
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.pausedReason !== undefined) add("paused_reason", patch.pausedReason);
    const rows = await this.db.query(
      `UPDATE copy_tasks SET ${sets.join(", ")} WHERE user_id = $1::uuid AND id = $2::uuid RETURNING ${TASK_COLS}`,
      params,
    );
    return rows[0] ? mapTask(rows[0]) : null;
  }

  async deleteTask(userId: string, id: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM copy_tasks WHERE user_id = $1::uuid AND id = $2::uuid RETURNING id", [userId, id]);
    return rows.length > 0;
  }

  async saveState(id: string, state: StoredState): Promise<void> {
    await this.db.query("UPDATE copy_tasks SET state = $2::text::jsonb WHERE id = $1::uuid", [id, JSON.stringify(state)]);
  }

  async saveStats(id: string, stats: StoredStats): Promise<void> {
    await this.db.query("UPDATE copy_tasks SET stats = $2::text::jsonb WHERE id = $1::uuid", [id, JSON.stringify(stats)]);
  }

  // signals ------------------------------------------------------------------------------------

  async insertSignal(userId: string, s: CopySignal, keySignature: string): Promise<void> {
    await this.db.query(
      `INSERT INTO copy_signals (id, task_id, user_id, side, status, reason, mint, leader, leader_signature, leader_slot, size_sol,
                                 filled_sol, filled_tokens, signature, confirmed, detail, created_at, expires_at, resolved_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::text::jsonb,
               $17::timestamptz, $18::timestamptz, $19::timestamptz)`,
      [
        s.id,
        s.taskId,
        userId,
        s.side,
        s.status,
        s.reason,
        s.mint,
        s.leader,
        keySignature,
        s.leaderSlot,
        s.side === "buy" ? s.sizeSol : null,
        s.filledSol,
        s.filledTokens,
        s.signature,
        s.confirmed,
        JSON.stringify(s),
        iso(s.createdAt),
        s.expiresAt === null ? null : iso(s.expiresAt),
        s.resolvedAt === null ? null : iso(s.resolvedAt),
      ],
    );
  }

  /** Writes a signal's mutable fields (status, outcome) from its current wire form. */
  async updateSignal(s: CopySignal): Promise<void> {
    await this.db.query(
      `UPDATE copy_signals SET status = $2, reason = $3, filled_sol = $4, filled_tokens = $5, signature = $6, confirmed = $7,
              resolved_at = $8::timestamptz, detail = $9::text::jsonb
       WHERE id = $1::uuid`,
      [
        s.id,
        s.status,
        s.reason,
        s.filledSol,
        s.filledTokens,
        s.signature,
        s.confirmed,
        s.resolvedAt === null ? null : iso(s.resolvedAt),
        JSON.stringify(s),
      ],
    );
  }

  async getSignal(userId: string, id: string): Promise<CopySignal | null> {
    const rows = await this.db.query(
      `SELECT id, task_id, status, reason, filled_sol, filled_tokens, signature, confirmed, resolved_at, detail
       FROM copy_signals WHERE user_id = $1::uuid AND id = $2::uuid`,
      [userId, id],
    );
    return rows[0] ? mapSignal(rows[0]) : null;
  }

  async listSignals(userId: string, o: { taskId?: string; limit: number }): Promise<CopySignal[]> {
    const rows = o.taskId
      ? await this.db.query(
          `SELECT id, task_id, status, reason, filled_sol, filled_tokens, signature, confirmed, resolved_at, detail
           FROM copy_signals WHERE user_id = $1::uuid AND task_id = $2::uuid ORDER BY created_at DESC, id LIMIT $3`,
          [userId, o.taskId, o.limit],
        )
      : await this.db.query(
          `SELECT id, task_id, status, reason, filled_sol, filled_tokens, signature, confirmed, resolved_at, detail
           FROM copy_signals WHERE user_id = $1::uuid ORDER BY created_at DESC, id LIMIT $2`,
          [userId, o.limit],
        );
    return rows.map(mapSignal);
  }

  /** Spend per task counted against the caps: executed fills (or their reservation) plus pending buys. */
  async spend(dayStart: number): Promise<Map<string, TaskSpend>> {
    const rows = await this.db.query(
      `SELECT task_id,
              sum(CASE WHEN status = 'executed' THEN coalesce(filled_sol, size_sol, 0)
                       WHEN status = 'pending' THEN coalesce(size_sol, 0) ELSE 0 END) AS spent,
              sum(CASE WHEN created_at < $1::timestamptz THEN 0
                       WHEN status = 'executed' THEN coalesce(filled_sol, size_sol, 0)
                       WHEN status = 'pending' THEN coalesce(size_sol, 0) ELSE 0 END) AS spent_today,
              count(*) FILTER (WHERE created_at >= $1::timestamptz AND status IN ('executed', 'pending')) AS buys_today
       FROM copy_signals WHERE side = 'buy' GROUP BY task_id`,
      [iso(dayStart)],
    );
    const out = new Map<string, TaskSpend>();
    for (const r of rows) {
      out.set(String(r.task_id), {
        spentSol: Number(r.spent ?? 0),
        spentTodaySol: Number(r.spent_today ?? 0),
        buysToday: toInt(r.buys_today ?? 0),
      });
    }
    return out;
  }

  /** Start-up: signals left pending by a previous process can no longer be acted on safely. */
  async expirePending(now: number): Promise<number> {
    const rows = await this.db.query(
      `UPDATE copy_signals SET status = 'expired', resolved_at = $1::timestamptz,
              detail = jsonb_set(jsonb_set(detail, '{status}', '"expired"'), '{resolvedAt}', to_jsonb($2::bigint))
       WHERE status = 'pending' RETURNING id`,
      [iso(now), now],
    );
    return rows.length;
  }

  async purgeSkipped(before: number): Promise<number> {
    const rows = await this.db.query("DELETE FROM copy_signals WHERE status = 'skipped' AND created_at < $1::timestamptz RETURNING id", [
      iso(before),
    ]);
    return rows.length;
  }
}
