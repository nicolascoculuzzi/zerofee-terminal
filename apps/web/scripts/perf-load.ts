#!/usr/bin/env bun
/**
 * Repeatable production-load measurement: loads the built app in headless Chrome N times and reports paint
 * timings, the app's own `zf:*` performance marks, and bytes transferred by resource type, with medians.
 * It drives Chrome over the DevTools Protocol with Bun's built-in WebSocket (no npm dependencies).
 *
 *   VITE_DATA_SOURCE=live bun run --cwd apps/web build
 *   bun apps/web/scripts/perf-load.ts [--url http://127.0.0.1:4173/pulse] [--runs 5] [--throttle none|fast4g|slow4g]
 *                                     [--cpu 4] [--cold|--warm] [--wait-ms 15000] [--json out.json]
 *
 * Without --url it starts scripts/preview-live.ts in-process on a free port (GATEWAY / DIST env apply) and
 * loads /pulse. --cold (default): every run gets a fresh browser context, so the HTTP cache is empty. --warm:
 * run 1 primes a shared context and runs 2..N measure the repeat visit (immutable assets from cache); the
 * summary covers runs 2..N only. A run ends at the `zf:pulse-data` mark, at the first non-empty
 * `[data-pulse-row]` / Pulse card (`[role=row][data-mint]`) element when the mark does not follow within 1 s, or after --wait-ms.
 *
 * Browser: CHROME_PATH, else the newest Playwright chrome-headless-shell / Chrome for Testing in the
 * Playwright cache, else Google Chrome / Chromium on the system.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { type PreviewHandle, startPreview } from "./preview-live";

// ---------------------------------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------------------------------

/** A failure to set up the measurement (bad flags, no browser, unreachable page): exit code 1. */
class SetupError extends Error {}

type Throttle = "none" | "fast4g" | "slow4g";

interface Options {
  url: string | null;
  runs: number;
  throttle: Throttle;
  cpu: number;
  warm: boolean;
  waitMs: number;
  json: string | null;
}

/** Throughput in bytes/s (DevTools units). slow4g is Lighthouse's mobile preset; fast4g a good LTE link. */
const THROTTLES: Record<Exclude<Throttle, "none">, { latency: number; down: number; up: number }> = {
  fast4g: { latency: 40, down: (9 * 1_000_000) / 8, up: (1.5 * 1_000_000) / 8 },
  slow4g: { latency: 150, down: (1.6 * 1_000_000) / 8, up: (0.75 * 1_000_000) / 8 },
};

const CDP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;
/** After the first Pulse row shows up in the DOM, how long to wait for the zf:pulse-data mark. */
const ROW_GRACE_MS = 1_000;
const MARKS = ["zf:boot", "zf:skeleton", "zf:pulse-data", "zf:ws-open", "zf:ws-first-snapshot"] as const;

function parseOptions(): Options {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      url: { type: "string" },
      runs: { type: "string" },
      throttle: { type: "string" },
      cpu: { type: "string" },
      cold: { type: "boolean" },
      warm: { type: "boolean" },
      "wait-ms": { type: "string" },
      json: { type: "string" },
    },
    strict: true,
  });
  const runs = Number(values.runs ?? 5);
  const cpu = Number(values.cpu ?? 1);
  const waitMs = Number(values["wait-ms"] ?? 15_000);
  const throttle = (values.throttle ?? "none") as Throttle;
  if (!Number.isInteger(runs) || runs < 1) throw new SetupError(`--runs must be a positive integer, got ${values.runs}`);
  if (!(cpu >= 1)) throw new SetupError(`--cpu must be >= 1, got ${values.cpu}`);
  if (!(waitMs > 0)) throw new SetupError(`--wait-ms must be > 0, got ${values["wait-ms"]}`);
  if (!["none", "fast4g", "slow4g"].includes(throttle)) throw new SetupError(`--throttle must be none, fast4g or slow4g, got ${throttle}`);
  if (values.cold && values.warm) throw new SetupError("--cold and --warm are exclusive");
  if (values.warm && runs < 2) throw new SetupError("--warm needs --runs >= 2 (run 1 only primes the cache)");
  return { url: values.url ?? null, runs, throttle, cpu, warm: values.warm ?? false, waitMs, json: values.json ?? null };
}

