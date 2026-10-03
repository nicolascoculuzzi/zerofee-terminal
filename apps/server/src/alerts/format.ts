/**
 * Alert text. Token names and symbols are chosen by whoever launched the coin, so they are treated as
 * hostile: control and bidi characters removed, whitespace collapsed, length capped, and anything that
 * looks like a link defanged ("." -> "․" one-dot leader) so a coin called "claim-airdrop.xyz" cannot
 * become a clickable link in a Telegram or Discord message. Every link we send points at our own app.
 */
import type { AlertCurrency } from "@zerofee/protocol";
import { hasControlChars } from "../api/validate";

const URLISH = /(https?:\/\/|www\.|[a-z0-9-]\.[a-z]{2,})/i;

export function sanitizeUntrusted(v: string | null | undefined, max: number): string {
  if (!v) return "";
  let out = "";
  for (const ch of v) out += hasControlChars(ch) ? " " : ch;
  out = out.replace(/\s+/g, " ").trim();
  if (URLISH.test(out)) out = out.replaceAll("://", " ").replaceAll(".", "․");
  const chars = [...out];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : out;
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** Prices span 1e-10..1e5: significant digits for small values, cents for large ones. */
export function fmtPrice(v: number, currency: AlertCurrency): string {
  const unit = currency === "usd" ? "$" : "";
  const suffix = currency === "sol" ? " SOL" : "";
  let s: string;
  if (v >= 1) s = v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 4 });
  else if (v === 0) s = "0";
  else if (v < 1e-9) s = v.toExponential(3);
  else
    s = v
      .toFixed(Math.min(20, Math.ceil(-Math.log10(v)) + 3))
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  return `${unit}${s}${suffix}`;
}

/** Market caps in compact notation: $1.23M, 45.6K SOL. */
export function fmtCap(v: number, currency: AlertCurrency): string {
  const unit = currency === "usd" ? "$" : "";
  const suffix = currency === "sol" ? " SOL" : "";
  const abs = Math.abs(v);
  const [div, sym] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const n = v / div;
  const fixed = n.toFixed(n >= 100 || div === 1 ? 0 : 2);
  const s = fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  return `${unit}${s}${sym}${suffix}`;
}

export function fmtSol(v: number): string {
  return `${v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2)} SOL`;
}

/** Escapes Discord markdown so text renders literally. */
export function escapeDiscord(s: string): string {
  return s.replace(/([\\*_~`|>[\]()#:-])/g, "\\$1");
}
