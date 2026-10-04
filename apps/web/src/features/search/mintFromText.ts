/**
 * The token address in a pasted string: a bare contract address, or a link from the usual terminals and
 * explorers (pump.fun /coin/<mint>, DexScreener /solana/<pair>, Axiom /meme/<pair>, GMGN /sol/token/<mint>,
 * Solscan / Birdeye /token/<mint>, anything with ?address= or ?token=). Pair addresses come back as they are: the
 * server answers a pool address with the coin it trades (TokenNotFoundBody.redirect).
 */
import { isBase58Address } from "../../lib/address";

const RUN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const QUERY_KEYS = ["address", "token", "mint", "ca", "outputMint", "inputCurrency", "outputCurrency"];

/** The last base58 address-sized run in `s` (GMGN prefixes some paths: "abcd_<mint>"). */
function lastRun(s: string): string | null {
  let found: string | null = null;
  for (const m of s.matchAll(RUN)) if (isBase58Address(m[0])) found = m[0];
  return found;
}

export function mintFromText(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 2_048) return null;
  if (isBase58Address(t)) return t;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    return null;
  }
  if (!url.hostname.includes(".")) return null;
  for (const k of QUERY_KEYS) {
    const v = url.searchParams.get(k);
    if (v && isBase58Address(v) && v !== "So11111111111111111111111111111111111111112") return v;
  }
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponentSafe);
  for (let i = segments.length - 1; i >= 0; i--) {
    const run = lastRun(segments[i] as string);
    if (run) return run;
  }
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