// ---------------------------------------------------------------------------------------------------
// Chrome DevTools Protocol client
// ---------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
type EventHandler = (method: string, params: Json, sessionId: string | undefined) => void;

interface Pending {
  method: string;
  resolve: (value: Json) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<EventHandler>();
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => this.dispatch(String(ev.data));
    ws.onclose = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`browser connection closed during ${p.method}`));
      }
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new SetupError(`timed out connecting to ${url}`));
      }, CDP_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new SetupError(`could not connect to the DevTools endpoint ${url}`));
      };
    });
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string, timeoutMs = CDP_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`browser connection closed before ${method}`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => resolve(v as T), reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private dispatch(raw: string): void {
    let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: { message: string }; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) for (const h of this.handlers) h(msg.method, msg.params ?? {}, msg.sessionId);
  }
}

// ---------------------------------------------------------------------------------------------------
// browser discovery and launch
// ---------------------------------------------------------------------------------------------------

interface BrowserBin {
  path: string;
  headlessShell: boolean;
}

function revision(path: string): number {
  const m = /-(\d+)[\\/]/.exec(path);
  return m ? Number(m[1]) : 0;
}

function globNewest(root: string, patterns: string[]): string | null {
  if (!existsSync(root)) return null;
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })) found.push(join(root, rel));
  }
  found.sort((a, b) => revision(b) - revision(a));
  return found[0] ?? null;
}

function findBrowser(): BrowserBin | null {
  const isShell = (p: string): boolean => /headless[_-]shell/.test(basename(p));
  const env = process.env.CHROME_PATH;
  if (env) {
    if (!existsSync(env)) throw new SetupError(`CHROME_PATH does not exist: ${env}`);
    return { path: env, headlessShell: isShell(env) };
  }
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ].filter((p): p is string => !!p);
  for (const root of caches) {
    const shell = globNewest(root, [
      "chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell",
      "chromium_headless_shell-*/chrome-linux/headless_shell",
    ]);
    if (shell) return { path: shell, headlessShell: true };
  }
  for (const root of caches) {
    const full = globNewest(root, [
      "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
      "chromium-*/chrome-linux*/chrome",
    ]);
    if (full) return { path: full, headlessShell: false };
  }
  for (const app of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    if (existsSync(app)) return { path: app, headlessShell: false };
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    const p = Bun.which(name);
    if (p) return { path: p, headlessShell: false };
  }
  return null;
}

interface Browser {
  cdp: Cdp;
  bin: BrowserBin;
  version: string;
  close(): Promise<void>;
}

