import { memo } from "react";
import { cn } from "../../lib/cn";
import { LAUNCHPAD_BY_ID } from "../../lib/metrics";
import type { Launchpad } from "../../protocol";

const FALLBACK_GLYPHS = ["🐸", "🐶", "🐱", "🚀", "🌕", "💎", "🔥", "🦍", "🍌", "🧠", "👽", "🐳", "🦊", "🐼"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface TokenAvatarProps {
  mint: string;
  symbol: string;
  imageUri: string | null;
  launchpad?: Launchpad;
  size?: number;
  /** 0..1 bonding progress drawn as the border; null hides it. */
  progress?: number | null;
  migrated?: boolean;
  className?: string;
}

/**
 * Locally generated token art (gradient + glyph). Real metadata images will come through an
 * image proxy later; until then nothing is fetched from external hosts.
 */
export const TokenAvatar = memo(function TokenAvatar({
  mint,
  symbol,
  imageUri,
  launchpad,
  size = 44,
  progress = null,
  migrated,
  className,
}: TokenAvatarProps) {
  const h = hash(mint);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + ((h >> 9) % 80)) % 360;
  const glyph = imageUri?.startsWith("gen:") ? imageUri.slice(4) : (FALLBACK_GLYPHS[h % FALLBACK_GLYPHS.length] ?? symbol[0]);
  const id = `g${h.toString(36)}`;
  const radius = Math.round(size * 0.22);
  const badge = launchpad ? LAUNCHPAD_BY_ID[launchpad] : null;
  const ring = progress !== null && progress !== undefined;
  const p = Math.max(0, Math.min(1, progress ?? 0));
  const ringColor = migrated || p >= 1 ? "var(--zf-accent)" : p >= 0.6 ? "var(--zf-warn)" : "var(--zf-buy)";
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={`hsl(${hue1} 70% 42%)`} />
            <stop offset="100%" stopColor={`hsl(${hue2} 75% 22%)`} />
          </linearGradient>
        </defs>
        <rect x={2} y={2} width={size - 4} height={size - 4} rx={radius} fill={`url(#${id})`} />
        {ring && (
          <>
            <rect
              x={1}
              y={1}
              width={size - 2}
              height={size - 2}
              rx={radius + 1}
              fill="none"
              stroke="var(--zf-line-strong)"
              strokeWidth={1.5}
            />
            <rect
              x={1}
              y={1}
              width={size - 2}
              height={size - 2}
              rx={radius + 1}
              fill="none"
              stroke={ringColor}
              strokeWidth={1.75}
              pathLength={100}
              strokeDasharray={`${(migrated ? 1 : p) * 100} 100`}
              strokeLinecap="round"
            />
          </>
        )}
        <text x="50%" y="54%" dominantBaseline="middle" textAnchor="middle" fontSize={size * 0.5} style={{ userSelect: "none" }}>
          {glyph}
        </text>
      </svg>
      {badge && (
        <span
          title={badge.label}
          className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full border border-bg font-bold text-black"
          style={{
            background: badge.color,
            width: Math.max(12, size * 0.32),
            height: Math.max(12, size * 0.32),
            fontSize: Math.max(7, size * 0.16),
          }}
        >
          {badge.short}
        </span>
      )}
    </div>
  );
});
