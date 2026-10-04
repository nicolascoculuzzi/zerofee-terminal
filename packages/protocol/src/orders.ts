/**
 * Armed orders (SPEC "Armed orders"): pre-signed durable-nonce transactions the server holds and
 * submits when a trigger fires, so exits run with the tab closed. REST (session cookie; mutations need
 * an allowed Origin) and the `orders` user topic.
 *
 *   POST /api/orders/armed            body: one @zerofee/core ArmedOrder JSON (armedOrderToJson, bigints
 *                                     tagged {"$bigint":"..."}), or { "orders": [ArmedOrder, ...] } to arm
 *                                     several at once, atomically (an OCO pair, a ladder plus its partner)
 *                                     -> 201 ArmOrdersResponse; refusals are ArmRejection (400/403/409/422/503)
 *   GET  /api/orders?status=open|all&limit=100   -> OrdersListResponse (newest first)
 *   GET  /api/orders/limits           -> OrderLimits
 *   GET  /api/orders/nonce-slots      -> NonceSlotsResponse (the user's nonce accounts the server knows)
 *   GET  /api/orders/nonce-probe?wallet&count -> NonceProbeResponse: one of the user's wallets' derived nonce slots
 *                                     0..count-1 (count 1-32) read from chain, for the browser to arm against
 *   GET  /api/orders/:id              -> OrderDetailResponse (the order and its event history)
 *   POST /api/orders/:id/cancel       -> CancelOrderResponse: fires the stored pre-signed cancel(s); an order
 *                                     sharing a nonce with others (OCO) cancels them too
 *   POST /api/orders/panic            -> PanicResponse: cancels every open order of the user (the browser
 *                                     also locks its keystore)
 *
 * The signed transaction bytes never come back from the server: a leaked armed transaction can be landed by
 * anyone until its nonce advances, so views carry signatures (transaction ids) only.
 *
 * Amounts are decimal strings of base units: lamports for SOL, token base units otherwise. Every trigger
 * threshold is in the order's own "quote out" units: tokens out for a buy's fixed spend, quote out for a
 * sell's fixed token amount (so a threshold already includes price impact and the fee tier).
 */

export const ORDER_KINDS = [
  "limit-buy",
  "limit-sell",
  "take-profit",
  "stop-loss",
  "trailing-stop",
  "dca-tranche",
  "migration-snipe",
  "dev-sell-exit",
] as const;
/** Same strings as @zerofee/core ArmedOrderKind. */
export type OrderKind = (typeof ORDER_KINDS)[number];

/**
 * armed -> submitted -> filled | failed-consumed, and armed|submitted -> stale | cancelled.
 *   armed            waiting for its trigger
 *   submitted        one variant is in flight
 *   filled           a variant landed and executed
 *   failed-consumed  a variant landed but failed (or the cancel burned a missed attempt): the nonce is
 *                    consumed, re-arm
 *   stale            pump upgraded, the coin migrated, the creator changed... the signed transactions can
 *                    no longer succeed; re-arm from the browser
 *   cancelled        by the user, Panic, the admin kill switch, or because its OCO partner filled
 */
