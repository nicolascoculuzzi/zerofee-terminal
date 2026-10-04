import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TokenAvatar } from "./TokenAvatar";
import { imageVersion, proxySize, tokenImageSrc } from "./tokenImage";

const MINT = "6FrwqBPGwwbyxwzwkWnks2qmVRXbu53LGnhnvM7apump";

describe("token image URLs (mirror of packages/protocol media.ts)", () => {
  test("same version vectors as the server (apps/server/test/imageProxy.test.ts)", () => {
    expect(imageVersion("")).toBe("ztntfp");
    expect(imageVersion("https://pump.mypinata.cloud/ipfs/QmV1kzYWKenrPrGnR56bc1tnknH6dLk4KFszDhUCR7s6Tq")).toBe("gkevgp");
    expect(imageVersion("https://a.example/x.png")).toBe("1q7q8zf");
  });

  test("size buckets: at most 2x the box, rounded up to the proxy's sizes", () => {
    expect(proxySize(16, 1)).toBe(32);
    expect(proxySize(40, 1)).toBe(48);
    expect(proxySize(40, 2)).toBe(96);
    expect(proxySize(48, 3)).toBe(96); // DPR capped at 2
    expect(proxySize(28, 2)).toBe(64);
    expect(proxySize(500, 2)).toBe(256);
  });

  test("metadata URLs become same-origin proxy URLs; proxied URLs get their size", () => {
    expect(tokenImageSrc(MINT, "https://a.example/x.png", 40, 2)).toBe(`/api/img?mint=${MINT}&v=1q7q8zf&s=96`);
    expect(tokenImageSrc(MINT, `/api/img?mint=${MINT}&v=1q7q8zf`, 20, 1)).toBe(`/api/img?mint=${MINT}&v=1q7q8zf&s=32`);
    expect(tokenImageSrc(MINT, `/api/img?mint=${MINT}&v=1q7q8zf&s=256`, 16, 1)).toBe(`/api/img?mint=${MINT}&v=1q7q8zf&s=32`);
  });

  test("nothing else is ever loaded: missing, foreign, scriptable or mismatched sources give the monogram", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "blob:https://x/1",
      "/other/path.png",
      "//evil.example/x.png",
      "ipfs://QmV1kzYWKenrPrGnR56bc1tnknH6dLk4KFszDhUCR7s6Tq",
      "/api/img?mint=SomeOtherMint1111111111111111111111&v=1",
    ]) {
      expect(tokenImageSrc(MINT, bad, 40, 2)).toBeNull();
    }
    expect(tokenImageSrc("", "https://a.example/x.png", 40)).toBeNull();
  });
});

describe("TokenAvatar fallback (server-rendered markup)", () => {
  const render = (props: Partial<Parameters<typeof TokenAvatar>[0]>) =>
    renderToStaticMarkup(createElement(TokenAvatar, { mint: MINT, symbol: "wif", imageUri: null, ...props }));

  test("no image (simulated coins): the monogram only, on its fill, in the fixed box", () => {
    const html = render({ size: "lg" });
    expect(html).not.toContain("<img");
    expect(html).toContain(">WI<");
    expect(html).toContain("size-10");
    expect(html).toContain("background:var(--zf-mono-");
  });

  test("with an image: the monogram stays drawn and the proxied image loads over it, lazily and async", () => {
    const html = render({ size: "card", imageUri: "https://a.example/x.png" });
    expect(html).toContain(">WI<");
    expect(html).toMatch(/<img[^>]+src="\/api\/img\?mint=6Frw[^"]+&amp;v=1q7q8zf&amp;s=(48|96)"/);
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain("object-cover");
    expect(html).toContain("opacity-0"); // fades in on load, inside the same box
    expect(html).toContain("size-card-avatar");
  });

  test("an unsafe image URL is never put in the markup", () => {
    const html = render({ size: "sm", imageUri: "javascript:alert(1)" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });

  test("launchpad badge is the platform's logo; 'other' keeps the neutral letter", () => {
    const pump = render({ size: "card", launchpad: "pump" });
    expect(pump).toContain("/venues/pump.webp");
    expect(pump).toContain('aria-label="Pump"');
    const other = render({ size: "card", launchpad: "other" });
    expect(other).not.toContain("/venues/");
    expect(other).toContain(">X</span>");
    expect(render({ size: "xs", launchpad: "pump" })).not.toContain("/venues/"); // small avatars have no badge
  });
});
