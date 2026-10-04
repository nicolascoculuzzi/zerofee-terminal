/**
 * Social links from token metadata, normalized to safe absolute https URLs (TokenSocials in
 * packages/protocol): x.com for X / Twitter, t.me for Telegram, anything else https for the website.
 *
 * Input is whatever launchers put in the JSON: handles ("@name", "name"), bare hosts ("x.com/name"),
 * http or https URLs, sometimes in the wrong field (a t.me link under "twitter"). Output never carries
 * another scheme (javascript:, data:, ...), credentials, a local or IP-literal host, or control characters.
 */

import { isIP } from "node:net";
import type { TokenSocials } from "@zerofee/protocol";
import { hasControlChars } from "./urls";

type Kind = keyof TokenSocials;

const MAX_LEN = 512;
const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "www.x.com", "www.twitter.com"]);
const TG_HOSTS = new Set(["t.me", "telegram.me", "www.t.me", "www.telegram.me", "telegram.dog"]);
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TG_HANDLE = /^[A-Za-z0-9_]{4,64}$/;

/** Parses a link (adding https:// to scheme-less host/path forms); null unless a public http(s) URL. */
function parseLink(raw: string): URL | null {
  let s = raw.trim();
  if (!s || s.length > MAX_LEN || hasControlChars(s) || /[\s<>"`]/.test(s)) return null;
  if (s.startsWith("//")) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|\?|#|$)/i.test(s)) return null;
    s = `https://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || host.endsWith(".")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  u.protocol = "https:";
  return u;
}

function kindOfHost(host: string): Kind {
  const h = host.toLowerCase();
  if (X_HOSTS.has(h)) return "x";
  if (TG_HOSTS.has(h)) return "telegram";
  return "website";
}

function xUrl(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  if (!parts.length) return null;
  const [first, second, third] = parts as [string, string?, string?];
  if (first === "i" && second === "communities" && third && /^\d{1,25}$/.test(third)) return `https://x.com/i/communities/${third}`;
  if (first === "i" || !X_HANDLE.test(first)) return null;
  if (second === "status" && third && /^\d{1,25}$/.test(third)) return `https://x.com/${first}/status/${third}`;
  return `https://x.com/${first}`;
}

function tgUrl(u: URL): string | null {
  const parts = u.pathname.split("/").filter(Boolean);
  const [first, second] = parts as [string?, string?];
  if (!first) return null;
  if (first === "joinchat" && second && /^[A-Za-z0-9_-]{8,64}$/.test(second)) return `https://t.me/joinchat/${second}`;
  if (/^\+[A-Za-z0-9_-]{8,64}$/.test(first)) return `https://t.me/${first}`;
  if (first === "s" && second && TG_HANDLE.test(second)) return `https://t.me/${second}`;
  if (!TG_HANDLE.test(first)) return null;
  return second && /^\d{1,12}$/.test(second) ? `https://t.me/${first}/${second}` : `https://t.me/${first}`;
}

function websiteUrl(u: URL): string | null {
  u.hash = "";
  return u.href.length <= MAX_LEN ? u.href : null;
}

/** One value as found in the field `field`: returns the kind it really is and its URL, or null. */
export function normalizeSocial(field: Kind, raw: unknown): { kind: Kind; url: string } | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return null;
  // Bare handles only make sense in the X / Telegram fields.
  if (field !== "website" && !v.includes("/") && !v.includes(".")) {
    const handle = v.replace(/^@/, "");
    if (field === "x" && X_HANDLE.test(handle)) return { kind: "x", url: `https://x.com/${handle}` };
    if (field === "telegram" && TG_HANDLE.test(handle)) return { kind: "telegram", url: `https://t.me/${handle}` };
    return null;
  }
  const u = parseLink(v);
  if (!u) return null;
  const kind = kindOfHost(u.hostname);
  const url = kind === "x" ? xUrl(u) : kind === "telegram" ? tgUrl(u) : websiteUrl(u);
  return url ? { kind, url } : null;
}

/**
 * Normalized socials from candidate values per field (first usable value wins). A link in the wrong field
 * (t.me under "twitter") moves to its own kind when that kind is still empty.
 */
export function normalizeSocials(fields: Partial<Record<Kind, unknown[]>>): TokenSocials {
  const out: TokenSocials = { x: null, telegram: null, website: null };
  const strays: { kind: Kind; url: string }[] = [];
  for (const field of ["x", "telegram", "website"] as const) {
    for (const raw of fields[field] ?? []) {
      const n = normalizeSocial(field, raw);
      if (!n) continue;
      if (n.kind === field) {
        out[field] = n.url;
        break;
      }
      strays.push(n);
    }
  }
  for (const s of strays) if (out[s.kind] === null) out[s.kind] = s.url;
  return out;
}
