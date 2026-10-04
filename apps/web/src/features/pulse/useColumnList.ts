import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { compileBlacklists, compileFilter, isBlacklisted, matchesFilter } from "../../lib/filters";
import { compareKnown } from "../../lib/sort";
import type { PulseColumnId, TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { emptyList, type ListState, queuedCount, RELEASE_MS, RESORT_MS, sameList, stepList } from "./liveList";
import { rememberToken, type SortKey, seenToken, usePulseUi } from "./store";

function matchesSearch(t: TokenSummary, q: string): boolean {
  if (!q) return true;
  return t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.mint.toLowerCase().startsWith(q);
}

const SORT_VALUE: Record<Exclude<SortKey, "default">, (t: TokenSummary) => number | null> = {
  mc: (t) => t.marketCapUsd,
  volume: (t) => t.volumeUsd,
  holders: (t) => t.holders,
  txns: (t) => t.txns,
};

export interface ColumnList {
  /** Mints matching the column right now, in sort order. */
  incoming: string[];
  /** What the column renders: frozen order and membership while paused. */
  shown: string[];
  /** Matches waiting behind the "N new" bar while frozen. */
  queued: number;
  frozen: boolean;
  inserted: ReadonlyMap<string, number>;
  /** Applies the queue now (an "N new" click). */
  apply: () => void;
  token: (mint: string) => TokenSummary | undefined;
}

/**
 * One column's list (DESIGN.md 6.7): filters, blacklists and search over the market store, the
 * optional user sort, then the live-calm engine. `paused` is hover, keyboard focus, P or
 * Shift+P; after it ends the queue applies 300 ms later in one batch. A user query change
 * (search, filters, sort) re-syncs at once; a blacklisted card leaves at once without
 * releasing the queue.
 */
/** Mints matching a column right now (filters, blacklists, search), in its sort order. */
export function useIncoming(column: PulseColumnId) {
  const mints = useMarket((s) => s.columns[column]);
  const tokens = useMarket((s) => s.tokens);
  const filter = useSettings((s) => s.columns[column].filters[s.columns[column].activeFilter]);
  const search = useSettings((s) => s.columns[column].search.trim().toLowerCase());
  const blacklists = useSettings((s) => s.blacklists);
  const sort = usePulseUi((s) => s.sort[column]);
  const compiled = useMemo(() => compileFilter(filter), [filter]);
  const blocked = useMemo(() => compileBlacklists(blacklists), [blacklists]);

  const incoming = useMemo(() => {
    const now = Date.now();
    const list = mints.filter((m) => {
      const t = tokens[m];
      return t !== undefined && !isBlacklisted(t, blocked) && matchesFilter(t, compiled, now) && matchesSearch(t, search);
    });
    if (sort !== "default") {
      const value = SORT_VALUE[sort];
      // Highest first; unknown values (null from the live server) last, never as 0.
      list.sort((a, b) => compareKnown(value(tokens[a] as TokenSummary), value(tokens[b] as TokenSummary), -1));
    }
    return list;
  }, [mints, tokens, blocked, compiled, search, sort]);

  return { incoming, tokens, filter, search, sort, blocked };
}

export function useColumnList(column: PulseColumnId, paused: boolean): ColumnList {
  const { incoming, tokens, filter, search, sort, blocked } = useIncoming(column);
  const calm = useSettings((s) => s.display.insertMode === "calm");

  // Query version: bumps when the user changes what the column asks for.
  const queryRef = useRef({ filter, search, sort, version: 0 });
  if (queryRef.current.filter !== filter || queryRef.current.search !== search || queryRef.current.sort !== sort) {
    queryRef.current = { filter, search, sort, version: queryRef.current.version + 1 };
  }
  const query = String(queryRef.current.version);

  // Release: the queue applies RELEASE_MS after the pause ends (derived state, set during render).
  const [wasPaused, setWasPaused] = useState(paused);
  const [releaseAt, setReleaseAt] = useState(0);
  if (wasPaused !== paused) {
    setWasPaused(paused);
    if (!paused) setReleaseAt(Date.now() + RELEASE_MS);
  }
  const [, wake] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (paused) return;
    const wait = releaseAt - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(wake, wait + 10);
    return () => clearTimeout(t);
  }, [paused, releaseAt]);
  const frozen = paused || Date.now() < releaseAt;

  const [nonce, setNonce] = useState(0);
  const committed = useRef<ListState>(emptyList());
  const resortMs = sort !== "default" || column === "final" ? RESORT_MS : 0;
  const state = useMemo(
    () => stepList(committed.current, { incoming, now: Date.now(), frozen, calm, resortMs, query, nonce }),
    [incoming, frozen, calm, resortMs, query, nonce],
  );
  useLayoutEffect(() => {
    committed.current = state;
  });

  // Rendered list: blacklisted cards leave at once; tokens that left the feed while frozen keep
  // their last summary until the column moves again.
  const shownRef = useRef<string[]>([]);
  const shown = useMemo(() => {
    const out: string[] = [];
    for (const m of state.shown) {
      const t = tokens[m] ?? seenToken(m);
      if (t && !isBlacklisted(t, blocked)) out.push(m);
    }
    return sameList(out, shownRef.current) ? shownRef.current : out;
  }, [state.shown, tokens, blocked]);
  useLayoutEffect(() => {
    shownRef.current = shown;
  });

  useEffect(() => {
    for (const m of shown) {
      const t = tokens[m];
      if (t) rememberToken(t);
    }
  }, [shown, tokens]);

  return {
    incoming,
    shown,
    queued: frozen ? queuedCount(state.shown, incoming) : 0,
    frozen,
    inserted: state.inserted,
    apply: () => setNonce((n) => n + 1),
    token: (mint) => tokens[mint] ?? seenToken(mint),
  };
}
