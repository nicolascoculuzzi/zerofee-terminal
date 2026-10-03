/**
 * Wallet-tracker list formats, so users can move their lists from other terminals and back.
 *
 *   GMGN   [{ "address": "...", "name": "...", "emoji": "..." }]            https://docs.gmgn.ai/index/wallets-import-export
 *   BullX  [{ "name": "...", "address": "...", "emoji": "...", "tags": [] }] (BullX Neo wallet tracker export, e.g.
 *          https://github.com/3rror404/bullx-wallet-tracker-wallets/blob/main/wallets.json)
 *   Axiom  [{ "trackedWalletAddress": "...", "name": "...", "emoji": "...", "alertsOn": false }]
 *          (Axiom Wallet Manager export / import)
 *
 * Import also accepts a JSON array of address strings and plain text, one wallet per line:
 * `<address> [emoji] [name...]`, separated by spaces, tabs or commas; blank lines and lines starting
 * with # or // are ignored. Imports are lenient (labels are cleaned and truncated, broken entries are
 * reported and skipped); the import as a whole fails only when nothing is usable.
 */
import { isAddress } from "@solana/kit";
import type { TrackedWallet, WalletListFormat } from "@zerofee/protocol";
import { hasControlChars } from "./validate";

export interface ParsedWallet {
  address: string;
  label: string;
  emoji: string;
  tags: string[];
  /** Axiom's alertsOn: new wallets get buy + sell alerts. */
  alertsOn: boolean;
}

export type DetectedFormat = WalletListFormat | "addresses" | "text";

export interface WalletListParse {
  detected: DetectedFormat;
  wallets: ParsedWallet[];
  /** Duplicate addresses and unusable entries. */
  skipped: number;
  /** First 20 problems. */
  errors: { entry: number; error: string }[];
}

export class WalletListError extends Error {}

const MAX_ERRORS = 20;
const MAX_TAGS = 8;

/** Lenient cleanup for imported text: drop control / bidi characters, collapse whitespace, truncate. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  let out = "";
  for (const ch of v) out += hasControlChars(ch) ? " " : ch;
  out = out.replace(/\s+/g, " ").trim();
  return [...out].slice(0, max).join("");
}

function cleanEmoji(v: unknown): string {
  const s = cleanText(v, 16);
  return s && !/\s/.test(s) && s.length <= 16 ? s : "";
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    const s = cleanText(t, 32);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

const validAddress = (s: unknown): s is string => typeof s === "string" && s.length >= 32 && s.length <= 44 && isAddress(s);

/** An emoji-ish token: short, no ASCII letters or digits, at least one non-ASCII character. */
const looksLikeEmoji = (s: string): boolean =>
  s.length <= 16 && !/[A-Za-z0-9]/.test(s) && [...s].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f);

function fromObject(o: Record<string, unknown>): ParsedWallet | string {
  const address = o.trackedWalletAddress ?? o.address ?? o.walletAddress ?? o.wallet;
  if (!validAddress(address)) return "missing or invalid address";
  return {
    address,
    label: cleanText(o.name ?? o.label ?? o.remark ?? o.note, 64),
    emoji: cleanEmoji(o.emoji),
    tags: cleanTags(o.tags),
    alertsOn: o.alertsOn === true,
  };
}

function fromLine(line: string): ParsedWallet | string {
  const tokens = line.split(/[\s,;]+/).filter(Boolean);
  const i = tokens.findIndex(validAddress);
  if (i < 0) return "no valid address on this line";
  const rest = tokens.filter((_, j) => j !== i);
  let emoji = "";
  if (rest[0] && looksLikeEmoji(rest[0])) emoji = cleanEmoji(rest.shift());
  return { address: tokens[i] as string, label: cleanText(rest.join(" "), 64), emoji, tags: [], alertsOn: false };
}

function detectJson(items: unknown[]): DetectedFormat {
  if (items.every((x) => typeof x === "string")) return "addresses";
  const objs = items.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
  if (objs.some((o) => "trackedWalletAddress" in o)) return "axiom";
  if (objs.some((o) => "tags" in o)) return "bullx";
  return "gmgn";
}

/** Parses an import (file text or parsed JSON) of at most `maxWallets` distinct wallets. */
export function parseWalletList(data: string | unknown[], maxWallets: number): WalletListParse {
  let items: unknown[] | null = null;
  let lines: string[] | null = null;
  if (Array.isArray(data)) items = data;
  else if (typeof data === "string") {
    const text = data.replace(/^﻿/, "").trim();
    if (!text) throw new WalletListError("the import is empty");
    if (text.startsWith("[") || text.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new WalletListError("the import looks like JSON but does not parse");
      }
      if (Array.isArray(parsed)) items = parsed;
      else if (parsed && typeof parsed === "object") {
        const inner = Object.values(parsed).find(Array.isArray);
        if (inner) items = inner;
      }
      if (!items) throw new WalletListError("expected a JSON array of wallets");
    } else lines = text.split(/\r?\n/);
  } else throw new WalletListError("data must be a string or an array");

  const out: ParsedWallet[] = [];
  const seen = new Set<string>();
  const errors: { entry: number; error: string }[] = [];
  let skipped = 0;
  const take = (entry: number, r: ParsedWallet | string) => {
    if (typeof r === "string") {
      skipped++;
      if (errors.length < MAX_ERRORS) errors.push({ entry, error: r });
      return;
    }
    if (seen.has(r.address)) {
      skipped++;
      return;
    }
    seen.add(r.address);
    out.push(r);
  };

  let detected: DetectedFormat;
  if (items) {
    detected = detectJson(items);
    items.forEach((x, i) => {
      if (typeof x === "string")
        take(i + 1, validAddress(x.trim()) ? { address: x.trim(), label: "", emoji: "", tags: [], alertsOn: false } : "invalid address");
      else if (x && typeof x === "object" && !Array.isArray(x)) take(i + 1, fromObject(x as Record<string, unknown>));
      else take(i + 1, "expected a wallet object or address string");
    });
  } else {
    detected = "text";
    (lines ?? []).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) return;
      take(i + 1, fromLine(line));
    });
  }
  if (out.length > maxWallets) throw new WalletListError(`the import holds ${out.length} wallets; the limit is ${maxWallets}`);
  if (!out.length)
    throw new WalletListError(
      errors[0] ? `no usable wallets (first problem, entry ${errors[0].entry}: ${errors[0].error})` : "no wallets found",
    );
  return { detected, wallets: out, skipped, errors };
}

/** The list in another terminal's import format. */
export function exportWalletList(wallets: TrackedWallet[], format: WalletListFormat): Record<string, unknown>[] {
  switch (format) {
    case "gmgn":
      return wallets.map((w) => ({ address: w.address, name: w.label, emoji: w.emoji }));
    case "bullx":
      return wallets.map((w) => ({ name: w.label, address: w.address, emoji: w.emoji, tags: w.tags }));
    case "axiom":
      return wallets.map((w) => ({
        trackedWalletAddress: w.address,
        name: w.label,
        emoji: w.emoji,
        alertsOn: w.alerts.buy || w.alerts.sell || w.alerts.create,
      }));
  }
}
