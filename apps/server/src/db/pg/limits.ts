/**
 * Per-user caps (protocol USER_LIMITS). Inserts that grow a capped list run in a transaction that
 * first locks the user row, inserts, then counts: concurrent requests from one user serialize, and an
 * insert that overshoots rolls back with LimitExceededError (HTTP 422 "limit_exceeded").
 */
import { type Queryable, toInt } from "./driver";

export class LimitExceededError extends Error {
  constructor(
    readonly what: string,
    readonly limit: number,
  ) {
    super(`limit reached: at most ${limit} ${what}`);
    this.name = "LimitExceededError";
  }
}

/** SELECT ... FOR UPDATE on the user row: serializes capped inserts per user. */
export async function lockUser(tx: Queryable, userId: string): Promise<void> {
  await tx.query("SELECT id FROM users WHERE id = $1::uuid FOR UPDATE", [userId]);
}

/** Throws LimitExceededError when `table` holds more than `limit` rows for the user (`where` narrows it). */
export async function assertWithinLimit(
  tx: Queryable,
  table: string,
  userId: string,
  limit: number,
  what: string,
  where = "",
  params: unknown[] = [],
): Promise<void> {
  const rows = await tx.query(`SELECT count(*) AS n FROM ${table} WHERE user_id = $1::uuid ${where}`, [userId, ...params]);
  if (toInt(rows[0]?.n ?? 0) > limit) throw new LimitExceededError(what, limit);
}
