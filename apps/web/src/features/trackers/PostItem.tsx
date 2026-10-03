import { BadgeCheck, Ban, type LucideIcon, Quote, Repeat2, Reply, UserPen, UserPlus } from "lucide-react";
import { memo, type ReactNode } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { IconButton } from "../../components/ui/Button";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtClock, fmtPct, fmtUsd, shortAddr } from "../../lib/format";
import type { SocialPost, TokenRef } from "../../protocol";
import { useMarket } from "../../state/market";
import { QuickBuyButton } from "./QuickBuyButton";
import { firstGlyph } from "./TradeRow";

const KIND: Partial<Record<SocialPost["kind"], { label: string; Icon: LucideIcon }>> = {
  reply: { label: "Reply", Icon: Reply },
  quote: { label: "Quote", Icon: Quote },
  retweet: { label: "Retweet", Icon: Repeat2 },
  profile_update: { label: "Profile update", Icon: UserPen },
  follow: { label: "Follow", Icon: UserPlus },
};

export const postId = (p: SocialPost): string => p.id;

const TEXT_TOKENS =
  /(\$[A-Za-z][A-Za-z0-9_]{0,15}|@[A-Za-z0-9_]{1,15}|(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z]))/g;

/** Cashtags and mentions in bold; contract addresses shortened (full value on hover). */
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
          {shortAddr(s, 4, 4)}
        </span>,
      );
    }
    last = at + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Token mentioned in a post: open on click, quick-buy, MC now vs at post time. */
const MentionChip = memo(function MentionChip({ token }: { token: TokenRef }) {
  const liveMc = useMarket((s) => s.tokens[token.mint]?.marketCapUsd);
  const mc = liveMc ?? token.marketCapUsd;
  const change = liveMc !== undefined && token.marketCapUsd > 0 ? ((liveMc - token.marketCapUsd) / token.marketCapUsd) * 100 : null;
  return (
    <span className="relative inline-flex h-6 items-center gap-1 rounded-sm border border-hairline bg-surface-2 pr-px pl-1 text-label hover:bg-surface-3">
      <Link
        to={`/t/${token.mint}`}
        className="absolute inset-0 rounded-sm"
        title={`MC at post ${fmtUsd(token.marketCapUsd)}${liveMc === undefined ? "" : ` · now ${fmtUsd(liveMc)}`}`}
      >
        <span className="sr-only">Open {token.symbol}</span>
      </Link>
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="xs" />
      <span className="font-semibold text-fg-1">{token.symbol}</span>
      <span className="text-fg-2">{fmtUsd(mc)}</span>
      {change !== null && Math.abs(change) >= 0.1 && (
        <span className={change >= 0 ? "text-buy" : "text-sell"}>{fmtPct(change, { signed: true })}</span>
      )}
      <QuickBuyButton mint={token.mint} symbol={token.symbol} source="social" />
    </span>
  );
});

/*
 * X post. Anatomy follows Basecamp's activity timeline (monogram avatar, actor, action label,
 * time, then the text) with Buffer's reply header (name + relative time):
 * https://mobbin.com/screens/b71d21b5-1078-44a4-adb3-9583531a6059
 * https://mobbin.com/screens/7282f8fa-ca9d-484b-bf12-71fca844293e
 * `compact` (dock) drops the clock time and the row actions.
 */
export const PostItem = memo(function PostItem({
  post,
  fresh,
  compact,
  tracked,
  onTrack,
  onBlacklist,
}: {
  post: SocialPost;
  fresh: boolean;
  compact?: boolean;
  tracked?: boolean;
  onTrack?: (handle: string) => void;
  onBlacklist?: (handle: string) => void;
}) {
  const kind = KIND[post.kind];
  const name = post.displayName || post.handle;
  return (
    <article className={cn("flex gap-2 border-b border-hairline px-3 py-2", fresh && "zf-enter")}>
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-label font-semibold text-fg-2"
      >
        {firstGlyph(name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex h-5 items-center gap-1 text-data">
          <span className="truncate font-semibold text-fg-1">{name}</span>
          {post.verified && <BadgeCheck className="icon-sm text-info" aria-label="Verified" />}
          <span className="min-w-0 truncate text-fg-3">@{post.handle}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-1 text-label text-fg-3">
            <Age ts={post.ts} />
            {!compact && (
              <>
                <span aria-hidden="true">·</span>
                <span>{fmtClock(post.ts)}</span>
              </>
            )}
          </span>
          {!compact && (
            <span className="flex shrink-0 items-center">
              {!tracked && onTrack && (
                <IconButton label={`Track @${post.handle}`} size="xs" onClick={() => onTrack(post.handle)}>
                  <UserPlus className="icon-sm" />
                </IconButton>
              )}
              {onBlacklist && (
                <IconButton label={`Blacklist @${post.handle}`} size="xs" onClick={() => onBlacklist(post.handle)}>
                  <Ban className="icon-sm" />
                </IconButton>
              )}
            </span>
          )}
        </div>
        {kind && (
          <div className="zf-label flex items-center gap-1">
            <kind.Icon className="icon-xs" />
            {kind.label}
          </div>
        )}
        <p className="mt-1 break-words text-data whitespace-pre-wrap text-fg-1">{richText(post.text)}</p>
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
