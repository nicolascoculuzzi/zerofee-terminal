import { HOTKEY_ACTIONS } from "../../lib/hotkeys";
import { type SettingsTab, useUi } from "../../state/ui";

/**
 * Settings sections (DESIGN.md 5.5): Trading (Presets, Landing, Limits, Blacklists), Hotkeys,
 * Display, Wallets and security, Alerts, Metrics, About.
 *
 * `useUi().settingsTab` names a section (Limits is still "trading" and withdrawal destinations
 * "withdrawals" for older call sites); the drawer keeps its own section state, store tabs map
 * onto sections below, and `openSettingsAt` (palette, cross-links) can also target a row anchor.
 */
export type SectionId =
  | "presets"
  | "landing"
  | "limits"
  | "blacklists"
  | "hotkeys"
  | "display"
  | "security"
  | "alerts"
  | "metrics"
  | "about";

export interface SearchTerm {
  text: string;
  /** Row anchor inside the section (see `anchorId`). */
  anchor?: string;
}

export interface SectionMeta {
  id: SectionId;
  label: string;
  group?: "Trading";
  /** Closest `settingsTab` value, written back so a reopen lands here. */
  tab?: SettingsTab;
  terms: SearchTerm[];
}

const t = (text: string, anchor?: string): SearchTerm => ({ text, anchor });

export const SECTIONS: SectionMeta[] = [
  {
    id: "presets",
    label: "Presets",
    group: "Trading",
    tab: "presets",
    terms: [
      t("P1 P2 P3 preset"),
      t("Slippage", "execution"),
      t("Priority fee", "execution"),
      t("Tip", "execution"),
      t("Cost per trade", "cost"),
      t("Button amounts", "amounts"),
      t("Instant Trade amounts", "amounts"),
      t("Quick-buy amount", "quickbuy"),
    ],
  },
  {
    id: "landing",
    label: "Landing",
    group: "Trading",
    tab: "landing",
    terms: [t("Landing route"), t("Reduced"), t("Secure"), t("Fast"), t("Jito"), t("Helius Sender"), t("MEV"), t("Sandwich")],
  },
  {
    id: "limits",
    label: "Limits",
    group: "Trading",
    tab: "trading",
    terms: [
      t("Per-trade cap", "caps"),
      t("Daily cap", "caps"),
      t("Spent today", "caps"),
      t("Signer firewall", "caps"),
      t("Auto-buy on paste", "paste"),
      t("Clipboard", "paste"),
    ],
  },
  {
    id: "blacklists",
    label: "Blacklists",
    group: "Trading",
    tab: "blacklists",
    terms: [t("Blacklist"), t("Hide token"), t("Dev wallet"), t("Funding wallet"), t("X handle"), t("Import"), t("Export")],
  },
  {
    id: "hotkeys",
    label: "Hotkeys",
    tab: "hotkeys",
    terms: [
      t("Keyboard shortcuts"),
      t("Trade hotkeys", "master"),
      t("Key bindings"),
      ...HOTKEY_ACTIONS.map((a) => t(a.label, `hk-${a.id}`)),
    ],
  },
  {
    id: "display",
    label: "Display",
    tab: "display",
    terms: [
      t("Theme", "theme"),
      t("Dark", "theme"),
      t("Light", "theme"),
      t("Density", "density"),
      t("Compact", "density"),
      t("Comfortable", "density"),
      t("Colour vision", "cvd"),
      t("Color blind", "cvd"),
      t("Blue/orange", "cvd"),
      t("Quote currency", "quote"),
      t("USD / SOL", "quote"),
      t("Pulse insert mode", "insert"),
      t("Refresh rate", "insert"),
      t("Toast position", "toasts"),
      t("Risk thresholds", "risk"),
      t("Sound volume", "sound"),
      t("Confirm trades on touch devices", "touch"),
    ],
  },
  {
    id: "security",
    label: "Wallets and security",
    tab: "security",
    terms: [
      t("Trading wallets", "wallets"),
      t("Export key", "wallets"),
      t("Private key", "wallets"),
      t("Default mode", "signing"),
      t("Instant / Direct", "signing"),
      t("Lock keystore", "keystore"),
      t("Auto-lock", "keystore"),
      t("Passkey", "keystore"),
      t("Passphrase", "keystore"),
      t("Withdrawal destinations", "withdrawals"),
      t("Nonce slots", "nonce"),
      t("Reclaim rent", "nonce"),
      t("Sessions", "sessions"),
      t("Sign out", "sessions"),
      t("Panic", "danger"),
      t("Remove trading wallet", "danger"),
    ],
  },
  {
    id: "alerts",
    label: "Alerts",
    tab: "alerts",
    terms: [
      t("Notifications"),
      t("Web Push", "channels"),
      t("Telegram", "channels"),
      t("Discord", "channels"),
      t("Order filled", "events"),
    ],
  },
  {
    id: "metrics",
    label: "Metrics",
    tab: "metrics",
    terms: [t("Metric definitions"), t("Top 10 holders"), t("Snipers"), t("Insiders"), t("Bundlers"), t("Methodology")],
  },
  {
    id: "about",
    label: "About",
    tab: "about",
    terms: [t("Version"), t("Build"), t("Licences"), t("Licenses"), t("Lightweight Charts"), t("IBM Plex"), t("Platform fee")],
  },
];

export const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s])) as Record<SectionId, SectionMeta>;

export interface SettingsTarget {
  section: SectionId;
  anchor?: string;
}

/** Where each legacy `settingsTab` value lands. */
export const TARGET_FOR_TAB: Record<SettingsTab, SettingsTarget> = {
  presets: { section: "presets" },
  landing: { section: "landing" },
  trading: { section: "limits" },
  blacklists: { section: "blacklists" },
  hotkeys: { section: "hotkeys" },
  display: { section: "display" },
  security: { section: "security" },
  withdrawals: { section: "security", anchor: "withdrawals" },
  alerts: { section: "alerts" },
  metrics: { section: "metrics" },
  about: { section: "about" },
};

export function anchorId(anchor: string): string {
  return `zf-settings-${anchor}`;
}

// A target requested before (or while) the drawer is mounted. The drawer is lazy-loaded and
// only mounted while open, so the request waits here until it takes it.
let pending: SettingsTarget | null = null;
const listeners = new Set<(target: SettingsTarget) => void>();

/** Opens Settings on a section (and optionally scrolls to a row), e.g. from the palette. */
export function openSettingsAt(section: SectionId, anchor?: string): void {
  const target = { section, anchor };
  pending = target;
  for (const l of listeners) l(target);
  useUi.getState().openSettings(SECTION_BY_ID[section].tab);
}

/** Takes the pending target, if any (the drawer calls this when it mounts). */
export function takePendingTarget(): SettingsTarget | null {
  const p = pending;
  pending = null;
  return p;
}

/** The mounted drawer listens so it can follow `openSettingsAt` calls while open. */
export function onSettingsTarget(listener: (target: SettingsTarget) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface SearchHit {
  section: SectionMeta;
  /** The matched term when the label itself didn't match. */
  term?: SearchTerm;
}

/** Nav search: sections whose label matches, then sections with a matching row term. */
export function searchSettings(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const s of SECTIONS) {
    if (s.label.toLowerCase().includes(q) || s.group?.toLowerCase().includes(q)) {
      hits.push({ section: s });
      continue;
    }
    const term = s.terms.find((x) => x.text.toLowerCase().includes(q));
    if (term) hits.push({ section: s, term });
  }
  return hits;
}
