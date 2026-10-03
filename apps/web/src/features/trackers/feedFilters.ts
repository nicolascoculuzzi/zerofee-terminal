import { type BlacklistEntry, type Blacklists, compileBlacklists, isBlacklisted, normalizeHandle } from "../../lib/filters";
import type { SocialPost, TrackedTrade } from "../../protocol";
import { useMarket } from "../../state/market";
import type { TrackedHandle } from "../../state/trackers";
import type { FeedScope, TradeFilters } from "./prefs";

export function tradeFiltersActive(f: TradeFilters): boolean {
  return f.side !== "all" || f.minSol !== null || f.maxMc !== null;
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

export function filterTrades(items: TrackedTrade[], f: TradeFilters, blocked: (mint: string) => boolean): TrackedTrade[] {
  return items.filter(({ trade, token }) => {
    if (f.side !== "all" && trade.side !== f.side) return false;
    if (f.minSol !== null && trade.solAmount < f.minSol) return false;
    if (f.maxMc !== null && trade.marketCapUsd > f.maxMc) return false;
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
 * feed is scoped to "My list".
 */
export function visiblePosts(
  posts: SocialPost[],
  handles: ReadonlyMap<string, TrackedHandle>,
  blocked: ReadonlySet<string>,
  scope: FeedScope,
): SocialPost[] {
  return posts.filter((p) => {
    const handle = normalizeHandle(p.handle);
    if (blocked.has(handle)) return false;
    const tracked = handles.get(handle);
    if (!tracked) return scope === "all";
    return tracked[postToggle(p.kind)];
  });
}

export function handleMap(handles: TrackedHandle[]): Map<string, TrackedHandle> {
  return new Map(handles.map((h) => [h.handle, h]));
}
