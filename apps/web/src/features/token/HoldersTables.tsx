import { UserPlus } from "lucide-react";
import { memo } from "react";
import { Tag } from "../../components/ui/bits";
import { CopyButton } from "../../components/ui/controls";
import { cn } from "../../lib/cn";
import { fmtPct, fmtSignedSol, fmtSol, fmtTokens, shortAddr } from "../../lib/format";
import type { Holder, TokenSummary, TopTrader, WalletTag } from "../../protocol";
import { useToasts } from "../../state/toasts";
import { useTrackedMap, useTrackers } from "../../state/trackers";
import { type Col, sp, TableHead, template } from "./table";
import { useTokenUi } from "./tokenUi";

const ROW_TAGS: WalletTag[] = ["you", "dev", "sniper", "insider", "bundler", "kol", "whale", "pro", "curve", "pool"];

function WalletCell({ address, tags }: { address: string; tags: WalletTag[] }) {
  const tracked = useTrackedMap().get(address);
  const setMaker = useTokenUi((s) => s.setMaker);
  const system = tags.includes("curve") || tags.includes("pool");
  return (
    <span className="flex min-w-0 items-center gap-1">
      {system ? (
        <span className="truncate text-fg-2">{tags.includes("curve") ? "Bonding curve" : "Liquidity pool"}</span>
      ) : (
        <button
          type="button"
          onClick={() => setMaker(address)}
          className="truncate font-mono text-fg-2 hover:text-fg-1"
          title="Show this wallet's trades"
        >
          {shortAddr(address, 4, 4)}
        </button>
      )}
      <CopyButton text={address} label="Copy address" />
      {tracked && <Tag tag="tracked" label={tracked.name} className="max-w-24 truncate" />}
      {ROW_TAGS.filter((t) => tags.includes(t))
        .slice(0, 2)
        .map((t) => (
          <Tag key={t} tag={t} />
        ))}
    </span>
  );
}

function TrackButton({ address }: { address: string }) {
  const isTracked = useTrackers((s) => s.wallets.some((w) => w.address === address));
  const add = useTrackers((s) => s.addWallet);
  if (isTracked) return <span />;
  return (
    <button
      type="button"
      aria-label="Track wallet"
      title="Track wallet"
      onClick={() => {
        if (add({ address, name: shortAddr(address, 4, 4), emoji: "", alerts: false })) {
          useToasts.getState().push({ kind: "success", title: "Wallet tracked", body: shortAddr(address, 6, 6), ttl: 2000 });
        }
      }}
      className="flex size-5 items-center justify-center rounded-xs text-fg-3 hover:bg-surface-3 hover:text-fg-1"
    >
      <UserPlus className="icon-sm" />
    </button>
  );
}

const HOLDER_COLS: Col[] = [
  { label: "#", width: sp(6) },
  { label: "Wallet", width: "minmax(0,1fr)" },
  { label: "% owned", width: sp(28), align: "right" },
  { label: "Amount", width: sp(16), align: "right" },
  { label: "Value SOL", width: sp(18), align: "right" },
  { label: "Bought", width: sp(16), align: "right" },
  { label: "Sold", width: sp(16), align: "right" },
  { label: "Funded by", width: sp(22) },
  { label: "", width: sp(5) },
];