export const ORDER_STATUSES = ["armed", "submitted", "filled", "failed-consumed", "stale", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = ["filled", "failed-consumed", "stale", "cancelled"];

export function isTerminalOrderStatus(s: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(s);
}

export type OrderSide = "buy" | "sell";
export type OrderVenue = "pump" | "pumpswap";

/**
 * live        nonce untouched, variants valid
 * submitted   one variant is in flight
 * cancelling  the cancel was fired; waiting to see which transaction consumed the nonce
 * landed-ok   a variant of this attempt filled
 * landed-failed a variant landed but failed (nonce consumed, fee paid)
 * burned      the nonce was consumed by the cancel or by another order's transaction (OCO partner)
 */
export type OrderAttemptStatus = "live" | "submitted" | "cancelling" | "landed-ok" | "landed-failed" | "burned";

/** @zerofee/core ArmedTrigger with bigints as decimal strings. */
export type OrderTrigger =
  /** Limit buy / take-profit / limit sell: fire once the live quote out is at least `threshold`. */
  | { type: "quote-at-least"; threshold: string }
  /** Stop-loss: fire once the live quote out is at most `threshold`. */
  | { type: "quote-at-most"; threshold: string }
  /** Trailing stop: fire when the quote falls `trailBps` below its high-water mark (bounded by the grid). */
  | { type: "trailing"; trailBps: number; activationQuoteOut: string | null }
  /** DCA tranche: fire after `notBeforeMs` while the quote out is at least `minQuoteOut`. */
  | { type: "time"; notBeforeMs: number; minQuoteOut: string | null }
  /** Migration snipe: fire once the coin migrated and its canonical PumpSwap pool is live. */
  | { type: "migration" }
  /** Dev-sell exit: fire when `creator` sells at least `minTokenAmount` of the coin. */
  | { type: "dev-sell"; creator: string; minTokenAmount: string | null };

/** One nonce slot of the order with its pre-signed variants (more than one attempt = a full-exit ladder). */
export interface OrderAttempt {
  index: number;
  nonceAccount: string;
  status: OrderAttemptStatus;
  /** Number of pre-signed variants (min-out x tip levels x venues). */
  variants: number;
  /** Lowest and highest min-out among the variants (base units of what the order receives). */
  minOutLow: string;
  minOutHigh: string;
  submittedVariantId: string | null;
  submittedAtSlot: number | null;
  /** Signature that consumed this attempt's nonce, once known. */
  consumedBy: string | null;
}

export interface Order {
  id: string;
  /** Trading wallet: fee payer, nonce authority and token owner of every transaction. */
  wallet: string;
  kind: OrderKind;
  side: OrderSide;
  mint: string;
  /** buy: quote spend; sell: base tokens. Frozen at signing. */
  amount: string;
  /** Sells the whole armed balance and closes the token account. */
  fullExit: boolean;
  trigger: OrderTrigger;
  /** Orders sharing a nonce (take-profit + stop-loss): whichever lands first burns the other. */
  ocoGroup: string | null;
  status: OrderStatus;
  statusReason: string | null;
  /** Non-fatal warnings (e.g. "interface-upgrade"): check and re-arm. */
  flags: string[];
  attempts: OrderAttempt[];
  venues: OrderVenue[];
  /** Live quote out for `amount` when armed (reference of the min-out grid). */
  armingQuoteOut: string;
  armedAt: number;
  /** What must stay in the wallet until the order resolves (shown as "reserved"). */
  reservation: { lamports: string; tokens: string };
  /** What arming used of the signer's daily caps. */
  capCost: { buyLamports: string; feeLamports: string };
  /** Signature of the variant that filled. */
  signature: string | null;
  /** Trailing stops: the highest quote out seen since arming. */
  highWater: string | null;
  /** True while any nonce of the order is unconsumed: its reservation is held and the server keeps watching. */
  open: boolean;
  /** True when the server only simulated its submission (DRY_RUN). */
  dryRun: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface OrdersSnapshot {
  /** The user's open orders plus recently closed ones, newest first. */
  orders: Order[];
}

export interface OrdersDelta {
  upsert: Order[];
  remove: string[];
}

export type OrderEventType =
  | "armed"
  | "submitted"
  | "sent"
  | "simulated"
  | "send-failed"
  | "nonce-consumed"
  | "submit-missed"
  | "cancel-requested"
  | "cancel-fired"
  | "stale"
  | "flag"
  | "held";

export interface OrderEventRecord {
  id: number;
  at: number;
  type: OrderEventType;
  /** Order status after the event. */
  status: OrderStatus;
  message: string;
  detail: Record<string, unknown>;
}

export interface OrdersListResponse {
  orders: Order[];
}

export interface OrderDetailResponse {
  order: Order;
  /** Oldest first. */
  events: OrderEventRecord[];
}

export interface ArmOrdersResponse {
  orders: Order[];
}

/** One reason an armed order was refused (codes from @zerofee/core ArmedViolationCode plus server checks). */
export interface ArmViolation {
  code: string;
  orderId: string;
  message: string;
  variantId?: string;
}

/** Error body of POST /api/orders/armed. */
export interface ArmRejection {
  error: string;
  code: "bad_request" | "unauthorized" | "forbidden" | "conflict" | "limit_exceeded" | "halted" | "unavailable" | "rate_limited";
  violations: ArmViolation[];
}

export interface CancelOrderResponse {
  /** The order and any OCO partners cancelled with it. */
  orders: Order[];
}

export interface PanicResponse {
  /** Orders that were cancelled now. */
  cancelled: number;
  orders: Order[];
}

/** Server-side caps (SPEC "Limits"); the browser shows them before arming. */
export interface OrderLimits {
  maxOpenOrders: number;
  /** Total armed notional (buys: spend; sells: arming quote; an OCO group counts once). */
  maxArmedNotionalLamports: string;
  /** Per armed buy: the lower of the server cap and the user's maxTradeSol setting. */
  maxBuyLamports: string;
  /** How far below the arming quote the widest variant may reach. */
  maxGridDepthBps: number;
  maxTipLamports: string;
  maxPriorityFeeLamports: string;
  maxAttempts: number;
  maxVariantsPerNonce: number;
  maxBuyVariants: number;
  /** Operator lookup tables armed transactions may load from. */
  lookupTables: string[];
  /** Live usage. */
  openOrders: number;
  armedNotionalLamports: string;
  /** Submissions are simulated, never sent. */
  dryRun: boolean;
}

export type NonceSlotStatus = "in-use" | "free" | "missing";

export interface NonceSlot {
  nonceAccount: string;
  wallet: string;
  status: NonceSlotStatus;
  /** Last nonce value the server saw (null before the first read). */
  nonceValue: string | null;
  /** An open order bound to the slot. */
  orderId: string | null;
  updatedAt: number;
}

export interface NonceSlotsResponse {
  slots: NonceSlot[];
}

/**
 *   ready     an initialized durable nonce the wallet is the authority of (armable unless an open order holds it)
 *   absent    nothing at the address yet: the browser creates it (CreateAccountWithSeed + InitializeNonceAccount)
 *   foreign   a nonce account whose authority is someone else
 *   occupied  some other account sits at the address
 */
export type NonceProbeState = "ready" | "absent" | "foreign" | "occupied";

/** One derived slot: createWithSeed(wallet, "zerofee-nonce-<index>", System program). */
export interface NonceSlotProbe {
  index: number;
  nonceAccount: string;
  state: NonceProbeState;
  /** Durable nonce value (ready / foreign). */
  nonceValue: string | null;
  /** Lamports at the address (null when absent). */
  lamports: string | null;
  /** An open order of this user holds the slot. */
  orderId: string | null;
}

export interface NonceProbeResponse {
  wallet: string;
  /** Context slot of the chain read. */
  slot: number;
  slots: NonceSlotProbe[];
  /** Rent-exempt minimum of a new slot (lamports, getMinimumBalanceForRentExemption(80)); null when unread. */
  rentLamports: string | null;
}
