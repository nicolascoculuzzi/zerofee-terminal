/**
 * Isomorphic client for Jupiter Swap API V2 `GET /build` (browser and Bun: fetch only).
 *
 * `/build` returns a quote plus raw instructions (Metis routing) and charges no Jupiter swap fee. It is
 * the only Jupiter endpoint this codebase calls: `/order` (the Meta-Aggregator) charges Jupiter's
 * platform fee, up to 50 bps on tokens younger than 24 h, which a zero-fee terminal must not pay.
 *   https://developers.jup.ag/docs/swap/build
 *   https://developers.jup.ag/docs/api-reference/swap/build
 *   https://developers.jup.ag/docs/swap/fees
 *
 * The request is built from an allowlist of parameters. Never sent: `platformFeeBps` / `feeAccount`
 * (integrator fee, default 0), `tipAmount` (a tip to Jupiter's landing service; we tip our own lanes),
 * `destinationTokenAccount` / `nativeDestinationAccount` (output must land in the taker's own ATA, which
 * the signer firewall requires), `payer` (the taker pays). `slippageBps` is always a number, so Jupiter's
 * dynamic slippage estimator (RTSE, `slippageBps=rtse`) stays off and the user's own slippage applies.
 */
import { type Address, type AddressesByLookupTableAddress, getBase64Encoder, isAddress } from "@solana/kit";
import { JUPITER_BUILD_PATH, JUPITER_MAX_ACCOUNTS, JUPITER_SWAP_API_BASE } from "../constants";

export interface JupiterBuildRequest {
  inputMint: Address;
  outputMint: Address;
  /** Exact input in the input mint's base units (`/build` is exact-in only). */
  amount: bigint;
  /** The user's slippage, 0-10,000 bps. */
  slippageBps: number;
  /** Signer and owner of the source and destination token accounts. */
  taker: Address;
  /** Route account budget (1-64, Jupiter's default 64). Lower it only when a transaction is too large. */
  maxAccounts?: number;
  /** Venue labels to avoid (case sensitive, from program-id-to-label). Mutually exclusive with `dexes`. */
  excludeDexes?: readonly string[];
  dexes?: readonly string[];
  /** Skip venues that cannot run inside a Jito bundle (set for bundle-only landing). */
  forJitoBundle?: boolean;
  /** "fast": lower routing latency, possibly a worse route (beta). */
  mode?: "fast";
}

export interface JupiterClientOptions {
  /** Optional `x-api-key` (keyless access is limited to 0.5 RPS). Never logged. */
  apiKey?: string;
  /** Default JUPITER_SWAP_API_BASE. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
  /** Default 10 s. */
  timeoutMs?: number;
}

export interface JupiterAccountMeta {
  pubkey: Address;
  isSigner: boolean;
  isWritable: boolean;
}

export interface JupiterApiInstruction {
  programId: Address;
  accounts: JupiterAccountMeta[];
  data: Uint8Array;
}

export interface JupiterRouteStep {
  label: string;
  ammKey: Address;
  inputMint: Address;
  outputMint: Address;
  inAmount: bigint;
  outAmount: bigint;
  percent: number;
  bps: number;
}

/** A parsed `/build` response. Amounts are bigints; every address is validated. */
export interface JupiterBuildResponse {
  inputMint: Address;
  outputMint: Address;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum output after slippage, as Jupiter computed it. */
  otherAmountThreshold: bigint;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string | null;
  routePlan: JupiterRouteStep[];
  computeBudgetInstructions: JupiterApiInstruction[];
  setupInstructions: JupiterApiInstruction[];
  swapInstruction: JupiterApiInstruction;
  cleanupInstruction: JupiterApiInstruction | null;
  otherInstructions: JupiterApiInstruction[];
  tipInstruction: JupiterApiInstruction | null;
  addressesByLookupTableAddress: AddressesByLookupTableAddress;
}

export class JupiterApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JupiterApiError";
  }
}

const QUERY_KEYS = new Set([
  "inputMint",
  "outputMint",
  "amount",
  "taker",
  "slippageBps",
  "maxAccounts",
  "excludeDexes",
  "dexes",
  "forJitoBundle",
  "mode",
]);

/** The `/build` URL for a request. Only allowlisted parameters can appear (see the header comment). */
export function jupiterBuildUrl(req: JupiterBuildRequest, baseUrl: string = JUPITER_SWAP_API_BASE): string {
  if (req.amount <= 0n) throw new RangeError("Jupiter amount must be > 0");
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < 0 || req.slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000], got ${req.slippageBps}`);
  }
  if (req.inputMint === req.outputMint) throw new RangeError("input and output mints are the same");
  if (
    req.maxAccounts !== undefined &&
    (!Number.isInteger(req.maxAccounts) || req.maxAccounts < 1 || req.maxAccounts > JUPITER_MAX_ACCOUNTS)
  ) {
    throw new RangeError(`maxAccounts must be an integer in [1, ${JUPITER_MAX_ACCOUNTS}]`);
  }
  if (req.dexes?.length && req.excludeDexes?.length) throw new RangeError("dexes and excludeDexes are mutually exclusive");
  const params = new URLSearchParams({
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: req.amount.toString(),
    taker: req.taker,
    slippageBps: String(req.slippageBps),
  });
  if (req.maxAccounts !== undefined) params.set("maxAccounts", String(req.maxAccounts));
  if (req.excludeDexes?.length) params.set("excludeDexes", req.excludeDexes.join(","));
  if (req.dexes?.length) params.set("dexes", req.dexes.join(","));
  if (req.forJitoBundle) params.set("forJitoBundle", "true");
  if (req.mode) params.set("mode", req.mode);
  for (const k of params.keys()) if (!QUERY_KEYS.has(k)) throw new Error(`refusing to send /build parameter ${k}`);
  return `${baseUrl.replace(/\/+$/, "")}${JUPITER_BUILD_PATH}?${params}`;
}

/** Calls `/build` and parses the response (throws JupiterApiError on HTTP errors, e.g. "No routes found"). */
export async function fetchJupiterBuild(req: JupiterBuildRequest, opts: JupiterClientOptions = {}): Promise<JupiterBuildResponse> {
  const fetchFn = opts.fetchFn ?? fetch;
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.apiKey) headers["x-api-key"] = opts.apiKey;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetchFn(jupiterBuildUrl(req, opts.baseUrl), { headers, signal });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const err = (JSON.parse(text) as { error?: unknown }).error;
      if (typeof err === "string") message = err;
    } catch {
      // not JSON: keep the raw text
    }
    throw new JupiterApiError(`Jupiter /build HTTP ${res.status}: ${message}`, res.status);
  }
  return parseJupiterBuildResponse(JSON.parse(text));
}

// ---------------------------------------------------------------------------------------------
// Response parsing (strict: anything unexpected throws)
// ---------------------------------------------------------------------------------------------

const b64 = getBase64Encoder();

function fail(path: string, what: string): never {
  throw new Error(`Jupiter /build response: ${path} ${what}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(path, "is not an object");
  return v as Record<string, unknown>;
}

