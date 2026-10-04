/**
 * Strict parsing of the ArmedOrder JSON a browser POSTs (@zerofee/core armedOrderToJson: bigints tagged
 * {"$bigint":"..."}). The body is untrusted: every field is type- and bound-checked, unknown keys are
 * refused, and a fresh object is built from the checked values, before any core validator (which assumes
 * well-typed input) or the database sees it. Signed bytes are checked by assertArmable afterwards.
 */
import type { Address } from "@solana/kit";
import {
  ARMED_ORDER_SIDE,
  type ArmedAttempt,
  type ArmedOrder,
  type ArmedOrderKind,
  type ArmedTrigger,
  type ArmedVariant,
  type ArmedVenue,
  armedJsonReviver,
  type FrozenVenueAccounts,
  PACKET_DATA_SIZE,
  type SignedTx,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@zerofee/core";
import { ORDER_KINDS, ORDER_VENUES } from "@zerofee/protocol";
import { address, arr, bool, obj, oneOf, strict, ValidationError } from "../api/validate";

const U64_MAX = (1n << 64n) - 1n;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const OCO_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Base64 length of a PACKET_DATA_SIZE transaction (armed transactions are v0, never larger). */
const MAX_WIRE_B64 = Math.ceil(PACKET_DATA_SIZE / 3) * 4;
/** pump.fun curve, PumpSwap, Raydium LaunchLab, Raydium CPMM (protocol ORDER_VENUES = core ArmedVenue). */
const VENUES: readonly ArmedVenue[] = ORDER_VENUES;
const RAYDIUM_VENUES: readonly ArmedVenue[] = ["launchlab", "cpmm"];

export interface WireLimits {
  maxAttempts: number;
  maxVariantsPerNonce: number;
  /** Orders per POST. */
  maxOrders: number;
}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

function big(v: unknown, name: string, o: { min?: bigint; optional?: boolean } = {}): bigint {
  if (typeof v !== "bigint") return fail(`${name} must be an integer tagged {"$bigint": "..."}`);
  if (v < (o.min ?? 0n)) fail(`${name} must be at least ${o.min ?? 0n}`);
  if (v > U64_MAX) fail(`${name} does not fit in u64`);
  return v;
}

function optBig(v: unknown, name: string, min = 1n): bigint | undefined {
  return v === undefined ? undefined : big(v, name, { min });
}

function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) fail(`${name} must be an integer in [${min}, ${max}]`);
  return v as number;
}

function addr(v: unknown, name: string): Address {
  return address(v, name) as Address;
}

/** A base58 value of `bytes` bytes (signatures 64, nonce values 32): shape check only. */
function b58(v: unknown, name: string, minLen: number, maxLen: number): string {
  if (typeof v !== "string" || v.length < minLen || v.length > maxLen || !B58_RE.test(v)) fail(`${name} must be base58`);
  return v as string;
}

function signedTx(v: unknown, name: string): SignedTx {
  const o = obj(v, name);
  strict(o, ["wireBase64", "signature", "size"], name);
  if (typeof o.wireBase64 !== "string" || o.wireBase64.length < 8 || o.wireBase64.length > MAX_WIRE_B64 || !B64_RE.test(o.wireBase64)) {
    fail(`${name}.wireBase64 must be a base64 transaction of at most ${PACKET_DATA_SIZE} bytes`);
  }
  return {
    wireBase64: o.wireBase64 as string,
    signature: b58(o.signature, `${name}.signature`, 64, 88),
    size: int(o.size, `${name}.size`, 1, PACKET_DATA_SIZE),
  };
}

