/**
 * Telegram: a bot (TELEGRAM_BOT_TOKEN) that users link to their account, then alert delivery through
 * the Bot API's sendMessage.
 *
 * Linking: POST /api/notifications/telegram/link returns https://t.me/<bot>?start=<code>, a one-time
 * code valid for 10 minutes (only its SHA-256 is stored). Opening it and pressing Start makes Telegram
 * send `/start <code>` to the bot, which binds that chat to the account. `/stop` unlinks the chat.
 * Updates arrive by long polling (getUpdates) or, when TELEGRAM_WEBHOOK_SECRET is set, by webhook at
 * POST /api/telegram/webhook with the secret in X-Telegram-Bot-Api-Secret-Token (constant-time check).
 *
 * Messages are plain text (no parse_mode, so nothing in a token name is interpreted as markup) with
 * link previews off. Limits (dispatcher): about 1 message/s per chat and 30/s for the whole bot;
 * 429 `retry_after` is honoured, 403 (blocked, kicked) disables the chat.
 * The bot token is a secret: it only appears in request URLs, never in logs.
 */
import type { TelegramLinkResponse } from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import { logger } from "../log";
import { constantTimeEqual, sha256Hex } from "../util/hash";
import { shortAddress } from "./format";
import { type OutboundMessage, SEND_TIMEOUT_MS, type SendResult, type Transport } from "./types";

const log = logger("telegram");

export const TELEGRAM_LINK_TTL_MS = 10 * 60_000;
const API = "https://api.telegram.org";

type TgResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Error text with the bot token removed (the token is part of every request URL). */
  private redact(e: unknown): Error {
    const text = e instanceof Error ? `${e.name === "Error" ? "" : `${e.name}: `}${e.message}` : String(e);
    return new Error(text.replaceAll(this.token, "<bot-token>"));
  }

  async call<T>(method: string, body: Record<string, unknown>, timeoutMs = SEND_TIMEOUT_MS, signal?: AbortSignal): Promise<TgResponse<T>> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let r: Response;
    try {
      r = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      // Bun's fetch errors carry the full URL (token included) in `path`: never let them escape.
      throw this.redact(e);
    }
    const j = (await r.json().catch(() => null)) as TgResponse<T> | null;
    if (!j || typeof j !== "object" || typeof j.ok !== "boolean")
      return { ok: false, error_code: r.status, description: `HTTP ${r.status}` };
    return j;
  }
}

export function formatTelegram(msg: OutboundMessage): string {
  const text = `${msg.title}\n${msg.body}${msg.url ? `\n${msg.url}` : ""}`;
  return text.length > 4_000 ? `${text.slice(0, 3_999)}…` : text;
}

export class TelegramTransport implements Transport<"telegram"> {
  readonly kind = "telegram" as const;

  constructor(private readonly api: TelegramApi) {}

