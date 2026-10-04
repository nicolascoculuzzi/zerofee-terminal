import { ChevronLeft, Share2, Star, Zap } from "lucide-react";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Segmented } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { fmtPct, fmtSol, fmtUsd, signClass } from "../../lib/format";
import { TIMEFRAMES, type Timeframe, type TokenDetail } from "../../protocol";
import { useSettings } from "../../state/settings";
import { RiskChips } from "../pulse/RiskChips";
import { CancelOrderDialog } from "./CancelOrderDialog";
import { MobileHoldersList } from "./HoldersTables";
import { MobileTradeBar } from "./MobileTradeBar";
import { Money, useQuote } from "./money";
import { TokenInfo } from "./TokenInfo";
import { TokenOrders } from "./TokenOrders";
import { MobileTradesList } from "./TradesTable";
import { type ChartMode, useTokenUi } from "./tokenUi";
import { useTickFlash } from "./useTickFlash";

const TokenChart = lazy(() => import("./TokenChart"));

/*
 * Phone token page (DESIGN.md 5.8): header 44 · price block 64 · chart 240 (no toolbar) ·
 * timeframes 36 · risk strip 40 · tabs 36 · 44 px rows · the sticky trade bar. Targets are
 * 44 px. Price headline, change chip and timeframe row after Phantom:
 * https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba
 */

type MobileTab = "trades" | "holders" | "info" | "orders";

const MOBILE_TFS: Timeframe[] = TIMEFRAMES.filter((t) => t !== "15s");

function HitButton({ label, onClick, children, active }: { label: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn("flex size-11 shrink-0 items-center justify-center rounded-sm transition-colors", active ? "text-fg-1" : "text-fg-3")}
    >
      {children}
    </button>
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-sticky flex h-11 items-center gap-1 border-b border-hairline bg-surface-1 pr-1">
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
            <span className={cn("zf-num text-data font-medium", signClass(change))}>
              {change !== null && change > 0 ? "↑ " : change !== null && change < 0 ? "↓ " : ""}
              {fmtPct(change, { signed: true })} 5m
            </span>
          </div>
          <div className="flex items-center gap-1 text-data text-fg-2">
            Price <Num kind="price" usd={quote === "USD"} value={quote === "USD" ? token.priceUsd : token.priceSol} />
            <span className="text-fg-3">·</span>
            Liq <Money usd={token.liquidityUsd} unit />
          </div>
        </div>

        <div className="h-60 border-b border-hairline">
          <Suspense fallback={<div className="h-full bg-surface-1 p-2 text-data text-fg-3">Loading {tf} candles…</div>}>
            <TokenChart key={token.mint} detail={detail} variant="compact" />
          </Suspense>
        </div>

        <div className="flex h-9 items-center justify-between gap-2 border-b border-hairline bg-surface-1 px-3">
          <Segmented<Timeframe>
            size="sm"
            value={MOBILE_TFS.includes(tf) ? tf : "1m"}
            onChange={setTf}
            options={MOBILE_TFS.map((t) => ({ value: t, label: t }))}
            label="Timeframe"
          />
          <Segmented<ChartMode>
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "mc", label: "MC" },
              { value: "price", label: "Price" },
            ]}
            label="Chart value"
          />
        </div>

        <div className="flex h-10 items-center overflow-x-auto border-b border-hairline bg-surface-1 px-3">
          <RiskChips risk={token.risk} />
        </div>

        <div
          role="tablist"
          aria-label="Token tables"
          className="sticky top-11 z-sticky flex h-9 items-stretch border-b border-hairline bg-surface-1 px-1"
        >
          {(["trades", "holders", "info", "orders"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("relative flex-1 text-data font-medium capitalize", tab === t ? "text-fg-1" : "text-fg-3")}
            >
              {t}
              {tab === t && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 bg-accent" />}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="bg-surface-1">
          {tab === "trades" && <MobileTradesList supply={token.supply} />}
          {tab === "holders" && <MobileHoldersList holders={detail.holders} token={token} />}
          {tab === "info" && <TokenInfo detail={detail} header={false} />}
          {tab === "orders" && (
            <div className="min-h-60">
              <TokenOrders token={token} />
            </div>
          )}
        </div>
      </div>
      <MobileTradeBar detail={detail} />
      <CancelOrderDialog />
    </div>
  );
}
