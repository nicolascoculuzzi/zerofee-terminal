/**
 * Image pipeline under load: per-host pacing and priorities, Retry-After, the metadata retry state machine,
 * image job retries and "pending" answers, large-image downscaling, AVIF / HEIC, the startup refetch spread,
 * the worker-process pool and the event-loop lag monitor. Offline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageProxyUrl } from "@zerofee/protocol";
import type { ParsedMetadata } from "../src/feeds/metadata";
import { MetadataFetcher } from "../src/feeds/metadata";
import { loadMediaConfig } from "../src/media/config";
import { makeMaster } from "../src/media/imageops";
import { boundedFetch, FetchFailure, parseRetryAfter } from "../src/media/net";
import { HostPacer, parseHostLimits } from "../src/media/pacer";
import { WorkPool } from "../src/media/pool";
import { ImageProxy, type ImageRef, pumpCdnUrl } from "../src/media/proxy";
import { describeUnknown, sniffImage, sniffSource } from "../src/media/sniff";
import { staggeredRace } from "../src/media/urls";
import { LoopLagMonitor } from "../src/util/loopLag";
import { waitFor } from "./helpers";

const MINT = "6FrwqBPGwwbyxwzwkWnks2qmVRXbu53LGnhnvM7apump";
const OTHER = "B4fHi8Fdt4SCZ3C9kMCsPBgCHTQVxQP2y83iaQjPpump";
const QM = "QmV1kzYWKenrPrGnR56bc1tnknH6dLk4KFszDhUCR7s6Tq";
const dirs: string[] = [];
const proxies: ImageProxy[] = [];
afterAll(() => {
  for (const p of proxies) p.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function bmp(w: number, h: number, noise = false): Uint8Array {
  const row = Math.ceil((w * 3) / 4) * 4;
  const b = new Uint8Array(54 + row * h);
  const dv = new DataView(b.buffer);
  b.set([0x42, 0x4d]);
  dv.setUint32(2, b.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  if (noise) {
    // random pixels: incompressible, so the PNG is several MB
    for (let off = 54; off < b.length; off += 65_536) crypto.getRandomValues(b.subarray(off, Math.min(b.length, off + 65_536)));
    return b;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set([x & 255, y & 255, 128], 54 + y * row + x * 3);
  return b;
}
const PNG = await new Bun.Image(bmp(400, 200)).png().bytes();
const img = (bytes: Uint8Array, type = "image/png", extra: Record<string, string> = {}) =>
  new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type, ...extra } });

function setup(o: { route: (url: string) => Response | Promise<Response>; refs?: Record<string, ImageRef>; env?: Record<string, string> }) {
  const calls: { url: string; at: number }[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, at: Date.now() });
    return o.route(url);
  }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "zf-imgp-"));
  dirs.push(dir);
  const cfg = loadMediaConfig(
    { IMG_CACHE_DIR: dir, IMG_STAGGER_MS: "20", IMG_PUMP_CDN: "off", IMG_WORKERS: "0", IMG_RETRY_BASE_MS: "50", ...o.env },
    ":memory:",
  );
  const refs = o.refs ?? { [MINT]: { image: "https://cdn.example.com/a.png", pump: false } };
  const proxy = new ImageProxy({
    cfg,
    gateways: ["https://pump.mypinata.cloud", "https://gateway.pinata.cloud"],
    lookup: (m) => refs[m] ?? null,
    fetchFn,
    resolve: async () => ["93.184.216.34"],
    random: () => 0.5,
  });
  proxies.push(proxy);
  const get = (path: string, method = "GET", ip = "1.2.3.4") => {
    const url = new URL(`http://zf.test${path}`);
    return proxy.handle(new Request(url, { method }), url, ip);
  };
  return { proxy, calls, get, refs };
}
const path = (mint: string, image: string, px: number) => imageProxyUrl(mint, image, px) as string;

describe("host pacing", () => {
  test("concurrency and token bucket per host; waiters served by priority, FIFO within one", async () => {
    const pacer = new HostPacer({ limits: { "a.test": { concurrency: 1, rps: 1_000, burst: 10 } } });
    const order: string[] = [];
    const first = await pacer.acquire("a.test", 1);
    const take = (prio: 0 | 1 | 2, name: string) =>
      pacer.acquire("a.test", prio).then((release) => {
        order.push(name);
        release();
      });
    const waits = [take(2, "bg"), take(1, "launch1"), take(0, "visible"), take(1, "launch2")];
    // another host is not affected
    (await pacer.acquire("b.test", 2))();
    expect(order).toEqual([]);
    first();
    await Promise.all(waits);
    expect(order).toEqual(["visible", "launch1", "launch2", "bg"]);
  });

  test("token bucket spreads a burst: 6 requests at 20/s with burst 2 take >= ~200 ms", async () => {
    const pacer = new HostPacer({ limits: { "a.test": { concurrency: 10, rps: 20, burst: 2 } } });
    const t0 = performance.now();
    const stamps: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, () =>
        pacer.acquire("a.test", 1).then((release) => {
          stamps.push(performance.now() - t0);
          release();
        }),
      ),
    );
    stamps.sort((a, b) => a - b);
    expect(stamps[1] as number).toBeLessThan(30); // the burst
    expect(stamps[5] as number).toBeGreaterThan(180); // 4 more at 50 ms each
  });

  test("Retry-After pauses the host; 429 halves its rate; an aborted waiter leaves the queue", async () => {
    const pacer = new HostPacer({ limits: { "a.test": { concurrency: 2, rps: 100, burst: 5 } } });
    pacer.throttled("a.test", 300);
    expect(pacer.pausedFor("a.test")).toBeGreaterThan(200);
    expect(pacer.snapshot()[0]?.rate).toBe(50);
    const ctl = new AbortController();
    const aborted = pacer.acquire("a.test", 1, ctl.signal);
    ctl.abort();
    await expect(aborted).rejects.toBeInstanceOf(FetchFailure);
    const t0 = performance.now();
    (await pacer.acquire("a.test", 0))();
    expect(performance.now() - t0).toBeGreaterThan(250);
    expect(pacer.snapshot()[0]?.queued).toBe(0);
  });

  test("Retry-After: 0 (block pages) falls back to an exponential back-off with jitter", () => {
    const pacer = new HostPacer({ random: () => 0.5, now: () => 1_000 });
    pacer.throttled("x.test", 0);
    expect(pacer.pausedFor("x.test")).toBe(2_000);
    pacer.throttled("x.test", null);
    expect(pacer.pausedFor("x.test")).toBe(4_000);
  });

  test("parsing: Retry-After seconds and dates; IMG_HOST_LIMITS entries", () => {
    expect(parseRetryAfter("7")).toBe(7_000);
    expect(parseRetryAfter(new Date(10_000 + 5_000).toUTCString(), 10_000)).toBe(5_000);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    const l = parseHostLimits("pump.mypinata.cloud=2/1.5/3,*=1/1/1");
    expect(l.limits["pump.mypinata.cloud"]).toEqual({ concurrency: 2, rps: 1.5, burst: 3 });
    expect(l.limits["gateway.pinata.cloud"]).toBeDefined();
    expect(l.fallback).toEqual({ concurrency: 1, rps: 1, burst: 1 });
    expect(() => parseHostLimits("nope")).toThrow();
  });

  test("boundedFetch reports 429 + Retry-After to the pacer and on the failure", async () => {
    const pacer = new HostPacer();
    const fetchFn = (async () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } })) as unknown as typeof fetch;
    const err = await boundedFetch("https://a.test/x", {
      fetchFn,
      resolve: async () => ["93.184.216.34"],
      timeoutMs: 1_000,
      maxBytes: 1_000,
      accept: "*/*",
      pacer,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FetchFailure);
    expect(err.retryAfterMs).toBe(3_000);
    expect(err.permanent).toBe(false);
    expect(pacer.pausedFor("a.test")).toBeGreaterThan(2_500);
  });

  test("staggered race: a paced attempt still queued does not start the stagger clock", async () => {
    const started: string[] = [];
    const v = await staggeredRace(
      ["queued", "b"],
      (c, signal, begin) =>
        new Promise<string>((resolve, reject) => {
          started.push(c);
          signal.addEventListener("abort", () => reject(new Error("aborted")));
          if (c === "b") {
            begin();
            setTimeout(() => resolve("b"), 5);
          } // "queued" never gets its slot
        }),
      10,
      80,
    );
    expect(v).toBe("b");
    expect(started).toEqual(["queued", "b"]);
  });
});

