/** Tiny isomorphic JSON-RPC-over-fetch helper for relay endpoints (Sender, Jito). */

export interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  /** HTTP status and selected headers (Jito returns the bundle id in `x-bundle-id`). */
  status: number;
  headers: Headers;
}

let nextId = 1;

export async function postJsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  opts: { headers?: Record<string, string>; signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<JsonRpcResponse<T>> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    signal: opts.signal,
  });
  let body: { result?: T; error?: JsonRpcResponse<T>["error"] } = {};
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { code: res.status, message: text.slice(0, 300) } };
    }
  }
  if (!res.ok && !body.error) body.error = { code: res.status, message: `HTTP ${res.status}` };
  return { result: body.result, error: body.error, status: res.status, headers: res.headers };
}
