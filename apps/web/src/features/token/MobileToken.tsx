import { ArrowLeftRight, Check, ChevronLeft, Share2, Star, Zap } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { EmptyState, Skeleton } from "../../components/ui/bits";
import { Segmented } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtCount, fmtMs, fmtPct, fmtSol, fmtUsd, signClass } from "../../lib/format";
import { TONE_TEXT } from "../../lib/metrics";
import { rearmOrder } from "../../lib/tradeActions";
import { type Order, TIMEFRAMES, type Timeframe, type TokenDetail, type TokenRisk, type TokenSummary } from "../../protocol";
import { isOpenOrder, useOrders } from "../../state/orders";
import { useSettings } from "../../state/settings";
import { triggerText } from "../orders/orderText";
import { RISK_ICON } from "../pulse/icons";
import { RISK_CHIPS, riskChip } from "../pulse/RiskChips";
import { CancelOrderDialog, useCancelDialog } from "./CancelOrderDialog";
import { MobileHoldersList } from "./HoldersTables";
import { MobileTradeBar } from "./MobileTradeBar";
import { Money, useQuote } from "./money";
import { distanceToTrigger, KIND_TEXT, STATUS_TEXT, type StatusTone, sizeText } from "./orderText";
import { TokenInfo } from "./TokenInfo";
import { useOpenOrderCount } from "./TokenOrders";
import { MobileTradesList } from "./TradesTable";
import { type ChartMode, useTokenUi } from "./tokenUi";
import { useTickFlash } from "./useTickFlash";

const TokenChart = lazy(() => import("./TokenChart"));

/*
 * Phone token page (DESIGN.md 5.8): header 44 · price block 64 · chart 240 (no toolbar) ·
 * timeframes · risk strip · tabs · 44 px rows · the sticky trade bar. Every target is 44 px, so the
 * timeframe row and tabs are 44 px bands (the blueprint's 36 px plus the touch rule). The screen is a
 * detail view: the app's top bar and bottom tabs step aside, this header takes the top safe area and
 * the trade bar the bottom one. Price headline, change and timeframe row after Phantom:
 * https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba ; header, chart, tabs and a
 * bottom Buy/Sell pair without the tab bar after Coinbase Advanced:
 * https://mobbin.com/screens/f7580aa4-4e73-4a2a-800f-4682a03bbd30
 */

type MobileTab = "trades" | "holders" | "info" | "orders";

const MOBILE_TFS: Timeframe[] = TIMEFRAMES.filter((t) => t !== "15s");
const TAB_LABEL: Record<MobileTab, string> = { trades: "Trades", holders: "Holders", info: "Info", orders: "Orders" };

function HitButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-inset flex size-11 shrink-0 items-center justify-center rounded-sm transition-colors active:bg-surface-2",
        active ? "text-fg-1" : "text-fg-3 hover:text-fg-1",
      )}
    >
      {children}
    </button>
  );
}

const RISK_NAME: Record<(typeof RISK_CHIPS)[number]["key"], string> = {
  top10: "Top 10",
  dev: "Dev",
  snipers: "Snipers",
  insiders: "Insiders",
  bundlers: "Bundlers",
};

/**
 * Holder-risk strip: the Pulse slot language (DESIGN.md 4.5: the metric's glyph in text-3, the band
 * on the value only, 0% dim) with room for the full name under each value, as one stat strip with
 * hairline dividers rather than five chips (after Fey's stats row:
 * https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2). A metric the server hasn't
 * computed keeps its cell with the name dimmed and no value: never a dash. While the server is still
 * computing them (`pending`: a history backfill runs) each value is a static skeleton; when none is
 * known and none is coming the strip is left out (five bare glyphs would say nothing).
 */
