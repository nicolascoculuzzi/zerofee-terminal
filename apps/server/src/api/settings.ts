/**
 * Per-user settings REST (protocol user.ts): trading wallets, presets P1-P3, settings, watchlist,
 * blacklists and the wallet tracker with BullX / GMGN / Axiom import and export. All routes need a
 * session; mutations also need an allowed Origin (router.ts).
 */
import {
  BLACKLIST_KINDS,
  type BlacklistKind,
  type BlacklistsResponse,
  CHANNEL_KINDS,
  type ChannelKind,
  DEFAULT_PRESETS,
  DEFAULT_USER_SETTINGS,
  type LandingPreset,
  type PresetSide,
  type PresetSlot,
  type TrackedWalletAlerts,
  type TrackedWalletImportResult,
  type TradingPreset,
  USER_LIMITS,
  type UserSettings,
  type WalletListFormat,
} from "@zerofee/protocol";
import type { UserStore } from "../db/pg";
import type { TrackedWalletWrite } from "../db/pg/tracked";
import { badRequest, HttpError, json, notFound, ok } from "./http";
import type { Route } from "./router";
import { address, arr, bool, emoji, label, num, obj, oneOf, str, strict, xHandle } from "./validate";
import { exportWalletList, parseWalletList, WalletListError } from "./walletFormats";

export interface SettingsHooks {
  /** Settings changed (alert routing reads the notification preferences). */
  settingsChanged?(userId: string, settings: UserSettings): void;
  /** The user's tracked wallets changed (alert engine index). */
  trackedChanged?(userId: string): void;
}

const LANDINGS: readonly LandingPreset[] = ["reduced", "secure", "fast"];
const SLOTS: readonly PresetSlot[] = [1, 2, 3];
const IMPORT_BODY_LIMIT = 3 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function presetSide(v: unknown, name: string): PresetSide {
  const o = obj(v, name);
  strict(o, ["slippageBps", "priorityFeeSol", "tipSol", "landing", "autoFee"], name);
  return {
    slippageBps: num(o.slippageBps, `${name}.slippageBps`, { min: 1, max: 9_900, int: true }),
    priorityFeeSol: num(o.priorityFeeSol, `${name}.priorityFeeSol`, { min: 0, max: 0.1 }),
    tipSol: num(o.tipSol, `${name}.tipSol`, { min: 0, max: 0.1 }),
    landing: oneOf(o.landing, `${name}.landing`, LANDINGS),
    autoFee: bool(o.autoFee, `${name}.autoFee`),
  };
}

function channelList(v: unknown, name: string): ChannelKind[] {
  const list = arr(v, name, CHANNEL_KINDS.length).map((c, i) => oneOf(c, `${name}[${i}]`, CHANNEL_KINDS));
  return [...new Set(list)];
}

function flatRecord<T extends string | number | boolean>(
  v: unknown,
  name: string,
  keyRe: RegExp,
  value: (x: unknown, n: string) => T,
): Record<string, T> {
  const o = obj(v, name);
  const keys = Object.keys(o);
  if (keys.length > 64) throw badRequest(`${name} may hold at most 64 entries`);
  const out: Record<string, T> = {};
  for (const k of keys) {
    if (!keyRe.test(k)) throw badRequest(`${name}: invalid key ${JSON.stringify(k.slice(0, 40))}`);
    out[k] = value(o[k], `${name}.${k}`);
  }
  return out;
}

