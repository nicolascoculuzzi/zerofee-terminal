/**
 * Every buy, sell and order in the UI goes through here: firewall-style cap checks, the
 * lock/approval gate for the current mode, the optimistic pending trade, progress, toasts
 * and the latency record. Components never call TradeService directly.
 */
import type { Order, OrderSize, OrderTrigger } from "../protocol";
import { getServices } from "../services";
import type { ExecutionSettings, TpSlLeg, TradeReceipt, TradeSource } from "../services/tradeService";
import { useMarket } from "../state/market";
import { type PresetId, useSettings } from "../state/settings";
import { useToasts } from "../state/toasts";
import { useToken } from "../state/token";
import { type ClientTrade, useTrades } from "../state/trades";
import { useUi } from "../state/ui";
import { useWallet } from "../state/wallet";
import { uid } from "./cn";
import { fmtSol } from "./format";
import { navigateTo } from "./nav";
import { playTone } from "./sound";

const NETWORK_FEE_SOL = 0.000005;

function tokenInfo(mint: string): { symbol: string; priceSol: number } {
  const t = useMarket.getState().tokens[mint];
  if (t) return { symbol: t.symbol, priceSol: t.priceSol };
  const detail = useToken.getState().detail;
  if (detail && detail.summary.mint === mint) return { symbol: detail.summary.symbol, priceSol: detail.summary.priceSol };
  return { symbol: "TOKEN", priceSol: 0 };
}

function blocked(title: string, body: string, action?: { label: string; run: () => void }): void {
  playTone("fail", useSettings.getState().display.soundVolume);
  useToasts.getState().push({ kind: "error", title, body, ttl: 7000, action });
}

/** Instant mode needs an unlocked keystore; resolves true when trading can proceed now. */
function ensureUnlocked(reason: string, retry: () => void): boolean {
  const { mode, service } = useWallet.getState();
  if (mode === "direct") return true;
  if (!service.locked) return true;
  useUi.getState().requestUnlock(reason, retry);
  return false;
}

function resolveWallets(explicit?: string[]): string[] {
  const { activeAddress, service } = useWallet.getState();
  const live = new Set(service.tradingWallets.filter((w) => !w.archived).map((w) => w.address));
  const list = (explicit && explicit.length > 0 ? explicit : activeAddress ? [activeAddress] : []).filter((a) => live.has(a));
  return list;
}

async function approveDirect(title: string, lines: { label: string; value: string }[]): Promise<boolean> {
  if (useWallet.getState().mode !== "direct") return true;
  const ok = await getServices().wallet.approveWithConnected({ title, lines });
  if (!ok) useToasts.getState().push({ kind: "warn", title: "Rejected in wallet", body: title });
  return ok;
}

function costLines(settings: ExecutionSettings): { label: string; value: string }[] {
  return [
    { label: "Slippage", value: `${settings.slippagePct}%` },
    { label: "Priority fee", value: `${fmtSol(settings.priorityFeeSol)} SOL` },
    { label: "Tip", value: `${fmtSol(settings.tipSol)} SOL` },
    { label: "Landing", value: settings.landing },
  ];
}

function startTrade(t: Omit<ClientTrade, "stage" | "status" | "receipt" | "error">): void {
  useTrades.getState().begin({ ...t, stage: "clicked", status: "pending", receipt: null, error: null });
  useToasts.getState().push({ kind: "info", title: "", tradeId: t.id, ttl: null });
}

function settleToast(tradeId: string): void {
  const toasts = useToasts.getState();
  const toast = toasts.toasts.find((x) => x.tradeId === tradeId);
  if (toast) toasts.update(toast.id, { ttl: 5000 });
}

export interface BuyArgs {
  mint: string;
  sol: number;
  preset?: PresetId | null;
  source: TradeSource;
  wallets?: string[];
}