function RiskStrip({ risk, pending }: { risk: TokenRisk | null; pending: boolean }) {
  const thresholds = useSettings((s) => s.display.riskThresholds);
  const colored = useSettings((s) => s.display.metricColors);
  const chips = RISK_CHIPS.map(({ key }) => riskChip(key, risk, thresholds));
  if (!pending && chips.every((c) => c.unknown)) return null;
  return (
    // Under 360 px of strip the names drop (the aria-label keeps them) and each glyph sits over its value:
    // values never truncate.
    <div className="@container border-b border-hairline bg-surface-1" aria-busy={pending || undefined}>
      <div className="grid h-12 grid-cols-5 divide-x divide-hairline">
        {chips.map((chip) => {
          const key = chip.key;
          const Icon = RISK_ICON[key];
          if (pending && chip.unknown) {
            return (
              <div
                key={key}
                role="img"
                aria-label={`${RISK_NAME[key]}: computing`}
                className="flex min-w-0 flex-col justify-center gap-1 px-2.5 @max-[359px]:items-center @max-[359px]:px-1"
              >
                <span className="flex h-4 items-center gap-1 @max-[359px]:h-auto @max-[359px]:flex-col @max-[359px]:gap-0.5">
                  <Icon aria-hidden="true" className="icon-xs shrink-0 text-fg-4" />
                  <Skeleton width={24} />
                </span>
                <span className="truncate text-micro font-medium text-fg-4 @max-[359px]:hidden">{RISK_NAME[key]}</span>
              </div>
            );
          }
          const tone = chip.devSold ? "text-fg-2" : chip.text === "0%" ? "text-fg-3" : colored ? TONE_TEXT[chip.tone] : "text-fg-2";
          return (
            <div
              key={key}
              role="img"
              aria-label={chip.aria}
              className="flex min-w-0 flex-col justify-center gap-0.5 px-2.5 @max-[359px]:items-center @max-[359px]:px-1"
            >
              <span className="flex h-4 items-center gap-1 @max-[359px]:h-auto @max-[359px]:flex-col @max-[359px]:gap-0.5">
                <Icon aria-hidden="true" className={cn("icon-xs shrink-0", chip.unknown ? "text-fg-4" : "text-fg-3")} />
                {!chip.unknown && (
                  <span className={cn("zf-num text-data font-semibold whitespace-nowrap", tone)}>{chip.devSold ? "Sold" : chip.text}</span>
                )}
              </span>
              <span className={cn("truncate text-micro font-medium @max-[359px]:hidden", chip.unknown ? "text-fg-4" : "text-fg-3")}>
                {RISK_NAME[key]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Segments of the shared control stretched to a 44 px hit area (row height) without growing visually. */
const TOUCH_SEGMENTS =
  "h-7 [&>button]:relative [&>button]:after:absolute [&>button]:after:inset-x-0 [&>button]:after:-inset-y-[11px] [&>button]:after:content-['']";

/** Chart placeholder while its chunk loads: the price axis and OHLC legend as static bars. */
function ChartSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-full bg-surface-1">
      <div className="flex flex-1 flex-col gap-2 p-2">
        <Skeleton width={148} />
        <Skeleton width={96} />
      </div>
      <div className="flex w-14 flex-col justify-around border-l border-hairline px-2 py-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} width={32} />
        ))}
      </div>
    </div>
  );
}

/** Phone token page before the detail snapshot lands: header, price block, chart and bar shapes. */
export function MobileTokenSkeleton({ label }: { label?: string } = {}) {
  return (
    <section aria-busy="true" aria-label={label ?? "Loading token"} className="flex h-full flex-col bg-surface-1">
      <div className="flex h-[calc(44px+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-hairline pt-[env(safe-area-inset-top)] pl-11">
        <Skeleton shape="square" size={24} />
        <Skeleton width={72} />
      </div>
      <div className="flex h-16 shrink-0 flex-col justify-center gap-2 border-b border-hairline px-3">
        <Skeleton width={128} className="h-4" />
        <Skeleton width={176} />
      </div>
      <div className="h-60 shrink-0 border-b border-hairline">
        <ChartSkeleton />
      </div>
      <div className="min-h-0 flex-1">
        {label && (
          <div role="status" className="p-3 text-data text-fg-3">
            {label}
          </div>
        )}
      </div>
      <div className="flex h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 items-start gap-2 border-t border-hairline px-3 pt-2.5 pb-[env(safe-area-inset-bottom)]">
        <Skeleton width={72} className="h-11 rounded-sm" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-11 rounded-sm" />
        </div>
        <Skeleton width={88} className="h-11 rounded-sm" />
      </div>
    </section>
  );
}

const STATUS_DOT: Record<StatusTone, string> = { info: "bg-info", warn: "bg-warn", sell: "bg-sell", done: "", off: "bg-fg-4" };

/** One armed order as a two-line 56 px row: kind and size over status and trigger, its action on the right. */
function MobileOrderRow({ order, token }: { order: Order; token: TokenSummary }) {
  const ask = useCancelDialog((s) => s.ask);
  const { quote, solUsd } = useQuote();
  const open = isOpenOrder(order);
  const status = STATUS_TEXT[order.status];
  const distance = open ? distanceToTrigger(order, { mcUsd: token.marketCapUsd, priceSol: token.priceSol }) : null;
  const rearm = order.status === "stale" || order.status === "failed";
  return (
    <li className="flex h-14 items-center gap-3 border-b border-hairline px-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2 text-data">
          <span className={cn("shrink-0 font-medium", order.status === "cancelled" ? "text-fg-3" : "text-fg-1")}>
            {KIND_TEXT[order.kind]}
          </span>
          <span className="zf-num truncate text-fg-2">{sizeText(order)}</span>
          {distance !== null && <span className="zf-num ml-auto shrink-0 text-fg-2">{fmtPct(distance, { signed: true })}</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-label text-fg-3">
          {order.status === "filled" ? (
            <Check aria-hidden="true" className="icon-xs text-fg-1" />
          ) : (
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status.tone])} />
          )}
          <span className="shrink-0 text-fg-2">{status.label}</span>
          {order.status === "filled" && order.fillLatencyMs !== null && (
            <span className="zf-num shrink-0">{fmtMs(order.fillLatencyMs)}</span>
          )}
          <span className="truncate">· {triggerText(order, { quote, solUsd, supply: token.supply })}</span>
        </div>
      </div>
      {(open || rearm) && (
        <Button
          variant={rearm ? "secondary" : "danger"}
          size="lg"
          className="relative shrink-0 after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']"
          onClick={() => (rearm ? void rearmOrder(order.id) : ask(order))}
        >
          {rearm ? "Re-arm" : "Cancel"}
        </Button>
      )}
    </li>
  );
}

