/** Token media: metadata extraction (captured JSONs), URL and social normalization, IPFS sources. Offline. */
import { describe, expect, test } from "bun:test";
import { extractImage, extractSocials, parseMetadataJson } from "../src/media/extract";
import { isPrivateIp, isSafeUrlSyntax } from "../src/media/net";
import { checkContentType, looksLikeMarkup, sniffImage } from "../src/media/sniff";
import { normalizeSocial, normalizeSocials } from "../src/media/socials";
import {
  contentKey,
  DEFAULT_IPFS_GATEWAYS,
  extractArweave,
  extractCid,
  fetchCandidates,
  HostHealth,
  normalizeImageUrl,
  staggeredRace,
} from "../src/media/urls";
import samples from "./fixtures/metadata-samples.json";

const GW = DEFAULT_IPFS_GATEWAYS;
const QM = "QmV1kzYWKenrPrGnR56bc1tnknH6dLk4KFszDhUCR7s6Tq";
const BAFY = "bafkreicv5dyh3aydneshkq3j4a6eajc4h3yqgnk5kssyfgqtk7ikhwqs6q";
const AR = "kPdoAqDUoAxQwrnSOcKWJg9C-EWcIVrGO9xcwIr5vPI";

describe("metadata JSON extraction (captured launches)", () => {
  for (const s of samples.samples) {
    test(s.source, () => {
      const p = parseMetadataJson(s.json, GW);
      expect(p.image).toBe(s.expect.image);
      expect(p.socials).toEqual(s.expect.socials);
      expect(p.name).toBe(s.json.name.trim());
    });
  }

  test("Metaplex shape: properties.files (image types first), extensions and links", () => {
    const json = {
      name: "Meta",
      symbol: "MTA",
      properties: {
        category: "image",
        files: [
          { uri: "https://cdn.example.com/anim.mp4", type: "video/mp4" },
          { uri: `ipfs://${BAFY}`, type: "image/png" },
        ],
      },
      extensions: { twitter: "@meta_sol", telegram: "meta_portal" },
      links: { website: "meta.example" },
    };
    expect(extractImage(json, GW)).toBe(`https://pump.mypinata.cloud/ipfs/${BAFY}`);
    expect(extractSocials(json)).toEqual({
      x: "https://x.com/meta_sol",
      telegram: "https://t.me/meta_portal",
      website: "https://meta.example/",
    });
  });

  test("image key precedence and fallbacks: image > image_uri > properties.image > files > logo", () => {
    expect(extractImage({ image: "", image_uri: "https://a.example/1.png", logo: "https://a.example/logo.png" }, GW)).toBe(
      "https://a.example/1.png",
    );
    expect(extractImage({ imageUrl: "https://a.example/2.png" }, GW)).toBe("https://a.example/2.png");
    expect(extractImage({ properties: { image: `ar://${AR}` } }, GW)).toBe(`https://arweave.net/${AR}`);
    expect(extractImage({ properties: { files: [`https://a.example/f.png`] } }, GW)).toBe("https://a.example/f.png");
    expect(extractImage({ logoURI: "https://a.example/logo.png" }, GW)).toBe("https://a.example/logo.png");
    expect(extractImage({ image: "javascript:alert(1)", logo: "data:image/png;base64,AAAA" }, GW)).toBeNull();
    expect(extractImage(null, GW)).toBeNull();
    expect(extractImage([1, 2], GW)).toBeNull();
  });

  test("socials in odd places: misfiled links move to their kind, junk is dropped", () => {
    expect(extractSocials({ twitter: "https://t.me/wrongfield", telegram: "", website: "https://x.com/i/communities/1977" })).toEqual({
      x: "https://x.com/i/communities/1977",
      telegram: "https://t.me/wrongfield",
      website: null,
    });
    expect(extractSocials({ socials: { x: "solana" }, website: "vbscript:msgbox" })).toEqual({
      x: "https://x.com/solana",
      telegram: null,
      website: null,
    });
  });
});

