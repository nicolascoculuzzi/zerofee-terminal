/**
 * Social and token links as safe https hrefs plus a short label and the logo to show.
 *
 * Accepts both shapes a token's socials come in: the server's absolute URLs (packages/protocol TokenSocials:
 * x.com / t.me / https website) and the simulated data's handles and bare domains. Anything that is not an
 * https URL on a public host (javascript:, data:, credentials, ports, IP or local hosts) yields null and is
 * not rendered.
 */

export type SocialKind = "x" | "telegram" | "website";
/** The logo a link shows: brand marks for X, Telegram, Discord, pump.fun and DexScreener, else a globe. */
export type LinkIcon = "x" | "telegram" | "discord" | "pump" | "dexscreener" | "globe";

export interface SafeLink {
  href: string;
  label: string;
  icon: LinkIcon;
}

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const TG_HANDLE = /^[A-Za-z0-9_]{4,64}$/;
const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const TG_HOSTS = new Set(["t.me", "www.t.me", "telegram.me", "www.telegram.me"]);

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** An https URL on a public, dotted host, or null. Scheme-less "host/path" gets https://. */
export function safeHttpsUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s || s.length > 512 || hasControlChars(s) || /[\s<>"`]/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|\?|#|$)/i.test(s) ? `https://${s}` : null;
  if (!withScheme) return null;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("[") || host.endsWith(".local") || host.endsWith(".localhost"))
    return null;
  u.protocol = "https:";
  u.hash = "";
  return u;
}

function iconForHost(host: string): LinkIcon {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (X_HOSTS.has(h) || X_HOSTS.has(`www.${h}`)) return "x";
  if (TG_HOSTS.has(h)) return "telegram";
  if (h === "discord.gg" || h === "discord.com" || h === "discordapp.com") return "discord";
  if (h === "pump.fun" || h.endsWith(".pump.fun")) return "pump";
  if (h === "dexscreener.com") return "dexscreener";
  return "globe";
}

const display = (u: URL) => `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}${u.search}`;

/** One social value (URL, handle or bare domain) as a safe link, or null. */
export function socialLink(kind: SocialKind, raw: string | null | undefined): SafeLink | null {
  if (!raw) return null;
  const v = raw.trim();
  if (kind === "x") {
    const u = v.includes("://") || /^(www\.|mobile\.)?(x|twitter)\.com\//i.test(v) ? safeHttpsUrl(v) : null;
    const path = u ? (X_HOSTS.has(u.hostname.toLowerCase()) ? u.pathname : null) : `/${v.replace(/^@/, "")}`;
    if (path === null) return null;
    const [first, second, third] = path.split("/").filter(Boolean) as [string?, string?, string?];
    if (first === "i" && second === "communities" && third && /^\d+$/.test(third))
      return { href: `https://x.com/i/communities/${third}`, label: "X community", icon: "x" };
    if (!first || first === "i" || !X_HANDLE.test(first)) return null;
    if (second === "status" && third && /^\d+$/.test(third))
      return { href: `https://x.com/${first}/status/${third}`, label: "Tweet", icon: "x" };
    return { href: `https://x.com/${first}`, label: `@${first}`, icon: "x" };
  }
  if (kind === "telegram") {
    const u = v.includes("://") || /^(www\.)?(t|telegram)\.me\//i.test(v) ? safeHttpsUrl(v) : null;
    const path = u ? (TG_HOSTS.has(u.hostname.toLowerCase()) ? u.pathname : null) : `/${v.replace(/^@/, "")}`;
    if (path === null) return null;
    const parts = path.split("/").filter(Boolean);
    const first = parts[0] ?? "";
    if (first === "joinchat" && parts[1] && /^[A-Za-z0-9_-]{8,64}$/.test(parts[1]))
      return { href: `https://t.me/joinchat/${parts[1]}`, label: "Telegram invite", icon: "telegram" };
    if (/^\+[A-Za-z0-9_-]{8,64}$/.test(first)) return { href: `https://t.me/${first}`, label: "Telegram invite", icon: "telegram" };
    if (!TG_HANDLE.test(first)) return null;
    return { href: `https://t.me/${first}`, label: `t.me/${first}`, icon: "telegram" };
  }
  const u = safeHttpsUrl(v);
  if (!u) return null;
  return { href: u.href, label: display(u), icon: iconForHost(u.hostname) };
}

/** Links every token gets from its mint: its pump.fun page (pump coins) and DexScreener. */
export function tokenLinks(mint: string, opts: { pump: boolean }): SafeLink[] {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return [];
  const out: SafeLink[] = [];
  if (opts.pump) out.push({ href: `https://pump.fun/coin/${mint}`, label: "pump.fun", icon: "pump" });
  out.push({ href: `https://dexscreener.com/solana/${mint}`, label: "DexScreener", icon: "dexscreener" });
  return out;
}
