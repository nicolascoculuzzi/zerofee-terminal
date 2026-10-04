import { ChevronDown, Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../../components/ui/Tooltip";
import { cn } from "../../lib/cn";
import { fmtFee, fmtLamports, fmtPct, fmtSol, fmtSolShort, fmtTokens } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { LandingPreset, TradeRoute } from "../../protocol";
import type { CostLines } from "./tradeMath";

/*
 * Cost breakdown (DESIGN.md 4.11 item 7, 1.6): collapsed to one 24 px row "Total 0.5084 SOL ·
 * Platform fee 0"; expanded to 20 px rows, each label with an info tooltip. "Platform fee 0" is
 * on every trade entry. Fee rows with info icons after Uniswap's review
 * https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5 and the fee explained next
 * to the number after Coinbase Advanced https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544;
 * Phantom's "Quote includes a 0.85% fee" https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2
 * inverted into "Platform fee 0".
 */

export type CostKind = "buy" | "sell" | "limitBuy" | "limitSell" | "ladder";

/** The zerofee mark at 12 px: a slashed zero in ink on the neutral accent square. */
export function ZeroMark({ className }: { className?: string }) {
  return (
    <svg className={cn("icon-xs", className)} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="0" y="0" width="20" height="20" rx="4" className="fill-accent" />
      <ellipse cx="10" cy="10" rx="4.2" ry="5.8" fill="none" className="stroke-ink" strokeWidth="2.4" />
      <path d="M6.3 15.4 L13.7 4.6" className="stroke-ink" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Sol({ value, approx }: { value: number | null; approx?: boolean }) {
  if (value === null) return <span className="zf-num text-fg-4">–</span>;
  return (
    <span className="zf-num">
      {approx && value !== null ? "~" : ""}
      {fmtSol(value)}
      <span className="zf-unit">{" SOL"}</span>
    </span>
  );
}

/**
 * A fee line. `computed` fees (venue fee, rent) round to four significant digits like any SOL
 * amount ("0.003086"); fees the user typed (priority, tip) keep every digit as entered. The exact
 * lamports are in the tooltip either way.
 */
function Fee({ value, computed = false }: { value: number | null; computed?: boolean }) {
  return (
    <span className="zf-num" title={fmtLamports(value)}>
      {computed ? fmtSol(value) : fmtFee(value)}
      <span className="zf-unit">{" SOL"}</span>
    </span>
  );
}

function Line({ label, tip, children, strong }: { label: ReactNode; tip: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className={cn("flex h-5 items-center justify-between gap-2 text-label", strong && "mt-1 h-6 border-t border-hairline pt-1")}>
      <Tooltip content={tip}>
        <span className={cn("flex min-w-0 items-center gap-1 truncate", strong ? "text-data font-semibold text-fg-1" : "text-fg-3")}>
          {label}
          {!strong && <Info className="icon-xs shrink-0" />}
        </span>
      </Tooltip>
      <span className={cn("shrink-0 text-right", strong ? "text-data font-semibold text-fg-1" : "text-fg-2")}>{children}</span>
    </div>
  );
}

export function CostBreakdown({
  kind,
  cost,
  symbol,
  venue,
  route = null,
  landing,
  slippagePct,
  open,
  onToggle,
}: {
  kind: CostKind;
  cost: CostLines;
  symbol: string;
  venue: string;
  /** Live: the coin trades through the Jupiter fallback (no local venue); shown instead of the venue fee. */
  route?: TradeRoute | null;
  landing: LandingPreset;
  slippagePct: number;
  open: boolean;
  onToggle: () => void;
}) {
  const fees = cost.priorityFeeSol + cost.tipSol + cost.baseFeeSol;
  const buying = kind === "buy" || kind === "limitBuy";
  const headline: { label: string; node: ReactNode } =
    kind === "buy"
      ? { label: "Total", node: <Sol value={cost.totalSol} /> }
      : kind === "sell"
        ? { label: "Net", node: <Sol value={cost.totalSol} approx /> }
        : kind === "limitBuy"
          ? { label: "Reserves", node: <Sol value={cost.totalSol} /> }
          : { label: kind === "ladder" ? "Fees per fill" : "Fees", node: <Fee value={fees} /> };
  const lane = LANDING_INFO[landing];

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="focus-inset flex h-6 w-full items-center gap-1 rounded-xs text-left text-label text-fg-3 transition-colors hover:text-fg-1"
      >
        <span className="text-fg-3">{headline.label}</span>
        <span className="text-fg-1">{headline.node}</span>
        <span>·</span>
        <span className="text-fg-3">Platform fee</span>
        <span className="zf-num text-fg-1">0</span>
        <ChevronDown className={cn("icon-xs ml-auto transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="pb-1">
          {kind === "buy" && (
            <Line
              label="You receive (est.)"
              tip={`Estimated from the live curve or pool reserves. Up to ${slippagePct}% slippage is allowed.`}
            >
              <span className="zf-num text-fg-1">
                {cost.tokens === null ? "" : "~"}
                {fmtTokens(cost.tokens)} {symbol}
              </span>
            </Line>
          )}
          {kind === "sell" && (
            <Line
              label="You receive (est.)"
              tip={`SOL from the live reserves after the venue fee. Up to ${slippagePct}% slippage is allowed.`}
            >
              <span className="text-fg-1">
                <Sol value={cost.amountSol === null || cost.venueFeeSol === null ? null : cost.amountSol - cost.venueFeeSol} approx />
              </span>
            </Line>
          )}
          {(kind === "buy" || kind === "sell") && (
            <Line label="Price impact" tip="How far this trade moves the price against you at today's reserves.">
              <span className={cn("zf-num", (cost.impactPct ?? route?.priceImpactPct ?? 0) >= 10 && "text-warn")}>
                {fmtPct(cost.impactPct ?? route?.priceImpactPct ?? null)}
              </span>
            </Line>
          )}
          {route && (
            <Line
              label="Route (Jupiter)"
              tip={`No pump.fun curve or PumpSwap pool to build on (${route.reason}), so Jupiter routes this trade, chosen when you trade. Venue fees along the route are inside its quote; Jupiter adds no fee and neither does zerofee.`}
            >
              <span className="block max-w-44 truncate text-fg-1" title={route.labels.join(" → ")}>
                {route.labels.length > 0 ? route.labels.join(" → ") : "Best route at trade time"}
              </span>
            </Line>
          )}
          {!route && kind !== "ladder" && kind !== "limitSell" && kind !== "limitBuy" && (
            <Line
              label={`Venue fee (${venue} ${fmtSolShort(cost.venuePct)}%)`}
              tip={`Charged by ${venue} on every trade. It goes to the launchpad or AMM, not to zerofee.`}
            >
              <Fee value={cost.venueFeeSol} computed />
            </Line>
          )}
          <Line label="Priority fee" tip="Paid to the validator for ordering, clamped to the live estimate.">
            <Fee value={cost.priorityFeeSol} />
          </Line>
          <Line label={`Tip (${lane.label} lane)`} tip={`Paid to the landing lane: ${lane.route}.`}>
            <Fee value={cost.tipSol} />
          </Line>
          <Line label="Network base fee" tip="Solana's base fee per signature (5,000 lamports).">
            <Fee value={cost.baseFeeSol} />
          </Line>
          {buying && cost.rentSol > 0 && (
            <Line
              label="Rent, refundable (first buy only)"
              tip="Opens your token account on the first buy. Refunded when the account closes."
            >
              <Fee value={cost.rentSol} computed />
            </Line>
          )}
          <Line label="Platform fee" tip="zerofee adds nothing on top: no platform fee, no spread, no referral cut.">
            <span className="flex items-center gap-1 text-fg-1">
              <ZeroMark />
              <span className="zf-num">0</span>
            </span>
          </Line>
          <Line
            strong
            label={headline.label}
            tip={
              kind === "buy"
                ? "Everything leaving your wallet for this buy."
                : kind === "sell"
                  ? "Estimated SOL arriving after every fee."
                  : kind === "limitBuy"
                    ? "Reserved while the order is armed: the size plus fees, tip and rent."
                    : "Fees each armed sell pays when it fires."
            }
          >
            {headline.node}
          </Line>
        </div>
      )}
    </div>
  );
}
