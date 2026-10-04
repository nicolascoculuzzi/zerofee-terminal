/**
 * Discord webhook delivery. Only https://discord.com/api/webhooks/<id>/<token> (or discordapp.com,
 * optionally with an /api/v<N>/ version segment) is accepted, so a user-supplied URL can never make
 * the server call anything else; it is normalized before storage and stored encrypted (secretBox.ts).
 * Requests never follow redirects. Messages are embeds with markdown escaped and
 * `allowed_mentions: { parse: [] }`, so a coin named "@everyone" pings nobody.
 * Rate limit: about 30 messages per minute per webhook (dispatcher); 429 `retry_after` is honoured.
 */
import { escapeDiscord } from "./format";
import { type OutboundMessage, retryAfterMs, SEND_TIMEOUT_MS, type SendResult, type Transport } from "./types";

const HOSTS = new Set(["discord.com", "discordapp.com"]);
const PATH = /^\/api\/(?:v\d{1,2}\/)?webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{50,100})$/;

export interface DiscordWebhook {
  /** Canonical https://discord.com/api/webhooks/<id>/<token>. */
  url: string;
  id: string;
}

/** Validates and normalizes a webhook URL; null for anything that is not a Discord webhook. */
export function parseDiscordWebhook(input: string): DiscordWebhook | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname) || u.port || u.username || u.password || u.search || u.hash) return null;
  const m = PATH.exec(u.pathname);
  if (!m) return null;
  return { url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}`, id: m[1] as string };
}

/** Display form: enough to recognize, useless to post with. */
export function maskWebhook(w: DiscordWebhook): string {
  const token = w.url.slice(w.url.lastIndexOf("/") + 1);
  return `discord.com/api/webhooks/${w.id.slice(0, 6)}…/…${token.slice(-4)}`;
}

const COLORS = { high: 0xe5484d, normal: 0x3e63dd, low: 0x8b8d98 } as const;

export class DiscordTransport implements Transport<"discord"> {
  readonly kind = "discord" as const;

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async send(target: { id: string; url: string }, msg: OutboundMessage): Promise<SendResult> {
    // Defence in depth: the stored URL was validated on the way in; check again on the way out.
    if (!parseDiscordWebhook(target.url)) return { ok: false, error: "not a Discord webhook URL", permanent: true };
    const body = {
      username: "zerofee",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: escapeDiscord(msg.title).slice(0, 256),
          description: escapeDiscord(msg.body).slice(0, 4_000),
          ...(msg.url ? { url: msg.url } : {}),
          color: COLORS[msg.priority],
          timestamp: new Date(msg.ts).toISOString(),
        },
      ],
    };
    let r: Response;
    try {
      r = await this.fetchFn(target.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.ok) return { ok: true };
    if (r.status === 429) {
      const j = (await r.json().catch(() => null)) as { retry_after?: number; global?: boolean } | null;
      const wait = typeof j?.retry_after === "number" ? j.retry_after * 1000 : (retryAfterMs(r.headers.get("retry-after")) ?? 2_000);
      return { ok: false, error: "rate limited by Discord", retryAfterMs: wait, global: j?.global === true };
    }
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      return { ok: false, error: `webhook rejected (${r.status}): deleted or revoked`, permanent: true };
    }
    return { ok: false, error: `Discord HTTP ${r.status}` };
  }
}
