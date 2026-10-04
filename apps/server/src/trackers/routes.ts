/**
 * Copy-trading and tracked-trade REST (protocol trackers.ts). Every route needs a session; mutations
 * also need an allowed Origin (CSRF, api/router.ts). Inputs are validated strictly (unknown keys
 * rejected) and tasks are only ever visible to their owner (another user's id answers 404).
 */
import {
  type CopyRange,
  type CopySignalResult,
  type CopySizing,
  type CopyTaskConfig,
  type CopyTaskStatus,
  type CopyValueRange,
  DEFAULT_COPY_CONFIG,
  type PresetSlot,
} from "@zerofee/protocol";
import { badRequest, HttpError, json, notFound, ok } from "../api/http";
import type { Route } from "../api/router";
import { address, arr, bool, label, num, obj, oneOf, str, strict, uuid } from "../api/validate";
import type { UserStore } from "../db/pg";
import type { TrackerService } from "./service";

export interface TrackerRoutesDeps {
  service: TrackerService;
  store: UserStore;
}

const SLOTS: readonly PresetSlot[] = [1, 2, 3];
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE_UNITS_RE = /^[0-9]{1,20}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

function nullableNum(v: unknown, name: string, o: { min: number; max: number; int?: boolean }): number | null {
  return v === null ? null : num(v, name, o);
}

function range(v: unknown, base: CopyRange, name: string, bounds: { max: number; int?: boolean }): CopyRange {
  const o = obj(v, name);
  strict(o, ["min", "max"], name);
  const out = {
    min: o.min === undefined ? base.min : nullableNum(o.min, `${name}.min`, { min: 0, ...bounds }),
    max: o.max === undefined ? base.max : nullableNum(o.max, `${name}.max`, { min: 0, ...bounds }),
  };
  if (out.min !== null && out.max !== null && out.min > out.max) throw badRequest(`${name}.min cannot exceed ${name}.max`);
  return out;
}

function valueRange(v: unknown, base: CopyValueRange, name: string): CopyValueRange {
  const o = obj(v, name);
  strict(o, ["min", "max", "currency"], name);
  const { min, max } = range({ min: o.min, max: o.max }, base, name, { max: 1e12 });
  return { min, max, currency: o.currency === undefined ? base.currency : oneOf(o.currency, `${name}.currency`, ["usd", "sol"] as const) };
}

function sizing(v: unknown, base: CopySizing): CopySizing {
  const o = obj(v, "config.sizing");
  strict(o, ["mode", "sol", "pct"], "config.sizing");
  const mode = o.mode === undefined ? base.mode : oneOf(o.mode, "config.sizing.mode", ["fixed", "ratio"] as const);
  if (mode === "fixed") {
    if (o.pct !== undefined) throw badRequest("config.sizing.pct only applies to mode ratio");
    const sol = o.sol === undefined ? (base.mode === "fixed" ? base.sol : undefined) : o.sol;
    if (sol === undefined) throw badRequest("config.sizing.sol is required for mode fixed");
    return { mode, sol: num(sol, "config.sizing.sol", { min: 0.0001, max: 1_000 }) };
  }
  if (o.sol !== undefined) throw badRequest("config.sizing.sol only applies to mode fixed");
  const pct = o.pct === undefined ? (base.mode === "ratio" ? base.pct : undefined) : o.pct;
  if (pct === undefined) throw badRequest("config.sizing.pct is required for mode ratio");
  return { mode, pct: num(pct, "config.sizing.pct", { min: 0.01, max: 1_000 }) };
}

function addressList(v: unknown, name: string): string[] {
  return [...new Set(arr(v, name, 200).map((x, i) => address(x, `${name}[${i}]`)))];
}

const CONFIG_KEYS = Object.keys(DEFAULT_COPY_CONFIG);

