/** Append-only admin audit log (SPEC "Insider risk": every admin lookup is logged). */
import type { AdminAuditEntry } from "@zerofee/protocol";
import { iso, type PgDriver, type Row, toInt, toJson, toMs, toStrOrNull } from "./driver";

export interface AuditWrite {
  at: number;
  actor: string;
  action: string;
  target?: string | null;
  ip?: string | null;
  userAgentHash?: string | null;
  ok: boolean;
  detail?: Record<string, unknown>;
}

function mapEntry(r: Row): AdminAuditEntry {
  return {
    id: toInt(r.id),
    at: toMs(r.at),
    actor: String(r.actor),
    action: String(r.action),
    target: toStrOrNull(r.target),
    ip: toStrOrNull(r.ip),
    ok: r.ok === true,
    detail: toJson<Record<string, unknown>>(r.detail) ?? {},
  };
}

export class AuditRepo {
  constructor(private readonly db: PgDriver) {}

  async append(e: AuditWrite): Promise<AdminAuditEntry> {
    const rows = await this.db.query(
      `INSERT INTO admin_audit_log (at, actor, action, target, ip, user_agent_hash, ok, detail)
       VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8::text::jsonb)
       RETURNING id, at, actor, action, target, ip, ok, detail`,
      [iso(e.at), e.actor, e.action, e.target ?? null, e.ip ?? null, e.userAgentHash ?? null, e.ok, JSON.stringify(e.detail ?? {})],
    );
    return mapEntry(rows[0] as Row);
  }

  /** Newest first; `beforeId` pages backwards. */
  async list(limit: number, beforeId?: number): Promise<AdminAuditEntry[]> {
    const rows =
      beforeId === undefined
        ? await this.db.query("SELECT id, at, actor, action, target, ip, ok, detail FROM admin_audit_log ORDER BY id DESC LIMIT $1", [
            limit,
          ])
        : await this.db.query(
            "SELECT id, at, actor, action, target, ip, ok, detail FROM admin_audit_log WHERE id < $2 ORDER BY id DESC LIMIT $1",
            [limit, beforeId],
          );
    return rows.map(mapEntry);
  }

  /** The latest successful halt or resume: the kill switch survives restarts. */
  async lastHaltChange(): Promise<AdminAuditEntry | null> {
    const rows = await this.db.query(
      `SELECT id, at, actor, action, target, ip, ok, detail FROM admin_audit_log
       WHERE action IN ('halt', 'resume') AND ok ORDER BY id DESC LIMIT 1`,
    );
    return rows[0] ? mapEntry(rows[0]) : null;
  }
}