function trigger(v: unknown, name: string): ArmedTrigger {
  const o = obj(v, name);
  const type = oneOf(o.type, `${name}.type`, ["quote-at-least", "quote-at-most", "trailing", "time", "migration", "dev-sell"] as const);
  switch (type) {
    case "quote-at-least":
    case "quote-at-most":
      strict(o, ["type", "threshold"], name);
      return { type, threshold: big(o.threshold, `${name}.threshold`, { min: 1n }) };
    case "trailing": {
      strict(o, ["type", "trailBps", "activationQuoteOut"], name);
      const activation = optBig(o.activationQuoteOut, `${name}.activationQuoteOut`);
      return {
        type,
        trailBps: int(o.trailBps, `${name}.trailBps`, 1, 9_999),
        ...(activation !== undefined ? { activationQuoteOut: activation } : {}),
      };
    }
    case "time": {
      strict(o, ["type", "notBeforeMs", "minQuoteOut"], name);
      const min = optBig(o.minQuoteOut, `${name}.minQuoteOut`);
      return {
        type,
        notBeforeMs: int(o.notBeforeMs, `${name}.notBeforeMs`, 0, Number.MAX_SAFE_INTEGER),
        ...(min !== undefined ? { minQuoteOut: min } : {}),
      };
    }
    case "migration":
      strict(o, ["type"], name);
      return { type };
    case "dev-sell": {
      strict(o, ["type", "creator", "minTokenAmount"], name);
      const min = optBig(o.minTokenAmount, `${name}.minTokenAmount`);
      return { type, creator: addr(o.creator, `${name}.creator`), ...(min !== undefined ? { minTokenAmount: min } : {}) };
    }
  }
}

function variant(v: unknown, name: string, prefix: string): ArmedVariant {
  const o = obj(v, name);
  strict(o, ["id", "venue", "minOut", "tipLevel", "tipLamports", "priorityFeeLamports", "tx"], name);
  const venue = oneOf(o.venue, `${name}.venue`, VENUES);
  if (typeof o.id !== "string" || o.id.length > 200 || !o.id.startsWith(`${prefix}/${venue}/`) || !/^[A-Za-z0-9/_-]+$/.test(o.id)) {
    fail(`${name}.id must look like ${prefix}/${venue}/<minOutIndex>/<tipLevel>`);
  }
  return {
    id: o.id as string,
    venue,
    minOut: big(o.minOut, `${name}.minOut`, { min: 1n }),
    tipLevel: int(o.tipLevel, `${name}.tipLevel`, 0, 255),
    tipLamports: big(o.tipLamports, `${name}.tipLamports`),
    priorityFeeLamports: big(o.priorityFeeLamports, `${name}.priorityFeeLamports`),
    tx: signedTx(o.tx, `${name}.tx`),
  };
}

function attempt(v: unknown, name: string, index: number, orderId: string, lim: WireLimits): ArmedAttempt {
  const o = obj(v, name);
  strict(o, ["index", "nonce", "variants", "status"], name);
  if (o.index !== index) fail(`${name}.index must be ${index}`);
  if (o.status !== "live") fail(`${name}.status must be "live" when arming`);
  const n = obj(o.nonce, `${name}.nonce`);
  strict(n, ["account", "authority", "value", "cancel"], `${name}.nonce`);
  const variants = arr(o.variants, `${name}.variants`, lim.maxVariantsPerNonce).map((x, i) =>
    variant(x, `${name}.variants[${i}]`, `${orderId}/${index}`),
  );
  if (variants.length === 0) fail(`${name}.variants must not be empty`);
  return {
    index,
    nonce: {
      account: addr(n.account, `${name}.nonce.account`),
      authority: addr(n.authority, `${name}.nonce.authority`),
      value: b58(n.value, `${name}.nonce.value`, 32, 44),
      cancel: signedTx(n.cancel, `${name}.nonce.cancel`),
    },
    variants,
    status: "live",
  };
}

/**
 * pump / PumpSwap venues name their fee and buyback recipients (and coin flags); Raydium venues name the
 * LaunchLab platform_config or CPMM amm_config instead and have no recipients (core FrozenVenueAccounts).
 */
