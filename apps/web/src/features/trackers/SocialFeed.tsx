import { useCallback } from "react";
import { Segmented } from "../../components/ui/controls";
import { normalizeHandle } from "../../lib/filters";
import { getServices } from "../../services";
import { useTrackers } from "../../state/trackers";
import { PauseStatus } from "./bits";
import { useArrivals, useHoverPause, useMarkRead } from "./hooks";
import { PostItem, postId } from "./PostItem";
import { type FeedScope, useTrackerPrefs } from "./prefs";
import { blacklistHandle, trackHandle, useVisiblePosts } from "./socialActions";

/*
 * X tracker live feed. Item anatomy is documented on PostItem (Basecamp activity timeline /
 * Buffer replies); the toolbar mirrors the wallet tracker's filter bar.
 */
export function SocialFeed() {
  const scope = useTrackerPrefs((s) => s.feedScope);
  const setScope = useTrackerPrefs((s) => s.setFeedScope);
  const handleCount = useTrackers((s) => s.handles.length);
  const { posts, visible, tracked } = useVisiblePosts(scope);
  const { shown, paused, pending, bind } = useHoverPause(visible);
  const isFresh = useArrivals(posts, postId);
  const simulated = getServices().simulated;
  useMarkRead("posts");

  const onTrack = useCallback((handle: string) => trackHandle(handle), []);
  const onBlacklist = useCallback((handle: string) => blacklistHandle(handle), []);

  const empty =
    posts.length === 0
      ? "Waiting for posts."
      : scope === "mine" && handleCount === 0
        ? "Add handles in Customize Feed to build your list."
        : "No posts match your toggles.";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-2">
        <Segmented<FeedScope>
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All posts" },
            { value: "mine", label: "My list", title: "Only handles you track" },
          ]}
          label="Feed scope"
        />
        {simulated && (
          <span className="text-label text-warn" title="Posts come from the in-browser simulation, not X.">
            Simulated feed (mock source)
          </span>
        )}
        <span className="ml-auto">
          <PauseStatus paused={paused} pending={pending} idle={`${visible.length.toLocaleString("en-US")} posts`} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" {...bind}>
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-data text-fg-3">{empty}</p>
        ) : (
          shown.map((post) => (
            <PostItem
              key={post.id}
              post={post}
              fresh={isFresh(post.id)}
              tracked={tracked.has(normalizeHandle(post.handle))}
              onTrack={onTrack}
              onBlacklist={onBlacklist}
            />
          ))
        )}
      </div>
    </div>
  );
}
