/**
 * What we show from a token's metadata JSON: name, symbol, description, image and socials.
 *
 * Shapes seen in the wild (fixtures in apps/server/test/fixtures/metadata/):
 *  - pump.fun: { name, symbol, description, image, showName, createdOn, twitter?, telegram?, website? }
 *  - third-party launchers on pump (Axiom, uxento, agency pads ...): the same keys, own CDNs for image and JSON
 *  - Metaplex token standard: image plus properties.files [{ uri, type }], properties.category, and links in
 *    `extensions` or `links`
 *  - token lists and assorted tools: image_uri, imageUrl, image_url, logo, logoURI, icon
 */
import type { TokenSocials } from "@zerofee/protocol";
import { normalizeSocials } from "./socials";
import { normalizeImageUrl } from "./urls";

export interface ParsedMetadata {
  name: string | null;
  symbol: string | null;
  description: string | null;
  image: string | null;
  socials: TokenSocials;
}

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

function str(v: unknown, max = 2_000): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

const IMAGE_KEYS = ["image", "image_uri", "imageUri", "imageUrl", "image_url", "imageURI"] as const;
const FALLBACK_IMAGE_KEYS = ["logo", "logoURI", "logoUrl", "logo_uri", "icon", "iconUrl"] as const;
const IMAGE_FILE_TYPE = /^image\/(png|jpe?g|webp|gif)$/i;

/** First usable image URL: the image keys, then properties.files (image types first), then logo-ish keys. */
export function extractImage(json: unknown, gateways: readonly string[]): string | null {
  const o = obj(json);
  const props = obj(o.properties);
  for (const k of IMAGE_KEYS) {
    const u = normalizeImageUrl(o[k], gateways);
    if (u) return u;
  }
  const propImage = normalizeImageUrl(props.image, gateways);
  if (propImage) return propImage;
  const files = Array.isArray(props.files) ? props.files : [];
  const entries = files.map((f) => (typeof f === "string" ? { uri: f, type: "" } : { uri: obj(f).uri, type: str(obj(f).type, 64) ?? "" }));
  const ranked = [...entries.filter((f) => IMAGE_FILE_TYPE.test(f.type)), ...entries.filter((f) => !f.type)];
  for (const f of ranked) {
    const u = normalizeImageUrl(f.uri, gateways);
    if (u) return u;
  }
  for (const k of FALLBACK_IMAGE_KEYS) {
    const u = normalizeImageUrl(o[k], gateways);
    if (u) return u;
  }
  return null;
}

/** Socials from top-level keys, `extensions`, `links`, `properties.links` and a `socials` object. */
export function extractSocials(json: unknown): TokenSocials {
  const o = obj(json);
  const places = [o, obj(o.extensions), obj(o.links), obj(obj(o.properties).links), obj(o.socials)];
  const pick = (...keys: string[]) => places.flatMap((p) => keys.map((k) => p[k]));
  return normalizeSocials({
    x: pick("twitter", "x", "twitter_url", "twitterUrl", "x_url"),
    telegram: pick("telegram", "tg", "telegram_url", "telegramUrl"),
    website: pick("website", "web", "site", "website_url", "websiteUrl", "external_url"),
  });
}

export function parseMetadataJson(json: unknown, gateways: readonly string[]): ParsedMetadata {
  const o = obj(json);
  return {
    name: str(o.name, 64),
    symbol: str(o.symbol, 32),
    description: str(o.description, 1_000),
    image: extractImage(o, gateways),
    socials: extractSocials(o),
  };
}