/** Validates a config patch and merges it over `base` (nested objects field by field). */
export function mergeCopyConfig(base: CopyTaskConfig, patch: unknown): CopyTaskConfig {
  const p = obj(patch, "config");
  strict(p, CONFIG_KEYS, "config");
  const c: CopyTaskConfig = structuredClone(base);
  if (p.sizing !== undefined) c.sizing = sizing(p.sizing, base.sizing);
  if (p.maxPerBuySol !== undefined) c.maxPerBuySol = num(p.maxPerBuySol, "config.maxPerBuySol", { min: 0.0001, max: 1_000 });
  if (p.totalSpendLimitSol !== undefined)
    c.totalSpendLimitSol = num(p.totalSpendLimitSol, "config.totalSpendLimitSol", { min: 0.0001, max: 1_000_000 });
  if (p.dailySpendLimitSol !== undefined)
    c.dailySpendLimitSol = num(p.dailySpendLimitSol, "config.dailySpendLimitSol", { min: 0.0001, max: 100_000 });
  if (p.dailyBuyLimit !== undefined) c.dailyBuyLimit = num(p.dailyBuyLimit, "config.dailyBuyLimit", { min: 1, max: 10_000, int: true });
  if (p.mc !== undefined) c.mc = valueRange(p.mc, base.mc, "config.mc");
  if (p.liquidity !== undefined) c.liquidity = valueRange(p.liquidity, base.liquidity, "config.liquidity");
  if (p.ageSec !== undefined) c.ageSec = range(p.ageSec, base.ageSec, "config.ageSec", { max: 1e9 });
  if (p.leaderSol !== undefined) c.leaderSol = range(p.leaderSol, base.leaderSol, "config.leaderSol", { max: 1e6 });
  if (p.excludeBondingCurve !== undefined) c.excludeBondingCurve = bool(p.excludeBondingCurve, "config.excludeBondingCurve");
  if (p.onlyFirstBuy !== undefined) c.onlyFirstBuy = bool(p.onlyFirstBuy, "config.onlyFirstBuy");
  if (p.maxBuysPerToken !== undefined)
    c.maxBuysPerToken = num(p.maxBuysPerToken, "config.maxBuysPerToken", { min: 1, max: 100, int: true });
  if (p.skipDangerousTokens !== undefined) c.skipDangerousTokens = bool(p.skipDangerousTokens, "config.skipDangerousTokens");
  if (p.copySells !== undefined) c.copySells = bool(p.copySells, "config.copySells");
  if (p.takeProfitPct !== undefined) c.takeProfitPct = nullableNum(p.takeProfitPct, "config.takeProfitPct", { min: 0.1, max: 100_000 });
  if (p.stopLossPct !== undefined) c.stopLossPct = nullableNum(p.stopLossPct, "config.stopLossPct", { min: 0.1, max: 99.9 });
  if (p.maxDriftPct !== undefined) c.maxDriftPct = num(p.maxDriftPct, "config.maxDriftPct", { min: 0, max: 1_000 });
  if (p.slippageBps !== undefined) c.slippageBps = num(p.slippageBps, "config.slippageBps", { min: 1, max: 9_900, int: true });
  if (p.preset !== undefined) c.preset = oneOf(p.preset, "config.preset", SLOTS);
  if (p.blacklist !== undefined) {
    const b = obj(p.blacklist, "config.blacklist");
    strict(b, ["mints", "devs"], "config.blacklist");
    if (b.mints !== undefined) c.blacklist.mints = addressList(b.mints, "config.blacklist.mints");
    if (b.devs !== undefined) c.blacklist.devs = addressList(b.devs, "config.blacklist.devs");
  }
  if (c.maxPerBuySol > c.totalSpendLimitSol) throw badRequest("config.maxPerBuySol cannot exceed config.totalSpendLimitSol");
  if (c.dailySpendLimitSol > c.totalSpendLimitSol) throw badRequest("config.dailySpendLimitSol cannot exceed config.totalSpendLimitSol");
  return c;
}

function parseResult(v: unknown): CopySignalResult {
  const o = obj(v);
  strict(o, ["status", "signature", "solAmount", "tokenAmount", "reason"]);
  const status = oneOf(o.status, "status", ["executed", "failed", "declined"] as const);
  const reason = o.reason === undefined ? undefined : str(o.reason, "reason", { min: 1, max: 200 });
  if (status !== "executed") {
    for (const k of ["solAmount", "tokenAmount"] as const) if (o[k] !== undefined) throw badRequest(`${k} only applies to executed`);
    const signature = o.signature === undefined ? undefined : str(o.signature, "signature", { pattern: SIGNATURE_RE, max: 88 });
    return { status, ...(signature ? { signature } : {}), ...(reason ? { reason } : {}) };
  }
  if (reason !== undefined) throw badRequest("reason only applies to failed or declined");
  const signature = str(o.signature, "signature", { pattern: SIGNATURE_RE, max: 88 });
  const solAmount = num(o.solAmount, "solAmount", { min: 0, max: 1_000_000 });
  const tokenAmount = str(o.tokenAmount, "tokenAmount", { pattern: BASE_UNITS_RE, max: 20 });
  const t = BigInt(tokenAmount);
  if (t <= 0n || t > U64_MAX) throw badRequest("tokenAmount must be a positive u64 in base units");
  return { status, signature, solAmount, tokenAmount };
}

function limitParam(url: URL, def: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return def;
  return num(Number(raw), "limit", { min: 1, max, int: true });
}

