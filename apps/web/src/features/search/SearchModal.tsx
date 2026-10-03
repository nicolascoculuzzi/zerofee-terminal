import { Clock, Search, Star, UserPlus, Wallet, X, Zap } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { SocialLinks, Tag } from "../../components/ui/bits";
import { CopyButton, Kbd } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtAge, fmtSolShort, fmtUsd, shortAddr } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import { useNow } from "../../lib/useNow";
import type { SearchResults, TokenSummary, WalletSearchHit } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useTrackers } from "../../state/trackers";
import { useUi } from "../../state/ui";

type Item = { kind: "token"; token: TokenSummary } | { kind: "wallet"; wallet: WalletSearchHit };

function TokenRow({
  token,
  active,
  now,
  onOpen,
  onHover,
}: {
  token: TokenSummary;
  active: boolean;
  now: number;
  onOpen: () => void;
  onHover: () => void;
}) {
  const quickBuy = useSettings((s) => s.quickBuySol);
  const watched = useSettings((s) => s.watchlist.includes(token.mint));
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      onPointerMove={onHover}
      className={cn("flex cursor-pointer items-center gap-2 px-3 py-2", active ? "bg-surface-3" : "hover:bg-surface-3/60")}
    >
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} launchpad={token.launchpad} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="text-body font-semibold">{token.symbol}</span>
          <span className="truncate text-data text-fg-3">{token.name}</span>
          {watched && <Star className="icon-sm fill-fg-1 text-fg-1" />}
          <CopyButton text={token.mint} label="Copy contract address" />
        </div>
        <div className="flex items-center gap-2 text-label">
          <span className="text-buy">{fmtAge(token.createdAt, now)}</span>
          <span className="font-mono text-fg-3">{shortAddr(token.mint, 4, 4)}</span>
          <SocialLinks socials={token.socials} />
        </div>
      </div>
      <div className="hidden w-[150px] grid-cols-3 gap-2 text-right text-label sm:grid">
        <span>
          <span className="block text-fg-3">MC</span>
          <span className="font-semibold">{fmtUsd(token.marketCapUsd)}</span>
        </span>
        <span>
          <span className="block text-fg-3">V</span>
          {fmtUsd(token.volumeUsd)}
        </span>
        <span>
          <span className="block text-fg-3">L</span>
          {fmtUsd(token.liquidityUsd)}
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void buy({ mint: token.mint, sol: quickBuy, source: "search" });
        }}
        className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-buy-tint px-2 text-label font-semibold text-buy hover:bg-buy-tint-hover"
        aria-label={`Quick buy ${fmtSolShort(quickBuy)} SOL of ${token.symbol}`}
      >
        <Zap className="icon-sm" /> {fmtSolShort(quickBuy)}
      </button>
    </div>
  );
}

function WalletRow({
  wallet,
  active,
  onOpen,
  onHover,
}: {
  wallet: WalletSearchHit;
  active: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const tracked = useTrackers((s) => s.wallets.some((w) => w.address === wallet.address));
  const addWallet = useTrackers((s) => s.addWallet);
  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={-1}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      onPointerMove={onHover}
      className={cn("flex cursor-pointer items-center gap-2 px-3 py-2", active ? "bg-surface-3" : "hover:bg-surface-3/60")}
    >
      <span className="flex h-[34px] w-[34px] items-center justify-center rounded-sm bg-surface-3 text-fg-2">
        <Wallet className="icon-lg" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="font-mono text-data">{shortAddr(wallet.address, 6, 6)}</span>
          {wallet.label && <span className="truncate text-data text-fg-2">{wallet.label}</span>}
          {wallet.tags.map((t) => (
            <Tag key={t} tag={t} />
          ))}
          <CopyButton text={wallet.address} label="Copy address" />
        </div>
        <div className="text-label text-fg-3">
          Wallet · {wallet.holdings} live token{wallet.holdings === 1 ? "" : "s"} held
        </div>
      </div>
      {!tracked && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (addWallet({ address: wallet.address, name: wallet.label ?? shortAddr(wallet.address), emoji: "", alerts: false })) {
              useToasts.getState().push({ kind: "success", title: "Wallet tracked", body: shortAddr(wallet.address, 6, 6), ttl: 2000 });
            }
          }}
          className="flex h-6 items-center gap-1 rounded-full border border-hairline px-2 text-label text-fg-2 hover:text-fg-1"
        >
          <UserPlus className="icon-sm" /> Track
        </button>
      )}
    </div>
  );
}