describe("metadata retries", () => {
  const GW = ["https://pump.mypinata.cloud", "https://gateway.pinata.cloud"];
  const CID = "Qme95r8YzjeMNFeE8UTE6LRr3ZQRSHrktTYi97hPbNPjNF";
  function fetcher(route: (url: string, n: number) => Response, extra: Partial<ConstructorParameters<typeof MetadataFetcher>[0]> = {}) {
    let n = 0;
    const results: [string, ParsedMetadata | null][] = [];
    const retries: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return route(url, n++);
    }) as typeof fetch;
    const f = new MetadataFetcher({
      gateways: GW,
      timeoutMs: 500,
      staggerMs: 5,
      retryBaseMs: 20,
      fetchFn,
      resolve: async () => ["93.184.216.34"],
      random: () => 0.5,
      onResult: (mint, meta) => results.push([mint, meta]),
      onRetry: (mint, _a, reason) => retries.push(`${mint}:${reason}`),
      ...extra,
    });
    return { f, results, retries, calls: () => n };
  }
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

  test("429s are retried with back-off until the metadata arrives; onRetry fires once", async () => {
    let round = 0;
    const t = fetcher((url) => {
      if (url.includes("pump.mypinata.cloud")) round++;
      return round <= 2 ? new Response("", { status: 429 }) : json({ name: "A", image: `ipfs://${CID}` });
    });
    t.f.request("M1", `https://pump.mypinata.cloud/ipfs/${CID}`);
    await waitFor(() => t.results.length === 1, 3_000);
    expect(t.results[0]?.[1]?.image).toContain(CID);
    expect(t.retries).toEqual(["M1:http_429"]);
    expect(t.f.stats.retries).toBe(2);
    expect(t.f.pendingCount).toBe(0);
    t.f.stop();
  });

  test("every token sharing a failing URI hears about the retry (fallback image), including late joiners", async () => {
    const t = fetcher(() => new Response("", { status: 503 }), { retryBaseMs: 200 });
    t.f.request("A", "https://meta.example/same.json");
    t.f.request("B", "https://meta.example/same.json");
    await waitFor(() => t.retries.length === 2);
    t.f.request("C", "https://meta.example/same.json");
    expect(t.retries.sort()).toEqual(["A:http_503", "B:http_503", "C:http_503"]);
    expect(t.calls()).toBe(1);
    t.f.stop();
  });

  test("permanent failures stop at once: invalid JSON; 404 everywhere stops after three attempts", async () => {
    const bad = fetcher(() => new Response("<html>oops</html>", { headers: { "content-type": "text/html" } }));
    bad.f.request("M1", "https://meta.example/a.json");
    await waitFor(() => bad.results.length === 1);
    expect(bad.results[0]?.[1]).toBeNull();
    expect(bad.calls()).toBe(1);
    expect(bad.f.stats.permanent).toBe(1);

    const gone = fetcher(() => new Response("", { status: 404 }));
    gone.f.request("M2", "https://meta.example/b.json");
    await waitFor(() => gone.results.length === 1, 3_000);
    expect(gone.calls()).toBe(3);
    expect(gone.f.stats).toMatchObject({ permanent: 1, retries: 2 });
  });

  test("transient failures give up after retryMax attempts", async () => {
    const t = fetcher(() => new Response("", { status: 503 }), { retryMax: 3 });
    t.f.request("M1", "https://meta.example/a.json");
    await waitFor(() => t.results.length === 1, 3_000);
    expect(t.calls()).toBe(3);
    expect(t.f.stats).toMatchObject({ gaveUp: 1, permanent: 0 });
  });

  test("restored tokens wait behind launches and start at the background rate; on-screen ones jump ahead", async () => {
    const order: string[] = [];
    const t = fetcher(
      (url) => {
        order.push(url.slice(-6));
        return json({ name: url.slice(-6) });
      },
      { maxConcurrent: 2, backgroundRps: 20, priorityOf: (m) => (m === "SEEN" ? 0 : undefined) },
    );
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) t.f.request(`R${i}`, `https://meta.example/rest0${i}`, "restore");
    t.f.request("SEEN", "https://meta.example/seen00", "restore");
    t.f.request("L", "https://meta.example/launch", "launch");
    await waitFor(() => t.results.length === 8, 3_000);
    expect(order.slice(0, 2).sort()).toEqual(["launch", "seen00"].sort());
    expect(performance.now() - t0).toBeGreaterThan(150); // 6 background jobs at 20/s after a burst of 2
  });

  test("a token that is gone is not retried", async () => {
    let alive = true;
    const t = fetcher(() => new Response("", { status: 503 }), { wanted: () => alive });
    t.f.request("M1", "https://meta.example/a.json");
    await waitFor(() => t.f.stats.retries === 1);
    alive = false;
    await Bun.sleep(100);
    expect(t.calls()).toBe(1);
    expect(t.f.pendingCount).toBe(0);
  });
});

