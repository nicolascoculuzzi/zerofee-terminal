import { Check, ClipboardCopy, Download, FileDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { MenuItem, Popover } from "../../components/ui/Popover";
import { copyText, downloadText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";

export interface ExportAction {
  label: string;
  icon: ReactNode;
  /** Resolves false when it failed (e.g. clipboard blocked). */
  run: () => boolean | Promise<boolean>;
  /** Word shown on the button for 1,200 ms after it ran: "Copied", "Saved". */
  done: string;
}

/**
 * Menu body with Up/Down, Home/End and type-ahead over its items, focusing the first item on
 * open (DESIGN.md 4.17 menu keyboard).
 */
export function MenuList({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("[role^='menuitem']:not([disabled])")?.focus(), 0);
    return () => clearTimeout(t);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([disabled])") ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      next = items.findIndex((el, j) => j > i && el.textContent?.trim().toLowerCase().startsWith(ch));
      if (next < 0) next = items.findIndex((el) => el.textContent?.trim().toLowerCase().startsWith(ch));
    }
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <div ref={ref} role="menu" aria-label={label} onKeyDown={onKeyDown} className={cn("flex flex-col", className)}>
      {children}
    </div>
  );
}

/**
 * Export button with a menu of download and copy actions. The result shows on the button
 * itself (Check plus "Copied" for 1,200 ms), never as a toast (DESIGN.md 4.13, 4.23).
 */
export function ExportMenu({
  actions,
  disabled,
  size = "md",
  className,
}: {
  actions: ExportAction[];
  disabled?: boolean;
  /** md in the 40 px page toolbar, xs in 28 px pane toolbars. */
  size?: "md" | "xs";
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; word: string } | null>(null);
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 1200);
    return () => clearTimeout(t);
  }, [result]);
  return (
    <>
      <Button
        ref={anchor}
        size={size}
        variant={size === "xs" ? "ghost" : "secondary"}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? "Nothing to export yet" : "Export"}
        icon={result?.ok ? <Check /> : <Download />}
        className={cn("max-md:h-11", className)}
      >
        {/* The 40 px page toolbar drops labels below 1024 px, like Import and Add wallet; pane toolbars keep them. */}
        <span className={cn(size === "md" ? "max-lg:sr-only" : "max-md:sr-only", result && !result.ok && "text-sell")}>
          {result ? result.word : "Export"}
        </span>
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={208}>
        <MenuList label="Export">
          {actions.map((a) => (
            <MenuItem
              key={a.label}
              icon={a.icon}
              onSelect={() => {
                setOpen(false);
                void Promise.resolve(a.run()).then((ok) => setResult(ok ? { ok, word: a.done } : { ok, word: "Copy failed" }));
              }}
            >
              {a.label}
            </MenuItem>
          ))}
        </MenuList>
      </Popover>
    </>
  );
}

/** Standard actions: download a JSON file, copy the JSON, and optionally copy plain lines. */
export function jsonExportActions(opts: {
  filename: string;
  json: () => string;
  lines?: { label: string; text: () => string };
}): ExportAction[] {
  const actions: ExportAction[] = [
    {
      label: "Download JSON",
      icon: <FileDown />,
      done: "Saved",
      run: () => {
        downloadText(opts.filename, opts.json());
        return true;
      },
    },
    { label: "Copy JSON", icon: <ClipboardCopy />, done: "Copied", run: () => copyText(opts.json()) },
  ];
  const lines = opts.lines;
  if (lines) actions.push({ label: lines.label, icon: <ClipboardCopy />, done: "Copied", run: () => copyText(lines.text()) });
  return actions;
}