function frozenVenue(v: unknown, name: string): FrozenVenueAccounts {
  const o = obj(v, name);
  const venue = oneOf(o.venue, `${name}.venue`, VENUES);
  const base = { venue, creator: addr(o.creator, `${name}.creator`), market: addr(o.market, `${name}.market`) };
  if (RAYDIUM_VENUES.includes(venue)) {
    strict(o, ["venue", "creator", "market", "config"], name);
    return { ...base, config: addr(o.config, `${name}.config`) };
  }
  strict(o, ["venue", "creator", "market", "feeRecipient", "buybackFeeRecipient", "isMayhemMode", "isCashbackCoin"], name);
  return {
    ...base,
    feeRecipient: addr(o.feeRecipient, `${name}.feeRecipient`),
    buybackFeeRecipient: addr(o.buybackFeeRecipient, `${name}.buybackFeeRecipient`),
    ...(o.isMayhemMode !== undefined ? { isMayhemMode: bool(o.isMayhemMode, `${name}.isMayhemMode`) } : {}),
    ...(o.isCashbackCoin !== undefined ? { isCashbackCoin: bool(o.isCashbackCoin, `${name}.isCashbackCoin`) } : {}),
  };
}

const ORDER_KEYS = [
  "id",
  "wallet",
  "kind",
  "side",
  "mint",
  "amount",
  "fullExit",
  "trigger",
  "attempts",
  "ocoGroup",
  "armingQuoteOut",
  "armedAtMs",
  "frozen",
  "reservation",
  "capCost",
  "status",
  "statusReason",
  "flags",
];

