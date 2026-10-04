import { create } from "zustand";
import type { PulseColumnId, TokenSummary } from "../../protocol";
import { useUi } from "../../state/ui";

/**
 * Pulse page state that isn't a persisted setting: which column the keyboard acts on, the card
 * under the pointer, manual pauses, per-column sort, and which overlay is open. Columns also
 * register an imperative handle so page-level hotkeys can move their cursor.
 */

export type SortKey = "default" | "mc" | "volume" | "holders" | "txns";

export const SORT_KEYS: SortKey[] = ["default", "mc", "volume", "holders", "txns"];

/** Label of each column's own order (the "default" sort). */
export const DEFAULT_SORT_LABEL: Record<PulseColumnId, string> = {
  new: "Newest first",
  final: "Bonding progress",
  migrated: "Newest migration",
};

export const SORT_LABEL: Record<Exclude<SortKey, "default">, string> = {
  mc: "Market cap",
  volume: "Volume",
  holders: "Holders",
  txns: "Txns",
};

const SORT_STORAGE = "zerofee.pulse.sort";

function loadSort(): Record<PulseColumnId, SortKey> {
  const fallback: Record<PulseColumnId, SortKey> = { new: "default", final: "default", migrated: "default" };
  try {
    const raw = localStorage.getItem(SORT_STORAGE);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<PulseColumnId, string>>;
    const pick = (v: string | undefined): SortKey => (SORT_KEYS.includes(v as SortKey) ? (v as SortKey) : "default");
    return { new: pick(parsed.new), final: pick(parsed.final), migrated: pick(parsed.migrated) };
  } catch {
    return fallback;
  }
}

function saveSort(sort: Record<PulseColumnId, SortKey>): void {
  try {
    localStorage.setItem(SORT_STORAGE, JSON.stringify(sort));
  } catch {
    // Storage unavailable (private mode): the sort lasts for this visit only.
  }
}

export interface PulseTarget {
  mint: string;
  column: PulseColumnId;
}

/** Per-card menu: anchored to the card's "more" button, or at the pointer for a right-click. */
export interface MenuTarget extends PulseTarget {
  x?: number;
  y?: number;
}

interface PulseUiState {
  /** Columns in screen order, for 1/2/3 and H/L (set by the page per breakpoint). */
  order: PulseColumnId[];
  /** Column that keyboard actions target: last focused, hovered or picked with 1/2/3. */
  activeColumn: PulseColumnId | null;
  /** Card under the pointer (trade-hotkey target). */
  hover: PulseTarget | null;
  /** Manual pause per column (P) and for every column (Shift+P). */
  paused: Record<PulseColumnId, boolean>;
  pausedAll: boolean;
  sort: Record<PulseColumnId, SortKey>;
  /** 768–1023 px: the column shown in the second slot. */
  tabletColumn: PulseColumnId | null;
  /** Below 768 px: the column shown. */
  mobileColumn: PulseColumnId;
  /** Overlays. */
  filterColumn: PulseColumnId | null;
  blacklistOpen: boolean;
  menu: MenuTarget | null;
  confirmDev: string | null;
  review: PulseTarget | null;

  setOrder(order: PulseColumnId[]): void;
  setActiveColumn(column: PulseColumnId | null): void;
  setHover(target: PulseTarget | null): void;
  togglePause(column: PulseColumnId): void;
  togglePauseAll(): void;
  setSort(column: PulseColumnId, sort: SortKey): void;
  setTabletColumn(column: PulseColumnId): void;
  setMobileColumn(column: PulseColumnId): void;
  openFilters(column: PulseColumnId | null): void;
  openBlacklist(open: boolean): void;
  openMenu(target: MenuTarget | null): void;
  askBlacklistDev(mint: string | null): void;
  openReview(target: PulseTarget | null): void;
}