/** Validates a PATCH body and merges it over `current`. */
export function mergeSettings(current: UserSettings, patchBody: unknown): UserSettings {
  const p = obj(patchBody);
  strict(p, Object.keys(DEFAULT_USER_SETTINGS));
  const next: UserSettings = { ...current, notifications: { ...current.notifications } };
  if (p.theme !== undefined) next.theme = oneOf(p.theme, "theme", ["dark", "light", "system"] as const);
  if (p.tradeMode !== undefined) next.tradeMode = oneOf(p.tradeMode, "tradeMode", ["instant", "direct"] as const);
  if (p.autoLockMinutes !== undefined) next.autoLockMinutes = num(p.autoLockMinutes, "autoLockMinutes", { min: 1, max: 240, int: true });
  if (p.activePreset !== undefined) next.activePreset = oneOf(p.activePreset, "activePreset", SLOTS);
  if (p.quickBuySol !== undefined) {
    next.quickBuySol = arr(p.quickBuySol, "quickBuySol", 6).map((x, i) => num(x, `quickBuySol[${i}]`, { min: 0.0001, max: 1_000 }));
  }
  if (p.quickSellPct !== undefined) {
    next.quickSellPct = arr(p.quickSellPct, "quickSellPct", 6).map((x, i) => num(x, `quickSellPct[${i}]`, { min: 1, max: 100 }));
  }
  if (p.maxTradeSol !== undefined) next.maxTradeSol = num(p.maxTradeSol, "maxTradeSol", { min: 0.001, max: 10_000 });
  if (p.maxDailySol !== undefined) next.maxDailySol = num(p.maxDailySol, "maxDailySol", { min: 0.001, max: 100_000 });
  if (next.maxTradeSol > next.maxDailySol) throw badRequest("maxTradeSol cannot exceed maxDailySol");
  if (p.hotkeys !== undefined) {
    next.hotkeys = flatRecord(p.hotkeys, "hotkeys", /^[A-Za-z0-9_.:-]{1,32}$/, (x, n) => str(x, n, { min: 1, max: 32 }));
  }
  if (p.sounds !== undefined) next.sounds = bool(p.sounds, "sounds");
  if (p.toastPosition !== undefined) {
    next.toastPosition = oneOf(p.toastPosition, "toastPosition", ["top-left", "top-right", "bottom-left", "bottom-right"] as const);
  }
  if (p.notifications !== undefined) {
    const n = obj(p.notifications, "notifications");
    strict(n, ["walletChannels", "orderChannels", "digestSeconds"], "notifications");
    if (n.walletChannels !== undefined) next.notifications.walletChannels = channelList(n.walletChannels, "notifications.walletChannels");
    if (n.orderChannels !== undefined) next.notifications.orderChannels = channelList(n.orderChannels, "notifications.orderChannels");
    if (n.digestSeconds !== undefined) {
      next.notifications.digestSeconds = num(n.digestSeconds, "notifications.digestSeconds", { min: 10, max: 3_600, int: true });
    }
  }
  if (p.display !== undefined) {
    next.display = flatRecord<string | number | boolean>(p.display, "display", /^[A-Za-z0-9_.-]{1,48}$/, (x, n) => {
      if (typeof x === "boolean") return x;
      if (typeof x === "number") return num(x, n, { min: -1e9, max: 1e9 });
      return str(x, n, { max: 64 });
    });
  }
  return next;
}

/** Stored settings merged over the defaults (fields added later get their default). */
export function withDefaults(stored: unknown): UserSettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Partial<UserSettings>;
  return {
    ...DEFAULT_USER_SETTINGS,
    ...s,
    notifications: { ...DEFAULT_USER_SETTINGS.notifications, ...(s.notifications ?? {}) },
  };
}

function presetsFrom(stored: { slot: PresetSlot; name: string; config: unknown }[]): TradingPreset[] {
  return DEFAULT_PRESETS.map((d) => {
    const s = stored.find((p) => p.slot === d.slot);
    if (!s) return d;
    const c = (s.config ?? {}) as Partial<Pick<TradingPreset, "buy" | "sell">>;
    return { slot: d.slot, name: s.name, buy: { ...d.buy, ...(c.buy ?? {}) }, sell: { ...d.sell, ...(c.sell ?? {}) } };
  });
}

function blacklistValue(kind: BlacklistKind, v: unknown): string {
  return kind === "x" ? xHandle(v, "value") : address(v, "value");
}

function trackedAlerts(v: unknown, base: TrackedWalletAlerts): TrackedWalletAlerts {
  const o = obj(v, "alerts");
  strict(o, ["buy", "sell", "create", "minSol"], "alerts");
  return {
    buy: o.buy === undefined ? base.buy : bool(o.buy, "alerts.buy"),
    sell: o.sell === undefined ? base.sell : bool(o.sell, "alerts.sell"),
    create: o.create === undefined ? base.create : bool(o.create, "alerts.create"),
    minSol: o.minSol === undefined ? base.minSol : num(o.minSol, "alerts.minSol", { min: 0, max: 100_000 }),
  };
}

function tags(v: unknown): string[] {
  return [...new Set(arr(v, "tags", 8).map((t, i) => str(t, `tags[${i}]`, { min: 1, max: 32 })))];
}

const NO_ALERTS: TrackedWalletAlerts = { buy: false, sell: false, create: false, minSol: 0 };

// ---------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------

