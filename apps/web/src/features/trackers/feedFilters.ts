import { type BlacklistEntry, type Blacklists, compileBlacklists, isBlacklisted, normalizeHandle } from "../../lib/filters";
import type { SocialPost, TokenRef, TrackedTrade, Trade } from "../../protocol";
import { useMarket } from "../../state/market";
import type { TrackedHandle, TrackedWallet } from "../../state/trackers";
import type { FeedScope, TradeFilters } from "./prefs";

const HOUR_MS = 3_600_000;

/** Trade-size bar width in % of the row (DESIGN.md 4.9): 60 × min(1, log10(1 + sol) / log10(11)); 10 SOL fills it. */
/** Size-bar width; an unknown size (null) draws no bar. */
export function sizeBarPct(sol: number | null): number {
  if (sol === null || !(sol > 0)) return 0;
  return 60 * Math.min(1, Math.log10(1 + sol) / Math.log10(11));
}

/** Market cap at trade time in SOL, exact from the trade's own SOL and USD prices. */
export function mcSol(trade: Pick<Trade, "marketCapUsd" | "priceSol" | "priceUsd">): number | null {
  const { marketCapUsd: mc, priceSol, priceUsd } = trade;
  return mc !== null && priceSol !== null && priceUsd !== null && priceUsd > 0 ? (mc * priceSol) / priceUsd : null;
}

/**
 * Predicate for tokens hidden by the user's blacklists. Tracked trades only carry a TokenRef,
 * so the mint list always applies and dev / funder / X rules apply while the token is in the
 * live set (read once per call, not reactively).
 */
export function tokenBlocker(blacklists: Blacklists): (mint: string) => boolean {
  const compiled = compileBlacklists(blacklists);
  if (compiled.size === 0) return () => false;
  const tokens = useMarket.getState().tokens;
  return (mint) => {
    if (compiled.tokens.has(mint)) return true;
    const summary = tokens[mint];
    return summary ? isBlacklisted(summary, compiled) : false;
  };
}

/** The toolbar search, lower-cased and trimmed; a leading "$" or "@" is ignored. */
export function normalizeQuery(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[$@]/, "");
}

export function walletMatches(w: Pick<TrackedWallet, "name" | "address">, q: string): boolean {
  return !q || w.name.toLowerCase().includes(q) || w.address.toLowerCase().includes(q);
}

export function tokenMatches(t: Pick<TokenRef, "symbol" | "name" | "mint">, q: string): boolean {
  return (
    !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || (q.length >= 4 && t.mint.toLowerCase().startsWith(q))
  );
}

/**
 * Live trades after the toolbar filters, the blacklists and the search (wallet name or address,
 * token ticker, name or CA). `now` is only read for "Only tokens under 1h".
 */
export function filterTrades(
  items: readonly TrackedTrade[],
  f: TradeFilters,
  blocked: (mint: string) => boolean,
  opts: { query?: string; wallets?: ReadonlyMap<string, TrackedWallet>; now?: number } = {},
): TrackedTrade[] {
  const q = opts.query ?? "";
  const now = opts.now ?? Date.now();
  const pads = f.launchpads.length > 0 ? new Set(f.launchpads) : null;
  return items.filter(({ trade, token }) => {
    if (f.side !== "all" && trade.side !== f.side) return false;
    // Unknown (null) fails a min or a max: unknown is not zero (DESIGN.md 4.16).
    const sol = trade.solAmount;
    const mc = trade.marketCapUsd;
    if (f.minSol !== null && (sol === null || sol < f.minSol)) return false;
    if (f.mcMin !== null && (mc === null || mc < f.mcMin)) return false;
    if (f.mcMax !== null && (mc === null || mc > f.mcMax)) return false;
    if (pads && !pads.has(token.launchpad)) return false;
    if (f.under1h && now - token.createdAt >= HOUR_MS) return false;
    if (q) {
      const w = opts.wallets?.get(trade.maker);
      const byWallet = walletMatches({ name: w?.name ?? "", address: trade.maker }, q);
      if (!byWallet && !tokenMatches(token, q)) return false;
    }
    return !blocked(token.mint);
  });
}

/** Which per-handle toggle governs a post kind. */
export function postToggle(kind: SocialPost["kind"]): "tweets" | "profile" | "follows" {
  if (kind === "profile_update") return "profile";
  if (kind === "follow") return "follows";
  return "tweets";
}

export function blockedHandles(xHandles: readonly BlacklistEntry[]): Set<string> {
  return new Set(xHandles.map((e) => normalizeHandle(e.value)));
}

/**
 * Posts the user wants to see: blacklisted handles never show; tracked handles follow their
 * Tweets / Profile updates / Follows toggles; untracked handles show everything unless the
 * feed is scoped to "My list". The search matches handle, display name, text or a mentioned ticker.
 */
export function visiblePosts(
  posts: readonly SocialPost[],
  handles: ReadonlyMap<string, TrackedHandle>,
  blocked: ReadonlySet<string>,
  scope: FeedScope,
  query = "",
): SocialPost[] {
  return posts.filter((p) => {
    const handle = normalizeHandle(p.handle);
    if (blocked.has(handle)) return false;
    const tracked = handles.get(handle);
    if (!tracked ? scope !== "all" : !tracked[postToggle(p.kind)]) return false;
    if (!query) return true;
    return (
      handle.includes(query) ||
      p.displayName.toLowerCase().includes(query) ||
      p.text.toLowerCase().includes(query) ||
      p.mentions.some((m) => tokenMatches(m, query))
    );
  });
}

export function handleMap(handles: readonly TrackedHandle[]): Map<string, TrackedHandle> {
  return new Map(handles.map((h) => [h.handle, h]));
}
