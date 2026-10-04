#!/usr/bin/env bun
/**
 * Fetches each platform's official site icon and writes a 64 x 64 WebP to public/venues/<id>.webp, then
 * prints the source URLs for LOGOS.md. Run by hand when a platform changes its icon:
 *
 *   bun apps/web/scripts/fetch-venue-logos.ts [id ...]        (DRY=1 lists candidates without writing)
 *
 * Only raster icons are used (PNG / JPEG / WebP / GIF, or the PNG inside a .ico); SVGs from third-party
 * sites are never bundled. X, Telegram, Discord and Solana come from the simple-icons package instead.
 */
import { join } from "node:path";

const PLATFORMS: Record<string, { site: string; icon?: string }> = {
  pump: { site: "https://pump.fun" },
  pumpswap: { site: "https://swap.pump.fun" },
  mayhem: { site: "https://pump.fun" },
  bonk: { site: "https://bonk.fun" },
  // the logo StonkFun publishes in its on-chain Raydium LaunchLab PlatformConfig (6BwHHDg3...) `img` field
  stonkfun: { site: "https://www.stonkfun.xyz", icon: "https://www.stonkfun.xyz/stonkfun-logo.png" },
  raydium: { site: "https://raydium.io" },
  meteora: { site: "https://www.meteora.ag" },
  bags: { site: "https://bags.fm" },
  moonit: { site: "https://moon.it" },
  boop: { site: "https://boop.fun" },
  // heaven.xyz's own favicon, through Google's favicon cache (the site refuses some networks)
  heaven: { site: "https://heaven.xyz", icon: "https://www.google.com/s2/favicons?domain=heaven.xyz&sz=128" },
  jupiter: { site: "https://jup.ag" },
  orca: { site: "https://www.orca.so" },
  dexscreener: { site: "https://dexscreener.com", icon: "https://dexscreener.com/favicon.png" },
};

const OUT = join(import.meta.dir, "..", "public", "venues");
const SIZE = 64;
const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36" };

async function get(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000), redirect: "follow" });
  } catch {
    return null;
  }
}

/** Icon candidates from <link rel=icon|apple-touch-icon> and the web manifest, biggest first. */
async function candidates(site: string): Promise<string[]> {
  const out: { url: string; size: number }[] = [];
  const r = await get(site);
  const html = r?.ok ? await r.text() : "";
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /rel=["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    if (!rel.includes("icon")) continue;
    const href = /href=["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href) continue;
    const sizes = /sizes=["']?(\d+)x/i.exec(tag)?.[1];
    out.push({
      url: new URL(href.replace(/&amp;/g, "&"), r?.url ?? site).href,
      size: sizes ? Number(sizes) : rel.includes("apple") ? 180 : 32,
    });
  }
  const manifest = /<link\b[^>]*rel=["']?manifest["']?[^>]*href=["']?([^"'\s>]+)/i.exec(html)?.[1];
  if (manifest) {
    const mr = await get(new URL(manifest, r?.url ?? site).href);
    try {
      const j = (await mr?.json()) as { icons?: { src: string; sizes?: string }[] };
      for (const i of j.icons ?? [])
        out.push({ url: new URL(i.src, mr?.url ?? site).href, size: Number(/^(\d+)/.exec(i.sizes ?? "")?.[1] ?? 64) });
    } catch {
      /* no manifest */
    }
  }
  out.push({ url: new URL("/apple-touch-icon.png", site).href, size: 180 }, { url: new URL("/favicon.ico", site).href, size: 16 });
  return [...new Map(out.sort((a, b) => b.size - a.size).map((c) => [c.url, c])).values()].map((c) => c.url);
}

/** The largest PNG stored inside an ICO container, if any. */
function pngFromIco(b: Uint8Array): Uint8Array | null {
  if (b.length < 6 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let best: Uint8Array | null = null;
  let bestW = 0;
  for (let i = 0; i < dv.getUint16(4, true); i++) {
    const e = 6 + i * 16;
    if (e + 16 > b.length) break;
    const w = b[e] || 256;
    const size = dv.getUint32(e + 8, true);
    const off = dv.getUint32(e + 12, true);
    const data = b.subarray(off, off + size);
    if (data[0] === 0x89 && data[1] === 0x50 && w > bestW) {
      best = data;
      bestW = w;
    }
  }
  return best;
}

async function raster(url: string): Promise<Uint8Array | null> {
  const r = await get(url);
  if (!r?.ok) return null;
  let b = new Uint8Array(await r.arrayBuffer());
  if (url.toLowerCase().includes(".ico") || (b[0] === 0 && b[2] === 1)) b = pngFromIco(b) ?? new Uint8Array(0);
  if (!b.length || b[0] === 0x3c) return null; // empty or markup (SVG / HTML)
  try {
    const meta = await new Bun.Image(b).metadata();
    if (Math.min(meta.width, meta.height) < 32) return null;
    const k = SIZE / Math.max(meta.width, meta.height);
    return await new Bun.Image(b)
      .resize(Math.max(1, Math.round(meta.width * k)), Math.max(1, Math.round(meta.height * k)), { fit: "fill" })
      .webp({ quality: 90 })
      .bytes();
  } catch {
    return null;
  }
}

const only = process.argv.slice(2);
for (const [id, p] of Object.entries(PLATFORMS)) {
  if (only.length && !only.includes(id)) continue;
  const list = p.icon ? [p.icon] : await candidates(p.site);
  if (process.env.DRY) {
    console.log(id, list.join("  "));
    continue;
  }
  let done = false;
  for (const url of list) {
    const webp = await raster(url);
    if (!webp) continue;
    await Bun.write(join(OUT, `${id}.webp`), webp);
    console.log(`${id}\t${url}\t${webp.byteLength} B`);
    done = true;
    break;
  }
  if (!done) console.log(`${id}\tNO RASTER ICON (${list.length} candidates)`);
}
