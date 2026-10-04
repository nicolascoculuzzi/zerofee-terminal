/** GET /api/img: refusals (SVG, oversize, bad bytes, private hosts), resizing, caches, rate limits. Offline. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageProxyUrl, imageVersion } from "@zerofee/protocol";
import { loadMediaConfig, type MediaConfig } from "../src/media/config";
import { ImageProxy, type ImageRef } from "../src/media/proxy";
import { sniffImage } from "../src/media/sniff";

const MINT = "6FrwqBPGwwbyxwzwkWnks2qmVRXbu53LGnhnvM7apump";
const OTHER = "B4fHi8Fdt4SCZ3C9kMCsPBgCHTQVxQP2y83iaQjPpump";
const QM = "QmV1kzYWKenrPrGnR56bc1tnknH6dLk4KFszDhUCR7s6Tq";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 24-bit BMP, then encoded by Bun.Image into the format under test. */
function bmp(w: number, h: number): Uint8Array {
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
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b.set([x & 255, y & 255, 128], 54 + y * row + x * 3);
  return b;
}
const PNG = await new Bun.Image(bmp(400, 200)).png().bytes();
const JPEG = await new Bun.Image(bmp(120, 120)).jpeg().bytes();
const GIF = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`);

type Route = (url: string) => Response | Promise<Response>;

function setup(o: {
  route: Route;
  refs?: Record<string, ImageRef>;
  env?: Record<string, string>;
  resolve?: (host: string) => Promise<string[]>;
  dir?: string | null;
}) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return o.route(url);
  }) as typeof fetch;
  const dir = o.dir === undefined ? mkdtempSync(join(tmpdir(), "zf-img-")) : o.dir;
  if (dir) dirs.push(dir);
  const cfg: MediaConfig = loadMediaConfig(
    { IMG_CACHE_DIR: dir ?? "off", IMG_STAGGER_MS: "20", IMG_PUMP_CDN: "off", ...o.env },
    ":memory:",
  );
  const refs = o.refs ?? { [MINT]: { image: "https://cdn.example.com/a.png", pump: false } };
  const proxy = new ImageProxy({
    cfg,
    gateways: ["https://pump.mypinata.cloud", "https://gateway.pinata.cloud"],
    lookup: (m) => refs[m] ?? null,
    fetchFn,
    resolve: o.resolve ?? (async () => ["93.184.216.34"]),
  });
  const get = (path: string, headers: Record<string, string> = {}, ip = "1.2.3.4") => {
    const url = new URL(`http://zf.test${path}`);
    return proxy.handle(new Request(url, { headers }), url, ip);
  };
  return { proxy, calls, get, dir, refs };
}

const img = (bytes: Uint8Array, type = "image/png", extra: Record<string, string> = {}) =>
  new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "content-type": type, ...extra } });
const path = (mint: string, image: string, px: number) => imageProxyUrl(mint, image, px) as string;