const HolderRow = memo(function HolderRow({ holder, rank, priceSol }: { holder: Holder; rank: number; priceSol: number }) {
  const system = holder.tags.includes("curve") || holder.tags.includes("pool");
  return (
    <div
      className={cn(
        "grid h-row items-center gap-2 border-b border-hairline px-3 text-label hover:bg-surface-2",
        holder.tags.includes("you") && "bg-fg-1/5",
      )}
      style={{ gridTemplateColumns: template(HOLDER_COLS) }}
    >
      <span className="text-fg-3">{system ? "–" : rank}</span>
      <WalletCell address={holder.address} tags={holder.tags} />
      <span className="flex items-center justify-end gap-2">
        <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-3">
          <span className="block h-full bg-fg-2" style={{ width: `${Math.min(100, holder.pct)}%` }} />
        </span>
        <span className="w-12 text-right">{fmtPct(holder.pct)}</span>
      </span>
      <span className="text-right text-fg-2">{fmtTokens(holder.balance)}</span>
      <span className="text-right">{fmtSol(holder.balance * priceSol)}</span>
      <span className="text-right text-buy">{holder.boughtSol > 0 ? fmtSol(holder.boughtSol) : "–"}</span>
      <span className="text-right text-sell">{holder.soldSol > 0 ? fmtSol(holder.soldSol) : "–"}</span>
      <span className="truncate font-mono text-fg-3">{holder.fundedBy ? shortAddr(holder.fundedBy, 4, 4) : "–"}</span>
      {system ? <span /> : <TrackButton address={holder.address} />}
    </div>
  );
});

/** Holders, after OpenSea's holders table (wallet, owned with inline bar, % owned, value) https://mobbin.com/screens/93596239-8d84-49e1-a17a-92fb82eec150 */
export function HoldersTable({ holders, token }: { holders: Holder[]; token: TokenSummary }) {
  let rank = 0;
  return (
    <section className="h-full min-h-0 overflow-auto" aria-label="Holders">
      <div className="min-w-176">
        <TableHead cols={HOLDER_COLS} />
        {holders.map((h) => {
          const system = h.tags.includes("curve") || h.tags.includes("pool");
          if (!system) rank++;
          return <HolderRow key={h.address} holder={h} rank={rank} priceSol={token.priceSol} />;
        })}
        <div className="px-3 py-2 text-micro text-fg-3">
          {token.holders.toLocaleString("en-US")} holders. Top 10 excludes the bonding-curve PDA, AMM vaults, burn addresses and lockers.
        </div>
      </div>
    </section>
  );
}

const TRADER_COLS: Col[] = [
  { label: "#", width: sp(6) },
  { label: "Wallet", width: "minmax(0,1fr)" },
  { label: "Bought", width: sp(18), align: "right" },
  { label: "Sold", width: sp(18), align: "right" },
  { label: "PnL", width: sp(20), align: "right" },
  { label: "Remaining", width: sp(18), align: "right" },
  { label: "Txns", width: sp(16), align: "right" },
  { label: "", width: sp(5) },
];

/** Top traders by realized + unrealized PnL at the current price. */
export function TopTradersTable({ traders }: { traders: TopTrader[] }) {
  return (
    <section className="h-full min-h-0 overflow-auto" aria-label="Top traders">
      <div className="min-w-160">
        <TableHead cols={TRADER_COLS} />
        {traders.map((t, i) => (
          <div
            key={t.address}
            className={cn(
              "grid h-row items-center gap-2 border-b border-hairline px-3 text-label hover:bg-surface-2",
              t.tags.includes("you") && "bg-fg-1/5",
            )}
            style={{ gridTemplateColumns: template(TRADER_COLS) }}
          >
            <span className="text-fg-3">{i + 1}</span>
            <WalletCell address={t.address} tags={t.tags} />
            <span className="text-right">{fmtSol(t.boughtSol)}</span>
            <span className="text-right">{fmtSol(t.soldSol)}</span>
            <span className={cn("text-right font-medium", t.pnlSol >= 0 ? "text-buy" : "text-sell")}>{fmtSignedSol(t.pnlSol)}</span>
            <span className="text-right text-fg-2">{t.holdingPct > 0 ? fmtPct(t.holdingPct) : "Exited"}</span>
            <span className="text-right text-fg-2">
              <span className="text-buy">{t.buys}</span>/<span className="text-sell">{t.sells}</span>
            </span>
            <TrackButton address={t.address} />
          </div>
        ))}
      </div>
    </section>
  );
}