function addr(v: unknown, path: string): Address {
  if (typeof v !== "string" || !isAddress(v)) fail(path, "is not an address");
  return v;
}

function amount(v: unknown, path: string): bigint {
  if (typeof v !== "string" || !/^\d{1,20}$/.test(v)) fail(path, "is not a u64 decimal string");
  const n = BigInt(v);
  if (n >= 1n << 64n) fail(path, "exceeds u64");
  return n;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "is not a number");
  return v;
}

function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "is not an array");
  return v;
}

function instruction(v: unknown, path: string): JupiterApiInstruction {
  const o = obj(v, path);
  if (typeof o.data !== "string") fail(`${path}.data`, "is not base64");
  return {
    programId: addr(o.programId, `${path}.programId`),
    accounts: array(o.accounts, `${path}.accounts`).map((a, i) => {
      const m = obj(a, `${path}.accounts[${i}]`);
      if (typeof m.isSigner !== "boolean" || typeof m.isWritable !== "boolean") fail(`${path}.accounts[${i}]`, "has no role flags");
      return { pubkey: addr(m.pubkey, `${path}.accounts[${i}].pubkey`), isSigner: m.isSigner, isWritable: m.isWritable };
    }),
    data: new Uint8Array(b64.encode(o.data)),
  };
}

const optionalInstruction = (v: unknown, path: string) => (v === null || v === undefined ? null : instruction(v, path));
const instructions = (v: unknown, path: string) => (v === undefined ? [] : array(v, path).map((x, i) => instruction(x, `${path}[${i}]`)));

export function parseJupiterBuildResponse(json: unknown): JupiterBuildResponse {
  const o = obj(json, "body");
  const tables: AddressesByLookupTableAddress = {};
  if (o.addressesByLookupTableAddress !== null && o.addressesByLookupTableAddress !== undefined) {
    for (const [table, list] of Object.entries(obj(o.addressesByLookupTableAddress, "addressesByLookupTableAddress"))) {
      const path = `addressesByLookupTableAddress.${table}`;
      tables[addr(table, path)] = array(list, path).map((a, i) => addr(a, `${path}[${i}]`));
    }
  }
  if (typeof o.swapMode !== "string") fail("swapMode", "is missing");
  return {
    inputMint: addr(o.inputMint, "inputMint"),
    outputMint: addr(o.outputMint, "outputMint"),
    inAmount: amount(o.inAmount, "inAmount"),
    outAmount: amount(o.outAmount, "outAmount"),
    otherAmountThreshold: amount(o.otherAmountThreshold, "otherAmountThreshold"),
    swapMode: o.swapMode,
    slippageBps: num(o.slippageBps, "slippageBps"),
    priceImpactPct: typeof o.priceImpactPct === "string" ? o.priceImpactPct : null,
    routePlan: array(o.routePlan, "routePlan").map((r, i) => {
      const step = obj(r, `routePlan[${i}]`);
      const info = obj(step.swapInfo, `routePlan[${i}].swapInfo`);
      return {
        label: typeof info.label === "string" ? info.label : "?",
        ammKey: addr(info.ammKey, `routePlan[${i}].swapInfo.ammKey`),
        inputMint: addr(info.inputMint, `routePlan[${i}].swapInfo.inputMint`),
        outputMint: addr(info.outputMint, `routePlan[${i}].swapInfo.outputMint`),
        inAmount: amount(info.inAmount, `routePlan[${i}].swapInfo.inAmount`),
        outAmount: amount(info.outAmount, `routePlan[${i}].swapInfo.outAmount`),
        percent: num(step.percent, `routePlan[${i}].percent`),
        bps: typeof step.bps === "number" ? step.bps : Math.round(num(step.percent, `routePlan[${i}].percent`) * 100),
      };
    }),
    computeBudgetInstructions: instructions(o.computeBudgetInstructions, "computeBudgetInstructions"),
    setupInstructions: instructions(o.setupInstructions, "setupInstructions"),
    swapInstruction: instruction(o.swapInstruction, "swapInstruction"),
    cleanupInstruction: optionalInstruction(o.cleanupInstruction, "cleanupInstruction"),
    otherInstructions: instructions(o.otherInstructions, "otherInstructions"),
    tipInstruction: optionalInstruction(o.tipInstruction, "tipInstruction"),
    addressesByLookupTableAddress: tables,
  };
}