export function trackerRoutes(d: TrackerRoutesDeps): Route[] {
  const { service, store } = d;
  const engine = service.copy;
  const taskId = (raw: string | undefined) => uuid(raw, "id");
  return [
    // copy tasks --------------------------------------------------------------------------------
    { method: "GET", path: "/api/copy/tasks", auth: "session", handler: async (c) => json(engine.listTasks(c.session.userId)) },
    {
      method: "POST",
      path: "/api/copy/tasks",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json());
        strict(b, ["leader", "label", "status", "config"]);
        const leader = address(b.leader, "leader");
        if (await store.users.ownsWallet(c.session.userId, leader)) {
          throw badRequest("that is one of your own wallets: copying it would copy your own copies");
        }
        const status: CopyTaskStatus = b.status === undefined ? "active" : oneOf(b.status, "status", ["active", "paused"] as const);
        const config = b.config === undefined ? structuredClone(DEFAULT_COPY_CONFIG) : mergeCopyConfig(DEFAULT_COPY_CONFIG, b.config);
        const l = b.label === undefined ? "" : label(b.label, "label");
        if (engine.listTasks(c.session.userId).some((t) => t.leader === leader)) {
          throw new HttpError(409, "conflict", "you already copy this wallet: edit that task instead");
        }
        return json(await engine.createTask(c.session.userId, { leader, label: l, status, config }));
      },
    },
    {
      method: "GET",
      path: "/api/copy/tasks/:id",
      auth: "session",
      handler: async (c) => {
        const t = engine.getTask(c.session.userId, taskId(c.params.id));
        if (!t) throw notFound("no such copy task");
        return json(t);
      },
    },
    {
      method: "PATCH",
      path: "/api/copy/tasks/:id",
      auth: "session",
      handler: async (c) => {
        const id = taskId(c.params.id);
        const current = engine.getTask(c.session.userId, id);
        if (!current) throw notFound("no such copy task");
        const b = obj(await c.json());
        strict(b, ["label", "config"]);
        const patch = {
          ...(b.label !== undefined ? { label: label(b.label, "label") } : {}),
          ...(b.config !== undefined ? { config: mergeCopyConfig(current.config, b.config) } : {}),
        };
        const t = await engine.updateTask(c.session.userId, id, patch);
        if (!t) throw notFound("no such copy task");
        return json(t);
      },
    },
    {
      method: "DELETE",
      path: "/api/copy/tasks/:id",
      auth: "session",
      handler: async (c) => {
        if (!(await engine.deleteTask(c.session.userId, taskId(c.params.id)))) throw notFound("no such copy task");
        return ok();
      },
    },
    {
      method: "POST",
      path: "/api/copy/tasks/:id/pause",
      auth: "session",
      handler: async (c) => {
        const t = await engine.setStatus(c.session.userId, taskId(c.params.id), "paused");
        if (!t) throw notFound("no such copy task");
        return json(t);
      },
    },
    {
      method: "POST",
      path: "/api/copy/tasks/:id/resume",
      auth: "session",
      handler: async (c) => {
        const t = await engine.setStatus(c.session.userId, taskId(c.params.id), "active");
        if (!t) throw notFound("no such copy task");
        return json(t);
      },
    },

    // positions and signals --------------------------------------------------------------------
    { method: "GET", path: "/api/copy/positions", auth: "session", handler: async (c) => json(engine.positions(c.session.userId)) },
    {
      method: "GET",
      path: "/api/copy/signals",
      auth: "session",
      handler: async (c) => {
        const limit = limitParam(c.url, 50, 500);
        const raw = c.url.searchParams.get("task");
        const task = raw === null ? undefined : taskId(raw);
        if (task && !engine.getTask(c.session.userId, task)) throw notFound("no such copy task");
        const stored = await service.repo.listSignals(c.session.userId, { taskId: task, limit });
        // Rows are written behind the live state: overlay what memory knows, and pending ones not saved yet.
        const live = new Map(engine.pendingOf(c.session.userId).map((s) => [s.id, s]));
        const out = stored.map((s) => live.get(s.id) ?? s);
        const have = new Set(out.map((s) => s.id));
        const extra = [...live.values()].filter((s) => !have.has(s.id) && (!task || s.taskId === task));
        return json([...extra, ...out].slice(0, limit));
      },
    },
    {
      method: "POST",
      path: "/api/copy/signals/:id/result",
      auth: "session",
      handler: async (c) => {
        const id = uuid(c.params.id, "id");
        const result = parseResult(await c.json(4 * 1024));
        const r = await engine.report(c.session.userId, id, result);
        if (!r.ok) throw new HttpError(r.status, r.status === 404 ? "not_found" : r.status === 409 ? "conflict" : "bad_request", r.message);
        return json(r.signal);
      },
    },

    // tracked-wallet trades (REST twin of the topic snapshots) ---------------------------------
    {
      method: "GET",
      path: "/api/tracked-trades",
      auth: "session",
      handler: async (c) => {
        const rawMint = c.url.searchParams.get("mint");
        const mint = rawMint === null ? null : address(rawMint, "mint");
        return json(service.feed.snapshot(c.session.userId, mint, limitParam(c.url, 100, 500)));
      },
    },
  ];
}
