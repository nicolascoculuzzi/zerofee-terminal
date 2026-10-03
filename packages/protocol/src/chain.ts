/** `chain` topic: what the browser needs to stamp, price and tip a transaction it builds locally. */

export interface PriorityFeeEstimate {
  /** Micro-lamports per compute unit. */
  p50: number;
  p75: number;
  p95: number;
  /** "helius" (getPriorityFeeEstimate) or "rpc" (getRecentPrioritizationFees percentiles). */
  source: "helius" | "rpc";
  updatedAt: number;
}

export interface JitoTipFloor {
  /** Landed-tip percentiles in lamports. */
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  emaP50: number;
  updatedAt: number;
}

export interface SolUsdPrice {
  price: number;
  /** When the price was last updated (ms). */
  updatedAt: number;
  /** True when the feed has been silent for longer than the staleness threshold. */
  stale: boolean;
  source: "binance";
}

/**
 * Admin kill switch (SPEC "Kill switches"). While `halted`, POST /api/tx refuses every submission
 * (HTTP 503, code "halted"); the web app should disable trading and show `reason`.
 */
export interface HaltState {
  halted: boolean;
  /** Operator-supplied reason, shown to users. */
  reason: string | null;
  /** When the current halt began (ms); null while running. */
  since: number | null;
}

export interface ChainState {
  /** Highest processed slot seen by the ingest source. */
  slot: number | null;
  blockhash: string | null;
  /** Check this, not wall time: the blockhash is valid while block height <= lastValidBlockHeight. */
  lastValidBlockHeight: number | null;
  /** Slot at which the blockhash was observed / fetched. */
  blockhashSlot: number | null;
  blockhashUpdatedAt: number | null;
  priorityFees: PriorityFeeEstimate | null;
  jitoTipFloor: JitoTipFloor | null;
  solUsd: SolUsdPrice | null;
  /** Trading kill switch; a delta carries the full object whenever it changes. */
  halt: HaltState;
}

/** `chain` snapshot = full state; delta = only the changed fields. */
export type ChainSnapshot = ChainState;
export type ChainDelta = Partial<ChainState>;
