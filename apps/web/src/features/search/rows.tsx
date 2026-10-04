import { Check, History, Lock, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { MetricLabel, SolGlyph, Tag } from "../../components/ui/bits";
import { Hotkey } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar, WalletAvatar } from "../../components/ui/TokenAvatar";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtCount, fmtSol, fmtSolShort, shortAddr } from "../../lib/format";
import type { TokenSummary, WalletSearchHit } from "../../protocol";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import type { PaletteAction } from "./actions";
import type { DevHit } from "./devs";

/** MC / liquidity in the global quote (DESIGN.md 3.9): USD compact, or a SolGlyph and SOL. */
export function QuoteValue({ usd, sol, strong }: { usd: number; sol: number | null; strong?: boolean }) {
  const quote = useSettings((s) => s.display.quote);
  const solUsd = useMarket((s) => s.solUsd);
  const tone = strong ? "text-fg-1" : "text-fg-2";
  if (quote === "SOL") {
    const value = sol ?? (solUsd > 0 ? usd / solUsd : Number.NaN);
    return (
      <span className={cn("zf-num inline-flex items-center justify-end gap-0.5 text-data", tone)}>
        <SolGlyph className="text-fg-3" />
        {fmtSol(value)}
      </span>
    );
  }
  return <Num value={usd} kind="usd" className={cn("text-data", tone)} />;
}

interface RowBase {
  id: string;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
}

/** Shared row frame: the selected row is surface-3 with a 2 px accent bar on the left. */
function Row({
  id,
  active,
  onHover,
  onOpen,
  className,
  children,
  label,
}: RowBase & { className: string; children: ReactNode; label: string }) {
  return (
    // Options are activated through the input (aria-activedescendant); clicks are a pointer shortcut.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox input
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      aria-label={label}
      onPointerMove={onHover}
      onClick={onOpen}
      className={cn("group relative flex cursor-pointer items-center gap-2 px-3", active && "bg-surface-3", className)}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
      {children}
    </div>
  );
}

