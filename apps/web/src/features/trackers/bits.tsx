import { Pause, Search } from "lucide-react";
import { cn } from "../../lib/cn";

/** Small presentational pieces shared by the trackers page, the dock and Discover (import-light). */

/** Unread count (info = neutral state). */
export function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-info-tint px-1 text-micro font-semibold text-info">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Feed status: a muted count while live, the Pulse-style "Paused · N new" chip while hover-paused. */
export function PauseStatus({ paused, pending, idle }: { paused: boolean; pending: number; idle?: string }) {
  if (!paused) return idle ? <span className="text-label whitespace-nowrap text-fg-3">{idle}</span> : null;
  return (
    <span
      className="flex h-5 items-center gap-1 rounded-xs border border-info/40 px-1 text-micro font-semibold whitespace-nowrap text-info"
      title="Paused while the pointer is over the list"
    >
      <Pause className="icon-xs" />
      Paused{pending > 0 ? ` · ${pending} new` : ""}
    </span>
  );
}

/** Search field with a leading icon (same anatomy as the Pulse column search). */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex h-7 min-w-0 items-center gap-1 rounded-sm border border-hairline-strong bg-bg px-2 text-data focus-within:border-accent",
        className,
      )}
    >
      <Search className="icon-sm shrink-0 text-fg-3" />
      <input
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-3"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