export function SearchModal() {
  const open = useUi((s) => s.searchOpen);
  const setOpen = useUi((s) => s.openSearch);
  const navigate = useNavigate();
  const now = useNow();
  const recent = useSettings((s) => s.recentSearches);
  const recentTokens = useSettings((s) => s.recentTokens);
  const addRecentSearch = useSettings((s) => s.addRecentSearch);
  const addRecentToken = useSettings((s) => s.addRecentToken);
  const clearRecent = useSettings((s) => s.clearRecentSearches);
  const tokens = useMarket((s) => s.tokens);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>({ tokens: [], wallets: [] });
  const [active, setActive] = useState(0);
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults({ tokens: [], wallets: [] });
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults({ tokens: [], wallets: [] });
      return;
    }
    const id = ++reqId.current;
    const t = setTimeout(() => {
      void getServices()
        .data.search(q, 12)
        .then((r) => {
          if (id === reqId.current) {
            setResults(r);
            setActive(0);
          }
        });
    }, 90);
    return () => clearTimeout(t);
  }, [query]);

  const history = useMemo(
    () =>
      recentTokens
        .map((m) => tokens[m])
        .filter((t): t is TokenSummary => t !== undefined)
        .slice(0, 6),
    [recentTokens, tokens],
  );

  const items: Item[] = useMemo(() => {
    if (!query.trim()) return history.map((token) => ({ kind: "token" as const, token }));
    return [
      ...results.tokens.map((token) => ({ kind: "token" as const, token })),
      ...results.wallets.map((wallet) => ({ kind: "wallet" as const, wallet })),
    ];
  }, [query, results, history]);

  const openItem = (item: Item | undefined) => {
    if (!item) return;
    if (query.trim()) addRecentSearch(query);
    setOpen(false);
    if (item.kind === "token") {
      addRecentToken(item.token.mint);
      navigate(`/t/${item.token.mint}`);
    } else navigate(`/portfolio?wallet=${encodeURIComponent(item.wallet.address)}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item?.kind === "token" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        void buy({ mint: item.token.mint, sol: useSettings.getState().quickBuySol, source: "search" });
        return;
      }
      openItem(item);
    }
  };

  const tokenCount = query.trim() ? results.tokens.length : history.length;

  return (
    <Modal open={open} onClose={() => setOpen(false)} bare width={660} label="Search">
      <div className="flex h-12 items-center gap-2 border-b border-hairline px-3">
        <Search className="icon-lg text-fg-3" />
        <input
          data-autofocus
          className="h-full flex-1 bg-transparent text-heading outline-none placeholder:text-fg-3"
          placeholder="Search by name, ticker, contract address or wallet…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search"
        />
        {query && (
          <button type="button" aria-label="Clear" onClick={() => setQuery("")} className="text-fg-3 hover:text-fg-1">
            <X className="icon-md" />
          </button>
        )}
        <Kbd>Esc</Kbd>
      </div>
      <div className="max-h-[60vh] overflow-y-auto py-1" role="listbox" aria-label="Results">
        {!query.trim() && recent.length > 0 && (
          <div className="px-3 pb-2 pt-1">
            <div className="mb-2 flex items-center justify-between">
              <span className="zf-label flex items-center gap-1">
                <Clock className="icon-xs" /> Recent searches
              </span>
              <button type="button" className="text-micro text-fg-3 hover:text-fg-1" onClick={clearRecent}>
                Clear
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setQuery(r)}
                  className="max-w-[220px] truncate rounded-full border border-hairline px-2 py-px text-label text-fg-2 hover:text-fg-1"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
        {tokenCount > 0 && <div className="zf-label px-3 pb-1 pt-1">{query.trim() ? "Tokens" : "History"}</div>}
        {items.map((item, i) =>
          item.kind === "token" ? (
            <TokenRow
              key={item.token.mint}
              token={item.token}
              active={i === active}
              now={now}
              onOpen={() => openItem(item)}
              onHover={() => setActive(i)}
            />
          ) : (
            <div key={item.wallet.address}>
              {i === results.tokens.length && <div className="zf-label px-3 pb-1 pt-2">Wallets</div>}
              <WalletRow wallet={item.wallet} active={i === active} onOpen={() => openItem(item)} onHover={() => setActive(i)} />
            </div>
          ),
        )}
        {query.trim() && items.length === 0 && (
          <div className="px-3 py-8 text-center text-data text-fg-3">No tokens or wallets match “{query}”.</div>
        )}
        {!query.trim() && items.length === 0 && recent.length === 0 && (
          <div className="px-3 py-8 text-center text-data text-fg-3">Type a name, $ticker, contract address or wallet address.</div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-hairline px-3 py-1 text-micro text-fg-3">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Enter</Kbd> open
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⇧</Kbd>
          <Kbd>Enter</Kbd> quick buy
        </span>
        <span className="ml-auto">Paste a CA anywhere to open it</span>
      </div>
    </Modal>
  );
}