export async function buy(args: BuyArgs): Promise<TradeReceipt[]> {
  const clickedAt = Date.now();
  const settingsState = useSettings.getState();
  const settings = settingsState.presets[args.preset ?? settingsState.activePreset].buy;
  const { symbol, priceSol } = tokenInfo(args.mint);
  const wallets = resolveWallets(args.wallets);
  if (wallets.length === 0) {
    blocked("No trading wallet", "Create a trading wallet to trade.", { label: "Set up", run: () => navigateTo("/onboarding") });
    return [];
  }
  if (!(args.sol > 0)) {
    blocked("Enter an amount", "Buy amount must be greater than zero.");
    return [];
  }
  const caps = settingsState.caps;
  if (args.sol > caps.perTradeSol) {
    blocked("Blocked by signer firewall", `${fmtSol(args.sol)} SOL is above your per-trade cap of ${fmtSol(caps.perTradeSol)} SOL.`, {
      label: "Caps",
      run: () => useUi.getState().openSettings("trading"),
    });
    return [];
  }
  const spent = useTrades.getState().spentToday();
  const total = args.sol * wallets.length;
  if (spent + total > caps.dailySol) {
    blocked(
      "Blocked by signer firewall",
      `Daily cap ${fmtSol(caps.dailySol)} SOL: ${fmtSol(spent)} used today, this buy needs ${fmtSol(total)}.`,
      { label: "Caps", run: () => useUi.getState().openSettings("trading") },
    );
    return [];
  }
  const status = useWallet.getState().status;
  for (const w of wallets) {
    const st = status[w];
    const need = args.sol + settings.priorityFeeSol + settings.tipSol + NETWORK_FEE_SOL;
    if (st && st.solBalance - st.reservedSol < need) {
      blocked(
        "Insufficient SOL",
        `Need ${fmtSol(need)} SOL; ${fmtSol(Math.max(0, st.solBalance - st.reservedSol))} available (${fmtSol(st.reservedSol)} reserved by armed orders).`,
        { label: "Fund", run: () => useUi.getState().openFund("fund") },
      );
      return [];
    }
  }
  if (!ensureUnlocked(`Unlock to buy $${symbol}`, () => void buy(args))) return [];
  const approved = await approveDirect(`Buy $${symbol} for ${fmtSol(args.sol)} SOL`, costLines(settings));
  if (!approved) return [];

  const { trade, wallet } = getServices();
  wallet.touch();
  const receipts: TradeReceipt[] = [];
  await Promise.all(
    wallets.map(async (address) => {
      const id = uid("trade");
      startTrade({
        id,
        mint: args.mint,
        symbol,
        side: "buy",
        label: `${fmtSol(args.sol)} SOL`,
        wallet: address,
        source: args.source,
        startedAt: clickedAt,
      });
      try {
        const receipt = await trade.buy(
          {
            clientId: id,
            mint: args.mint,
            wallet: address,
            settings,
            mode: useWallet.getState().mode,
            source: args.source,
            clickedAt,
            expectedPriceSol: priceSol,
            solAmount: args.sol,
          },
          (p) => useTrades.getState().progress(id, p.stage),
        );
        useTrades.getState().finish(id, receipt);
        receipts.push(receipt);
        if (receipt.status === "confirmed") {
          useTrades.getState().addSpend(args.sol);
          playTone("fill", useSettings.getState().display.soundVolume);
        } else playTone("fail", useSettings.getState().display.soundVolume);
      } catch (e) {
        useTrades.getState().fail(id, e instanceof Error ? e.message : String(e));
      }
      settleToast(id);
    }),
  );
  return receipts;
}

export interface SellArgs {
  mint: string;
  /** Exactly one of pct / solValue / tokenAmount. */
  pct?: number;
  solValue?: number;
  tokenAmount?: number;
  label?: string;
  preset?: PresetId | null;
  source: TradeSource;
  wallets?: string[];
}

