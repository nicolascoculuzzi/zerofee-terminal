#!/usr/bin/env bun
/**
 * Production-like static server for the live web build, mirroring the Caddy edge (deploy/docker/Caddyfile):
 * precompressed assets (brotli q11 / gzip, chosen by Accept-Encoding), immutable caching for /assets/*,
 * no-cache + ETag revalidation for index.html and the SPA fallback, the edge's security headers including its
 * enforced Content-Security-Policy (read from the Caddyfile, on top of the build's meta tag, as in production),
 * and same-origin /api/* + /ws proxied to the gateway. Use it to measure what a real visitor downloads, instead of `vite preview`.
 *
 *   VITE_DATA_SOURCE=live bun run --cwd apps/web build
 *   bun apps/web/scripts/preview-live.ts [--port 4173] [--host 127.0.0.1] [--gateway http://127.0.0.1:8787] [--dist apps/web/dist]
 *
 * Environment: PORT, HOST, GATEWAY, DIST (flags win). Set the gateway's PUBLIC_ORIGIN to the printed URL so
 * cookie-authenticated requests and WebSocket upgrades pass its Origin check (the browser's Origin is forwarded
 * unchanged). `startPreview()` starts the same server in-process (scripts/perf-load.ts uses it).
 */
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { brotliCompress, gzip as gzipCallback, constants as zlib } from "node:zlib";
import { caddyAppCsp } from "../csp";

export interface PreviewOptions {
  /** 0 picks a free port. Default 4173. */
  port?: number;
  host?: string;
  /** Gateway origin for /api and /ws. Default http://127.0.0.1:8787. */
  gateway?: string;
  /** Build output directory. Default apps/web/dist. */
  dist?: string;
  /** Skip the startup log line. */
  quiet?: boolean;
}

export interface AssetSizes {
  files: number;
  raw: number;
  gzip: number;
  brotli: number;
}

export interface PreviewHandle {
  url: string;
  port: number;
  gateway: string;
  /** JS + CSS under dist/assets: raw and compressed byte totals. */
  sizes: AssetSizes;
  stop(): Promise<void>;
}

interface Entry {
  body: Uint8Array<ArrayBuffer>;
  br: Uint8Array<ArrayBuffer> | null;
  gz: Uint8Array<ArrayBuffer> | null;
  type: string;
  etag: string;
  cache: string;
}

interface WsData {
  upstreamUrl: string;
  headers: Record<string, string>;
  upstream: WebSocket | null;
  pending: (string | Uint8Array)[];
}

const DEFAULT_DIST = fileURLToPath(new URL("../dist", import.meta.url));
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const PUBLIC_FILE = "public, max-age=3600";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};
/** Precompressed at startup. Source maps are skipped (only devtools fetch them). */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".webmanifest", ".txt", ".xml", ".wasm"]);

/** Hop-by-hop headers (RFC 9110 7.6.1) never cross a proxy. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization"];

const CADDYFILE = fileURLToPath(new URL("../../../deploy/docker/Caddyfile", import.meta.url));

/**
 * The edge's enforced Content-Security-Policy for this origin: {$APP_DOMAIN} becomes the preview's host,
 * {$CSP_CONNECT_EXTRA} the environment's value or docker-compose.yml's default. On plain http (loopback) the
 * WebSocket origin is ws: and upgrade-insecure-requests is dropped, since nothing here serves https.
 */
export function edgeCsp(origin: string, connectExtra = process.env.CSP_CONNECT_EXTRA ?? DEFAULT_CSP_CONNECT_EXTRA): string {
  const u = new URL(origin);
  let policy = caddyAppCsp(readFileSync(CADDYFILE, "utf8"))
    .replaceAll("{$APP_DOMAIN}", u.host)
    .replaceAll("{$CSP_CONNECT_EXTRA}", connectExtra);
  if (u.protocol === "http:") {
    policy = policy
      .replaceAll(`wss://${u.host}`, `ws://${u.host}`)
      .split(";")
      .filter((d) => d.trim() !== "upgrade-insecure-requests")
      .join(";");
  }
  return policy.replace(/\s+/g, " ").trim();
}

