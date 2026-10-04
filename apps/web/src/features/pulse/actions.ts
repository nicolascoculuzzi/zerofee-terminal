import { create } from "zustand";
import { copyText } from "../../lib/clipboard";
import { shortAddr } from "../../lib/format";
import type { TokenSummary } from "../../protocol";
import { useMarket } from "../../state/market";
import { type BlacklistKind, useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { seenToken } from "./store";

/**
 * Card actions shared by the menu, the hotkeys (C, X, Shift+X) and the card controls. Copying
 * confirms on the card's copy control (icon swap for 1,200 ms, never a toast); hiding confirms
 * by removing the card, with an "Undo" toast (DESIGN.md 6.4).
 */

const COPIED_MS = 1200;

export const useCopied = create<{ mint: string | null }>()(() => ({ mint: null }));
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

export function copyCa(mint: string): void {
  void copyText(mint).then((ok) => {
    if (!ok) return;
    useCopied.setState({ mint });
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => useCopied.setState({ mint: null }), COPIED_MS);
  });
}

export function tokenFor(mint: string): TokenSummary | undefined {
  return useMarket.getState().tokens[mint] ?? seenToken(mint);
}

function blacklist(kind: BlacklistKind, value: string, title: string, note: string): void {
  const s = useSettings.getState();
  if (s.blacklists[kind].some((e) => e.value === value)) return;
  s.addBlacklist(kind, value, note);
  useToasts.getState().push({
    kind: "info",
    title,
    body: "Removed from every Pulse column.",
    action: { label: "Undo", run: () => useSettings.getState().removeBlacklist(kind, value) },
  });
}

export function hideToken(mint: string): void {
  const t = tokenFor(mint);
  const name = t ? t.symbol : shortAddr(mint);
  blacklist("tokens", mint, `${name} hidden`, t ? `${t.symbol} · ${t.name}` : "");
}

export function blacklistDev(mint: string): void {
  const t = tokenFor(mint);
  if (!t) return;
  blacklist("devs", t.creator, `Dev of ${t.symbol} blacklisted`, `Dev of ${t.symbol}`);
}

export function blacklistFunder(mint: string): void {
  const t = tokenFor(mint);
  if (!t?.fundingWallet) return;
  blacklist("fundingWallets", t.fundingWallet, `Funder of ${t.symbol}'s dev blacklisted`, `Funded the dev of ${t.symbol}`);
}

export function blacklistHandle(mint: string): void {
  const t = tokenFor(mint);
  if (!t?.socials.x) return;
  blacklist("xHandles", t.socials.x, `@${t.socials.x} blacklisted`, `Linked by ${t.symbol}`);
}