describe("image URL normalization", () => {
  const n = (u: unknown) => normalizeImageUrl(u, GW);

  test("IPFS: every form ends up on a live gateway, query and fragment dropped", () => {
    expect(n(`ipfs://${BAFY}`)).toBe(`https://pump.mypinata.cloud/ipfs/${BAFY}`);
    expect(n(`ipfs://ipfs/${BAFY}/img.png`)).toBe(`https://pump.mypinata.cloud/ipfs/${BAFY}/img.png`);
    expect(n(BAFY)).toBe(`https://pump.mypinata.cloud/ipfs/${BAFY}`);
    expect(n(`/ipfs/${QM}`)).toBe(`https://pump.mypinata.cloud/ipfs/${QM}`);
    // retired gateways (ipfs.io, dweb.link, Cloudflare, nftstorage.link) are rewritten
    for (const h of ["ipfs.io", "dweb.link", "cloudflare-ipfs.com", "cf-ipfs.com", "nftstorage.link", "gateway.ipfs.io"]) {
      expect(n(`https://${h}/ipfs/${QM}?filename=a.png`)).toBe(`https://pump.mypinata.cloud/ipfs/${QM}`);
    }
    expect(n(`https://${BAFY}.ipfs.dweb.link/`)).toBe(`https://pump.mypinata.cloud/ipfs/${BAFY}`);
    // a live gateway (where the content is pinned) is kept, upgraded to https, path form
    expect(n(`http://desperate-moccasin-minnow.myfilebase.com/ipfs/${QM}?img-width=128`)).toBe(
      `https://desperate-moccasin-minnow.myfilebase.com/ipfs/${QM}`,
    );
    expect(n(`https://${BAFY}.ipfs.w3s.link/`)).toBe(`https://w3s.link/ipfs/${BAFY}`);
    expect(n(`https://pump.mypinata.cloud/ipfs/${QM}#x`)).toBe(`https://pump.mypinata.cloud/ipfs/${QM}`);
  });

  test("Arweave: ar:// and any arweave.net host map to arweave.net", () => {
    expect(n(`ar://${AR}`)).toBe(`https://arweave.net/${AR}`);
    expect(n(`https://abcdefgh.arweave.net/${AR}`)).toBe(`https://arweave.net/${AR}`);
    expect(n(`https://www.arweave.net/${AR}/0.png`)).toBe(`https://arweave.net/${AR}/0.png`);
    expect(extractArweave(`ar://short`)).toBeNull();
  });

  test("other http(s) URLs are kept; protocol-relative and scheme-less get https", () => {
    expect(n("https://axiomtrading-v2.axiom-cdn.io/x.webp")).toBe("https://axiomtrading-v2.axiom-cdn.io/x.webp");
    expect(n("http://cdn.example.com/a b.png")).toBe("http://cdn.example.com/a%20b.png");
    expect(n("//cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(n("cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(n("  https://cdn.example.com/a.png#frag  ")).toBe("https://cdn.example.com/a.png");
  });

  test("refused: other schemes, credentials, local hosts, control characters, traversal, junk", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "vbscript:x",
      "file:///etc/passwd",
      "blob:https://x/y",
      "ftp://example.com/a.png",
      "https://user:pass@example.com/a.png",
      "http://localhost/a.png",
      "http://printer.local/a.png",
      "https://metadata.internal/a.png",
      "https://example.com/a\n.png",
      `ipfs://${QM}/../../etc`,
      "not a url",
      "",
      42,
      null,
      `https://x.example/${"a".repeat(2_100)}`,
    ]) {
      expect(n(bad)).toBeNull();
    }
  });

  test("CIDs: forms, validation, content keys shared across hosts", () => {
    expect(extractCid(`ipfs://${QM}/meta.json`)).toEqual({ cid: QM, path: "/meta.json" });
    expect(extractCid("https://example.com/ipfs/notacid")).toBeNull();
    expect(extractCid("https://example.com/token.json")).toBeNull();
    expect(contentKey(`https://ipfs.io/ipfs/${QM}`)).toBe(contentKey(`https://pump.mypinata.cloud/ipfs/${QM}`));
    expect(contentKey(`https://arweave.net/${AR}`)).toBe(`ar:${AR}`);
    expect(contentKey("https://a.example/x.png")).toBe("https://a.example/x.png");
  });
});