/** The quick-buy pill (DESIGN.md 4.6): neutral at rest, buy-tinted on hover, buy-filled on press. */
function QuickBuyPill({
  amount,
  locked,
  visible,
  onBuy,
  symbol,
}: {
  amount: number;
  locked: boolean;
  visible: boolean;
  onBuy: () => void;
  symbol: string;
}) {
  return (
    <Tooltip
      content={
        <span className="inline-flex items-center gap-2">
          {locked ? "Unlock to buy" : `Buy ${fmtSolShort(amount)} SOL`} <Hotkey binding="Mod+Enter" />
        </span>
      }
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Buy ${fmtSolShort(amount)} SOL of ${symbol}`}
        onClick={(e) => {
          e.stopPropagation();
          onBuy();
        }}
        className={cn(
          "flex h-6 items-center gap-1 rounded-full border border-hairline-strong bg-surface-3 px-1.5 text-data font-semibold text-fg-1 transition-colors hover:border-buy-edge hover:bg-buy-tint hover:text-buy active:bg-buy active:text-ink [&:hover_svg]:text-buy",
          visible ? "visible" : "invisible group-hover:visible",
        )}
      >
        {locked ? <Lock className="icon-xs text-fg-3" /> : <Zap className="icon-xs text-fg-3" />}
        <span className="zf-num">{fmtSolShort(amount)}</span>
      </button>
    </Tooltip>
  );
}

/** Token row, 36 px: avatar 20 · ticker 13/600, name, CA · age · MC · liquidity · change · pill. */
export function TokenRow({
  token,
  quickBuy,
  locked,
  onBuy,
  ...base
}: RowBase & { token: TokenSummary; quickBuy: number; locked: boolean; onBuy: () => void }) {
  return (
    <Row {...base} className="h-9" label={`${token.symbol}, ${token.name}`}>
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="xs" badge={false} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 text-body font-semibold text-fg-1">{token.symbol}</span>
        <span className="truncate text-data text-fg-3">{token.name}</span>
        <span className="hidden shrink-0 font-mono text-label text-fg-3 sm:inline">{shortAddr(token.mint)}</span>
      </div>
      <Age ts={token.createdAt} className="w-7 shrink-0 text-right text-label" />
      <span className="w-16 shrink-0 text-right">
        <QuoteValue usd={token.marketCapUsd} sol={token.marketCapSol} strong />
      </span>
      <span className="hidden w-16 shrink-0 text-right sm:block">
        <QuoteValue usd={token.liquidityUsd} sol={null} />
      </span>
      <span className="hidden w-14 shrink-0 text-right sm:block">
        <Num value={token.change5mPct} kind="pct" signed className="text-data" />
      </span>
      <span className="flex w-16 shrink-0 justify-end">
        <QuickBuyPill amount={quickBuy} locked={locked} visible={base.active} onBuy={onBuy} symbol={token.symbol} />
      </span>
    </Row>
  );
}

/** An exact pasted contract address: "Open WIF · exact match", with "Buy 0.25 SOL" and its keycaps. */
export function ExactRow({ token, quickBuy, ...base }: RowBase & { token: TokenSummary; quickBuy: number }) {
  return (
    <Row {...base} className="h-11" label={`Open ${token.symbol}, exact match`}>
      <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="sm" badge={false} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">
          <span className="font-semibold text-fg-1">Open {token.symbol}</span>
          <span className="text-fg-3"> · exact match</span>
        </div>
        <div className="flex items-center gap-2 text-label text-fg-2">
          Buy {fmtSolShort(quickBuy)} SOL <Hotkey binding="Mod+Enter" />
        </div>
      </div>
      <span className="w-16 shrink-0 text-right">
        <QuoteValue usd={token.marketCapUsd} sol={token.marketCapSol} strong />
      </span>
      <Hotkey binding="Enter" />
    </Row>
  );
}

/** Wallet row, 32 px: avatar 16, label or address (mono), tags, holdings, a "Track" button. */
export function WalletRow({
  wallet,
  tracked,
  onTrack,
  ...base
}: RowBase & { wallet: WalletSearchHit; tracked: boolean; onTrack: () => void }) {
  return (
    <Row {...base} className="h-8" label={wallet.label ?? wallet.address}>
      <WalletAvatar seed={wallet.address} label={wallet.label ?? wallet.address} size={16} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {wallet.label ? (
          <>
            <span className="truncate text-data text-fg-1">{wallet.label}</span>
            <span className="shrink-0 font-mono text-label text-fg-3">{shortAddr(wallet.address)}</span>
          </>
        ) : (
          <span className="truncate font-mono text-data text-fg-2">{shortAddr(wallet.address, 6, 6)}</span>
        )}
        {wallet.tags.map((t) => (
          <Tag key={t} tag={t} />
        ))}
      </div>
      <span className="zf-num shrink-0 text-label text-fg-3">{fmtCount(wallet.holdings)} held</span>
      {tracked ? (
        <span className="inline-flex w-16 shrink-0 items-center justify-end gap-1 text-label text-fg-3">
          <Check className="icon-xs" /> Tracked
        </span>
      ) : (
        <span className="flex w-16 shrink-0 justify-end">
          <Button
            size="xs"
            variant="secondary"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              onTrack();
            }}
          >
            Track
          </Button>
        </span>
      )}
    </Row>
  );
}

/** Dev row, 32 px: a DEV tag, the creator address, live-set launch counts. */
export function DevRow({ dev, ...base }: RowBase & { dev: DevHit }) {
  return (
    <Row {...base} className="h-8" label={`Dev ${dev.address}`}>
      <WalletAvatar seed={dev.address} label={dev.address} size={16} />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Tag tag="dev" />
        <span className="truncate font-mono text-data text-fg-2">{shortAddr(dev.address, 6, 6)}</span>
        {dev.via && <span className="truncate text-label text-fg-3">dev of {dev.via.symbol}</span>}
      </div>
      <span className="zf-num shrink-0 text-label text-fg-3">
        {fmtCount(dev.launches)} live · {fmtCount(dev.migrated)} migrated
      </span>
    </Row>
  );
}

/** Action row, 28 px: 14 px icon in text-3, 12 px label, keycaps on the right. */
export function ActionRow({ action, binding, ...base }: RowBase & { action: PaletteAction; binding: string | undefined }) {
  return (
    <Row {...base} className="h-7" label={action.label}>
      <span className="flex shrink-0 text-fg-3 [&_svg]:size-3.5">{action.icon}</span>
      <span className="min-w-0 flex-1 truncate text-data text-fg-1">{action.label}</span>
      {action.hint && <span className="shrink-0 text-label text-fg-3">{action.hint}</span>}
      {binding && <Hotkey binding={binding} />}
    </Row>
  );
}

/** A recent search, 28 px. */
export function QueryRow({ query, ...base }: RowBase & { query: string }) {
  return (
    <Row {...base} className="h-7" label={`Search ${query}`}>
      <History className="icon-sm shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate text-data text-fg-1">{query}</span>
      <span className="shrink-0 text-label text-fg-3">Search again</span>
    </Row>
  );
}

/** Loading skeleton at the token row height: 8 px bars, no shimmer (DESIGN.md 4.18). */
export function SkeletonRow() {
  return (
    <div aria-hidden="true" className="flex h-9 items-center gap-2 px-3">
      <span className="size-5 shrink-0 rounded-sm bg-surface-3" />
      <span className="h-2 w-1/3 rounded-xs bg-surface-3" />
      <span className="ml-auto h-2 w-16 rounded-xs bg-surface-3" />
      <span className="h-2 w-16 rounded-xs bg-surface-3 max-sm:hidden" />
    </div>
  );
}

/** Group label, 24 px, 10/600 uppercase (+0.06em). Token groups add column captions. */
export function GroupLabel({ children, columns, action }: { children: ReactNode; columns?: boolean; action?: ReactNode }) {
  return (
    <div role="presentation" className="flex h-6 items-center gap-2 px-3">
      <span className="zf-group-label min-w-0 flex-1">{children}</span>
      {action}
      {columns && (
        // Column captions carry the published definitions (4.14), like any metric label.
        <span className="flex shrink-0 items-center gap-2 text-micro text-fg-3">
          <span className="flex w-7 justify-end">
            <MetricLabel metric="age">Age</MetricLabel>
          </span>
          <span className="flex w-16 justify-end">
            <MetricLabel metric="marketCap">MC</MetricLabel>
          </span>
          <span className="flex w-16 justify-end max-sm:hidden">
            <MetricLabel metric="liquidity">Liq</MetricLabel>
          </span>
          <span className="flex w-14 justify-end max-sm:hidden">
            <MetricLabel metric="change5m">5m</MetricLabel>
          </span>
          <span className="w-16" />
        </span>
      )}
    </div>
  );
}