describe("image proxy: serving", () => {
  test("PNG is re-encoded to WebP with the shorter side at the size bucket; immutable cache for the current version", async () => {
    const t = setup({ route: () => img(PNG) });
    const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 40));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const body = new Uint8Array(await r.arrayBuffer());
    expect(sniffImage(body)).toBe("webp");
    const meta = await new Bun.Image(body).metadata();
    expect(meta).toMatchObject({ width: 96, height: 48 }); // 40 px -> bucket 48 on the shorter side
    expect(t.calls).toEqual(["https://cdn.example.com/a.png"]);
  });

  test("stale or missing version: the current image, cacheable for 5 minutes only", async () => {
    const t = setup({ route: () => img(PNG) });
    const r = await t.get(`/api/img?mint=${MINT}&v=zzz&s=32`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await t.get(`/api/img?mint=${MINT}`)).headers.get("cache-control")).toBe("public, max-age=300");
  });

  test("ETag and If-None-Match: 304 with the same caching headers, no body", async () => {
    const t = setup({ route: () => img(JPEG, "image/jpeg") });
    const p = path(MINT, "https://cdn.example.com/a.png", 64);
    const r1 = await t.get(p);
    const etag = r1.headers.get("etag") as string;
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const r2 = await t.get(p, { "if-none-match": `"other", ${etag}` });
    expect(r2.status).toBe(304);
    expect(r2.headers.get("cache-control")).toContain("immutable");
    expect(await r2.text()).toBe("");
  });

  test("small images are not upscaled; GIF decodes (first frame) and comes out as WebP", async () => {
    const t = setup({ route: () => img(GIF, "image/gif") });
    const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 96));
    expect(r.status).toBe(200);
    const body = new Uint8Array(await r.arrayBuffer());
    expect(await new Bun.Image(body).metadata()).toMatchObject({ width: 1, height: 1, format: "webp" });
  });

  test("an image that can't be decoded but has valid magic bytes is passed through with its own type", async () => {
    const broken = new Uint8Array(64);
    broken.set([0xff, 0xd8, 0xff, 0xe0]);
    const t = setup({ route: () => img(broken, "application/octet-stream") });
    const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 48));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(t.proxy.stats.passthrough).toBe(1);
  });

  test("IPFS images come from the configured gateways in a staggered race, never from a retired gateway", async () => {
    const image = `https://pump.mypinata.cloud/ipfs/${QM}`;
    const t = setup({
      refs: { [MINT]: { image: `https://ipfs.io/ipfs/${QM}`, pump: false } },
      route: (url) => (url.startsWith("https://pump.mypinata.cloud") ? new Response("not pinned here", { status: 403 }) : img(PNG)),
    });
    const r = await t.get(path(MINT, image, 32));
    expect(r.status).toBe(200);
    expect(t.calls).toEqual([`https://pump.mypinata.cloud/ipfs/${QM}`, `https://gateway.pinata.cloud/ipfs/${QM}`]);
    expect(t.proxy.stats.sources).toEqual({ "gateway.pinata.cloud": 1 });
  });

  test("pump coins fall back to pump.fun's image CDN; its stock placeholder counts as no image", async () => {
    const placeholder = await new Bun.Image(bmp(8, 8)).png().bytes();
    const t = setup({
      env: { IMG_PUMP_CDN: "fallback" },
      refs: { [MINT]: { image: "https://dead.example/a.png", pump: true }, [OTHER]: { image: "https://dead.example/b.png", pump: true } },
      route: (url) => {
        if (url.startsWith("https://dead.example")) return new Response("gone", { status: 410 });
        if (url.endsWith("/11111111111111111111111111111111")) return img(placeholder);
        if (url.endsWith(`/${MINT}`)) return img(PNG);
        return img(placeholder); // OTHER: pump has no image either
      },
    });
    expect((await t.get(path(MINT, "https://dead.example/a.png", 48))).status).toBe(200);
    expect(t.proxy.stats.sources).toEqual({ "images.pump.fun": 1 });
    const r = await t.get(path(OTHER, "https://dead.example/b.png", 48));
    expect(r.status).toBe(404);
    expect(t.proxy.stats.failures.placeholder).toBe(1);
  });
});

