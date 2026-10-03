import { useMemo } from "react";
import { normalizeHandle } from "../../lib/filters";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useTrackers } from "../../state/trackers";
import { blockedHandles, handleMap, visiblePosts } from "./feedFilters";
import type { FeedScope } from "./prefs";

export function blacklistHandle(handle: string): void {
  const h = normalizeHandle(handle);
  useSettings.getState().addBlacklist("xHandles", h, "From the X tracker");
  useToasts.getState().push({
    kind: "info",
    title: `Blacklisted @${h}`,
    body: "Hidden from the X feed and from Pulse.",
    action: { label: "Undo", run: () => useSettings.getState().removeBlacklist("xHandles", h) },
  });
}

export function trackHandle(handle: string): void {
  const h = normalizeHandle(handle);
  if (useTrackers.getState().addHandle(h)) {
    useToasts.getState().push({ kind: "success", title: `Tracking @${h}`, body: "Tweets and profile updates are on.", ttl: 2500 });
  }
}

/** Posts after the per-handle toggles, the X blacklist and the scope (page and dock). */
export function useVisiblePosts(scope: FeedScope) {
  const posts = useTrackers((s) => s.posts);
  const handles = useTrackers((s) => s.handles);
  const xBlacklist = useSettings((s) => s.blacklists.xHandles);
  const tracked = useMemo(() => handleMap(handles), [handles]);
  const blocked = useMemo(() => blockedHandles(xBlacklist), [xBlacklist]);
  const visible = useMemo(() => visiblePosts(posts, tracked, blocked, scope), [posts, tracked, blocked, scope]);
  return { posts, visible, tracked };
}
