import { Ban } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Modal } from "../../components/ui/Modal";
import { isBase58Address } from "../../lib/address";
import { cn } from "../../lib/cn";
import { normalizeHandle } from "../../lib/filters";
import { fmtDate, shortAddr } from "../../lib/format";
import { type BlacklistKind, useSettings } from "../../state/settings";
import { usePulseUi } from "./store";

const KINDS: { id: BlacklistKind; label: string; placeholder: string; empty: string }[] = [
  { id: "tokens", label: "Tokens", placeholder: "Contract address", empty: "Press X on a Pulse card, or use its menu, to hide a token." },
  {
    id: "devs",
    label: "Devs",
    placeholder: "Creator wallet address",
    empty: "Press Shift+X on a Pulse card to hide every token from its dev.",
  },
  {
    id: "fundingWallets",
    label: "Funding wallets",
    placeholder: "Funding wallet address",
    empty: "Hide every token whose dev was funded by a wallet.",
  },
  { id: "xHandles", label: "X accounts", placeholder: "@handle or x.com link", empty: "Hide every token that links an X account." },
];

function normalize(kind: BlacklistKind, raw: string): string | null {
  const v = raw.trim();
  if (kind === "xHandles") {
    const h = normalizeHandle(v);
    return /^[a-z0-9_]{1,15}$/.test(h) ? h : null;
  }
  return isBase58Address(v) ? v : null;
}

/**
 * Blacklist (DESIGN.md 5.1): tokens, devs, funding wallets and X accounts hidden from every
 * Pulse column, with add and remove. Blacklisted cards are removed, never dimmed (4.4). Dense
 * rows with mono addresses after Emergent's table: https://mobbin.com/screens/430e05a7-1489-4b14-bf6b-1daaf61ff1ce
 */
export function BlacklistModal() {
  const open = usePulseUi((s) => s.blacklistOpen);
  const close = () => usePulseUi.getState().openBlacklist(false);
  const blacklists = useSettings((s) => s.blacklists);
  const addBlacklist = useSettings((s) => s.addBlacklist);
  const removeBlacklist = useSettings((s) => s.removeBlacklist);
  const [kindId, setKindId] = useState<BlacklistKind>("tokens");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const kind = KINDS.find((k) => k.id === kindId) ?? KINDS[0];
  if (!kind) return null;
  const list = blacklists[kind.id];

  const add = (e: FormEvent) => {
    e.preventDefault();
    const v = normalize(kind.id, value);
    if (!v) {
      setError(
        kind.id === "xHandles" ? "Enter an X handle (letters, digits and _)." : "Enter a Solana address (base58, 32–44 characters).",
      );
      return;
    }
    addBlacklist(kind.id, v, "Added in Pulse");
    setValue("");
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Blacklist"
      description="Hidden from every Pulse column. Remove an entry to show it again."
      width={560}
    >
      <div role="tablist" aria-label="Blacklist type" className="-mx-4 -mt-4 mb-3 flex h-panel-header border-b border-hairline px-2">
        {KINDS.map((k) => {
          const active = k.id === kindId;
          return (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                setKindId(k.id);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                e.preventDefault();
                const i = KINDS.findIndex((x) => x.id === kindId);
                const next = KINDS[(i + (e.key === "ArrowRight" ? 1 : KINDS.length - 1)) % KINDS.length];
                if (next) setKindId(next.id);
              }}
              className={cn(
                "focus-inset relative flex h-full items-center gap-1 px-2 text-data font-medium transition-colors",
                active
                  ? "text-fg-1 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-accent after:content-['']"
                  : "text-fg-3 hover:text-fg-2",
              )}
            >
              {k.label}
              <span className="zf-num text-fg-3">{blacklists[k.id].length}</span>
            </button>
          );
        })}
      </div>

      <form onSubmit={add} className="mb-3">
        <div className="flex items-center gap-2">
          <input
            className="zf-input font-mono"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder={kind.placeholder}
            aria-label={`Add to blacklisted ${kind.label.toLowerCase()}`}
            aria-invalid={error !== null}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={!value.trim()}>
            Hide
          </Button>
        </div>
        {error && <div className="mt-1 text-label text-sell">{error}</div>}
      </form>

      {list.length === 0 ? (
        <EmptyState icon={<Ban />} title={`No hidden ${kind.label.toLowerCase()}`} body={kind.empty} />
      ) : (
        <ul className="divide-y divide-hairline border-y border-hairline">
          {list.map((entry) => (
            <li key={entry.value} className="flex h-7 items-center gap-3 px-1 text-data">
              <span className="w-36 shrink-0 truncate font-mono text-fg-1" title={entry.value}>
                {kind.id === "xHandles" ? `@${entry.value}` : shortAddr(entry.value)}
              </span>
              <span className="min-w-0 flex-1 truncate text-fg-3">{entry.note}</span>
              <span className="shrink-0 text-label text-fg-3">{fmtDate(entry.addedAt)}</span>
              <Button size="xs" variant="ghost" onClick={() => removeBlacklist(kind.id, entry.value)}>
                Show again
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
