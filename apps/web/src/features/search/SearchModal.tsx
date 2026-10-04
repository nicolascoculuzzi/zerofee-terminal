import { ArrowRight, Check, Search, X } from "lucide-react";
import { type ClipboardEvent, Fragment, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Hotkey, KeyCap } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSolShort, shortAddr } from "../../lib/format";
import { buy } from "../../lib/tradeActions";
import { useMediaQuery } from "../../lib/useMediaQuery";
import type { SearchResults, TokenSummary, WalletSearchHit } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { useTrackers } from "../../state/trackers";
import { useUi } from "../../state/ui";
import { useWallet } from "../../state/wallet";
import { matchAction, type PaletteAction, paletteActions } from "./actions";
import { type DevHit, findDevs } from "./devs";
import { mintFromText } from "./mintFromText";
import { PreviewPane } from "./PreviewPane";
import { ActionRow, DevRow, ExactRow, GroupLabel, QueryRow, SkeletonRow, TokenRow, WalletRow } from "./rows";

type Scope = "all" | "tokens" | "wallets" | "devs" | "actions";
const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tokens", label: "Tokens" },
  { id: "wallets", label: "Wallets" },
  { id: "devs", label: "Devs" },
  { id: "actions", label: "Actions" },
];

type Item =
  | { kind: "exact"; key: string; token: TokenSummary }
  | { kind: "token"; key: string; token: TokenSummary }
  | { kind: "wallet"; key: string; wallet: WalletSearchHit }
  | { kind: "dev"; key: string; dev: DevHit }
  | { kind: "action"; key: string; action: PaletteAction }
  | { kind: "query"; key: string; query: string }
  /** A pasted / typed contract address (or a link holding one) the search did not find: open it anyway. */
  | { kind: "open"; key: string; mint: string };

interface Group {
  id: string;
  label: string;
  items: Item[];
  columns?: boolean;
  action?: ReactNode;
}

const EMPTY: SearchResults = { tokens: [], wallets: [] };
const SEARCH_DEBOUNCE_MS = 60;
const SKELETON_AFTER_MS = 150;
const PAGE = 8;
const LIST_ID = "zf-palette-list";
const optionId = (key: string) => `zf-palette-opt-${key}`;

/** Limits per group: a few each under All, more inside a scope. */
const LIMIT: Record<Scope, { tokens: number; wallets: number; devs: number; actions: number }> = {
  all: { tokens: 8, wallets: 4, devs: 3, actions: 4 },
  tokens: { tokens: 20, wallets: 0, devs: 0, actions: 0 },
  wallets: { tokens: 0, wallets: 20, devs: 0, actions: 0 },
  devs: { tokens: 0, wallets: 0, devs: 20, actions: 0 },
  actions: { tokens: 0, wallets: 0, devs: 0, actions: 99 },
};

function copyTarget(item: Item | undefined): { text: string; what: string } | null {
  if (!item) return null;
  if (item.kind === "open") return { text: item.mint, what: "CA" };
  if (item.kind === "token" || item.kind === "exact") return { text: item.token.mint, what: "CA" };
  if (item.kind === "wallet") return { text: item.wallet.address, what: "address" };
  if (item.kind === "dev") return { text: item.dev.address, what: "address" };
  return null;
}

function Hint({ children }: { children: ReactNode }) {
  return <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">{children}</span>;
}

/*
 * Command palette (DESIGN.md 4.15): 640 px (880 with a 240 px preview from 1280 px), a 44 px
 * input row with a scope chip and an Esc keycap, a 28 px scope row (Tab cycles), grouped results
 * (RECENT, TOKENS, WALLETS, DEVS, ACTIONS), and a 28 px footer of key hints with the result count.
 * Enter opens, Cmd+Enter quick-buys, Cmd+C copies the CA, Esc clears the query, then closes.
 * Sections, footer key hints and count after Vapi; ticker actions with keycaps after Fey; scopes
 * after OpenSea and Linear; preview pane after Dropbox Dash:
 * https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b
 * https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1
 * https://mobbin.com/screens/f603ab17-6650-4db3-ad20-56b6e5579863
 * https://mobbin.com/screens/d0b98680-66e2-47d4-9dc4-28bc9450c27f
 * https://mobbin.com/screens/0567ef26-d68b-4674-a6ee-8d255bbe7990
 */
