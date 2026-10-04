import { useMemo } from "react";
import { normalizeHandle } from "../../lib/filters";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { type TrackedHandle, useTrackers } from "../../state/trackers";
import { blockedHandles, handleMap, visiblePosts } from "./feedFilters";
import type { FeedScope } from "./prefs";

/** Blacklists an X handle everywhere (feed and Pulse), with Undo (DESIGN.md 4.13 action toast). */
export function blacklistHandle(handle: string): void {
  const h = normalizeHandle(handle);
  useSettings.getState().addBlacklist("xHandles", h, "From the X feed");
  useToasts.getState().push({
    kind: "info",
    title: `Blacklisted @${h}`,
    body: "Hidden from the X feed and from Pulse.",
    action: { label: "Undo", run: () => useSettings.getState().removeBlacklist("xHandles", h) },
  });
}

/** Adds a handle to the list. No toast: the post's Track control turns into the TRK tag. */
export function trackHandle(handle: string): boolean {
  return useTrackers.getState().addHandle(normalizeHandle(handle));
}

/** Removes a handle with Undo, restoring its switches and added date. */
export function removeHandle(h: TrackedHandle): void {
  useTrackers.getState().removeHandle(h.handle);
  useToasts.getState().push({
    kind: "info",
    title: `Removed @${h.handle}`,
    action: {
      label: "Undo",
      run: () => {
        const s = useTrackers.getState();
        if (s.addHandle(h.handle))
          s.updateHandle(h.handle, { tweets: h.tweets, profile: h.profile, follows: h.follows, addedAt: h.addedAt });
      },
    },
  });
}

/** Posts after the per-handle toggles, the X blacklist, the scope and the search (page and dock). */
export function useVisiblePosts(scope: FeedScope, query = "") {
  const posts = useTrackers((s) => s.posts);
  const handles = useTrackers((s) => s.handles);
  const xBlacklist = useSettings((s) => s.blacklists.xHandles);
  const tracked = useMemo(() => handleMap(handles), [handles]);
  const blocked = useMemo(() => blockedHandles(xBlacklist), [xBlacklist]);
  const visible = useMemo(() => visiblePosts(posts, tracked, blocked, scope, query), [posts, tracked, blocked, scope, query]);
  return { posts, visible, tracked };
}