export async function sell(args: SellArgs): Promise<TradeReceipt[]> {
  const clickedAt = Date.now();
  const settingsState = useSettings.getState();
  const settings = settingsState.presets[args.preset ?? settingsState.activePreset].sell;
  const { symbol, priceSol } = tokenInfo(args.mint);
  const wallets = resolveWallets(args.wallets);
  if (wallets.length === 0) {
    blocked("No trading wallet", "Create a trading wallet to trade.");
    return [];
  }
  const status = useWallet.getState().status;
  const plans = wallets
    .map((address) => {
      const pos = status[address]?.positions.find((p) => p.mint === args.mint && p.holdingTokens > 0);
      if (!pos) return null;
      let tokenAmount: number | undefined;
      let pct: number | undefined;
      if (args.pct !== undefined) pct = Math.min(100, Math.max(0, args.pct));
      else if (args.solValue !== undefined) {
        tokenAmount = priceSol > 0 ? Math.min(pos.holdingTokens, args.solValue / priceSol) : undefined;
        if (tokenAmount === undefined) pct = 100;
      } else if (args.tokenAmount !== undefined) tokenAmount = Math.min(pos.holdingTokens, args.tokenAmount);
      else pct = 100;
      return { address, pct, tokenAmount };
    })
    .filter((p): p is { address: string; pct: number | undefined; tokenAmount: number | undefined } => p !== null);
  if (plans.length === 0) {
    blocked("Nothing to sell", `No $${symbol} balance in the selected wallet.`);
    return [];
  }
  if (!ensureUnlocked(`Unlock to sell $${symbol}`, () => void sell(args))) return [];
  const label =
    args.label ?? (args.pct !== undefined ? `${args.pct}%` : args.solValue !== undefined ? `${fmtSol(args.solValue)} SOL` : "amount");
  const approved = await approveDirect(`Sell ${label} of $${symbol}`, costLines(settings));
  if (!approved) return [];

  const { trade, wallet } = getServices();
  wallet.touch();
  const receipts: TradeReceipt[] = [];
  await Promise.all(
    plans.map(async (plan) => {
      const id = uid("trade");
      startTrade({ id, mint: args.mint, symbol, side: "sell", label, wallet: plan.address, source: args.source, startedAt: clickedAt });
      try {
        const receipt = await trade.sell(
          {
            clientId: id,
            mint: args.mint,
            wallet: plan.address,
            settings,
            mode: useWallet.getState().mode,
            source: args.source,
            clickedAt,
            expectedPriceSol: priceSol,
            pct: plan.pct,
            tokenAmount: plan.tokenAmount,
          },
          (p) => useTrades.getState().progress(id, p.stage),
        );
        useTrades.getState().finish(id, receipt);
        receipts.push(receipt);
        playTone(receipt.status === "confirmed" ? "fill" : "fail", useSettings.getState().display.soundVolume);
      } catch (e) {
        useTrades.getState().fail(id, e instanceof Error ? e.message : String(e));
      }
      settleToast(id);
    }),
  );
  return receipts;
}

/** Sells the amount whose current value equals the SOL still to recover (bought − sold). */
export async function sellInitials(mint: string, source: TradeSource, preset?: PresetId | null): Promise<TradeReceipt[]> {
  const { activeAddress, status } = useWallet.getState();
  const pos = activeAddress ? status[activeAddress]?.positions.find((p) => p.mint === mint) : undefined;
  const { symbol, priceSol } = tokenInfo(mint);
  if (!pos || pos.holdingTokens <= 0) {
    blocked("Nothing to sell", `No $${symbol} balance in the active wallet.`);
    return [];
  }
  const remaining = pos.boughtSol - pos.soldSol;
  if (remaining <= 0) {
    useToasts
      .getState()
      .push({ kind: "info", title: "Initials already recovered", body: `You've taken out more than you put into $${symbol}.` });
    return [];
  }
  const tokens = priceSol > 0 ? Math.min(pos.holdingTokens, remaining / priceSol) : pos.holdingTokens;
  return sell({ mint, tokenAmount: tokens, label: `initials (${fmtSol(remaining)} SOL)`, source, preset });
}

// ---------------------------------------------------------------------------
// Armed orders
// ---------------------------------------------------------------------------

function activeWallet(): string | null {
  return useWallet.getState().activeAddress;
}

function orderError(title: string, e: unknown): void {
  blocked(title, e instanceof Error ? e.message : String(e));
}

/** Arming pre-signs durable-nonce transactions in the browser, so it needs the keystore. */
function ensureCanSign(reason: string, retry: () => void): boolean {
  const { service } = useWallet.getState();
  if (!service.locked) return true;
  useUi.getState().requestUnlock(reason, retry);
  return false;
}