export function SearchModal() {
  const open = useUi((s) => s.searchOpen);
  const setOpen = useUi((s) => s.openSearch);
  const navigate = useNavigate();
  const wide = useMediaQuery("(min-width: 1280px)");
  const live = useMarket((s) => s.tokens);
  const recentQueries = useSettings((s) => s.recentSearches);
  const recentTokens = useSettings((s) => s.recentTokens);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const hotkeys = useSettings((s) => s.hotkeys);
  const tracked = useTrackers((s) => s.wallets);
  const locked = useWallet((s) => s.service.locked && s.mode === "instant");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [results, setResults] = useState<{ q: string; data: SearchResults }>({ q: "", data: EMPTY });
  const [pending, setPending] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [actions, setActions] = useState<PaletteAction[]>([]);
  const reqId = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const q = query.trim();
  // a link (pump.fun, DexScreener, Axiom, GMGN ...) searches for the address it holds
  const pastedMint = useMemo(() => mintFromText(q), [q]);
  const searchQ = pastedMint ?? q;

  // Fresh state every time it opens; actions are built then, so their labels show current state.
  useEffect(() => {
    if (open) {
      setActions(paletteActions());
      return;
    }
    setQuery("");
    setScope("all");
    setResults({ q: "", data: EMPTY });
    setActive(0);
    setCopied(null);
  }, [open]);

  useEffect(() => {
    if (!q) {
      setPending(false);
      setSkeleton(false);
      return;
    }
    const id = ++reqId.current;
    setPending(true);
    const skeletonTimer = setTimeout(() => setSkeleton(true), SKELETON_AFTER_MS);
    const searchTimer = setTimeout(() => {
      void getServices()
        .data.search(searchQ, 24)
        .catch(() => EMPTY)
        .then((data) => {
          if (id !== reqId.current) return;
          setResults({ q, data });
          setPending(false);
          setSkeleton(false);
          clearTimeout(skeletonTimer);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(searchTimer);
      clearTimeout(skeletonTimer);
    };
  }, [q, searchQ]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  // Reset the selection when the question changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on query and scope
  useEffect(() => setActive(0), [q, scope]);

  const groups: Group[] = useMemo(() => {
    const withLive = (t: TokenSummary) => live[t.mint] ?? t;
    const out: Group[] = [];
    if (!q) {
      if (scope === "all" || scope === "tokens") {
        const recent: Item[] = recentTokens
          .map((m) => live[m])
          .filter((t): t is TokenSummary => t !== undefined)
          .slice(0, 5)
          .map((token) => ({ kind: "token", key: `recent-${token.mint}`, token }));
        if (scope === "all") {
          // Index keys: these become element ids (aria-activedescendant), and queries may hold spaces.
          recentQueries.slice(0, 3).forEach((rq, i) => {
            recent.push({ kind: "query", key: `q-${i}`, query: rq });
          });
        }
        if (recent.length > 0) out.push({ id: "recent", label: "Recent", items: recent, columns: recent.some((i) => i.kind === "token") });
      }
      if (scope === "all" || scope === "actions") {
        out.push({ id: "actions", label: "Actions", items: actions.map((action) => ({ kind: "action", key: `a-${action.id}`, action })) });
      }
      return out;
    }
    // While a newer search is in flight, the previous results stay up (no flicker).
    const data = results.data;
    const limit = LIMIT[scope];
    const exact = data.tokens.find((t) => t.mint === searchQ);
    // not in the index (never seen, or pruned): the token page reads it from chain
    if (pastedMint && !exact && !pending && limit.tokens > 0)
      out.push({ id: "open", label: "Contract address", items: [{ kind: "open", key: `o-${pastedMint}`, mint: pastedMint }] });
    if (exact && limit.tokens > 0)
      out.push({ id: "exact", label: "Exact match", items: [{ kind: "exact", key: `x-${exact.mint}`, token: withLive(exact) }] });
    const tokens = data.tokens.filter((t) => t.mint !== exact?.mint).slice(0, limit.tokens);
    if (tokens.length > 0) {
      out.push({
        id: "tokens",
        label: "Tokens",
        columns: true,
        items: tokens.map((t) => ({ kind: "token", key: `t-${t.mint}`, token: withLive(t) })),
      });
    }
    const wallets = data.wallets.slice(0, limit.wallets);
    if (wallets.length > 0)
      out.push({ id: "wallets", label: "Wallets", items: wallets.map((w) => ({ kind: "wallet", key: `w-${w.address}`, wallet: w })) });
    const devs = findDevs(q, live, data.tokens, limit.devs);
    if (devs.length > 0) out.push({ id: "devs", label: "Devs", items: devs.map((d) => ({ kind: "dev", key: `d-${d.address}`, dev: d })) });
    const acts = actions.filter((a) => matchAction(a, q)).slice(0, limit.actions);
    if (acts.length > 0)
      out.push({ id: "actions", label: "Actions", items: acts.map((action) => ({ kind: "action", key: `a-${action.id}`, action })) });
    return out;
  }, [q, scope, results, live, recentTokens, recentQueries, actions, pastedMint, searchQ, pending]);

  /** Per-scope counts for the scope row (only while searching). */
  const counts = useMemo(() => {
    if (!q) return null;
    const data = results.data;
    const actionCount = actions.filter((a) => matchAction(a, q)).length;
    const devCount = findDevs(q, live, data.tokens, 20).length;
    const c = { tokens: data.tokens.length, wallets: data.wallets.length, devs: devCount, actions: actionCount };
    return { ...c, all: c.tokens + c.wallets + c.devs + c.actions };
  }, [q, results, actions, live]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];
  const activeKey = current?.key ?? null;

  // Keep the selected row in view while moving with the keyboard.
  useEffect(() => {
    if (activeKey) document.getElementById(optionId(activeKey))?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const close = () => setOpen(false);

  const remember = () => {
    if (q) useSettings.getState().addRecentSearch(q);
  };

  const openMint = (mint: string) => {
    remember();
    useSettings.getState().addRecentToken(mint);
    close();
    navigate(`/t/${mint}`);
  };

  /** Pasting a contract address or a terminal link opens the token at once, indexed or not (like Axiom). */
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const mint = mintFromText(text);
    if (!mint || tracked.some((w) => w.address === mint)) return; // a tracked wallet: let the search show it
    e.preventDefault();
    openMint(mint);
  };

  const openItem = (item: Item | undefined) => {
    if (!item) return;
    switch (item.kind) {
      case "open":
        openMint(item.mint);
        return;
      case "exact":
      case "token":
        remember();
        useSettings.getState().addRecentToken(item.token.mint);
        close();
        navigate(`/t/${item.token.mint}`);
        return;
      case "wallet":
        remember();
        close();
        navigate(`/portfolio?wallet=${encodeURIComponent(item.wallet.address)}`);
        return;
      case "dev":
        remember();
        close();
        navigate(`/portfolio?wallet=${encodeURIComponent(item.dev.address)}`);
        return;
      case "action": {
        const run = item.action.run;
        close();
        // After the palette unmounts, so the next overlay takes focus cleanly.
        setTimeout(run, 0);
        return;
      }
      case "query":
        setQuery(item.query);
        inputRef.current?.focus();
        return;
    }
  };

  const quickBuyItem = (item: Item | undefined) => {
    if (!item || (item.kind !== "token" && item.kind !== "exact")) return;
    useSettings.getState().addRecentToken(item.token.mint);
    void buy({ mint: item.token.mint, sol: useSettings.getState().quickBuySol, source: "search" });
  };

  const track = (w: WalletSearchHit) => {
    useTrackers.getState().addWallet({ address: w.address, name: w.label ?? shortAddr(w.address), emoji: "", alerts: false });
  };

  const cycleScope = (dir: 1 | -1) => {
    const i = SCOPES.findIndex((s) => s.id === scope);
    const next = SCOPES[(i + dir + SCOPES.length) % SCOPES.length];
    if (next) setScope(next.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    const last = flat.length - 1;
    // The list can shrink under the selection (new results); move from where it shows.
    const at = Math.max(0, Math.min(active, last));
    const move = (to: number) => {
      e.preventDefault();
      setActive(Math.max(0, Math.min(last, to)));
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "PageDown") move(at + PAGE);
    else if (e.key === "PageUp") move(at - PAGE);
    else if (e.key === "Home" && !e.shiftKey) move(0);
    else if (e.key === "End" && !e.shiftKey) move(last);
    else if (e.key === "Enter") {
      e.preventDefault();
      if (mod) quickBuyItem(current);
      else openItem(current);
    } else if (e.key === "Tab") {
      // The palette keeps focus in its input; Tab changes scope instead (4.15).
      e.preventDefault();
      e.stopPropagation();
      cycleScope(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
      } else if (scope !== "all") {
        e.preventDefault();
        e.stopPropagation();
        setScope("all");
      }
      // Otherwise the global Esc closes the palette.
    } else if (mod && e.key.toLowerCase() === "c") {
      const input = e.currentTarget;
      if (input.selectionStart !== input.selectionEnd) return; // copying the typed text
      const target = copyTarget(current);
      if (!target) return;
      e.preventDefault();
      void copyText(target.text).then((ok) => ok && setCopied(target.what));
    }
  };

  const total = counts ? counts[scope] : null;
  const busyFirst = pending && skeleton && results.q !== q;
  const kind = current?.kind;
  const scopeLabel = SCOPES.find((s) => s.id === scope)?.label ?? "All";

  let index = -1;
  const renderItem = (item: Item) => {
    index++;
    const i = index;
    const base = { id: optionId(item.key), active: item.key === activeKey, onHover: () => setActive(i), onOpen: () => openItem(item) };
    switch (item.kind) {
      case "exact":
        return <ExactRow key={item.key} {...base} token={item.token} quickBuy={quickBuy} />;
      case "token":
        return (
          <TokenRow key={item.key} {...base} token={item.token} quickBuy={quickBuy} locked={locked} onBuy={() => quickBuyItem(item)} />
        );
      case "wallet":
        return (
          <WalletRow
            key={item.key}
            {...base}
            wallet={item.wallet}
            tracked={tracked.some((w) => w.address === item.wallet.address)}
            onTrack={() => track(item.wallet)}
          />
        );
      case "dev":
        return <DevRow key={item.key} {...base} dev={item.dev} />;
      case "action":
        return (
          <ActionRow
            key={item.key}
            {...base}
            action={item.action}
            binding={item.action.hotkey ? hotkeys[item.action.hotkey]?.[0] : undefined}
          />
        );
      case "query":
        return <QueryRow key={item.key} {...base} query={item.query} />;
      case "open":
        return (
          <ActionRow
            key={item.key}
            {...base}
            binding={undefined}
            action={{
              id: "open",
              label: `Open ${shortAddr(item.mint)}`,
              keywords: "",
              icon: <ArrowRight />,
              hint: "Load from chain",
              run: () => openMint(item.mint),
            }}
          />
        );
    }
  };

  const previewToken = wide && current && (current.kind === "token" || current.kind === "exact") ? current.token : null;

  return (
    <Modal open={open} onClose={close} bare width={wide ? 880 : 640} label="Command palette" layer="palette" top="palette">
      <div className="flex max-h-[min(520px,calc(84vh-2px))] min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
          <Search className="icon-md shrink-0 text-fg-3" />
          <input
            ref={inputRef}
            data-autofocus
            role="combobox"
            aria-expanded="true"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
            aria-label="Search token, CA, wallet or command"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-amount font-normal text-fg-1 outline-none placeholder:text-fg-4 max-md:text-title"
            placeholder="Search token, CA, wallet or command"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
          />
          {scope !== "all" && (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-surface-3 pr-0.5 pl-1.5 text-label text-fg-1">
              {scopeLabel}
              <button
                type="button"
                aria-label={`Clear the ${scopeLabel} scope`}
                onClick={() => {
                  setScope("all");
                  inputRef.current?.focus();
                }}
                className="flex size-4 items-center justify-center rounded-xs text-fg-3 hover:text-fg-1"
              >
                <X className="icon-xs" />
              </button>
            </span>
          )}
          <KeyCap k="Esc" />
        </div>

        <div role="tablist" aria-label="Search scope" className="flex h-7 shrink-0 items-center gap-1 border-b border-hairline px-2">
          {SCOPES.map((s) => {
            const on = s.id === scope;
            const n = counts?.[s.id];
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={-1}
                onClick={() => {
                  setScope(s.id);
                  inputRef.current?.focus();
                }}
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-xs px-1.5 text-label font-medium transition-colors max-md:h-9",
                  on ? "bg-surface-3 text-fg-1" : "text-fg-3 hover:text-fg-1",
                )}
              >
                {s.label}
                {n !== undefined && <span className="zf-num font-normal text-fg-3">{fmtCount(n)}</span>}
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1">
          <div id={LIST_ID} role="listbox" aria-label="Results" className="min-h-0 min-w-0 flex-1 overflow-y-auto py-1">
            {busyFirst ? (
              <>
                <GroupLabel columns>Tokens</GroupLabel>
                <SkeletonRow />
                <SkeletonRow />
                <SkeletonRow />
              </>
            ) : (
              groups.map((g) => (
                <Fragment key={g.id}>
                  <GroupLabel
                    columns={g.columns}
                    action={
                      g.id === "recent" && recentQueries.length > 0 ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => useSettings.getState().clearRecentSearches()}
                          className="text-micro font-medium text-fg-3 hover:text-fg-1"
                        >
                          Clear searches
                        </button>
                      ) : undefined
                    }
                  >
                    {g.label}
                  </GroupLabel>
                  {g.items.map(renderItem)}
                </Fragment>
              ))
            )}
            {!busyFirst && q && flat.length === 0 && !pending && (
              <div className="px-3 py-6">
                <p className="text-body font-medium text-fg-2">No matches for “{q}”</p>
                <p className="mt-1 text-data text-fg-3">Paste a contract address to open any token.</p>
              </div>
            )}
            {!q && flat.length === 0 && (
              <div className="px-3 py-6">
                <p className="text-body font-medium text-fg-2">
                  {scope === "wallets" ? "Search wallets" : scope === "devs" ? "Search devs" : "Search tokens"}
                </p>
                <p className="mt-1 text-data text-fg-3">
                  {scope === "devs"
                    ? "Type a ticker to find its dev, or the start of a creator address."
                    : scope === "wallets"
                      ? "Type a wallet address or a tracked wallet's name."
                      : "Type a name, ticker or contract address. Tokens you open appear here."}
                </p>
              </div>
            )}
          </div>
          {wide && <PreviewPane token={previewToken} />}
        </div>

        <div className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t border-hairline px-3 text-label text-fg-3">
          <Hint>
            <KeyCap k="↑" />
            <KeyCap k="↓" /> navigate
          </Hint>
          <Hint>
            <Hotkey binding="Enter" /> {kind === "action" ? "run" : kind === "query" ? "search" : "open"}
          </Hint>
          {(kind === "token" || kind === "exact") && (
            <Hint>
              <Hotkey binding="Mod+Enter" /> buy {fmtSolShort(quickBuy)} SOL
            </Hint>
          )}
          {copyTarget(current) && (
            <span className="max-md:hidden">
              <Hint>
                <Hotkey binding="Mod+C" /> copy {copyTarget(current)?.what}
              </Hint>
            </span>
          )}
          <span className="max-lg:hidden">
            <Hint>
              <Hotkey binding="Tab" /> scope
            </Hint>
          </span>
          <span className="max-lg:hidden">
            <Hint>
              <KeyCap k="Esc" /> {query ? "clear" : "close"}
            </Hint>
          </span>
          <span className="ml-auto shrink-0">
            {copied ? (
              <span role="status" className="inline-flex items-center gap-1 text-fg-1">
                <Check className="icon-xs" /> Copied {copied}
              </span>
            ) : total !== null ? (
              <span className="zf-num">
                {fmtCount(total)} {total === 1 ? "result" : "results"}
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </Modal>
  );
}