/**
 * Orders tab on phones: the desktop table (720 px of columns) becomes two-line rows, open orders
 * first. The empty state names what lands here without pointing at a trade panel phones don't have.
 */
function MobileOrders({ token }: { token: TokenSummary }) {
  const byId = useOrders((s) => s.byId);
  const orders = useMemo(
    () =>
      Object.values(byId)
        .filter((o) => o.mint === token.mint)
        .sort((a, b) => Number(isOpenOrder(b)) - Number(isOpenOrder(a)) || b.createdAt - a.createdAt),
    [byId, token.mint],
  );
  const all = (
    <Link
      to="/orders"
      className="relative inline-flex h-8 items-center rounded-sm border border-hairline-strong px-3 text-data font-medium text-fg-2 transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-surface-3 hover:text-fg-1"
    >
      All armed orders
    </Link>
  );
  if (orders.length === 0) {
    return (
      <EmptyState title="No orders on this token" body="Limits, take-profits and stop-losses armed on this token show here." action={all} />
    );
  }
  return (
    <div>
      <ul aria-label={`Orders for ${token.symbol}`}>
        {orders.map((o) => (
          <MobileOrderRow key={o.id} order={o} token={token} />
        ))}
      </ul>
      <div className="flex h-14 items-center px-3">{all}</div>
    </div>
  );
}