export async function placeLimit(args: {
  mint: string;
  side: "buy" | "sell";
  trigger: OrderTrigger;
  size: OrderSize;
  preset?: PresetId | null;
}): Promise<Order | null> {
  const wallet = activeWallet();
  if (!wallet) return null;
  const s = useSettings.getState();
  const settings = s.presets[args.preset ?? s.activePreset][args.side];
  if (args.side === "buy" && args.size.kind === "sol" && args.size.sol > s.caps.perTradeSol) {
    blocked("Blocked by signer firewall", `Order size is above your per-trade cap of ${fmtSol(s.caps.perTradeSol)} SOL.`);
    return null;
  }
  if (!ensureCanSign("Unlock to pre-sign the limit order", () => void placeLimit(args))) return null;
  try {
    const order = await getServices().trade.placeLimit({
      mint: args.mint,
      wallet,
      side: args.side,
      trigger: args.trigger,
      size: args.size,
      settings,
    });
    useToasts.getState().push({
      kind: "success",
      title: `Limit ${args.side} armed · $${order.symbol}`,
      body: "Pre-signed on a durable nonce. Safe to close this tab.",
      action: { label: "Orders", run: () => navigateTo("/orders") },
    });
    return order;
  } catch (e) {
    orderError("Couldn't arm limit order", e);
    return null;
  }
}

export async function armTpSl(args: {
  mint: string;
  entryPriceSol: number;
  legs: TpSlLeg[];
  oco: boolean;
  preset?: PresetId | null;
}): Promise<Order[]> {
  const wallet = activeWallet();
  if (!wallet) return [];
  if (args.legs.length === 0) return [];
  const s = useSettings.getState();
  const settings = s.presets[args.preset ?? s.activePreset].sell;
  if (!ensureCanSign("Unlock to pre-sign the TP/SL ladder", () => void armTpSl(args))) return [];
  try {
    const orders = await getServices().trade.armTpSl({
      mint: args.mint,
      wallet,
      entryPriceSol: args.entryPriceSol,
      legs: args.legs,
      settings,
      oco: args.oco,
    });
    useToasts.getState().push({
      kind: "success",
      title: `${orders.length} exit order${orders.length === 1 ? "" : "s"} armed`,
      body: "TP/SL ladder pre-signed. Safe to close this tab.",
      action: { label: "Orders", run: () => navigateTo("/orders") },
    });
    return orders;
  } catch (e) {
    orderError("Couldn't arm TP/SL", e);
    return [];
  }
}

export async function armMigration(args: {
  mint: string;
  side: "buy" | "sell";
  size: OrderSize;
  preset?: PresetId | null;
}): Promise<Order | null> {
  const wallet = activeWallet();
  if (!wallet) return null;
  const s = useSettings.getState();
  const settings = s.presets[args.preset ?? s.activePreset][args.side];
  if (!ensureCanSign("Unlock to pre-sign the migration order", () => void armMigration(args))) return null;
  try {
    const order = await getServices().trade.armMigration({ mint: args.mint, wallet, side: args.side, size: args.size, settings });
    useToasts
      .getState()
      .push({ kind: "success", title: `Migration ${args.side} armed · $${order.symbol}`, body: "Fires when the coin graduates." });
    return order;
  } catch (e) {
    orderError("Couldn't arm migration order", e);
    return null;
  }
}

export async function cancelOrder(id: string): Promise<void> {
  try {
    await getServices().trade.cancel(id);
  } catch (e) {
    orderError("Couldn't cancel", e);
  }
}

export async function rearmOrder(id: string): Promise<void> {
  if (!ensureCanSign("Unlock to re-sign the order", () => void rearmOrder(id))) return;
  try {
    const order = await getServices().trade.rearm(id);
    useToasts
      .getState()
      .push({ kind: "success", title: `Re-armed · $${order.symbol}`, body: "Fresh pre-signed transactions are with the server." });
  } catch (e) {
    orderError("Couldn't re-arm", e);
  }
}

/** User kill switch: cancel every armed order and lock the keystore. */
export async function panic(): Promise<void> {
  const { trade, wallet } = getServices();
  try {
    const { cancelled } = await trade.panic();
    wallet.lock();
    useToasts.getState().push({
      kind: "warn",
      title: "Panic: all orders cancelled",
      body: `${cancelled} pre-signed cancel${cancelled === 1 ? "" : "s"} fired and the keystore is locked.`,
      ttl: 8000,
    });
  } catch (e) {
    orderError("Panic failed", e);
  }
}