export const usePulseUi = create<PulseUiState>()((set, get) => ({
  order: ["new", "final", "migrated"],
  activeColumn: null,
  hover: null,
  paused: { new: false, final: false, migrated: false },
  pausedAll: false,
  sort: loadSort(),
  tabletColumn: null,
  mobileColumn: "new",
  filterColumn: null,
  blacklistOpen: false,
  menu: null,
  confirmDev: null,
  review: null,

  setOrder: (order) => {
    const prev = get().order;
    if (prev.length === order.length && prev.every((c, i) => c === order[i])) return;
    set({ order });
  },
  setActiveColumn: (column) => {
    if (get().activeColumn !== column) set({ activeColumn: column });
  },
  setHover: (target) => {
    const prev = get().hover;
    if (prev?.mint === target?.mint && prev?.column === target?.column) return;
    set({ hover: target });
    // The Instant Trade window and other shared code read the hovered card from the UI store.
    useUi.getState().setHoverMint(target?.mint ?? null);
  },
  togglePause: (column) => set((s) => ({ paused: { ...s.paused, [column]: !s.paused[column] } })),
  togglePauseAll: () =>
    set((s) => (s.pausedAll ? { pausedAll: false, paused: { new: false, final: false, migrated: false } } : { pausedAll: true })),
  setSort: (column, sort) => {
    const next = { ...get().sort, [column]: sort };
    saveSort(next);
    set({ sort: next });
  },
  setTabletColumn: (column) => set({ tabletColumn: column }),
  setMobileColumn: (column) => set({ mobileColumn: column }),
  openFilters: (column) => set({ filterColumn: column }),
  openBlacklist: (open) => set({ blacklistOpen: open }),
  openMenu: (target) => set({ menu: target }),
  askBlacklistDev: (mint) => set({ confirmDev: mint }),
  openReview: (target) => set({ review: target }),
}));

/** Element the per-card menu anchors to (the card's "more" button or the card itself). */
export const menuAnchor: { current: HTMLElement | null } = { current: null };

// ---------------------------------------------------------------------------
// Column handles: page-level hotkeys reach into the focused column through these.
// ---------------------------------------------------------------------------

export interface ColumnHandle {
  /** Focuses the column's card grid (which pauses it), with the cursor on row `at` or the current row. */
  focus(at?: number): void;
  /** Moves the keyboard cursor by a delta, or to the first / last card. */
  move(to: number | "first" | "last"): void;
  /** Mint under the keyboard cursor, if any. */
  cursor(): string | null;
  /** Row of the keyboard cursor, -1 without one. */
  cursorIndex(): number;
  /** Opens the column's search input. */
  openSearch(): void;
}

const handles = new Map<PulseColumnId, ColumnHandle>();

export function registerColumn(column: PulseColumnId, handle: ColumnHandle): () => void {
  handles.set(column, handle);
  return () => {
    if (handles.get(column) === handle) handles.delete(column);
  };
}

export function columnHandle(column: PulseColumnId | null | undefined): ColumnHandle | undefined {
  return column ? handles.get(column) : undefined;
}

/**
 * Trade-hotkey target (DESIGN.md 6.4): the hovered card if the pointer is over one, otherwise
 * the keyboard-cursor card of the active column. Null when neither exists: nothing is bought.
 */
export function pulseTarget(): PulseTarget | null {
  const s = usePulseUi.getState();
  if (s.hover) return s.hover;
  const column = s.activeColumn;
  const mint = columnHandle(column)?.cursor() ?? null;
  return column && mint ? { mint, column } : null;
}

// ---------------------------------------------------------------------------
// Last-seen summaries: a frozen column keeps showing a card whose token already left the feed.
// ---------------------------------------------------------------------------

const lastSeen = new Map<string, TokenSummary>();
const LAST_SEEN_MAX = 600;

export function rememberToken(t: TokenSummary): void {
  if (lastSeen.get(t.mint) === t) return;
  lastSeen.delete(t.mint);
  lastSeen.set(t.mint, t);
  if (lastSeen.size > LAST_SEEN_MAX) {
    const oldest = lastSeen.keys().next().value;
    if (oldest !== undefined) lastSeen.delete(oldest);
  }
}

export function seenToken(mint: string): TokenSummary | undefined {
  return lastSeen.get(mint);
}