describe("IPFS sources", () => {
  test("own live gateway first (untrusted), then the configured ones (trusted); retired hosts never", () => {
    expect(fetchCandidates(`https://desperate-moccasin-minnow.myfilebase.com/ipfs/${QM}`, GW)).toEqual([
      {
        url: `https://desperate-moccasin-minnow.myfilebase.com/ipfs/${QM}`,
        trusted: false,
        host: "desperate-moccasin-minnow.myfilebase.com",
      },
      { url: `https://pump.mypinata.cloud/ipfs/${QM}`, trusted: true, host: "pump.mypinata.cloud" },
      { url: `https://gateway.pinata.cloud/ipfs/${QM}`, trusted: true, host: "gateway.pinata.cloud" },
      { url: `https://ipfs.filebase.io/ipfs/${QM}`, trusted: true, host: "ipfs.filebase.io" },
      { url: `https://4everland.io/ipfs/${QM}`, trusted: true, host: "4everland.io" },
    ]);
    const viaDead = fetchCandidates(`https://ipfs.io/ipfs/${QM}`, GW);
    expect(viaDead.map((c) => c.host)).toEqual(["pump.mypinata.cloud", "gateway.pinata.cloud", "ipfs.filebase.io", "4everland.io"]);
    expect(fetchCandidates(`ar://${AR}`, GW)).toEqual([{ url: `https://arweave.net/${AR}`, trusted: true, host: "arweave.net" }]);
    expect(fetchCandidates("https://cdn.example.com/a.png", GW)).toEqual([
      { url: "https://cdn.example.com/a.png", trusted: false, host: "cdn.example.com" },
    ]);
    expect(fetchCandidates("javascript:alert(1)", GW)).toEqual([]);
  });

  test("host health: three transport failures trip a host to the back for 30 s; a success resets it", () => {
    let now = 1_000;
    const h = new HostHealth(() => now);
    const cands = [{ host: "a" }, { host: "b" }];
    h.failure("a");
    h.failure("a");
    expect(h.order(cands).map((c) => c.host)).toEqual(["a", "b"]);
    h.failure("a");
    expect(h.available("a")).toBe(false);
    expect(h.order(cands).map((c) => c.host)).toEqual(["b", "a"]);
    now += 30_001;
    expect(h.available("a")).toBe(true);
    h.success("a");
    h.failure("a");
    expect(h.available("a")).toBe(true);
  });

  test("staggered race: first success wins, the next source starts after the stagger or a failure, losers abort", async () => {
    const started: string[] = [];
    const aborted: string[] = [];
    const t0 = Date.now();
    const v = await staggeredRace(
      ["slow", "fail", "fast"],
      (c, signal) => {
        started.push(c);
        signal.addEventListener("abort", () => aborted.push(c));
        if (c === "fail") return Promise.reject(new Error("nope"));
        return new Promise((r) => setTimeout(() => r(c), c === "slow" ? 500 : 10));
      },
      50,
    );
    expect(v).toBe("fast");
    expect(started).toEqual(["slow", "fail", "fast"]);
    expect(aborted).toContain("slow");
    expect(Date.now() - t0).toBeLessThan(400);
    await expect(staggeredRace([1, 2], () => Promise.reject(new Error("x")), 10)).rejects.toBeInstanceOf(AggregateError);
    await expect(staggeredRace([], () => Promise.resolve(1), 10)).rejects.toBeInstanceOf(AggregateError);
  });
});

