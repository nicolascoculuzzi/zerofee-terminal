import { Search } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Segmented } from "../../components/ui/controls";
import { Num } from "../../components/ui/Num";
import { isBase58Address } from "../../lib/address";
import { cn } from "../../lib/cn";
import { fmtCount } from "../../lib/format";
import type { WalletStatus } from "../../protocol";
import { type PnlRange, RANGE_LABEL, RANGE_WORDS, RANGES, type WalletSummary } from "./helpers";
import { DefLabel } from "./PerformancePanel";
import { Money } from "./quote";

const RANGE_OPTIONS = RANGES.map((value) => ({ value, label: RANGE_LABEL[value] }));

/**
 * "Search other wallets" (DESIGN.md 5.3): a 240 px field; Enter opens the wallet read-only.
 * The invalid-address message floats under the field so the strip never changes height.
 */
export function WalletSearch({ onSubmit, className }: { onSubmit: (address: string) => void; className?: string }) {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    if (!isBase58Address(v)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setValue("");
    onSubmit(v);
  };
  return (
    <form onSubmit={submit} className={cn("relative", className)}>
      <Search className="icon-sm pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-3" />
      <input
        type="text"
        enterKeyHint="search"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (invalid) setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setValue("");
            setInvalid(false);
            e.currentTarget.blur();
          }
        }}
        placeholder="Search other wallets"
        aria-label="Search other wallets by address"
        aria-invalid={invalid}
        aria-describedby={invalid ? "wallet-search-error" : undefined}
        spellCheck={false}
        autoComplete="off"
        className="zf-input pl-7 max-md:h-11 max-md:text-[16px]"
      />
      {invalid && (
        <p
          id="wallet-search-error"
          role="alert"
          className="absolute top-full right-0 z-popover mt-1 rounded-md border border-hairline-strong bg-floating px-2 py-1 text-label whitespace-nowrap text-sell shadow-e1"
        >
          Not a Solana address. Paste a full base58 address.
        </p>
      )}
    </form>
  );
}

/** One stat: a micro label (with its definition) over a 13/600 value; the value keeps a min width in ch. */
function Stat({
  label,
  def,
  children,
  minCh,
  className,
}: {
  label: string;
  def: string;
  children: ReactNode;
  minCh: number;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-center gap-0.5 px-3", className)}>
      <DefLabel label={label} className="self-start text-micro font-medium text-fg-3">
        {def}
      </DefLabel>
      <span className="truncate text-body font-semibold text-fg-1" style={{ minWidth: `${minCh}ch` }}>
        {children}
      </span>
    </div>
  );
}

export interface HeaderStripProps {
  status: WalletStatus | null;
  summary: WalletSummary | null;
  range: PnlRange;
  onRange: (range: PnlRange) => void;
  onSearch: (address: string) => void;
  mobile: boolean;
}

/*
 * Portfolio header strip (DESIGN.md 5.3): the balance in display-1, then micro-labelled stats in
 * one strip with hairline dividers (no card grid), then 7d | 30d | Max and the wallet search.
 * One stats strip with hairline dividers after Fey: https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2
 * Balance, period toggle and today's PnL after Binance assets: https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036
 * Dotted "Unrealized return" labels under the balance after Kraken: https://mobbin.com/screens/96301422-fcd8-40f6-899d-7aab6d69260f
 */
export function HeaderStrip({ status, summary, range, onRange, onSearch, mobile }: HeaderStripProps) {
  const s = summary;
  const total = status && s ? status.solBalance + s.positionsSol : null;
  const available = status ? Math.max(0, status.solBalance - status.reservedSol) : null;
  const words = RANGE_WORDS[range];
  const winRate = s && s.closed > 0 ? (s.wins / s.closed) * 100 : null;

  const balance = (
    <div className={cn("flex min-w-0 flex-col justify-center gap-0.5", mobile ? "px-3 pt-3 pb-2" : "px-3")}>
      <DefLabel label="Balance" className="self-start text-micro font-medium text-fg-3">
        SOL in the wallet plus the live value of every open position. SOL reserved by armed orders is included.
      </DefLabel>
      <span className="truncate text-display-1 font-semibold text-fg-1" style={{ minWidth: "9ch" }}>
        {total === null ? <span className="text-fg-4">–</span> : <Money sol={total} />}
      </span>
    </div>
  );

  const stats = (
    <>
      <Stat
        label="Available"
        minCh={10}
        def="SOL you can spend now: the balance minus what armed orders reserve for their pre-signed buys, fees and tips."
      >
        <Money sol={available} quote="SOL" />
      </Stat>
      <Stat label="Unrealized" minCh={10} def="PnL of open positions at the live price, against what you paid including fees.">
        {s ? <Money sol={s.unrealizedSol} signed /> : <Num value={null} kind="sol" />}
      </Stat>
      <Stat label={`Realized ${RANGE_LABEL[range]}`} minCh={10} def={`PnL locked in by sells of positions traded ${words}.`}>
        {s ? <Money sol={s.realizedSol} signed /> : <Num value={null} kind="sol" />}
      </Stat>
      <Stat
        label={`Win rate ${RANGE_LABEL[range]}`}
        minCh={6}
        def={
          s && s.closed > 0
            ? `Closed positions ${words} that ended in profit: ${fmtCount(s.wins)} of ${fmtCount(s.closed)}. Open positions don't count.`
            : `Closed positions ${words} that ended in profit. Open positions don't count.`
        }
      >
        <Num value={winRate} kind="pct" />
      </Stat>
    </>
  );

  if (mobile) {
    return (
      <section aria-label="Balance" className="flex flex-col bg-surface-1">
        {balance}
        <div className="grid grid-cols-2 gap-px border-y border-hairline bg-hairline [&>*]:h-12 [&>*]:bg-surface-1">{stats}</div>
        <div className="flex flex-col gap-2 p-3">
          <Segmented<PnlRange> value={range} onChange={onRange} options={RANGE_OPTIONS} label="PnL range" className="h-11 w-full" />
          <WalletSearch onSubmit={onSearch} />
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Balance" className="flex min-h-16 flex-wrap items-stretch bg-surface-1 py-2 lg:h-16 lg:flex-nowrap lg:py-0">
      <div className="flex min-w-0 items-stretch divide-x divide-hairline">
        {balance}
        {stats}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2 px-3">
        <Segmented<PnlRange> value={range} onChange={onRange} options={RANGE_OPTIONS} label="PnL range" />
        <WalletSearch onSubmit={onSearch} className="w-60" />
      </div>
    </section>
  );
}
