import { BadgeCheck, Ban, type LucideIcon, Quote, Repeat2, Reply, UserPen, UserPlus } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { IconButton } from "../../components/ui/Button";
import { Tag } from "../../components/ui/bits";
import { Num } from "../../components/ui/Num";
import { TokenAvatar, WalletAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtClock, shortAddr } from "../../lib/format";
import type { SocialPost, TokenRef } from "../../protocol";
import { useMarket } from "../../state/market";
import { hoverTarget } from "./hooks";
import { QuoteValue } from "./money";
import { QuickBuyPill } from "./QuickBuyButton";

const KIND: Partial<Record<SocialPost["kind"], { label: string; Icon: LucideIcon }>> = {
  reply: { label: "Reply", Icon: Reply },
  quote: { label: "Quote", Icon: Quote },
  retweet: { label: "Repost", Icon: Repeat2 },
  profile_update: { label: "Profile update", Icon: UserPen },
  follow: { label: "Follow", Icon: UserPlus },
};

export const postId = (p: SocialPost): string => p.id;

const TEXT_TOKENS =
  /(\$[A-Za-z][A-Za-z0-9_]{0,15}|@[A-Za-z0-9_]{1,15}|(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z]))/g;

/** Cashtags and mentions at 600; contract addresses shortened in mono (full value in the tooltip). */
function richText(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TEXT_TOKENS)) {
    const s = m[0];
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    if (s.startsWith("$") || s.startsWith("@")) {
      out.push(
        <span key={at} className="font-semibold">
          {s}
        </span>,
      );
    } else {
      out.push(
        <span key={at} className="font-mono text-fg-2" title={s}>
          {shortAddr(s)}
        </span>,
      );
    }
    last = at + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * A token the post mentions: opens on click; MC now (and the change since the post, signed);
 * quick-buy. A 2 px-radius chip with a strong hairline, so it reads on the page and in the dock.
 */
const MentionChip = memo(function MentionChip({ token }: { token: TokenRef }) {
  const live = useMarket((s) => s.tokens[token.mint]);
  const mcUsd = live?.marketCapUsd ?? token.marketCapUsd;
  const change = live && token.marketCapUsd > 0 ? ((live.marketCapUsd - token.marketCapUsd) / token.marketCapUsd) * 100 : null;
  return (
    <span
      {...hoverTarget(token.mint)}
      className="relative inline-flex h-row items-center gap-1 rounded-xs border border-hairline-strong pr-0.5 pl-1 text-data"
    >
      <Link to={`/t/${token.mint}`} className="focus-inset absolute inset-0 rounded-xs">
        <span className="sr-only">Open {token.symbol}</span>
      </Link>
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="2xs" />
      <span className="font-semibold text-fg-1">{token.symbol}</span>
      <span className="text-fg-2" title="Market cap now">
        <QuoteValue usd={mcUsd} sol={live?.marketCapSol} />
      </span>
      {change !== null && Math.abs(change) >= 0.05 && (
        <span title="Market cap change since the post">
          <Num kind="pct" value={change} signed />
        </span>
      )}
      <QuickBuyPill mint={token.mint} symbol={token.symbol} source="social" size="row" />
    </span>
  );
});

/*
 * X post. Monogram avatar, name and handle, age (the clock time in its tooltip), the action
 * label for replies, reposts, profile updates and follows, then the text and the tokens it
 * mentions. Feeds have no dividers (DESIGN.md 4.9); hover shows the post's bounds. Activity
 * timeline anatomy after Basecamp, the "someone bought" card idea after Base's social feed:
 * https://mobbin.com/screens/b71d21b5-1078-44a4-adb3-9583531a6059
 * https://mobbin.com/screens/0ee5ef3f-8693-4e21-971f-8975e9157712
 * `compact` (dock) drops the row actions.
 */
export const PostItem = memo(function PostItem({
  post,
  fresh,
  compact,
  floating,
  tracked,
  onTrack,
  onBlacklist,
}: {
  post: SocialPost;
  /** New post: the 1,200 ms highlight (DESIGN.md 6.6). */
  fresh: boolean;
  compact?: boolean;
  /** Inside a floating dock (surface-2): hover steps to surface-3. */
  floating?: boolean;
  tracked?: boolean;
  onTrack?: (handle: string) => void;
  onBlacklist?: (handle: string) => void;
}) {
  const kind = KIND[post.kind];
  const name = post.displayName || post.handle;
  return (
    <article
      data-key={post.id}
      aria-label={`${name}, ${fmtClock(post.ts)}`}
      className={cn(
        "group/post relative flex gap-2 px-2 py-2",
        floating ? "hover:bg-surface-3" : "hover:bg-surface-2",
        "max-md:px-3",
        fresh && "zf-enter",
      )}
    >
      <WalletAvatar seed={post.handle} label={name} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex h-5 min-w-0 items-center gap-1 text-data">
          <span className="truncate font-semibold text-fg-1">{name}</span>
          {post.verified && <BadgeCheck className="icon-xs shrink-0 text-info" aria-label="Verified" />}
          <span className="min-w-0 truncate text-fg-3">@{post.handle}</span>
          {tracked && <Tag tag="tracked" label="TRK" />}
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-1" title={fmtClock(post.ts)}>
            <Age ts={post.ts} />
          </span>
          {!compact && (
            <span className="flex shrink-0 items-center">
              {!tracked && onTrack && (
                <IconButton label={`Track @${post.handle}`} size="xs" className="max-md:size-11" onClick={() => onTrack(post.handle)}>
                  <UserPlus />
                </IconButton>
              )}
              {onBlacklist && (
                <IconButton
                  label={`Blacklist @${post.handle}`}
                  size="xs"
                  className="max-md:size-11"
                  onClick={() => onBlacklist(post.handle)}
                >
                  <Ban />
                </IconButton>
              )}
            </span>
          )}
        </div>
        {kind && (
          <div className="zf-label flex h-4 items-center gap-1">
            <kind.Icon className="icon-xs" />
            {kind.label}
          </div>
        )}
        <p className="mt-1 max-w-[72ch] text-data break-words whitespace-pre-wrap text-fg-1">{richText(post.text)}</p>
        {post.mentions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {post.mentions.map((m) => (
              <MentionChip key={m.mint} token={m} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
});