describe("social links", () => {
  test("X: handles, @handles, twitter.com and mobile links become x.com; statuses and communities kept, queries dropped", () => {
    const x = (v: string) => normalizeSocial("x", v)?.url ?? null;
    expect(x("solana")).toBe("https://x.com/solana");
    expect(x("@solana")).toBe("https://x.com/solana");
    expect(x("twitter.com/solana")).toBe("https://x.com/solana");
    expect(x("http://mobile.twitter.com/solana/")).toBe("https://x.com/solana");
    expect(x("https://x.com/solana/status/123?s=20")).toBe("https://x.com/solana/status/123");
    expect(x("https://twitter.com/i/communities/1890")).toBe("https://x.com/i/communities/1890");
    expect(x("https://x.com/")).toBeNull();
    expect(x("handle_that_is_too_long_for_x")).toBeNull();
    expect(x("https://x.com/i/flow/login")).toBeNull();
  });

  test("Telegram: handles, t.me / telegram.me links, invites and joinchat", () => {
    const tg = (v: string) => normalizeSocial("telegram", v)?.url ?? null;
    expect(tg("portal_sol")).toBe("https://t.me/portal_sol");
    expect(tg("@portal_sol")).toBe("https://t.me/portal_sol");
    expect(tg("telegram.me/portal_sol")).toBe("https://t.me/portal_sol");
    expect(tg("https://t.me/+AbCdEfGh123")).toBe("https://t.me/+AbCdEfGh123");
    expect(tg("https://t.me/joinchat/AbCdEfGh123")).toBe("https://t.me/joinchat/AbCdEfGh123");
    expect(tg("abc")).toBeNull();
  });

  test("websites: https only (http upgraded), no other schemes, credentials, ports, IP or local hosts", () => {
    const w = (v: string) => normalizeSocial("website", v)?.url ?? null;
    expect(w("example.com")).toBe("https://example.com/");
    expect(w("http://example.com/path?q=1#frag")).toBe("https://example.com/path?q=1");
    for (const bad of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "https://user:pw@example.com",
      "https://example.com:8443/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://localhost:3000",
      "https://intranet.local",
      'https://example.com/"><script>',
      "https://exa mple.com",
      "justaword",
    ]) {
      expect(w(bad)).toBeNull();
    }
  });

  test("first usable value per field wins", () => {
    expect(normalizeSocials({ x: [null, "", "not valid!", "solana", "other"] }).x).toBe("https://x.com/solana");
  });
});

describe("image type checks", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  test("magic bytes", () => {
    expect(sniffImage(png)).toBe("png");
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new TextEncoder().encode("GIF89a...."))).toBe("gif");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(looksLikeMarkup(new TextEncoder().encode("﻿  \n<svg/>"))).toBe(true);
    expect(looksLikeMarkup(png)).toBe(false);
  });

  test("upstream Content-Type allowlist", () => {
    for (const ok of ["image/png", "image/jpeg; charset=binary", "IMAGE/WEBP", "image/gif", "application/octet-stream", null, ""]) {
      expect(checkContentType(ok)).toBe("accept");
    }
    expect(checkContentType("image/svg+xml")).toBe("svg");
    for (const bad of ["text/html", "application/json", "image/avif", "image/heic", "text/xml", "application/xhtml+xml"]) {
      expect(checkContentType(bad)).toBe("content_type");
    }
  });

  test("SSRF guard ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.5.4",
      "192.168.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["::1", "::", "::ffff:10.0.0.1", "::127.0.0.1", "fe80::1", "fd00::1", "64:ff9b::a00:1", "ff02::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateIp(ip)).toBe(false);
    expect(isSafeUrlSyntax("http://[fd00::1]/x")).toBe(false);
    expect(isSafeUrlSyntax("http://8.8.8.8/x")).toBe(true);
  });
});