describe("image jobs", () => {
  test("a 429 with Retry-After is retried by the job itself after the pause; the client is told pending meanwhile", async () => {
    let n = 0;
    const t = setup({
      env: { IMG_WAIT_MS: "30" },
      route: () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : img(PNG)),
    });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    const r1 = await t.get(p);
    expect(r1.status).toBe(404);
    expect(r1.headers.get("x-zf-image")).toBe("pending");
    const head = await t.get(p, "HEAD");
    expect(head.headers.get("x-zf-image")).toBe("pending");
    expect(Number(head.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(t.proxy.imageState(MINT)).toBe("pending");
    await waitFor(() => t.calls.length === 2, 3_000);
    expect((t.calls[1]?.at ?? 0) - (t.calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(900);
    await waitFor(() => t.proxy.stats.jobs.ok === 1);
    const r2 = await t.get(p);
    expect(r2.status).toBe(200);
    expect(t.proxy.imageState(MINT)).toBe("ok");
  });

  test("an empty 200 body (a CDN object not written yet) is retried, not refused", async () => {
    let n = 0;
    const t = setup({ env: { IMG_WAIT_MS: "30" }, route: () => (n++ === 0 ? img(new Uint8Array(0), "image/webp") : img(PNG)) });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    expect((await t.get(p)).headers.get("x-zf-image")).toBe("pending");
    await waitFor(() => t.proxy.stats.jobs.ok === 1, 3_000);
    expect((await t.get(p)).status).toBe(200);
    expect(t.proxy.stats.badMagic).toEqual({ empty: 1 });
  });

  test("permanent failures are reported as failed (the client stops asking); no image is none", async () => {
    const t = setup({
      refs: { [MINT]: { image: "https://cdn.example.com/a.svg", pump: false }, [OTHER]: { image: null, pump: false } },
      route: () => img(new TextEncoder().encode("<svg/>"), "image/svg+xml"),
    });
    const r = await t.get(path(MINT, "https://cdn.example.com/a.svg", 48));
    expect(r.headers.get("x-zf-image")).toBe("failed");
    expect(r.headers.get("retry-after")).toBeNull();
    expect((await t.get(`/api/img?mint=${OTHER}`)).headers.get("x-zf-image")).toBe("none");
    expect(t.proxy.stats.jobs.failedPermanent).toBe(1);
  });

  test("gives up after IMG_RETRY_MAX transient failures", async () => {
    const t = setup({ env: { IMG_RETRY_MAX: "3", IMG_WAIT_MS: "0" }, route: () => new Response("", { status: 404 }) });
    t.proxy.warm(MINT); // a 404 can be fresh IPFS content: transient
    await waitFor(() => t.proxy.stats.jobs.gaveUp === 1, 3_000);
    expect(t.calls).toHaveLength(3);
    expect(t.proxy.imageState(MINT)).toBe("failed");
  });

  test("startup refetch: background jobs are spread at IMG_BACKGROUND_RPS; a viewer's image jumps the queue", async () => {
    const refs: Record<string, ImageRef> = {};
    const mints = Array.from({ length: 8 }, (_, i) => `${"1".repeat(31)}${String.fromCharCode(65 + i)}${"1".repeat(8)}`);
    for (const [i, m] of mints.entries()) refs[m] = { image: `https://cdn.example.com/${i}.png`, pump: false };
    refs[MINT] = { image: "https://cdn.example.com/viewer.png", pump: false };
    const t = setup({ refs, env: { IMG_BACKGROUND_RPS: "10" }, route: () => img(PNG) });
    for (const m of mints) t.proxy.warm(m, 2);
    const viewer = t.get(path(MINT, "https://cdn.example.com/viewer.png", 48));
    expect((await viewer).status).toBe(200);
    await waitFor(() => t.calls.length === 9, 3_000);
    const bg = t.calls.filter((c) => !c.url.includes("viewer"));
    expect(t.calls.findIndex((c) => c.url.includes("viewer"))).toBeLessThan(3);
    // 8 background fetches at 10/s (burst 1-2): spread over >= ~0.5 s, never all at once
    expect((bg[7]?.at ?? 0) - (bg[0]?.at ?? 0)).toBeGreaterThanOrEqual(500);
  });

  test("a restart serves restored tokens from the disk cache (master), without touching the upstream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zf-imgp-"));
    dirs.push(dir);
    const a = setup({ route: () => img(PNG), env: { IMG_CACHE_DIR: dir } });
    expect((await a.get(path(MINT, "https://cdn.example.com/a.png", 48))).status).toBe(200);
    await Bun.sleep(50);
    const b = setup({ route: () => img(PNG), env: { IMG_CACHE_DIR: dir } });
    b.proxy.warm(MINT, 2);
    expect((await b.get(path(MINT, "https://cdn.example.com/a.png", 128))).status).toBe(200); // another size: from the master
    expect(b.calls).toHaveLength(0);
  });

  test("pump CDN: a redirect to its placeholder is a transient miss (not downloaded); the CDN fallback image works alone", async () => {
    const t = setup({
      env: { IMG_PUMP_CDN: "first", IMG_WAIT_MS: "200" },
      refs: {
        [MINT]: { image: `https://pump.mypinata.cloud/ipfs/${QM}`, pump: true },
        [OTHER]: { image: pumpCdnUrl(OTHER), pump: true },
      },
      route: (url) => {
        if (url.endsWith("/11111111111111111111111111111111"))
          return new Response(null, { status: 302, headers: { location: "https://images.pump.fun/coin-image/placeholder-mint" } });
        if (url.includes("placeholder-mint"))
          return img(Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")), "image/gif");
        if (url === pumpCdnUrl(MINT))
          return new Response(null, {
            status: 302,
            headers: { location: "https://images.pump.fun/coin-image/placeholder-mint?variant=256x256", "x-image-source": "placeholder" },
          });
        if (url === pumpCdnUrl(OTHER))
          return new Response(null, { status: 302, headers: { location: "https://imagedelivery.net/x/coin-image/o/256x256" } });
        return img(PNG, "image/png");
      },
    });
    expect((await t.get(path(MINT, `https://pump.mypinata.cloud/ipfs/${QM}`, 48))).status).toBe(200);
    expect(t.calls.some((c) => c.url.includes("placeholder-mint?variant"))).toBe(false);
    expect(t.proxy.stats.failures.placeholder).toBe(1);
    expect((await t.get(path(OTHER, pumpCdnUrl(OTHER), 48))).status).toBe(200);
    expect(t.proxy.stats.sources["images.pump.fun"]).toBe(1);
  });

  test("a fallback source whose host is busy gives up after the patience instead of holding the race open", async () => {
    const t = setup({
      env: { IMG_WAIT_MS: "3000", IMG_QUEUE_PATIENCE_MS: "100" },
      refs: { [MINT]: { image: `https://pump.mypinata.cloud/ipfs/${QM}`, pump: false } },
      route: () => new Response("", { status: 403 }),
    });
    // every slot on the fallback host is taken
    const held = [await t.proxy.pacer.acquire("gateway.pinata.cloud", 0), await t.proxy.pacer.acquire("gateway.pinata.cloud", 0)];
    const t0 = performance.now();
    const r = await t.get(path(MINT, `https://pump.mypinata.cloud/ipfs/${QM}`, 48));
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(r.headers.get("x-zf-image")).toBe("pending"); // 403 here + "busy" there: not a verdict on the image
    expect(t.proxy.stats.failures.host_busy).toBe(1);
    expect(t.calls.map((c) => new URL(c.url).host)).toEqual(["pump.mypinata.cloud"]);
    for (const release of held) release();
  });

  test("a host paused after 429s is skipped while another source remains, and that miss stays transient", async () => {
    const t = setup({
      env: { IMG_WAIT_MS: "500" },
      refs: { [MINT]: { image: `https://pump.mypinata.cloud/ipfs/${QM}`, pump: false } },
      route: (url) => (url.includes("gateway.pinata.cloud") ? new Response("", { status: 429 }) : new Response("", { status: 403 })),
    });
    t.proxy.pacer.throttled("gateway.pinata.cloud", 60_000);
    const r = await t.get(path(MINT, `https://pump.mypinata.cloud/ipfs/${QM}`, 48));
    expect(r.headers.get("x-zf-image")).toBe("pending");
    expect(t.calls.map((c) => new URL(c.url).host)).toEqual(["pump.mypinata.cloud"]);
  });
});

describe("large images and formats", () => {
  test("an 8 MB-class original is accepted and comes out as a tiny WebP at the avatar size; the pixel guard still holds", async () => {
    const big = await new Bun.Image(bmp(1600, 1400, true)).png().bytes();
    expect(big.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const t = setup({ route: () => img(big) });
    const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 40));
    expect(r.status).toBe(200);
    const body = new Uint8Array(await r.arrayBuffer());
    expect(sniffImage(body)).toBe("webp");
    expect(await new Bun.Image(body).metadata()).toMatchObject({ height: 48 });
    expect(body.byteLength).toBeLessThan(16 * 1024);

    const guarded = setup({ route: () => img(big), env: { IMG_MAX_PIXELS: String(1000 * 1000) } });
    const g = await guarded.get(path(MINT, "https://cdn.example.com/a.png", 40));
    expect(g.headers.get("x-zf-image")).toBe("failed");
    expect(guarded.proxy.stats.failures.too_many_pixels).toBe(1);
  });

  test("AVIF and HEIC: sniffed from the ftyp box, served as WebP when this host decodes them, refused otherwise", async () => {
    const ftyp = (brand: string, compat: string[] = []) => {
      const b = new Uint8Array(16 + compat.length * 4 + 8);
      new DataView(b.buffer).setUint32(0, 16 + compat.length * 4);
      b.set(new TextEncoder().encode(`ftyp${brand}\0\0\0\0${compat.join("")}`), 4);
      return b;
    };
    expect(sniffSource(ftyp("avif", ["mif1"]))).toBe("avif");
    expect(sniffSource(ftyp("mif1", ["avif"]))).toBe("avif");
    expect(sniffSource(ftyp("heic", ["mif1"]))).toBe("heic");
    expect(sniffSource(ftyp("isom", ["mp41"]))).toBeNull(); // a video
    for (const format of ["avif", "heic"] as const) {
      let encoded: Uint8Array | null = null;
      try {
        encoded =
          (await (new Bun.Image(bmp(300, 300)) as unknown as Record<string, () => { bytes(): Promise<Uint8Array> }>)[format]?.().bytes()) ??
          null;
      } catch {
        encoded = null; // this host can't encode it: nothing to serve, and the decoder may be missing too
      }
      if (!encoded) continue;
      expect(sniffSource(encoded)).toBe(format);
      const m = await makeMaster(encoded, format, 4096 * 4096, 256);
      if (!m.ok) {
        expect(m.reason).toBe(`undecodable_${format}`); // never passed through
        continue;
      }
      expect(sniffImage(m.bytes)).toBe("webp");
      const t = setup({ route: () => img(encoded as Uint8Array, `image/${format}`) });
      const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 48));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/webp");
      expect(t.proxy.stats.formats[format]).toBe(1);
    }
  });

  test("bad_magic bodies are classified (what upstreams send instead of images); HTML stays refused as markup", async () => {
    expect(describeUnknown(new Uint8Array(0))).toBe("empty");
    expect(describeUnknown(new TextEncoder().encode('{"error":"nope"}'))).toBe("json");
    expect(describeUnknown(new TextEncoder().encode("<!doctype html><title>x</title>"))).toBe("markup");
    expect(describeUnknown(bmp(2, 2))).toBe("bmp");
    expect(describeUnknown(Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16]))).toBe("ico");
    expect(describeUnknown(Uint8Array.from([0x1f, 0x8b, 8, 0]))).toBe("gzip");
    const t = setup({
      refs: { [MINT]: { image: "https://cdn.example.com/a", pump: false }, [OTHER]: { image: "https://cdn.example.com/b", pump: false } },
      route: (url) =>
        url.endsWith("/a")
          ? img(new TextEncoder().encode('{"error":1}'), "application/octet-stream")
          : img(new TextEncoder().encode("<html>"), "image/png"),
    });
    expect((await t.get(path(MINT, "https://cdn.example.com/a", 48))).headers.get("x-zf-image")).toBe("failed");
    expect((await t.get(path(OTHER, "https://cdn.example.com/b", 48))).status).toBe(404);
    expect(t.proxy.stats.badMagic).toEqual({ json: 1 });
    expect(t.proxy.stats.failures).toMatchObject({ bad_magic: 1, markup: 1 });
  });
});

