import { AtSign } from "lucide-react";
import { type FocusEvent, type PointerEvent, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../components/ui/bits";
import { Segmented } from "../../components/ui/controls";
import { normalizeHandle } from "../../lib/filters";
import { fmtInt } from "../../lib/format";
import type { SocialPost } from "../../protocol";
import type { TrackedHandle } from "../../state/trackers";
import { useTrackers } from "../../state/trackers";
import { MetaCount, NewRowsPill, PaneToolbar, PausedChip } from "./bits";
import { normalizeQuery } from "./feedFilters";
import { HIGHLIGHT_MS, useInsertions, useLivePause, useMarkRead } from "./hooks";
import { PostItem, postId } from "./PostItem";
import { type FeedScope, useTrackerPrefs } from "./prefs";
import { blacklistHandle, trackHandle, useVisiblePosts } from "./socialActions";

type Handlers = {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
};

/**
 * Post list with calm inserts (DESIGN.md 6.7). Posts vary in height, so instead of the
 * virtualiser's row math the first visible post is the anchor: after new posts land above it,
 * scrollTop moves by exactly the height they added, and an "↑ N new" pill counts them. Native
 * scroll anchoring is off so it never adjusts twice.
 */
export function PostList({
  posts,
  tracked,
  paused,
  pending,
  onRelease,
  bind,
  compact,
  floating,
  empty,
  label,
}: {
  posts: readonly SocialPost[];
  tracked: ReadonlyMap<string, TrackedHandle>;
  paused: boolean;
  pending: number;
  onRelease: () => void;
  bind: Handlers;
  compact?: boolean;
  floating?: boolean;
  empty: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [inserted, setInserted] = useState(0);
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const keys = useMemo(() => posts.map(postId), [posts]);
  const prevKeys = useRef(keys);
  const isFresh = useInsertions(posts, postId, HIGHLIGHT_MS);

  const record = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollTop < 8) {
      anchor.current = null;
      return;
    }
    for (const node of el.querySelectorAll<HTMLElement>("[data-key]")) {
      if (node.offsetTop + node.offsetHeight > el.scrollTop) {
        anchor.current = { key: node.dataset.key ?? "", offset: node.offsetTop - el.scrollTop };
        return;
      }
    }
  }, []);

  useLayoutEffect(() => {
    const prev = prevKeys.current;
    prevKeys.current = keys;
    const el = ref.current;
    const a = anchor.current;
    if (!el || !a || prev === keys) return;
    const node = el.querySelector<HTMLElement>(`[data-key="${CSS.escape(a.key)}"]`);
    if (!node) return;
    const delta = node.offsetTop - el.scrollTop - a.offset;
    if (delta !== 0) el.scrollTop += delta;
    const before = new Set(prev);
    let fresh = 0;
    for (const k of keys) {
      if (k === a.key) break;
      if (!before.has(k)) fresh++;
    }
    if (fresh > 0) setInserted((n) => n + fresh);
  }, [keys]);

  const onTrack = useCallback((handle: string) => void trackHandle(handle), []);
  const onBlacklist = useCallback((handle: string) => blacklistHandle(handle), []);
  const queued = inserted + (paused ? pending : 0);

  return (
    <section aria-label={label} className="relative flex min-h-0 flex-1 flex-col" {...bind}>
      <div
        ref={ref}
        onScroll={(e) => {
          record();
          if (inserted > 0 && e.currentTarget.scrollTop < 8) setInserted(0);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
      >
        {posts.length === 0
          ? empty
          : posts.map((post) => (
              <PostItem
                key={post.id}
                post={post}
                fresh={isFresh(post.id)}
                compact={compact}
                floating={floating}
                tracked={tracked.has(normalizeHandle(post.handle))}
                onTrack={compact ? undefined : onTrack}
                onBlacklist={compact ? undefined : onBlacklist}
              />
            ))}
      </div>
      {queued > 0 && (
        <NewRowsPill
          count={queued}
          paused={paused}
          className="top-1"
          onClick={() => {
            onRelease();
            setInserted(0);
            anchor.current = null;
            if (ref.current) ref.current.scrollTop = 0;
          }}
        />
      )}
    </section>
  );
}

const SCOPES: { value: FeedScope; label: string; title?: string }[] = [
  { value: "all", label: "All posts" },
  { value: "mine", label: "My list", title: "Only handles you track" },
];

/**
 * X feed (simulated: links copy instead of opening). Scope All posts or My list; the page
 * search matches handle, name, text or a mentioned ticker. Hover or focus pauses it.
 */
export function SocialFeed({ query, toolbarStart }: { query: string; toolbarStart?: ReactNode }) {
  const scope = useTrackerPrefs((s) => s.feedScope);
  const setScope = useTrackerPrefs((s) => s.setFeedScope);
  const setXView = useTrackerPrefs((s) => s.setXView);
  const handleCount = useTrackers((s) => s.handles.length);
  const q = normalizeQuery(query);
  const { posts, visible, tracked } = useVisiblePosts(scope, q);
  const { shown, paused, pending, bind, release } = useLivePause(visible, postId);
  useMarkRead("posts");

  const empty =
    posts.length === 0 ? (
      <EmptyState className="text-balance" title="No posts yet" body="Posts from the handles you track appear here as they're published." />
    ) : scope === "mine" && handleCount === 0 ? (
      <EmptyState className="text-balance" icon={<AtSign />} title="Your list is empty" body="Track handles to build your list." />
    ) : (
      <EmptyState
        className="text-balance"
        title={q ? `No posts match “${query.trim()}”` : "No posts match your switches"}
        body="Change the scope, the search or a handle's switches."
      />
    );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PaneToolbar>
        {toolbarStart}
        <Segmented<FeedScope> size="xs" value={scope} onChange={setScope} options={SCOPES} label="Feed scope" className="max-md:h-13" />
        {scope === "mine" && handleCount === 0 && (
          <button type="button" className="text-label text-fg-2 transition-colors hover:text-fg-1" onClick={() => setXView("handles")}>
            Add handles
          </button>
        )}
        <span className="ml-auto flex items-center gap-2 pl-2">
          <PausedChip paused={paused} />
          <MetaCount>{visible.length === 1 ? "1 post" : `${fmtInt(visible.length)} posts`}</MetaCount>
        </span>
      </PaneToolbar>
      <PostList
        posts={shown}
        tracked={tracked}
        paused={paused}
        pending={pending}
        onRelease={release}
        bind={bind}
        empty={empty}
        label="X posts"
      />
    </div>
  );
}