export function settingsRoutes(store: UserStore, now: () => number, hooks: SettingsHooks = {}): Route[] {
  return [
    // trading wallets ---------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/trading-wallets",
      auth: "session",
      handler: async (c) => json(await store.users.listTradingWallets(c.session.userId)),
    },
    {
      method: "POST",
      path: "/api/trading-wallets",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json());
        strict(b, ["publicKey", "label"]);
        const publicKey = address(b.publicKey, "publicKey");
        if (publicKey === c.session.wallet) throw badRequest("that is your connected wallet, not a trading wallet");
        const l = b.label === undefined ? undefined : label(b.label, "label");
        return json(await store.users.upsertTradingWallet(c.session.userId, publicKey, l, now(), USER_LIMITS.tradingWallets));
      },
    },
    {
      method: "PATCH",
      path: "/api/trading-wallets/:publicKey",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json());
        strict(b, ["label"]);
        const w = await store.users.setTradingWalletLabel(
          c.session.userId,
          address(c.params.publicKey, "publicKey"),
          label(b.label, "label"),
        );
        if (!w) throw notFound("no such trading wallet");
        return json(w);
      },
    },
    {
      method: "DELETE",
      path: "/api/trading-wallets/:publicKey",
      auth: "session",
      handler: async (c) => {
        if (!(await store.users.deleteTradingWallet(c.session.userId, address(c.params.publicKey, "publicKey")))) {
          throw notFound("no such trading wallet");
        }
        return ok();
      },
    },

    // presets -------------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/presets",
      auth: "session",
      handler: async (c) => json(presetsFrom(await store.prefs.listPresets(c.session.userId))),
    },
    {
      method: "PUT",
      path: "/api/presets/:slot",
      auth: "session",
      handler: async (c) => {
        const slot = oneOf(Number(c.params.slot), "slot", SLOTS);
        const b = obj(await c.json());
        strict(b, ["name", "buy", "sell"]);
        const preset: TradingPreset = {
          slot,
          name: str(b.name, "name", { min: 1, max: 24 }),
          buy: presetSide(b.buy, "buy"),
          sell: presetSide(b.sell, "sell"),
        };
        await store.prefs.putPreset(c.session.userId, slot, preset.name, { buy: preset.buy, sell: preset.sell }, now());
        return json(preset);
      },
    },

    // settings ------------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/settings",
      auth: "session",
      handler: async (c) => json(withDefaults(await store.prefs.getSettings(c.session.userId))),
    },
    {
      method: "PATCH",
      path: "/api/settings",
      auth: "session",
      handler: async (c) => {
        const body = await c.json();
        const next = mergeSettings(withDefaults(await store.prefs.getSettings(c.session.userId)), body);
        await store.prefs.putSettings(c.session.userId, next, now());
        hooks.settingsChanged?.(c.session.userId, next);
        return json(next);
      },
    },

    // watchlist -----------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/watchlist",
      auth: "session",
      handler: async (c) => json(await store.prefs.listWatchlist(c.session.userId)),
    },
    {
      method: "PUT",
      path: "/api/watchlist/:mint",
      auth: "session",
      handler: async (c) =>
        json(await store.prefs.addWatch(c.session.userId, address(c.params.mint, "mint"), now(), USER_LIMITS.watchlist)),
    },
    {
      method: "DELETE",
      path: "/api/watchlist/:mint",
      auth: "session",
      handler: async (c) => {
        if (!(await store.prefs.removeWatch(c.session.userId, address(c.params.mint, "mint")))) throw notFound("not on the watchlist");
        return ok();
      },
    },

    // blacklists ----------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/blacklists",
      auth: "session",
      handler: async (c) => {
        const out = Object.fromEntries(BLACKLIST_KINDS.map((k) => [k, []])) as unknown as BlacklistsResponse;
        for (const e of await store.prefs.listBlacklists(c.session.userId)) out[e.kind].push(e);
        return json(out);
      },
    },
    {
      method: "PUT",
      path: "/api/blacklists/:kind/:value",
      auth: "session",
      handler: async (c) => {
        const kind = oneOf(c.params.kind, "kind", BLACKLIST_KINDS);
        const value = blacklistValue(kind, c.params.value);
        const b = obj(await c.json(4 * 1024));
        strict(b, ["note"]);
        const note = b.note === undefined ? undefined : str(b.note, "note", { max: 200 });
        return json(await store.prefs.addBlacklist(c.session.userId, kind, value, note, now(), USER_LIMITS.blacklistPerKind));
      },
    },
    {
      method: "DELETE",
      path: "/api/blacklists/:kind/:value",
      auth: "session",
      handler: async (c) => {
        const kind = oneOf(c.params.kind, "kind", BLACKLIST_KINDS);
        if (!(await store.prefs.removeBlacklist(c.session.userId, kind, blacklistValue(kind, c.params.value))))
          throw notFound("not blacklisted");
        return ok();
      },
    },

    // wallet tracker ------------------------------------------------------------------------------
    {
      method: "GET",
      path: "/api/tracked-wallets",
      auth: "session",
      handler: async (c) => json(await store.tracked.list(c.session.userId)),
    },
    {
      method: "POST",
      path: "/api/tracked-wallets",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json());
        strict(b, ["address", "label", "emoji", "tags", "alerts"]);
        const addr = address(b.address, "address");
        const existing = await store.tracked.get(c.session.userId, addr);
        const w: TrackedWalletWrite = {
          address: addr,
          label: b.label === undefined ? (existing?.label ?? "") : label(b.label, "label"),
          emoji: b.emoji === undefined ? (existing?.emoji ?? "") : b.emoji === "" ? "" : emoji(b.emoji, "emoji"),
          tags: b.tags === undefined ? (existing?.tags ?? []) : tags(b.tags),
          alerts: b.alerts === undefined ? (existing?.alerts ?? NO_ALERTS) : trackedAlerts(b.alerts, existing?.alerts ?? NO_ALERTS),
        };
        await store.tracked.upsertMany(c.session.userId, [w], { now: now(), max: USER_LIMITS.trackedWallets, overwriteAlerts: true });
        hooks.trackedChanged?.(c.session.userId);
        return json(await store.tracked.get(c.session.userId, addr));
      },
    },
    {
      method: "PATCH",
      path: "/api/tracked-wallets/:address",
      auth: "session",
      handler: async (c) => {
        const addr = address(c.params.address, "address");
        const b = obj(await c.json());
        strict(b, ["label", "emoji", "tags", "alerts"]);
        const existing = await store.tracked.get(c.session.userId, addr);
        if (!existing) throw notFound("not a tracked wallet");
        const updated = await store.tracked.update(
          c.session.userId,
          addr,
          {
            ...(b.label !== undefined ? { label: label(b.label, "label") } : {}),
            ...(b.emoji !== undefined ? { emoji: b.emoji === "" ? "" : emoji(b.emoji, "emoji") } : {}),
            ...(b.tags !== undefined ? { tags: tags(b.tags) } : {}),
            ...(b.alerts !== undefined ? { alerts: trackedAlerts(b.alerts, existing.alerts) } : {}),
          },
          now(),
        );
        if (!updated) throw notFound("not a tracked wallet");
        hooks.trackedChanged?.(c.session.userId);
        return json(updated);
      },
    },
    {
      method: "DELETE",
      path: "/api/tracked-wallets/:address",
      auth: "session",
      handler: async (c) => {
        if (!(await store.tracked.remove(c.session.userId, address(c.params.address, "address")))) throw notFound("not a tracked wallet");
        hooks.trackedChanged?.(c.session.userId);
        return ok();
      },
    },
    {
      method: "POST",
      path: "/api/tracked-wallets/import",
      auth: "session",
      handler: async (c) => {
        const b = obj(await c.json(IMPORT_BODY_LIMIT));
        strict(b, ["data", "mode"]);
        const mode = b.mode === undefined ? "merge" : oneOf(b.mode, "mode", ["merge", "replace"] as const);
        if (typeof b.data !== "string" && !Array.isArray(b.data))
          throw badRequest("data must be the file contents (string) or a JSON array");
        let parsed: ReturnType<typeof parseWalletList>;
        try {
          parsed = parseWalletList(b.data as string | unknown[], USER_LIMITS.trackedWallets);
        } catch (e) {
          if (e instanceof WalletListError)
            throw new HttpError(
              e.message.includes("limit") ? 422 : 400,
              e.message.includes("limit") ? "limit_exceeded" : "bad_request",
              e.message,
            );
          throw e;
        }
        const rows: TrackedWalletWrite[] = parsed.wallets.map((w) => ({
          address: w.address,
          label: w.label,
          emoji: w.emoji,
          tags: w.tags,
          alerts: w.alertsOn ? { buy: true, sell: true, create: false, minSol: 0 } : NO_ALERTS,
        }));
        const r = await store.tracked.upsertMany(c.session.userId, rows, {
          now: now(),
          max: USER_LIMITS.trackedWallets,
          replace: mode === "replace",
        });
        hooks.trackedChanged?.(c.session.userId);
        const result: TrackedWalletImportResult = { detected: parsed.detected, ...r, skipped: parsed.skipped, errors: parsed.errors };
        return json(result);
      },
    },
    {
      method: "GET",
      path: "/api/tracked-wallets/export",
      auth: "session",
      handler: async (c) => {
        const format = oneOf(c.url.searchParams.get("format") ?? "gmgn", "format", ["gmgn", "bullx", "axiom"] as const) as WalletListFormat;
        const list = exportWalletList(await store.tracked.list(c.session.userId), format);
        return json(list, 200, { "content-disposition": `attachment; filename="tracked-wallets-${format}.json"` });
      },
    },
  ];
}