async function launchBrowser(bin: BrowserBin): Promise<Browser> {
  const userDataDir = mkdtempSync(join(tmpdir(), "zf-perf-"));
  const args = [
    ...(bin.headlessShell ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--use-mock-keychain",
    "--password-store=basic",
    "--mute-audio",
    "--window-size=1440,900",
    "about:blank",
  ];
  const proc = Bun.spawn([bin.path, ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const cleanupDir = (): void => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Chrome may still hold files for a moment; the OS cleans its temp dir
    }
  };

  let wsUrl: string;
  try {
    wsUrl = await readDevToolsUrl(proc.stderr, proc.exited);
  } catch (err) {
    proc.kill();
    await proc.exited;
    cleanupDir();
    throw err;
  }
  const cdp = await Cdp.connect(wsUrl);
  const version = await cdp.send<{ product: string }>("Browser.getVersion");

  let closed = false;
  return {
    cdp,
    bin,
    version: version.product,
    async close() {
      if (closed) return;
      closed = true;
      await cdp.send("Browser.close", {}, undefined, 2_000).catch(() => undefined);
      cdp.close();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
      if (!exited) {
        proc.kill("SIGKILL");
        await proc.exited;
      }
      cleanupDir();
    },
  };
}

/** Reads Chrome's stderr until "DevTools listening on ws://...", then keeps draining it in the background. */
async function readDevToolsUrl(stderr: ReadableStream<Uint8Array>, exited: Promise<number>): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SetupError(`browser did not report a DevTools URL within 20 s. stderr:\n${text.slice(-2000)}`);
    const chunk = await Promise.race([
      reader.read(),
      exited.then((code) => ({ exitCode: code })),
      Bun.sleep(remaining).then(() => ({ timeout: true as const })),
    ]);
    if ("exitCode" in chunk)
      throw new SetupError(`browser exited with code ${chunk.exitCode} before DevTools was ready. stderr:\n${text.slice(-2000)}`);
    if ("timeout" in chunk) continue;
    if (chunk.done) throw new SetupError(`browser closed stderr before DevTools was ready. stderr:\n${text.slice(-2000)}`);
    text += decoder.decode(chunk.value, { stream: true });
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(text);
    if (m?.[1]) {
      void (async () => {
        try {
          while (!(await reader.read()).done) {
            // drain so Chrome never blocks on a full pipe
          }
        } catch {
          // process gone
        }
      })();
      return m[1];
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// one measured page load
// ---------------------------------------------------------------------------------------------------

const BUCKETS = ["Script", "Stylesheet", "Font", "Image", "Fetch/XHR", "Document", "Other"] as const;
type Bucket = (typeof BUCKETS)[number];

function bucketOf(type: string): Bucket {
  switch (type) {
    case "Script":
    case "Stylesheet":
    case "Font":
    case "Image":
    case "Document":
      return type;
    case "Fetch":
    case "XHR":
    case "EventSource":
    case "Preflight":
      return "Fetch/XHR";
    default:
      return "Other";
  }
}

interface RequestRecord {
  url: string;
  type: string;
  startTs: number;
  endTs: number | null;
  encoded: number;
  fromCache: boolean;
  failed: boolean;
}

interface Timing {
  ttfb: number | null;
  firstPaint: number | null;
  fcp: number | null;
  lcp: number | null;
  domContentLoaded: number | null;
  load: number | null;
  boot: number | null;
  skeleton: number | null;
  wsOpen: number | null;
  wsFirstSnapshot: number | null;
  pulseData: number | null;
  pulseRowDom: number | null;
}

export interface RunResult {
  run: number;
  mode: "cold" | "prime" | "warm";
  url: string;
  finishedBy: "pulse-data" | "pulse-row-dom" | "timeout";
  /** Page time (ms since timeOrigin) the run was cut at; transfer counts stop here. */
  finishAt: number;
  timing: Timing;
  longTasks: { count: number; totalMs: number; blockingMs: number } | null;
  transfer: {
    bytes: Record<Bucket, number>;
    total: number;
    requests: number;
    cachedRequests: number;
    failedRequests: number;
    jsBeforePulseData: number | null;
  };
  websocket: { framesReceived: number; bytesReceived: number };
  runtime: { scriptMs: number | null; taskMs: number | null; layoutMs: number | null; jsHeapUsedBytes: number | null };
  pageErrors: number;
}

/** Installed before any page script: LCP / long-task observers and the [data-pulse-row] DOM fallback. */
const INSTRUMENT = `(() => {
  const s = (window.__zfPerf = { lcp: null, longTasks: [], rowAt: null });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = e.startTime; })
      .observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longTasks.push(e.duration); })
      .observe({ type: "longtask", buffered: true });
  } catch {}
  const check = () => {
    for (const r of document.querySelectorAll("[data-pulse-row], [role=row][data-mint]")) {
      if ((r.textContent || "").trim()) { s.rowAt = performance.now(); return true; }
    }
    return false;
  };
  const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
  mo.observe(document, { childList: true, subtree: true, characterData: true });
})();`;

const POLL = `(() => {
  if (location.href === "about:blank") return null;
  const m = (n) => { const e = performance.getEntriesByName(n, "mark")[0]; return e ? e.startTime : null; };
  const s = window.__zfPerf;
  return { pulseData: m("zf:pulse-data"), rowAt: s ? s.rowAt : null, now: performance.now() };
})()`;

const COLLECT = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const paint = {};
  for (const e of performance.getEntriesByType("paint")) paint[e.name] = e.startTime;
  const marks = {};
  for (const n of ${JSON.stringify(MARKS)}) { const e = performance.getEntriesByName(n, "mark")[0]; marks[n] = e ? e.startTime : null; }
  const s = window.__zfPerf || {};
  return {
    nav: nav ? { requestStart: nav.requestStart, responseStart: nav.responseStart, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd } : null,
    firstPaint: paint["first-paint"] ?? null,
    fcp: paint["first-contentful-paint"] ?? null,
    lcp: s.lcp ?? null,
    longTasks: Array.isArray(s.longTasks) ? s.longTasks : null,
    rowAt: s.rowAt ?? null,
    marks,
  };
})()`;

interface PollResult {
  pulseData: number | null;
  rowAt: number | null;
  now: number;
}

interface CollectResult {
  nav: { requestStart: number; responseStart: number; dcl: number; load: number } | null;
  firstPaint: number | null;
  fcp: number | null;
  lcp: number | null;
  longTasks: number[] | null;
  rowAt: number | null;
  marks: Record<string, number | null>;
}

interface EvaluateResult<T> {
  result: { value?: T };
  exceptionDetails?: { text: string };
}

async function evaluate<T>(cdp: Cdp, sessionId: string, expression: string): Promise<T | null> {
  const r = await cdp.send<EvaluateResult<T>>("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`page evaluation failed: ${r.exceptionDetails.text}`);
  return r.result.value ?? null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const positive = (v: number | undefined | null): number | null => (typeof v === "number" && v > 0 ? v : null);

async function measure(
  cdp: Cdp,
  opts: Options,
  url: string,
  run: number,
  mode: RunResult["mode"],
  browserContextId: string | undefined,
): Promise<RunResult> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
    ...(browserContextId ? { browserContextId } : {}),
  });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });

    const requests = new Map<string, RequestRecord>();
    const ws = { framesReceived: 0, bytesReceived: 0 };
    let docTiming: { requestTime: number; sendStart: number } | null = null;
    let docStartTs: number | null = null;
    let pageErrors = 0;

    const off = cdp.on((method, p, sid) => {
      if (sid !== sessionId) return;
      switch (method) {
        case "Network.requestWillBeSent": {
          const req = obj(p.request);
          const reqUrl = str(req.url);
          if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:")) return;
          const id = str(p.requestId);
          const prev = requests.get(id);
          requests.set(id, {
            url: reqUrl,
            type: str(p.type) || prev?.type || "Other",
            startTs: prev?.startTs ?? num(p.timestamp),
            endTs: null,
            encoded: 0,
            fromCache: false,
            failed: false,
          });
          if (str(p.type) === "Document" && docStartTs === null) docStartTs = num(p.timestamp);
          return;
        }
        case "Network.responseReceived": {
          const r = requests.get(str(p.requestId));
          const res = obj(p.response);
          if (r) {
            r.type = str(p.type) || r.type;
            if (res.fromDiskCache === true || res.fromPrefetchCache === true || res.fromServiceWorker === true) r.fromCache = true;
          }
          const timing = obj(res.timing);
          if (str(p.type) === "Document" && !docTiming && typeof timing.requestTime === "number") {
            docTiming = { requestTime: num(timing.requestTime), sendStart: num(timing.sendStart) };
          }
          return;
        }
        case "Network.requestServedFromCache": {
          const r = requests.get(str(p.requestId));
          if (r) r.fromCache = true;
          return;
        }
        case "Network.loadingFinished": {
          const r = requests.get(str(p.requestId));
          if (r) {
            r.encoded = num(p.encodedDataLength);
            r.endTs = num(p.timestamp);
          }
          return;
        }
        case "Network.loadingFailed": {
          const r = requests.get(str(p.requestId));
          if (r) {
            r.failed = true;
            r.endTs = num(p.timestamp);
          }
          return;
        }
        case "Network.webSocketFrameReceived": {
          const frame = obj(p.response);
          const payload = str(frame.payloadData);
          ws.framesReceived++;
          ws.bytesReceived += num(frame.opcode) === 1 ? new TextEncoder().encode(payload).byteLength : Math.floor((payload.length * 3) / 4);
          return;
        }
        case "Runtime.exceptionThrown":
          pageErrors++;
          return;
      }
    });

    try {
      await Promise.all([
        cdp.send("Page.enable", {}, sessionId),
        cdp.send("Network.enable", {}, sessionId),
        cdp.send("Runtime.enable", {}, sessionId),
        cdp.send("Performance.enable", {}, sessionId),
      ]);
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }, sessionId);
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }, sessionId);
      if (opts.throttle !== "none") {
        const t = THROTTLES[opts.throttle];
        await cdp.send(
          "Network.emulateNetworkConditions",
          { offline: false, latency: t.latency, downloadThroughput: t.down, uploadThroughput: t.up },
          sessionId,
        );
      }
      if (opts.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: opts.cpu }, sessionId);

      const nav = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, sessionId);
      if (nav.errorText) throw new SetupError(`navigation to ${url} failed: ${nav.errorText}`);

      // Poll for the finish condition.
      const started = Date.now();
      let finishedBy: RunResult["finishedBy"] = "timeout";
      let finishAt = 0;
      let rowSeenAt: number | null = null;
      while (true) {
        let state: PollResult | null = null;
        try {
          state = await evaluate<PollResult>(cdp, sessionId, POLL);
        } catch {
          // the execution context is swapped during navigation; try again
        }
        if (state) {
          finishAt = state.now;
          if (state.pulseData !== null) {
            finishedBy = "pulse-data";
            finishAt = state.pulseData;
            break;
          }
          if (state.rowAt !== null) {
            rowSeenAt ??= Date.now();
            if (Date.now() - rowSeenAt >= ROW_GRACE_MS) {
              finishedBy = "pulse-row-dom";
              finishAt = state.rowAt;
              break;
            }
          }
        }
        if (Date.now() - started >= opts.waitMs) break;
        await Bun.sleep(POLL_MS);
      }
      // Let in-flight protocol events for work finished before the cut arrive.
      await Bun.sleep(250);

      const c = await evaluate<CollectResult>(cdp, sessionId, COLLECT);
      if (!c) throw new Error("could not read page metrics");
      const perf = await cdp.send<{ metrics: { name: string; value: number }[] }>("Performance.getMetrics", {}, sessionId);
      const metric = (name: string): number | undefined => perf.metrics.find((m) => m.name === name)?.value;

      // Convert protocol monotonic timestamps (s) to page time (ms since timeOrigin): the document's
      // sendStart is the navigation entry's requestStart.
      const dt = docTiming as { requestTime: number; sendStart: number } | null;
      const navStartMono =
        dt && c.nav && c.nav.requestStart > 0
          ? dt.requestTime * 1000 + dt.sendStart - c.nav.requestStart
          : docStartTs !== null
            ? docStartTs * 1000
            : null;
      const toPage = (ts: number): number => (navStartMono === null ? 0 : ts * 1000 - navStartMono);

      const bytes = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
      let requestsCount = 0;
      let cached = 0;
      let failed = 0;
      let jsBefore = 0;
      const pulseData = c.marks["zf:pulse-data"] ?? null;
      for (const r of requests.values()) {
        if (r.type === "WebSocket" || toPage(r.startTs) > finishAt) continue;
        requestsCount++;
        if (r.fromCache) cached++;
        if (r.failed) failed++;
        if (r.endTs === null || toPage(r.endTs) > finishAt) continue;
        bytes[bucketOf(r.type)] += r.encoded;
        if (r.type === "Script" && pulseData !== null && toPage(r.endTs) <= pulseData) jsBefore += r.encoded;
      }
      const longTasks = c.longTasks
        ? {
            count: c.longTasks.length,
            totalMs: c.longTasks.reduce((a, d) => a + d, 0),
            blockingMs: c.longTasks.reduce((a, d) => a + Math.max(0, d - 50), 0),
          }
        : null;
      const seconds = (v: number | undefined): number | null => (typeof v === "number" ? v * 1000 : null);

      return {
        run,
        mode,
        url,
        finishedBy,
        finishAt,
        timing: {
          ttfb: positive(c.nav?.responseStart),
          firstPaint: c.firstPaint,
          fcp: c.fcp,
          lcp: c.lcp,
          domContentLoaded: positive(c.nav?.dcl),
          load: positive(c.nav?.load),
          boot: c.marks["zf:boot"] ?? null,
          skeleton: c.marks["zf:skeleton"] ?? null,
          wsOpen: c.marks["zf:ws-open"] ?? null,
          wsFirstSnapshot: c.marks["zf:ws-first-snapshot"] ?? null,
          pulseData,
          pulseRowDom: c.rowAt,
        },
        longTasks,
        transfer: {
          bytes,
          total: BUCKETS.reduce((a, b) => a + bytes[b], 0),
          requests: requestsCount,
          cachedRequests: cached,
          failedRequests: failed,
          jsBeforePulseData: pulseData === null ? null : jsBefore,
        },
        websocket: ws,
        runtime: {
          scriptMs: seconds(metric("ScriptDuration")),
          taskMs: seconds(metric("TaskDuration")),
          layoutMs: seconds(metric("LayoutDuration")),
          jsHeapUsedBytes: metric("JSHeapUsedSize") ?? null,
        },
        pageErrors,
      };
    } finally {
      off();
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------

interface Row {
  label: string;
  unit: "ms" | "KB" | "n";
  get: (r: RunResult) => number | null;
}

const ROWS: { section: string; rows: Row[] }[] = [
  {
    section: "timing (ms from navigation start)",
    rows: [
      { label: "ttfb", unit: "ms", get: (r) => r.timing.ttfb },
      { label: "first-paint", unit: "ms", get: (r) => r.timing.firstPaint },
      { label: "fcp", unit: "ms", get: (r) => r.timing.fcp },
      { label: "lcp", unit: "ms", get: (r) => r.timing.lcp },
      { label: "domContentLoaded", unit: "ms", get: (r) => r.timing.domContentLoaded },
      { label: "load", unit: "ms", get: (r) => r.timing.load },
      { label: "zf:boot", unit: "ms", get: (r) => r.timing.boot },
      { label: "zf:skeleton", unit: "ms", get: (r) => r.timing.skeleton },
      { label: "zf:ws-open", unit: "ms", get: (r) => r.timing.wsOpen },
      { label: "zf:ws-first-snapshot", unit: "ms", get: (r) => r.timing.wsFirstSnapshot },
      { label: "zf:pulse-data", unit: "ms", get: (r) => r.timing.pulseData },
      { label: "pulseRowDom", unit: "ms", get: (r) => r.timing.pulseRowDom },
      { label: "run cut at", unit: "ms", get: (r) => r.finishAt },
    ],
  },
  {
    section: "main thread",
    rows: [
      { label: "long tasks", unit: "n", get: (r) => r.longTasks?.count ?? null },
      { label: "long tasks total", unit: "ms", get: (r) => r.longTasks?.totalMs ?? null },
      { label: "blocking (>50ms part)", unit: "ms", get: (r) => r.longTasks?.blockingMs ?? null },
      { label: "script (Performance)", unit: "ms", get: (r) => r.runtime.scriptMs },
      { label: "page errors", unit: "n", get: (r) => r.pageErrors },
    ],
  },
  {
    section: "transfer until cut (KB, encoded incl. headers)",
    rows: [
      ...BUCKETS.map((b): Row => ({ label: b.toLowerCase(), unit: "KB", get: (r) => r.transfer.bytes[b] })),
      { label: "total", unit: "KB", get: (r) => r.transfer.total },
      { label: "js before pulse-data", unit: "KB", get: (r) => r.transfer.jsBeforePulseData },
      { label: "requests", unit: "n", get: (r) => r.transfer.requests },
      { label: "from cache", unit: "n", get: (r) => r.transfer.cachedRequests },
      { label: "failed", unit: "n", get: (r) => r.transfer.failedRequests },
      { label: "ws frames received", unit: "n", get: (r) => r.websocket.framesReceived },
      { label: "ws KB received", unit: "KB", get: (r) => r.websocket.bytesReceived },
    ],
  },
];

function fmt(v: number | null, unit: Row["unit"]): string {
  if (v === null || Number.isNaN(v)) return "-";
  if (unit === "KB") return (v / 1024).toFixed(1);
  if (unit === "n") return String(Math.round(v));
  return v >= 100 ? v.toFixed(0) : v.toFixed(1);
}

function stats(values: (number | null)[]): { median: number | null; min: number | null; max: number | null } {
  const xs = values.filter((v): v is number => v !== null && !Number.isNaN(v)).sort((a, b) => a - b);
  if (xs.length === 0) return { median: null, min: null, max: null };
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? (xs[mid] as number) : ((xs[mid - 1] as number) + (xs[mid] as number)) / 2;
  return { median, min: xs[0] as number, max: xs[xs.length - 1] as number };
}

function report(results: RunResult[]): Record<string, { median: number | null; min: number | null; max: number | null }> {
  const measured = results.filter((r) => r.mode !== "prime");
  const headers = [...results.map((r) => (r.mode === "prime" ? `prime${r.run}` : `run${r.run}`)), "median", "min", "max"];
  const labelWidth = 26;
  const colWidth = Math.max(8, ...headers.map((h) => h.length + 1));
  const line = (label: string, cells: string[]): string => label.padEnd(labelWidth) + cells.map((c) => c.padStart(colWidth)).join("");
  const summary: Record<string, { median: number | null; min: number | null; max: number | null }> = {};

  console.log(line("", headers));
  for (const { section, rows } of ROWS) {
    console.log(section);
    for (const row of rows) {
      const s = stats(measured.map(row.get));
      summary[row.label] = s;
      const cells = [...results.map((r) => fmt(row.get(r), row.unit)), fmt(s.median, row.unit), fmt(s.min, row.unit), fmt(s.max, row.unit)];
      if (cells.every((c) => c === "-")) continue;
      console.log(line(`  ${row.label}`, cells));
    }
  }
  console.log(line("finished by", [...results.map((r) => r.finishedBy), "", "", ""]));
  return summary;
}

// ---------------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  let preview: PreviewHandle | null = null;
  let browser: Browser | null = null;
  let cleaning: Promise<void> | null = null;
  // Bounded: the browser close escalates to SIGKILL after 5 s and the preview stop waits at most 0.5 s.
  const cleanup = (): Promise<void> => {
    cleaning ??= Promise.race([
      (async () => {
        await browser?.close().catch(() => undefined);
        await preview?.stop().catch(() => undefined);
      })(),
      Bun.sleep(10_000),
    ]);
    return cleaning;
  };
  let signalled = false;
  const onSignal = (): void => {
    if (signalled) process.exit(130); // second Ctrl-C: leave now
    signalled = true;
    void cleanup().finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const opts = parseOptions();
    const bin = findBrowser();
    if (!bin) throw new SetupError("no Chrome / Chromium found; set CHROME_PATH to a Chrome, Chromium or chrome-headless-shell binary");

    let url = opts.url;
    if (!url) {
      preview = await startPreview({
        port: 0,
        ...(process.env.GATEWAY ? { gateway: process.env.GATEWAY } : {}),
        ...(process.env.DIST ? { dist: process.env.DIST } : {}),
      });
      url = `${preview.url}/pulse`;
    }

    browser = await launchBrowser(bin);
    const { cdp } = browser;
    console.log(
      `perf-load ${url}  runs ${opts.runs} (${opts.warm ? "warm: run 1 primes" : "cold"})  throttle ${opts.throttle}  cpu ${opts.cpu}x  wait ${opts.waitMs} ms`,
    );
    console.log(`browser ${browser.version}  ${bin.path}`);

    const results: RunResult[] = [];
    let shared: string | undefined;
    for (let run = 1; run <= opts.runs; run++) {
      let contextId: string;
      if (opts.warm && shared) contextId = shared;
      else {
        contextId = (await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true }))
          .browserContextId;
        if (opts.warm) shared = contextId;
      }
      const mode: RunResult["mode"] = opts.warm ? (run === 1 ? "prime" : "warm") : "cold";
      try {
        const r = await measure(cdp, opts, url, run, mode, contextId);
        results.push(r);
        const t = r.timing;
        console.log(
          `  ${mode} ${run}/${opts.runs}: fcp ${fmt(t.fcp, "ms")} ms, pulse-data ${fmt(t.pulseData, "ms")} ms, ${fmt(r.transfer.total, "KB")} KB, ${r.transfer.requests} requests, ${r.finishedBy}`,
        );
      } finally {
        if (!opts.warm) await cdp.send("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => undefined);
      }
    }
    if (shared) await cdp.send("Target.disposeBrowserContext", { browserContextId: shared }).catch(() => undefined);

    console.log("");
    const summary = report(results);
    if (opts.json) {
      const meta = {
        url,
        runs: opts.runs,
        mode: opts.warm ? "warm" : "cold",
        throttle: opts.throttle,
        cpu: opts.cpu,
        waitMs: opts.waitMs,
        browser: browser.version,
        browserPath: bin.path,
        assets: preview?.sizes ?? null,
        at: new Date().toISOString(),
      };
      await Bun.write(opts.json, `${JSON.stringify({ meta, summary, runs: results }, null, 2)}\n`);
      console.log(`\nwrote ${opts.json}`);
    }
    return 0;
  } catch (err) {
    console.error(`perf-load: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (import.meta.main) {
  process.exit(await main());
}
