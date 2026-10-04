/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291). The `web-push`
 * package (verified under Bun 1.3: its payloads decrypt with an independent WebCrypto implementation,
 * test/alerts.test.ts) builds the encrypted body and VAPID headers; the request goes out through
 * fetch, so it can be mocked and never follows redirects.
 *
 * Keys: `bun run --cwd apps/server vapid-keys` prints VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. The public
 * key is served at GET /api/push/vapid-public-key for pushManager.subscribe({ applicationServerKey }).
 *
 * The browser hands us the endpoint URL, so the server would POST wherever a user points it: only
 * https endpoints on the known push services are accepted (SSRF guard), checked again before sending.
 */
import type { AlertPriority, PushPayload } from "@zerofee/protocol";
import webpush from "web-push";
import type { PushTarget } from "../db/pg/notify";
import { type OutboundMessage, retryAfterMs, SEND_TIMEOUT_MS, type SendResult, type Transport } from "./types";

/** Push services of Chrome/Edge/Android (FCM), Firefox (Mozilla autopush), Windows (WNS) and Safari (APNs). */
const PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password || endpoint.length > 1_024) return false;
  return PUSH_HOST_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
}

/** Key material from PushSubscription.toJSON(): p256dh = 65-byte P-256 point, auth = 16 bytes, base64url. */
export function validPushKeys(p256dh: string, auth: string): boolean {
  const dec = (s: string) => (/^[A-Za-z0-9_-]+={0,2}$/.test(s) ? new Uint8Array(Buffer.from(s, "base64url")) : null);
  const k = dec(p256dh);
  const a = dec(auth);
  return k?.length === 65 && k[0] === 4 && a?.length === 16;
}

const TTL: Record<AlertPriority, number> = { high: 300, normal: 3_600, low: 86_400 };

/** Topic header: 32 URL-safe base64 characters at most; same topic = the newer message replaces the older. */
function topicFor(tag: string): string {
  return Buffer.from(new Bun.CryptoHasher("sha256").update(tag).digest()).toString("base64url").slice(0, 32);
}

export interface PushTransportOptions {
  publicKey: string;
  privateKey: string;
  subject: string;
  fetchFn?: typeof fetch;
}

export class PushTransport implements Transport<"push"> {
  readonly kind = "push" as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: PushTransportOptions) {
    this.fetchFn = o.fetchFn ?? fetch;
  }

  get publicKey(): string {
    return this.o.publicKey;
  }

  /** Builds the encrypted request (exposed for tests that decrypt it). */
  build(target: Pick<PushTarget, "endpoint" | "p256dh" | "auth">, msg: OutboundMessage) {
    const payload: PushPayload = { title: msg.title, body: msg.body, url: msg.url, tag: msg.tag, priority: msg.priority, ts: msg.ts };
    let json = JSON.stringify(payload);
    if (json.length > 3_000) json = JSON.stringify({ ...payload, body: `${payload.body.slice(0, 2_000)}…` });
    return webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, json, {
      vapidDetails: { subject: this.o.subject, publicKey: this.o.publicKey, privateKey: this.o.privateKey },
      TTL: TTL[msg.priority],
      urgency: msg.priority,
      topic: topicFor(msg.tag),
      contentEncoding: "aes128gcm",
    });
  }

  async send(target: PushTarget, msg: OutboundMessage): Promise<SendResult> {
    if (!isAllowedPushEndpoint(target.endpoint)) return { ok: false, error: "push endpoint not allowed", permanent: true };
    let r: Response;
    try {
      const req = this.build(target, msg);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v);
      r = await this.fetchFn(req.endpoint, {
        method: "POST",
        headers,
        body: req.body ? new Uint8Array(req.body) : null,
        redirect: "error",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.status >= 200 && r.status < 300) return { ok: true };
    if (r.status === 404 || r.status === 410) return { ok: false, error: `subscription gone (${r.status})`, permanent: true };
    // 403: the subscription belongs to another application server key (VAPID key changed).
    if (r.status === 403) return { ok: false, error: "push service rejected our VAPID key for this subscription", permanent: true };
    if (r.status === 429)
      return { ok: false, error: "rate limited by the push service", retryAfterMs: retryAfterMs(r.headers.get("retry-after")) ?? 5_000 };
    return { ok: false, error: `push service HTTP ${r.status}` };
  }
}

/** New VAPID key pair (base64url), as printed by scripts/generate-vapid-keys.ts. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