  async send(target: { chatId: string }, msg: OutboundMessage): Promise<SendResult> {
    let r: TgResponse<unknown>;
    try {
      r = await this.api.call("sendMessage", {
        chat_id: target.chatId,
        text: formatTelegram(msg),
        link_preview_options: { is_disabled: true },
        disable_notification: msg.priority === "low",
      });
    } catch (e) {
      return { ok: false, error: `network: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.ok) return { ok: true };
    if (r.error_code === 429) {
      return { ok: false, error: "rate limited by Telegram", retryAfterMs: (r.parameters?.retry_after ?? 1) * 1000 };
    }
    if (r.error_code === 403 || (r.error_code === 400 && /chat not found|user is deactivated|bot was kicked/i.test(r.description))) {
      return { ok: false, error: `Telegram refused: ${r.description}`, permanent: true };
    }
    return { ok: false, error: `Telegram ${r.error_code}: ${r.description}` };
  }
}

interface TgChat {
  id: number | string;
  type?: string;
  username?: string;
  title?: string;
  first_name?: string;
}
interface TgUpdate {
  update_id: number;
  message?: { chat?: TgChat; text?: string };
}

export interface TelegramBotOptions {
  api: TelegramApi;
  store: UserStore;
  username?: string | null;
  now?: () => number;
  /** Called after a chat is linked or unlinked (dispatcher target cache). */
  onChange?: (userIds: string[]) => void;
}

export class TelegramBot {
  private botName: string | null;
  private readonly now: () => number;
  private polling: AbortController | null = null;
  private offset = 0;
  private readonly helpSent = new Map<string, number>();
  readonly stats = { updates: 0, linked: 0, unlinked: 0, pollErrors: 0 };

  constructor(private readonly o: TelegramBotOptions) {
    this.botName = o.username ?? null;
    this.now = o.now ?? Date.now;
  }

  /** The bot's @username (TELEGRAM_BOT_USERNAME, else getMe once). */
  async username(): Promise<string> {
    if (this.botName) return this.botName;
    const r = await this.o.api.call<{ username?: string }>("getMe", {});
    if (!r.ok || !r.result.username) throw new Error("Telegram getMe failed: set TELEGRAM_BOT_USERNAME");
    this.botName = r.result.username;
    return this.botName;
  }

  /** A one-time deep link that binds the chat which presses Start to this user. */
  async createLink(userId: string, maxChannels: number): Promise<TelegramLinkResponse> {
    const name = await this.username();
    const code = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
    const expiresAt = this.now() + TELEGRAM_LINK_TTL_MS;
    const channelId = await this.o.store.notify.createTelegramLink(userId, sha256Hex(code), expiresAt, this.now(), maxChannels);
    return { channelId, code, url: `https://t.me/${name}?start=${code}`, expiresAt };
  }

  private async reply(chatId: string, text: string): Promise<void> {
    const r = await this.o.api.call("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } }).catch((e) => e);
    if (r instanceof Error || !r.ok) log.debug(`reply to a chat failed: ${r instanceof Error ? r.message : r.description}`);
  }

  /** Handles one update (from polling or the webhook). Only /start <code>, /stop and /help do anything. */
  async handleUpdate(raw: unknown): Promise<void> {
    const u = raw as TgUpdate;
    if (!u || typeof u !== "object") return;
    this.stats.updates++;
    if (typeof u.update_id === "number") this.offset = Math.max(this.offset, u.update_id + 1);
    const chat = u.message?.chat;
    const text = u.message?.text?.trim();
    if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string") || !text) return;
    const chatId = String(chat.id);
    const m = /^\/(start|stop|help)(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (!m) return this.help(chatId, chat);
    const [, cmd, arg] = m;
    const now = this.now();
    if (cmd === "start" && arg && /^[A-Za-z0-9_-]{8,64}$/.test(arg)) {
      const label = chat.username ? `@${chat.username}` : (chat.title ?? chat.first_name ?? "Telegram chat").slice(0, 64);
      const linked = await this.o.store.notify.consumeTelegramLink(sha256Hex(arg), chatId, label, now);
      if (linked) {
        this.stats.linked++;
        this.o.onChange?.([linked.userId]);
        return this.reply(
          chatId,
          `Linked to zerofee account ${shortAddress(linked.wallet)}. Alerts you route to Telegram will arrive here. Send /stop to unlink.`,
        );
      }
      return this.reply(chatId, "That link code is invalid or expired. Create a new one in zerofee Settings > Notifications.");
    }
    if (cmd === "stop") {
      const users = await this.o.store.notify.disableTelegramChat(chatId, "unlinked with /stop", now);
      if (users.length) {
        this.stats.unlinked++;
        this.o.onChange?.(users);
      }
      return this.reply(chatId, users.length ? "Unlinked. You will not get zerofee alerts here any more." : "This chat is not linked.");
    }
    return this.help(chatId, chat);
  }

  /** At most one help reply per chat per 10 minutes (the bot must not be a spam reflector). */
  private async help(chatId: string, chat: TgChat): Promise<void> {
    if (chat.type && chat.type !== "private") return;
    const now = this.now();
    if ((this.helpSent.get(chatId) ?? 0) > now - 600_000) return;
    this.helpSent.set(chatId, now);
    if (this.helpSent.size > 10_000) this.helpSent.clear();
    await this.reply(chatId, "This bot delivers zerofee alerts. Link it from zerofee Settings > Notifications > Telegram.");
  }

  /** True when the webhook header carries our secret. */
  static checkWebhookSecret(req: Request, secret: string): boolean {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    return got !== null && constantTimeEqual(got, secret);
  }

  /** Long polling (no public URL needed). Stops with stopPolling(). */
  startPolling(): void {
    if (this.polling) return;
    const ctl = new AbortController();
    this.polling = ctl;
    void (async () => {
      let backoff = 1_000;
      while (!ctl.signal.aborted) {
        try {
          const r = await this.o.api.call<TgUpdate[]>(
            "getUpdates",
            { offset: this.offset, timeout: 25, allowed_updates: ["message"] },
            35_000,
            ctl.signal,
          );
          if (!r.ok) throw new Error(`getUpdates ${r.error_code}: ${r.description}`);
          for (const u of r.result)
            await this.handleUpdate(u).catch((e) => log.warn(`update failed: ${e instanceof Error ? e.message : e}`));
          backoff = 1_000;
        } catch (e) {
          if (ctl.signal.aborted) break;
          this.stats.pollErrors++;
          log.warn(`polling failed, retrying in ${backoff / 1000}s: ${e instanceof Error ? e.message : e}`);
          await Bun.sleep(backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  stopPolling(): void {
    this.polling?.abort();
    this.polling = null;
  }
}