describe("image proxy: refusals", () => {
  test("SVG is refused by Content-Type, and SVG bytes under an image type are refused by their magic bytes", async () => {
    const t = setup({
      refs: {
        [MINT]: { image: "https://cdn.example.com/a.svg", pump: false },
        [OTHER]: { image: "https://cdn.example.com/b.png", pump: false },
      },
      route: (url) => (url.endsWith(".svg") ? img(SVG, "image/svg+xml") : img(SVG, "image/png")),
    });
    const r1 = await t.get(path(MINT, "https://cdn.example.com/a.svg", 32));
    expect(r1.status).toBe(404);
    expect(r1.headers.get("content-type")).toBe("application/json");
    expect(r1.headers.get("cache-control")).toBe("no-store");
    expect((await t.get(path(OTHER, "https://cdn.example.com/b.png", 32))).status).toBe(404);
    expect(t.proxy.stats.failures).toMatchObject({ svg: 1, markup: 1 });
  });

  test("other content types and unknown bytes are refused", async () => {
    const t = setup({
      refs: { [MINT]: { image: "https://cdn.example.com/a", pump: false }, [OTHER]: { image: "https://cdn.example.com/b", pump: false } },
      route: (url) => (url.endsWith("/a") ? img(PNG, "text/html") : img(new TextEncoder().encode("MZ\x90\x00 not an image"), "image/png")),
    });
    expect((await t.get(path(MINT, "https://cdn.example.com/a", 32))).status).toBe(404);
    expect((await t.get(path(OTHER, "https://cdn.example.com/b", 32))).status).toBe(404);
    expect(t.proxy.stats.failures).toMatchObject({ content_type: 1, bad_magic: 1 });
  });

  test("over 2 MB is refused, by Content-Length and while streaming without one", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG.subarray(0, 8));
    const t = setup({
      refs: {
        [MINT]: { image: "https://cdn.example.com/declared", pump: false },
        [OTHER]: { image: "https://cdn.example.com/streamed", pump: false },
      },
      route: (url) => {
        if (url.endsWith("/declared")) return img(big);
        const stream = new ReadableStream({
          start(c) {
            for (let i = 0; i < 3; i++) c.enqueue(big.subarray(i * 1_000_000, (i + 1) * 1_000_000));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "image/png" } });
      },
    });
    expect((await t.get(path(MINT, "https://cdn.example.com/declared", 32))).status).toBe(404);
    expect((await t.get(path(OTHER, "https://cdn.example.com/streamed", 32))).status).toBe(404);
    expect(t.proxy.stats.failures.too_large).toBe(2);
  });

  test("decompression bombs: a pixel count over the limit is refused from the header, and not retried", async () => {
    const t = setup({ env: { IMG_MAX_PIXELS: String(100 * 100) }, route: () => img(PNG) });
    const p = path(MINT, "https://cdn.example.com/a.png", 32);
    expect((await t.get(p)).status).toBe(404);
    expect((await t.get(path(MINT, "https://cdn.example.com/a.png", 96))).status).toBe(404);
    expect(t.calls).toHaveLength(1);
    expect(t.proxy.stats.failures.too_many_pixels).toBe(1);
  });

  test("hosts resolving to private addresses are never fetched; redirects to them neither", async () => {
    const t = setup({ route: () => img(PNG), resolve: async () => ["10.0.0.7"] });
    expect((await t.get(path(MINT, "https://cdn.example.com/a.png", 32))).status).toBe(404);
    expect(t.calls).toEqual([]);
    expect(t.proxy.stats.failures.unsafe_url).toBe(1);

    const r = setup({
      route: () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
    });
    expect((await r.get(path(MINT, "https://cdn.example.com/a.png", 32))).status).toBe(404);
    expect(r.calls).toEqual(["https://cdn.example.com/a.png"]);
  });

  test("closed proxy: only a known token's own image; a URL parameter is ignored; malformed input is a 400", async () => {
    const t = setup({ route: () => img(PNG), refs: { [MINT]: { image: null, pump: false } } });
    expect((await t.get(`/api/img?mint=${MINT}&s=32`)).status).toBe(404); // known, no image
    expect((await t.get(`/api/img?mint=${OTHER}&src=https://evil.example/x.png`)).status).toBe(404); // unknown
    expect(t.calls).toEqual([]);
    expect((await t.get("/api/img?mint=not-a-mint")).status).toBe(400);
    expect((await t.get(`/api/img?mint=${MINT}&s=0`)).status).toBe(400);
    expect((await t.get(`/api/img?mint=${MINT}&s=1.5`)).status).toBe(400);
    expect((await t.get(`/api/img?mint=${MINT}&v=<script>`)).status).toBe(400);
    const post = await t.proxy.handle(
      new Request("http://zf.test/api/img", { method: "POST" }),
      new URL("http://zf.test/api/img"),
      "1.2.3.4",
    );
    expect(post.status).toBe(405);
  });
});