/** deploy/docker/docker-compose.yml's default for CSP_CONNECT_EXTRA. */
const DEFAULT_CSP_CONNECT_EXTRA = "https://sender.helius-rpc.com https://api.mainnet-beta.solana.com https://api.jup.ag";

/** Response headers the edge sends on every app response (plus the CSP, added per origin in startPreview). */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "same-origin",
  "origin-agent-cluster": "?1",
};

/** Bun's WebSocket client accepts request headers (cookie, origin); the DOM typings only know protocols. */
const BunWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;

/** The gateway's WS_COMPRESSION (default on). */
const WS_COMPRESS = !/^(0|false|no|off)$/i.test(process.env.WS_COMPRESSION?.trim() ?? "");

/** Operator surfaces the edge never exposes (Caddyfile @internal). */
const INTERNAL = /^\/(?:metrics|debug|api\/admin)(?:\/|$)/;

const brotli = promisify(brotliCompress);
const gzip = promisify(gzipCallback);

/** Reads every file in dist and precompresses the text ones, in parallel on the zlib thread pool. */
async function loadDist(dist: string): Promise<{ files: Map<string, Entry>; sizes: AssetSizes }> {
  const files = new Map<string, Entry>();
  const sizes: AssetSizes = { files: 0, raw: 0, gzip: 0, brotli: 0 };
  const jobs: Promise<void>[] = [];
  for (const rel of new Bun.Glob("**/*").scanSync({ cwd: dist, onlyFiles: true })) {
    const path = `/${rel.split("\\").join("/")}`;
    const ext = extname(path).toLowerCase();
    const body = new Uint8Array(readFileSync(join(dist, rel)));
    const hashed = path.startsWith("/assets/");
    const entry: Entry = {
      body,
      br: null,
      gz: null,
      type: TYPES[ext] ?? "application/octet-stream",
      etag: Bun.hash(body).toString(36),
      cache: path === "/index.html" ? REVALIDATE : hashed ? IMMUTABLE : PUBLIC_FILE,
    };
    files.set(path, entry);
    const counted = hashed && (ext === ".js" || ext === ".css");
    if (counted) {
      sizes.files++;
      sizes.raw += body.byteLength;
    }
    if (!COMPRESSIBLE.has(ext) || body.byteLength === 0) {
      if (counted) {
        sizes.gzip += body.byteLength;
        sizes.brotli += body.byteLength;
      }
      continue;
    }
    jobs.push(
      (async () => {
        const [b, g] = await Promise.all([
          brotli(body, {
            params: {
              [zlib.BROTLI_PARAM_QUALITY]: 11,
              [zlib.BROTLI_PARAM_MODE]: ext === ".wasm" ? zlib.BROTLI_MODE_GENERIC : zlib.BROTLI_MODE_TEXT,
              [zlib.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
            },
          }),
          gzip(body, { level: 9 }),
        ]);
        if (b.byteLength < body.byteLength) entry.br = new Uint8Array(b);
        if (g.byteLength < body.byteLength) entry.gz = new Uint8Array(g);
        if (counted) {
          sizes.gzip += (entry.gz ?? body).byteLength;
          sizes.brotli += (entry.br ?? body).byteLength;
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return { files, sizes };
}

/** br > gzip > identity, honouring q=0 exclusions and `*`. */
function pickEncoding(header: string | null): "br" | "gzip" | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q=([\d.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (name) q.set(name, weight);
  }
  const accepts = (enc: string): boolean => (q.get(enc) ?? q.get("*") ?? 0) > 0;
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return null;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => {
    const v = t.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
    // Any encoding variant of the same bytes is still fresh.
    return v === etag || v === `${etag}-br` || v === `${etag}-gz`;
  });
}

function serveFile(req: Request, entry: Entry, cache = entry.cache): Response {
  const enc = pickEncoding(req.headers.get("accept-encoding"));
  const body = enc === "br" && entry.br ? entry.br : enc === "gzip" && entry.gz ? entry.gz : entry.body;
  const suffix = body === entry.br ? "-br" : body === entry.gz ? "-gz" : "";
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", entry.type);
  headers.set("cache-control", cache);
  headers.set("etag", `"${entry.etag}${suffix}"`);
  if (entry.br || entry.gz) headers.set("vary", "Accept-Encoding");
  if (suffix) headers.set("content-encoding", suffix === "-br" ? "br" : "gzip");
  if (cache !== IMMUTABLE && etagMatches(req.headers.get("if-none-match"), entry.etag)) {
    headers.delete("content-encoding");
    return new Response(null, { status: 304, headers });
  }
  headers.set("content-length", String(body.byteLength));
  return new Response(req.method === "HEAD" ? null : body, { status: 200, headers });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function forwardedHeaders(req: Request, clientIp: string | undefined): Headers {
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.delete("host");
  const prior = req.headers.get("x-forwarded-for");
  if (clientIp) headers.set("x-forwarded-for", prior ? `${prior}, ${clientIp}` : clientIp);
  headers.set("x-forwarded-proto", "http");
  const host = req.headers.get("host");
  if (host) headers.set("x-forwarded-host", host);
  return headers;
}

async function proxyHttp(req: Request, url: URL, gateway: string, clientIp: string | undefined): Promise<Response> {
  const target = new URL(url.pathname + url.search, gateway);
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: forwardedHeaders(req, clientIp),
      body: hasBody ? req.body : null,
      redirect: "manual",
      // Pass the gateway's encoding through untouched (Content-Encoding stays valid for the streamed body).
      decompress: false,
    });
  } catch (err) {
    return Response.json(
      { error: `gateway unreachable at ${gateway}: ${err instanceof Error ? err.message : String(err)}`, code: "unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
  const headers = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

/** Close codes a WebSocket client may send (the WHATWG close() accepts only these). */
function clientCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

/** Close codes a server may put on the wire; 1005/1006 are local-only states, never sent. */
function serverCloseCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006) return 1011;
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

/** Close reasons are capped at 123 UTF-8 bytes. */
function closeReason(reason: string): string {
  const bytes = new TextEncoder().encode(reason);
  return bytes.byteLength <= 123 ? reason : new TextDecoder().decode(bytes.slice(0, 120));
}

function toWsUrl(gateway: string): string {
  const u = new URL("/ws", gateway);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

export async function startPreview(opts: PreviewOptions = {}): Promise<PreviewHandle> {
  const dist = resolve(opts.dist ?? DEFAULT_DIST);
  const gateway = (opts.gateway ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const host = opts.host ?? "127.0.0.1";
  const gatewayWs = toWsUrl(gateway);

  if (!existsSync(dist)) throw new Error(`${dist} does not exist; run: VITE_DATA_SOURCE=live bun run --cwd apps/web build`);
  const { files, sizes } = await loadDist(dist);
  const index = files.get("/index.html");
  if (!index) throw new Error(`no index.html in ${dist}; run: VITE_DATA_SOURCE=live bun run --cwd apps/web build`);

  const sockets = new Set<Bun.ServerWebSocket<WsData>>();
  let csp = "";
  /** The edge's CSP on everything it serves itself (the gateway's own responses pass through as they are). */
  const withCsp = (res: Response): Response => {
    res.headers.set("content-security-policy", csp);
    return res;
  };

  const server = Bun.serve({
    port: opts.port ?? 4173,
    hostname: host,
    fetch(req, srv) {
      const url = new URL(req.url);
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        return textResponse(400, "bad path");
      }
      if (INTERNAL.test(path)) return withCsp(textResponse(404, "404 Not Found"));

      if (path === "/ws") {
        const headers: Record<string, string> = {};
        for (const h of ["cookie", "origin", "user-agent", "accept-language"]) {
          const v = req.headers.get(h);
          if (v) headers[h] = v;
        }
        const ip = srv.requestIP(req)?.address;
        if (ip) headers["x-forwarded-for"] = ip;
        headers["x-forwarded-proto"] = "http";
        const data: WsData = { upstreamUrl: gatewayWs + url.search, headers, upstream: null, pending: [] };
        if (srv.upgrade(req, { data })) return undefined;
        return textResponse(426, "expected a WebSocket upgrade");
      }
      if (path === "/api" || path.startsWith("/api/")) return proxyHttp(req, url, gateway, srv.requestIP(req)?.address);

      if (req.method !== "GET" && req.method !== "HEAD") return textResponse(405, "405 Method Not Allowed");
      const entry = files.get(path) ?? (path.endsWith("/") ? files.get(`${path}index.html`) : undefined);
      if (entry) return withCsp(serveFile(req, entry));
      // A missing hashed asset is a 404, never index.html (a stale tab must not parse HTML as JS).
      if (path.startsWith("/assets/")) return withCsp(textResponse(404, "404 Not Found"));
      return withCsp(serveFile(req, index, REVALIDATE));
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: 16 * 1024 * 1024,
      // The edge passes the extension negotiation through end to end: mirror the gateway's WS_COMPRESSION here.
      perMessageDeflate: WS_COMPRESS,
      open(ws) {
        sockets.add(ws);
        let upstream: WebSocket;
        try {
          upstream = new BunWebSocket(ws.data.upstreamUrl, { headers: ws.data.headers });
        } catch {
          ws.close(1011, "gateway unreachable");
          return;
        }
        upstream.binaryType = "arraybuffer";
        ws.data.upstream = upstream;
        upstream.onopen = () => {
          for (const m of ws.data.pending) upstream.send(m);
          ws.data.pending.length = 0;
        };
        upstream.onmessage = (ev: MessageEvent) => {
          const d: unknown = ev.data;
          // ws.send() compresses only when asked (unlike the gateway's publish())
          if (typeof d === "string") ws.send(d, WS_COMPRESS);
          else if (d instanceof ArrayBuffer) ws.send(new Uint8Array(d), WS_COMPRESS);
          else if (ArrayBuffer.isView(d)) ws.send(new Uint8Array(d.buffer, d.byteOffset, d.byteLength), WS_COMPRESS);
        };
        upstream.onclose = (ev: CloseEvent) => {
          if (ws.readyState === 1) ws.close(serverCloseCode(ev.code), closeReason(ev.reason));
        };
        upstream.onerror = () => {
          if (ws.readyState === 1) ws.close(1011, "gateway unreachable");
        };
      },
      message(ws, message) {
        const m = typeof message === "string" ? message : new Uint8Array(message);
        const up = ws.data.upstream;
        if (up && up.readyState === WebSocket.OPEN) up.send(m);
        else if (up && up.readyState === WebSocket.CONNECTING) ws.data.pending.push(m);
      },
      close(ws, code, reason) {
        sockets.delete(ws);
        const up = ws.data.upstream;
        ws.data.pending.length = 0;
        if (up && (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING)) {
          try {
            up.close(clientCloseCode(code), closeReason(reason));
          } catch {
            // already closing
          }
        }
      },
    },
  });

  const url = `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`;
  csp = edgeCsp(url);
  if (!opts.quiet) {
    const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
    console.log(
      `preview-live ${url}  gateway ${gateway}  assets js+css (${sizes.files} files): raw ${kb(sizes.raw)} / gzip ${kb(sizes.gzip)} / brotli ${kb(sizes.brotli)}`,
    );
  }
  return {
    url,
    port: server.port ?? 0,
    gateway,
    sizes,
    async stop() {
      for (const ws of sockets) {
        try {
          ws.data.upstream?.close(1000, "preview stopping");
        } catch {
          // ignore
        }
      }
      // Bun's stop(true) promise can stay pending after a WebSocket was served; bound the wait (as the
      // gateway does) instead of hanging the caller.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([server.stop(true), new Promise<void>((r) => (timer = setTimeout(r, 500)))]);
      clearTimeout(timer);
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      port: { type: "string" },
      host: { type: "string" },
      gateway: { type: "string" },
      dist: { type: "string" },
    },
    strict: true,
  });
  const port = Number(values.port ?? process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${values.port ?? process.env.PORT}`);
  const handle = await startPreview({
    port,
    host: values.host ?? process.env.HOST ?? "127.0.0.1",
    gateway: values.gateway ?? process.env.GATEWAY ?? "http://127.0.0.1:8787",
    dist: values.dist ?? process.env.DIST ?? DEFAULT_DIST,
  });
  const shutdown = (): void => {
    void handle.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
