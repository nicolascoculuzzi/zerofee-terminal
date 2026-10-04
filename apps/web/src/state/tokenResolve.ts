/**
 * Opening a token the live set doesn't hold (pasted mint, shared link, a coin the server pruned): the gateway
 * reads it from chain on GET /api/tokens/:mint (packages/protocol rest.ts TokenResponse / TokenNotFoundBody).
 * Only a definitive answer ends the wait: 404 with a reason ("not_a_token", "no_venue") or 400 (malformed). A
 * "not_a_token" address the server read as a wallet (`account: "wallet"`) comes back as "wallet".
 * 429 / 503 / network errors are retried (Retry-After, else a growing backoff) while the page stays open.
 */
import type { TokenNotFoundBody, TokenResponse } from "@zerofee/protocol";
import { ApiError, api } from "../services/live/api";

/** "wallet": not a token, a wallet (a System-owned account): the page offers the wallet view. */
export type MissingReason = "not_a_token" | "wallet" | "no_venue" | "invalid" | "not_found";

export type ResolveAnswer =
  | { kind: "found"; response: TokenResponse }
  | { kind: "missing"; reason: MissingReason; redirect: string | null }
  | { kind: "retry"; afterMs: number };

const BACKOFF_MS = [1_500, 3_000, 5_000, 8_000, 12_000];

/** One GET /api/tokens/:mint, mapped to found / definitive missing / retry. */
export async function askServer(mint: string, attempt: number, signal?: AbortSignal): Promise<ResolveAnswer> {
  const backoff = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] as number;
  try {
    const response = await api<TokenResponse>(`/api/tokens/${encodeURIComponent(mint)}`, { signal });
    return { kind: "found", response };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e; // aborted
    if (e.status === 400) return { kind: "missing", reason: "invalid", redirect: null };
    if (e.status === 404) {
      const b = (e.body ?? {}) as Partial<TokenNotFoundBody>;
      const reason: MissingReason =
        b.reason === "not_a_token" && b.account === "wallet"
          ? "wallet"
          : b.reason === "not_a_token" || b.reason === "no_venue"
            ? b.reason
            : "not_found";
      return { kind: "missing", reason, redirect: typeof b.redirect === "string" && b.redirect !== mint ? b.redirect : null };
    }
    const ra = Number((e.body as { retryAfterSec?: unknown } | null)?.retryAfterSec);
    return { kind: "retry", afterMs: Number.isFinite(ra) && ra > 0 ? Math.max(backoff, ra * 1000) : backoff };
  }
}

export interface ResolveLoopOptions {
  ask?: typeof askServer;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called with the final answer (found or missing); never after `signal` aborts. */
  onDone(answer: Exclude<ResolveAnswer, { kind: "retry" }>): void;
  /** Each retry (the page keeps saying "Loading from chain…"). */
  onRetry?(attempt: number): void;
  signal: AbortSignal;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** Asks until the server gives a definitive answer, or the page goes away. */
export async function resolveLoop(mint: string, o: ResolveLoopOptions): Promise<void> {
  const ask = o.ask ?? askServer;
  const sleep = o.sleep ?? abortableSleep;
  for (let attempt = 0; !o.signal.aborted; attempt++) {
    let a: ResolveAnswer;
    try {
      a = await ask(mint, attempt, o.signal);
    } catch {
      return; // aborted
    }
    if (o.signal.aborted) return;
    if (a.kind !== "retry") {
      o.onDone(a);
      return;
    }
    o.onRetry?.(attempt + 1);
    await sleep(a.afterMs, o.signal);
  }
}
