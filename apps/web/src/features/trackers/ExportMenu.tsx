import { ClipboardCopy, Download, FileDown } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Popover } from "../../components/ui/Popover";
import { copyText, downloadText } from "../../lib/clipboard";
import { useToasts } from "../../state/toasts";

export interface ExportAction {
  label: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

/** "Export" button with a small menu of download / copy actions. */
export function ExportMenu({
  actions,
  disabled,
  compactLabel,
}: {
  actions: ExportAction[];
  disabled?: boolean;
  /** Hide the text label in narrow containers (needs an @container ancestor). */
  compactLabel?: boolean;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <span ref={anchor} className="inline-flex">
        <Button
          size="md"
          variant="secondary"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Export"
          icon={<Download className="icon-sm" />}
        >
          <span className={compactLabel ? "hidden @lg:inline" : undefined}>Export</span>
        </Button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={200} className="p-1">
        <div role="menu" className="flex flex-col">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void a.run();
              }}
              className="flex h-7 items-center gap-2 rounded-sm px-2 text-left text-data text-fg-1 hover:bg-surface-3"
            >
              <span className="flex text-fg-2">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** Standard actions: download a JSON file, copy JSON, and optionally copy plain lines. */
export function jsonExportActions(opts: {
  filename: string;
  noun: string;
  count: number;
  json: () => string;
  lines?: { label: string; text: () => string };
}): ExportAction[] {
  const toast = useToasts.getState().push;
  const plural = `${opts.count.toLocaleString("en-US")} ${opts.noun}${opts.count === 1 ? "" : "s"}`;
  const actions: ExportAction[] = [
    {
      label: "Download JSON",
      icon: <FileDown className="icon-sm" />,
      run: () => {
        downloadText(opts.filename, opts.json());
        toast({ kind: "success", title: `Exported ${plural}`, body: opts.filename, ttl: 2500 });
      },
    },
    {
      label: "Copy JSON",
      icon: <ClipboardCopy className="icon-sm" />,
      run: async () => {
        const ok = await copyText(opts.json());
        toast(
          ok ? { kind: "success", title: `Copied ${plural} as JSON`, ttl: 2000 } : { kind: "error", title: "Couldn't copy to clipboard" },
        );
      },
    },
  ];
  const lines = opts.lines;
  if (lines) {
    actions.push({
      label: lines.label,
      icon: <ClipboardCopy className="icon-sm" />,
      run: async () => {
        const ok = await copyText(lines.text());
        toast(
          ok ? { kind: "success", title: `Copied ${plural} as text`, ttl: 2000 } : { kind: "error", title: "Couldn't copy to clipboard" },
        );
      },
    });
  }
  return actions;
}