describe("image proxy: caches and limits", () => {
  test("memory hit, then disk hit after a restart: one upstream fetch in total", async () => {
    const t = setup({ route: () => img(PNG) });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    const r1 = await t.get(p);
    expect(r1.headers.get("x-zf-cache")).toBe("miss");
    const body1 = new Uint8Array(await r1.arrayBuffer());
    const r2 = await t.get(p);
    expect(r2.headers.get("x-zf-cache")).toBe("hit");
    expect(t.proxy.stats.memoryHits).toBe(1);
    // other sizes reuse the fetched original
    expect((await t.get(path(MINT, "https://cdn.example.com/a.png", 96))).status).toBe(200);
    expect(t.calls).toHaveLength(1);
    await Bun.sleep(50); // disk writes are fire-and-forget

    const restarted = setup({ route: () => img(PNG), dir: t.dir });
    const r3 = await restarted.get(p);
    expect(r3.status).toBe(200);
    expect(new Uint8Array(await r3.arrayBuffer())).toEqual(body1);
    expect(restarted.calls).toEqual([]);
    expect(restarted.proxy.stats.diskHits).toBe(1);
  });

  test("concurrent requests for one image share one upstream fetch", async () => {
    const t = setup({
      route: async () => {
        await Bun.sleep(30);
        return img(PNG);
      },
    });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    const rs = await Promise.all([t.get(p), t.get(p), t.get(path(MINT, "https://cdn.example.com/a.png", 32))]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(t.calls).toHaveLength(1);
  });

  test("failures are negative-cached: no new upstream fetch until the back-off passes", async () => {
    const t = setup({ route: () => new Response("try later", { status: 503 }) });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    expect((await t.get(p)).status).toBe(404);
    expect((await t.get(p)).status).toBe(404);
    expect(t.calls).toHaveLength(1);
  });

  test("per-IP request limit (429 with Retry-After), separate per IP", async () => {
    const t = setup({ route: () => img(PNG), env: { IMG_RATE_RPS: "1", IMG_RATE_BURST: "2" } });
    const p = path(MINT, "https://cdn.example.com/a.png", 48);
    expect((await t.get(p)).status).toBe(200);
    expect((await t.get(p)).status).toBe(200);
    const r = await t.get(p);
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("1");
    expect((await t.get(p, {}, "5.6.7.8")).status).toBe(200);
  });

  test("per-IP cache-miss limit: cached images still serve once the upstream budget is spent", async () => {
    const t = setup({
      route: () => img(PNG),
      env: { IMG_MISS_RPS: "1", IMG_MISS_BURST: "1" },
      refs: {
        [MINT]: { image: "https://cdn.example.com/a.png", pump: false },
        [OTHER]: { image: "https://cdn.example.com/b.png", pump: false },
      },
    });
    const a = path(MINT, "https://cdn.example.com/a.png", 48);
    expect((await t.get(a)).status).toBe(200);
    expect((await t.get(path(OTHER, "https://cdn.example.com/b.png", 48))).status).toBe(429);
    expect((await t.get(a)).status).toBe(200);
  });

  test("prefetch (warm) fills the cache before the first request", async () => {
    const t = setup({ route: () => img(PNG) });
    t.proxy.warm(MINT);
    await Bun.sleep(100);
    const r = await t.get(path(MINT, "https://cdn.example.com/a.png", 96));
    expect(r.headers.get("x-zf-cache")).toBe("hit");
    expect(t.proxy.stats.prefetched).toBe(1);
  });

  test("disabled: 404 without any fetch", async () => {
    const t = setup({ route: () => img(PNG), env: { IMG_PROXY_ENABLED: "off" } });
    expect((await t.get(path(MINT, "https://cdn.example.com/a.png", 48))).status).toBe(404);
    expect(t.calls).toEqual([]);
  });

  test("the client-side version function matches the server's (protocol contract vectors)", () => {
    // Same vectors in apps/web/src/components/ui/tokenImage.test.ts (the web app mirrors imageProxyUrl).
    expect(imageVersion("")).toBe("ztntfp");
    expect(imageVersion(`https://pump.mypinata.cloud/ipfs/${QM}`)).toBe("gkevgp");
    expect(imageProxyUrl(MINT, null)).toBeNull();
    expect(imageProxyUrl(MINT, "https://a.example/x.png", 80)).toBe(`/api/img?mint=${MINT}&v=1q7q8zf&s=96`);
    expect(imageProxyUrl(MINT, "https://a.example/x.png")).toBe(`/api/img?mint=${MINT}&v=1q7q8zf`);
  });
});
