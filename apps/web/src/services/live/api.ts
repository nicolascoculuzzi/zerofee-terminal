/**
 * REST client for the gateway (packages/protocol rest.ts, user.ts, orders.ts, trackers.ts). JSON in and
 * out; errors become ApiError with the server's `{ error, code }`. The session rides in the
 * `__Host-zf_session` cookie (HttpOnly: this code never sees it); mutations carry the page's Origin,
 * which the server checks (CSRF).
 */
import type { ApiErrorBody, ErrorCode } from "@zerofee/protocol";
import { API_ORIGIN, apiUrl } from "../../runtime";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "network",
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Send `body` as-is (already serialized), e.g. bigint-tagged armed-order JSON. */
  rawBody?: string;
  signal?: AbortSignal;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: Fetch = (input, init) => fetch(input, init);

/** Tests swap the transport. */
export function setApiFetch(f: Fetch | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
}

export async function api<T>(path: string, o: ApiOptions = {}): Promise<T> {
  const method = o.method ?? (o.body !== undefined || o.rawBody !== undefined ? "POST" : "GET");
  const init: RequestInit = {
    method,
    credentials: API_ORIGIN ? "include" : "same-origin",
    headers: { accept: "application/json" },
    signal: o.signal,
  };
  if (o.rawBody !== undefined || o.body !== undefined) {
    init.headers = { ...init.headers, "content-type": "application/json" };
    init.body = o.rawBody ?? JSON.stringify(o.body);
  }
  let res: Response;
  try {
    res = await fetchImpl(apiUrl(path), init);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "network", "The server is unreachable. Check your connection.");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const b = body as Partial<ApiErrorBody> | null;
    const code = (b && typeof b === "object" && typeof b.code === "string" ? b.code : "internal") as ErrorCode;
    const message = b && typeof b === "object" && typeof b.error === "string" ? b.error : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message, body);
  }
  return body as T;
}
