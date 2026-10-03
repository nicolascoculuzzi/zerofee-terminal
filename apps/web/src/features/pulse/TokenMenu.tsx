import { Ban, Copy, ExternalLink, MoreHorizontal, Star } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Popover } from "../../components/ui/Popover";
import { copyText } from "../../lib/clipboard";
import { navigateTo } from "../../lib/nav";
import type { TokenSummary } from "../../protocol";
import { type BlacklistKind, useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";

function Item({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-data hover:bg-surface-3 ${danger ? "text-sell" : "text-fg-1"}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** Per-token overflow menu: open, copy, watchlist and the four blacklist targets (SPEC Discovery P0). */
export function TokenMenu({ token }: { token: TokenSummary }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const watched = useSettings((s) => s.watchlist.includes(token.mint));
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const addBlacklist = useSettings((s) => s.addBlacklist);
  const close = () => setOpen(false);
  const blacklist = (kind: BlacklistKind, value: string, what: string) => {
    addBlacklist(kind, value, `${token.symbol} (${token.mint.slice(0, 6)}…)`);
    useToasts
      .getState()
      .push({ kind: "info", title: `Blacklisted ${what}`, body: "Hidden from every Pulse column. Manage in Settings → Blacklists." });
    close();
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`More actions for ${token.symbol}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="flex size-4 items-center justify-center rounded-xs text-fg-3 hover:text-fg-1"
      >
        <MoreHorizontal className="icon-sm" />
      </button>
      <Popover open={open} onClose={close} anchor={anchor} align="end" width={224} className="p-1">
        <div>
          <Item
            icon={<ExternalLink className="icon-sm" />}
            onClick={() => {
              close();
              navigateTo(`/t/${token.mint}`);
            }}
          >
            Open token page
          </Item>
          <Item
            icon={<Copy className="icon-sm" />}
            onClick={() => {
              void copyText(token.mint);
              close();
            }}
          >
            Copy contract address
          </Item>
          <Item
            icon={<Star className="icon-sm" />}
            onClick={() => {
              toggleWatch(token.mint);
              close();
            }}
          >
            {watched ? "Remove from watchlist" : "Add to watchlist"}
          </Item>
          <div className="my-1 h-px bg-hairline" />
          <Item danger icon={<Ban className="icon-sm" />} onClick={() => blacklist("tokens", token.mint, `$${token.symbol}`)}>
            Blacklist token
          </Item>
          <Item danger icon={<Ban className="icon-sm" />} onClick={() => blacklist("devs", token.creator, "dev wallet")}>
            Blacklist dev
          </Item>
          {token.fundingWallet && (
            <Item
              danger
              icon={<Ban className="icon-sm" />}
              onClick={() => blacklist("fundingWallets", token.fundingWallet ?? "", "funding wallet")}
            >
              Blacklist funding wallet
            </Item>
          )}
          {token.socials.x && (
            <Item danger icon={<Ban className="icon-sm" />} onClick={() => blacklist("xHandles", token.socials.x ?? "", "X account")}>
              Blacklist X account
            </Item>
          )}
        </div>
      </Popover>
    </>
  );
}