export function MobileToken({ detail }: { detail: TokenDetail }) {
  const token = detail.summary;
  const navigate = useNavigate();
  const { quote } = useQuote();
  const watched = useSettings((s) => s.watchlist.includes(token.mint));
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const instantOpen = useSettings((s) => s.instant.open);
  const setInstant = useSettings((s) => s.setInstant);
  const tf = useTokenUi((s) => s.tf);
  const setTf = useTokenUi((s) => s.setTf);
  const mode = useTokenUi((s) => s.mode);
  const setMode = useTokenUi((s) => s.setMode);
  const [tab, setTab] = useState<MobileTab>("trades");
  const openOrders = useOpenOrderCount(token.mint);
  const [shared, setShared] = useState(false);
  const mc = quote === "USD" ? token.marketCapUsd : token.marketCapSol;
  const flash = useTickFlash(mc);
  const change = token.change5mPct;
  useEffect(() => {
    if (!shared) return;
    const t = setTimeout(() => setShared(false), 1200);
    return () => clearTimeout(t);
  }, [shared]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-surface-1">
        <header className="sticky top-0 z-sticky flex h-[calc(44px+env(safe-area-inset-top))] items-center gap-1 border-b border-hairline bg-surface-1 pt-[env(safe-area-inset-top)] pr-1">
          <HitButton label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/pulse"))}>
            <ChevronLeft className="icon-md" />
          </HitButton>
          <TokenAvatar mint={token.mint} symbol={token.symbol} imageUri={token.imageUri} size="sm" badge={false} />
          <h1 className="ml-1 min-w-0 truncate text-heading font-semibold text-fg-1">{token.symbol}</h1>
          <span className="ml-auto flex items-center">
            <HitButton
              label={watched ? "Remove from watchlist" : "Add to watchlist"}
              active={watched}
              onClick={() => toggleWatch(token.mint)}
            >
              <Star className={cn("icon-md", watched && "fill-current")} />
            </HitButton>
            <HitButton label="Instant Trade" active={instantOpen} onClick={() => setInstant({ open: !instantOpen })}>
              <Zap className="icon-md" />
            </HitButton>
            <HitButton
              label={shared ? "Link copied" : `Copy link to ${token.symbol}`}
              onClick={() => void copyText(`${window.location.origin}/t/${token.mint}`).then((ok) => setShared(ok))}
            >
              <Share2 className={cn("icon-md", shared && "text-fg-1")} />
            </HitButton>
          </span>
        </header>

        <div className="flex h-16 flex-col justify-center gap-1 border-b border-hairline bg-surface-1 px-3">
          <div className="flex items-baseline gap-2">
            <span className="text-micro font-medium text-fg-3">MC</span>
            <span key={flash.key} className={cn("zf-num text-display-2 font-semibold text-fg-1", flash.className)}>
              {quote === "USD" ? fmtUsd(mc) : fmtSol(mc)}
              {quote === "SOL" && <span className="zf-unit">{" SOL"}</span>}
            </span>
            {/* No 5m change reported yet: left out rather than "– 5m". */}
            {change !== null && Number.isFinite(change) && (
              <span className={cn("zf-num text-data font-medium", signClass(change))}>
                {change > 0 ? "↑ " : change < 0 ? "↓ " : ""}
                {fmtPct(change, { signed: true })}
                <span className="ml-1 text-fg-3">5m</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-data text-fg-2">
            Price <Num kind="price" usd={quote === "USD"} value={quote === "USD" ? token.priceUsd : token.priceSol} />
            {/* Unknown liquidity (a Jupiter-only coin's pools are not read): left out rather than "Liq –". */}
            {token.liquidityUsd !== null && (
              <>
                <span className="text-fg-3">·</span>
                Liq <Money usd={token.liquidityUsd} unit />
              </>
            )}
          </div>
        </div>

        <div className="h-60 border-b border-hairline">
          <Suspense fallback={<ChartSkeleton />}>
            <TokenChart key={token.mint} detail={detail} variant="compact" />
          </Suspense>
        </div>

        {/* Under 400 px the MC | Price pair collapses into one toggle so the band never clips. */}
        <div className="@container border-b border-hairline bg-surface-1">
          <div className="flex h-11 items-center gap-3 px-3 @max-[399px]:gap-2">
            <Segmented<Timeframe>
              size="side"
              value={MOBILE_TFS.includes(tf) ? tf : "1m"}
              onChange={setTf}
              options={MOBILE_TFS.map((t) => ({ value: t, label: t }))}
              label="Timeframe"
              className={cn("min-w-0 flex-1", TOUCH_SEGMENTS)}
            />
            <Segmented<ChartMode>
              size="side"
              value={mode}
              onChange={setMode}
              options={[
                { value: "mc", label: "MC" },
                { value: "price", label: "Price" },
              ]}
              label="Chart value"
              className={cn("shrink-0 @max-[399px]:hidden", TOUCH_SEGMENTS)}
            />
            <button
              type="button"
              onClick={() => setMode(mode === "mc" ? "price" : "mc")}
              aria-label={`Chart shows ${mode === "mc" ? "market cap" : "price"}; switch to ${mode === "mc" ? "price" : "market cap"}`}
              className="relative hidden h-7 shrink-0 items-center gap-1 rounded-sm border border-hairline-strong px-2 text-data font-medium text-fg-1 transition-colors after:absolute after:inset-x-0 after:-inset-y-[9px] after:content-[''] hover:bg-surface-3 @max-[399px]:inline-flex"
            >
              {mode === "mc" ? "MC" : "Price"}
              <ArrowLeftRight className="icon-xs text-fg-3" />
            </button>
          </div>
        </div>

        <RiskStrip risk={token.risk} pending={token.holdersPending === true} />

        <div
          role="tablist"
          aria-label="Token tables"
          className="sticky top-[calc(44px+env(safe-area-inset-top))] z-sticky flex h-[45px] items-stretch border-b border-hairline bg-surface-1 px-1"
        >
          {(["trades", "holders", "info", "orders"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "focus-inset relative flex flex-1 items-center justify-center gap-1.5 text-data font-medium transition-colors",
                tab === t ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
              )}
            >
              {TAB_LABEL[t]}
              {t === "holders" && token.holders !== null && token.holders > 0 && (
                <span className="zf-num text-label text-fg-3">{fmtCount(token.holders)}</span>
              )}
              {t === "orders" && openOrders > 0 && <span className="zf-num text-label text-fg-3">{openOrders}</span>}
              {tab === t && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 bg-fg-1" />}
            </button>
          ))}
        </div>
        {/* Tall enough for the tabs to stick under the header, so switching tabs never jumps the scroll. */}
        <div role="tabpanel" className="min-h-[calc(100dvh-153px-env(safe-area-inset-top)-env(safe-area-inset-bottom))]">
          {tab === "trades" && <MobileTradesList supply={token.supply} />}
          {tab === "holders" && <MobileHoldersList holders={detail.holders} token={token} />}
          {tab === "info" && <TokenInfo detail={detail} header={false} risk={false} />}
          {tab === "orders" && <MobileOrders token={token} />}
        </div>
      </div>
      <MobileTradeBar detail={detail} />
      <CancelOrderDialog />
    </div>
  );
}
