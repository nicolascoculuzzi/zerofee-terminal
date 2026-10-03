/**
 * Presets, settings, watchlist and blacklists. Values arrive validated by the API layer
 * (api/validate.ts); this layer only stores and reads them.
 */
import type { BlacklistEntry, BlacklistKind, PresetSlot, WatchlistEntry } from "@zerofee/protocol";
import { iso, type PgDriver, type Row, toInt, toJson, toMs } from "./driver";
import { assertWithinLimit, lockUser } from "./limits";

export interface StoredPreset {
  slot: PresetSlot;
  name: string;
  config: unknown;
  updatedAt: number;
}

function mapBlacklist(r: Row): BlacklistEntry {
  return { kind: String(r.kind) as BlacklistKind, value: String(r.value), note: String(r.note), addedAt: toMs(r.added_at) };
}

export class PrefsRepo {
  constructor(private readonly db: PgDriver) {}

  // presets ------------------------------------------------------------------------------------

  async listPresets(userId: string): Promise<StoredPreset[]> {
    const rows = await this.db.query("SELECT slot, name, config, updated_at FROM presets WHERE user_id = $1::uuid ORDER BY slot", [userId]);
    return rows.map((r) => ({
      slot: toInt(r.slot) as PresetSlot,
      name: String(r.name),
      config: toJson(r.config),
      updatedAt: toMs(r.updated_at),
    }));
  }

  async putPreset(userId: string, slot: PresetSlot, name: string, config: unknown, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO presets (user_id, slot, name, config, updated_at) VALUES ($1::uuid, $2, $3, $4::text::jsonb, $5::timestamptz)
       ON CONFLICT (user_id, slot) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config, updated_at = EXCLUDED.updated_at`,
      [userId, slot, name, JSON.stringify(config), iso(now)],
    );
  }

  // settings -----------------------------------------------------------------------------------

  async getSettings(userId: string): Promise<unknown | null> {
    const rows = await this.db.query("SELECT data FROM settings WHERE user_id = $1::uuid", [userId]);
    return rows[0] ? toJson(rows[0].data) : null;
  }

  async putSettings(userId: string, data: unknown, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (user_id, data, updated_at) VALUES ($1::uuid, $2::text::jsonb, $3::timestamptz)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [userId, JSON.stringify(data), iso(now)],
    );
  }

  /** Notification channel preferences of many users at once (alert routing). */
  async settingsOf(userIds: string[]): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    if (!userIds.length) return out;
    const rows = await this.db.query(
      "SELECT s.user_id, s.data FROM settings s JOIN jsonb_array_elements_text($1::text::jsonb) AS u(id) ON s.user_id = u.id::uuid",
      [JSON.stringify(userIds)],
    );
    for (const r of rows) out.set(String(r.user_id), toJson(r.data));
    return out;
  }

  // watchlist ----------------------------------------------------------------------------------

  async listWatchlist(userId: string): Promise<WatchlistEntry[]> {
    const rows = await this.db.query("SELECT mint, added_at FROM watchlist WHERE user_id = $1::uuid ORDER BY added_at DESC, mint", [
      userId,
    ]);
    return rows.map((r) => ({ mint: String(r.mint), addedAt: toMs(r.added_at) }));
  }

  /** Idempotent: re-adding keeps the original addedAt. */
  async addWatch(userId: string, mint: string, now: number, max: number): Promise<WatchlistEntry> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO watchlist (user_id, mint, added_at) VALUES ($1::uuid, $2, $3::timestamptz)
         ON CONFLICT (user_id, mint) DO UPDATE SET mint = EXCLUDED.mint
         RETURNING mint, added_at`,
        [userId, mint, iso(now)],
      );
      await assertWithinLimit(tx, "watchlist", userId, max, "watchlist tokens");
      const r = rows[0] as Row;
      return { mint: String(r.mint), addedAt: toMs(r.added_at) };
    });
  }

  async removeWatch(userId: string, mint: string): Promise<boolean> {
    return (await this.db.query("DELETE FROM watchlist WHERE user_id = $1::uuid AND mint = $2 RETURNING mint", [userId, mint])).length > 0;
  }

  // blacklists ---------------------------------------------------------------------------------

  async listBlacklists(userId: string): Promise<BlacklistEntry[]> {
    const rows = await this.db.query(
      "SELECT kind, value, note, added_at FROM blacklists WHERE user_id = $1::uuid ORDER BY kind, added_at DESC, value",
      [userId],
    );
    return rows.map(mapBlacklist);
  }

  /** Idempotent; a given note replaces the stored one. */
  async addBlacklist(
    userId: string,
    kind: BlacklistKind,
    value: string,
    note: string | undefined,
    now: number,
    max: number,
  ): Promise<BlacklistEntry> {
    return this.db.transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.query(
        `INSERT INTO blacklists (user_id, kind, value, note, added_at) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (user_id, kind, value) DO UPDATE SET note = CASE WHEN $6 THEN EXCLUDED.note ELSE blacklists.note END
         RETURNING kind, value, note, added_at`,
        [userId, kind, value, note ?? "", iso(now), note !== undefined],
      );
      await assertWithinLimit(tx, "blacklists", userId, max, `${kind} blacklist entries`, "AND kind = $2", [kind]);
      return mapBlacklist(rows[0] as Row);
    });
  }

  async removeBlacklist(userId: string, kind: BlacklistKind, value: string): Promise<boolean> {
    const rows = await this.db.query("DELETE FROM blacklists WHERE user_id = $1::uuid AND kind = $2 AND value = $3 RETURNING value", [
      userId,
      kind,
      value,
    ]);
    return rows.length > 0;
  }
}