/** One ArmedOrder from parsed JSON (bigints already revived). Throws ValidationError naming the field. */
export function parseArmedOrder(v: unknown, lim: WireLimits, name = "order"): ArmedOrder {
  const o = obj(v, name);
  strict(o, ORDER_KEYS, name);
  if (typeof o.id !== "string" || !UUID_RE.test(o.id)) fail(`${name}.id must be a lowercase UUID`);
  const id = o.id as string;
  const kind = oneOf(o.kind, `${name}.kind`, ORDER_KINDS) as ArmedOrderKind;
  const side = oneOf(o.side, `${name}.side`, ["buy", "sell"] as const);
  if (side !== ARMED_ORDER_SIDE[kind]) fail(`${name}.side: a ${kind} is a ${ARMED_ORDER_SIDE[kind]}`);
  const mint = addr(o.mint, `${name}.mint`);
  if (o.status !== "armed") fail(`${name}.status must be "armed"`);
  if (o.statusReason !== undefined) fail(`${name}.statusReason must be absent when arming`);
  if (o.flags !== undefined && (!Array.isArray(o.flags) || o.flags.length > 0)) fail(`${name}.flags must be empty when arming`);
  if (o.ocoGroup !== undefined && (typeof o.ocoGroup !== "string" || !OCO_RE.test(o.ocoGroup))) {
    fail(`${name}.ocoGroup must be 1-64 of A-Z a-z 0-9 _ -`);
  }
  const attemptsRaw = arr(o.attempts, `${name}.attempts`, lim.maxAttempts);
  if (attemptsRaw.length === 0) fail(`${name}.attempts must not be empty`);
  const attempts = attemptsRaw.map((a, i) => attempt(a, `${name}.attempts[${i}]`, i, id, lim));
  const ids = new Set<string>();
  for (const a of attempts) {
    for (const x of a.variants) {
      if (ids.has(x.id)) fail(`${name}: variant id ${x.id} is repeated`);
      ids.add(x.id);
    }
  }

  const f = obj(o.frozen, `${name}.frozen`);
  strict(f, ["mint", "baseTokenProgram", "quoteMint", "venues", "tipAccounts", "lookupTables", "interfaceVersion"], `${name}.frozen`);
  if (f.mint !== mint) fail(`${name}.frozen.mint must be the order mint`);
  const baseTokenProgram = oneOf(f.baseTokenProgram, `${name}.frozen.baseTokenProgram`, [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
  const venues = arr(f.venues, `${name}.frozen.venues`, 2).map((x, i) => frozenVenue(x, `${name}.frozen.venues[${i}]`));
  if (venues.length === 0 || new Set(venues.map((x) => x.venue)).size !== venues.length) {
    fail(`${name}.frozen.venues must list each venue at most once`);
  }
  for (const a of attempts)
    for (const x of a.variants) {
      if (!venues.some((fv) => fv.venue === x.venue)) fail(`${name}: variant ${x.id} trades on ${x.venue}, which has no frozen accounts`);
    }
  if (typeof f.interfaceVersion !== "string" || f.interfaceVersion.length < 1 || f.interfaceVersion.length > 256) {
    fail(`${name}.frozen.interfaceVersion must be a string`);
  }
  const frozen: ArmedOrder["frozen"] = {
    mint,
    baseTokenProgram: baseTokenProgram as Address,
    quoteMint: addr(f.quoteMint, `${name}.frozen.quoteMint`),
    venues,
    tipAccounts: [
      ...new Set(arr(f.tipAccounts, `${name}.frozen.tipAccounts`, 16).map((x, i) => addr(x, `${name}.frozen.tipAccounts[${i}]`))),
    ],
    lookupTables: [
      ...new Set(arr(f.lookupTables, `${name}.frozen.lookupTables`, 4).map((x, i) => addr(x, `${name}.frozen.lookupTables[${i}]`))),
    ],
    interfaceVersion: f.interfaceVersion as string,
  };

  const r = obj(o.reservation, `${name}.reservation`);
  strict(r, ["lamports", "mint", "tokens"], `${name}.reservation`);
  if (r.mint !== mint) fail(`${name}.reservation.mint must be the order mint`);
  const c = obj(o.capCost, `${name}.capCost`);
  strict(c, ["buyLamports", "buyQuote", "feeLamports"], `${name}.capCost`);
  const buyQuoteRaw = obj(c.buyQuote, `${name}.capCost.buyQuote`);
  if (Object.keys(buyQuoteRaw).length > 4) fail(`${name}.capCost.buyQuote has too many entries`);
  const buyQuote: Record<string, bigint> = {};
  for (const [k, x] of Object.entries(buyQuoteRaw))
    buyQuote[addr(k, `${name}.capCost.buyQuote key`)] = big(x, `${name}.capCost.buyQuote.${k}`);

  return {
    id,
    wallet: addr(o.wallet, `${name}.wallet`),
    kind,
    side,
    mint,
    amount: big(o.amount, `${name}.amount`, { min: 1n }),
    fullExit: bool(o.fullExit, `${name}.fullExit`),
    trigger: trigger(o.trigger, `${name}.trigger`),
    attempts,
    ...(o.ocoGroup !== undefined ? { ocoGroup: o.ocoGroup as string } : {}),
    armingQuoteOut: big(o.armingQuoteOut, `${name}.armingQuoteOut`, { min: 1n }),
    armedAtMs: int(o.armedAtMs, `${name}.armedAtMs`, 1, Number.MAX_SAFE_INTEGER),
    frozen,
    reservation: {
      lamports: big(r.lamports, `${name}.reservation.lamports`),
      mint,
      tokens: big(r.tokens, `${name}.reservation.tokens`),
    },
    capCost: {
      buyLamports: big(c.buyLamports, `${name}.capCost.buyLamports`),
      buyQuote,
      feeLamports: big(c.feeLamports, `${name}.capCost.feeLamports`),
    },
    status: "armed",
  };
}

/**
 * The POST /api/orders/armed body: one ArmedOrder JSON, or `{ "orders": [...] }` for an atomic batch.
 * Throws ValidationError on malformed input.
 */
export function parseArmBody(text: string, lim: WireLimits): ArmedOrder[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text, armedJsonReviver);
  } catch {
    return fail("invalid JSON");
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 1 && "orders" in raw) {
    const list = arr((raw as { orders: unknown }).orders, "orders", lim.maxOrders);
    if (list.length === 0) fail("orders must not be empty");
    const orders = list.map((o, i) => parseArmedOrder(o, lim, `orders[${i}]`));
    if (new Set(orders.map((o) => o.id)).size !== orders.length) fail("orders: duplicate order ids");
    return orders;
  }
  return [parseArmedOrder(raw, lim)];
}