describe("work pool and event loop", () => {
  test("worker processes decode, render and parse off the main thread; priority queue with backpressure", async () => {
    const pool = new WorkPool({ workers: 1, nice: 10, maxQueue: 2 });
    try {
      const m = await pool.master(PNG, "png", 4096 * 4096, 256, 0);
      expect(m.ok).toBe(true);
      if (!m.ok) return;
      expect(m).toMatchObject({ width: 400, height: 200, passthrough: false });
      const out = await pool.render(m.bytes, 48, 0);
      expect(await new Bun.Image(out).metadata()).toMatchObject({ width: 96, height: 48, format: "webp" });
      const meta = await pool.parseMetadata(JSON.stringify({ name: "A", image: `ipfs://${QM}` }), ["https://pump.mypinata.cloud"], 1);
      expect(meta?.image).toBe(`https://pump.mypinata.cloud/ipfs/${QM}`);
      expect(await pool.parseMetadata("not json", [], 1)).toBeNull();
      // backpressure: one running, two queued; the next background job is refused, a viewer's still fits
      const jobs = [pool.render(m.bytes, 32, 2), pool.render(m.bytes, 32, 2), pool.render(m.bytes, 32, 2)];
      await expect(pool.render(m.bytes, 32, 2)).rejects.toThrow("busy");
      const visible = pool.render(m.bytes, 32, 0);
      await Promise.all([...jobs, visible]);
      expect(pool.stats.dropped).toBe(1);
      expect(pool.stats.inline).toBe(0);
    } finally {
      pool.stop();
    }
  });

  test("event-loop lag monitor sees a blocked loop", async () => {
    const mon = new LoopLagMonitor(10);
    mon.start();
    await Bun.sleep(40);
    const t = performance.now();
    while (performance.now() - t < 60) {
      /* block */
    }
    await Bun.sleep(30);
    mon.stop();
    const s = mon.stats();
    expect(s.samples).toBeGreaterThan(2);
    expect(s.max ?? 0).toBeGreaterThan(40);
  });
});
