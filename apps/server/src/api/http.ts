/** JSON responses, errors and bounded body parsing for the REST API. */
import type { ErrorCode } from "@zerofee/protocol";

export function json(body: unknown, status = 200, headers: Record<string, string> | Headers = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json");
  h.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function apiError(status: number, code: ErrorCode, error: string, headers: Record<string, string> = {}): Response {
  return json({ error, code }, status, headers);
}

export const ok = (headers?: Headers): Response => json({ ok: true }, 200, headers);

/** Thrown by handlers and validators; becomes `{ error, code }` with `status`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, "bad_request", message);
export const notFound = (message = "not found"): HttpError => new HttpError(404, "not_found", message);

/** Default cap for JSON bodies; the import endpoint raises it. Bun.serve caps every body at 4 MiB. */
export const DEFAULT_BODY_LIMIT = 64 * 1024;

/** Reads and parses a JSON body of at most `maxBytes` (UTF-8). Empty bodies parse as `{}`. */
export async function readJson(req: Request, maxBytes = DEFAULT_BODY_LIMIT): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "bad_request", `body too large (max ${maxBytes} bytes)`);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw new HttpError(413, "bad_request", `body too large (max ${maxBytes} bytes)`);
  if (buf.length === 0) return {};
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw badRequest("body is not valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("invalid JSON");
  }
}
