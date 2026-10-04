import { create } from "zustand";
import type { ApprovalRequest } from "../services/walletService";
import type { PresetId } from "./settings";

export type SettingsTab =
  | "presets"
  | "landing"
  | "hotkeys"
  | "display"
  | "trading"
  | "security"
  | "withdrawals"
  | "blacklists"
  | "alerts"
  | "metrics"
  | "about";

export type FundTab = "fund" | "deposit" | "withdraw";

/** A buy waiting on the 3 s countdown confirm (DESIGN.md 1.7, 4.17). */
export interface RiskConfirmRequest {
  symbol: string;
  /** Names the action in the title: "Buy WIF · 0.50 SOL". */
  actionLabel: string;
  reasons: string[];
}

/** A buy waiting on the touch review sheet (DESIGN.md 5.8 "Confirm on touch"). */
export interface TradeReviewRequest {
  symbol: string;
  sol: number;
  /** Preset whose execution settings the buy uses. */
  preset: PresetId;
}

export interface UiState {
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  fundOpen: boolean;
  fundTab: FundTab;
  /** Trading wallet the fund dialog acts on; null = the active wallet. */
  fundAddress: string | null;
  hotkeysHelpOpen: boolean;
  /** Global Panic confirm (hold-to-confirm). */
  panicOpen: boolean;
  unlock: { open: boolean; reason: string; onUnlocked: (() => void) | null };
  approval: { request: ApprovalRequest; resolve: (ok: boolean) => void } | null;
  riskConfirm: { request: RiskConfirmRequest; resolve: (ok: boolean) => void } | null;
  tradeReview: { request: TradeReviewRequest; resolve: (ok: boolean) => void } | null;
  /** Token under the cursor on Pulse (target for Space+1..4 buys). */
  hoverMint: string | null;
  /** Token page currently open, or the last one viewed (Instant Trade target). */
  focusedMint: string | null;
  mobileTradeOpen: boolean;

  openSearch(open?: boolean): void;
  openSettings(tab?: SettingsTab): void;
  closeSettings(): void;
  /** Opens Fund on a tab, for `address` (another trading wallet) or the active one. */
  openFund(tab?: FundTab, address?: string | null): void;
  closeFund(): void;
  setHotkeysHelp(open: boolean): void;
  openPanic(): void;
  closePanic(): void;
  requestUnlock(reason: string, onUnlocked?: () => void): void;
  closeUnlock(): void;
  setApproval(approval: UiState["approval"]): void;
  setRiskConfirm(riskConfirm: UiState["riskConfirm"]): void;
  setTradeReview(tradeReview: UiState["tradeReview"]): void;
  setHoverMint(mint: string | null): void;
  setFocusedMint(mint: string | null): void;
  setMobileTradeOpen(open: boolean): void;
  /** Closes the top-most overlay; returns false when nothing was open. */
  closeTop(): boolean;
}

export const useUi = create<UiState>()((set, get) => ({
  searchOpen: false,
  settingsOpen: false,
  settingsTab: "presets",
  fundOpen: false,
  fundTab: "fund",
  fundAddress: null,
  hotkeysHelpOpen: false,
  panicOpen: false,
  unlock: { open: false, reason: "", onUnlocked: null },
  approval: null,
  riskConfirm: null,
  tradeReview: null,
  hoverMint: null,
  focusedMint: null,
  mobileTradeOpen: false,

  openSearch: (open = true) => set({ searchOpen: open }),
  openSettings: (tab) => set((s) => ({ settingsOpen: true, settingsTab: tab ?? s.settingsTab })),
  closeSettings: () => set({ settingsOpen: false }),
  openFund: (tab = "fund", address = null) => set({ fundOpen: true, fundTab: tab, fundAddress: address }),
  closeFund: () => set({ fundOpen: false }),
  setHotkeysHelp: (open) => set({ hotkeysHelpOpen: open }),
  openPanic: () => set({ panicOpen: true }),
  closePanic: () => set({ panicOpen: false }),
  requestUnlock: (reason, onUnlocked) => set({ unlock: { open: true, reason, onUnlocked: onUnlocked ?? null } }),
  closeUnlock: () => set({ unlock: { open: false, reason: "", onUnlocked: null } }),
  setApproval: (approval) => set({ approval }),
  setRiskConfirm: (riskConfirm) => set({ riskConfirm }),
  setTradeReview: (tradeReview) => set({ tradeReview }),
  setHoverMint: (mint) => {
    if (get().hoverMint !== mint) set({ hoverMint: mint });
  },
  setFocusedMint: (mint) => set({ focusedMint: mint }),
  setMobileTradeOpen: (open) => set({ mobileTradeOpen: open }),
  closeTop: () => {
    const s = get();
    if (s.riskConfirm) {
      s.riskConfirm.resolve(false);
      set({ riskConfirm: null });
      return true;
    }
    if (s.tradeReview) {
      s.tradeReview.resolve(false);
      set({ tradeReview: null });
      return true;
    }
    if (s.approval) {
      s.approval.resolve(false);
      set({ approval: null });
      return true;
    }
    if (s.unlock.open) {
      set({ unlock: { open: false, reason: "", onUnlocked: null } });
      return true;
    }
    if (s.searchOpen) {
      set({ searchOpen: false });
      return true;
    }
    if (s.hotkeysHelpOpen) {
      set({ hotkeysHelpOpen: false });
      return true;
    }
    if (s.fundOpen) {
      set({ fundOpen: false });
      return true;
    }
    if (s.settingsOpen) {
      set({ settingsOpen: false });
      return true;
    }
    if (s.mobileTradeOpen) {
      set({ mobileTradeOpen: false });
      return true;
    }
    return false;
  },
}));
