/**
 * Input validation for the REST API: small, explicit checks that throw ValidationError (HTTP 400)
 * with the offending field's name. Objects are strict: unknown keys are rejected so client typos
 * surface instead of being silently dropped.
 */
import { isAddress } from "@solana/kit";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const fail = (msg: string): never => {
  throw new ValidationError(msg);
};

/**
 * True if `s` holds C0/C1 control characters, DEL, or the bidi embedding / override / isolate
 * characters (U+202A-U+202E, U+2066-U+2069) used to make text render differently than it reads.
 */
export function hasControlChars(s: string, allowNewline = false): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (allowNewline && c === 0x0a) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

export function obj(v: unknown, name = "body"): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${name} must be an object`);
  return v as Record<string, unknown>;
}

/** Rejects keys outside `allowed`. */
export function strict(o: Record<string, unknown>, allowed: readonly string[], name = "body"): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${name}: unknown field ${JSON.stringify(k)}`);
}

export interface StrOpts {
  min?: number;
  max: number;
  pattern?: RegExp;
  /** Allow line breaks (still no other control characters). */
  multiline?: boolean;
}

export function str(v: unknown, name: string, o: StrOpts): string {
  if (typeof v !== "string") fail(`${name} must be a string`);
  const s = (v as string).trim();
  if (s.length < (o.min ?? 0)) fail(`${name} must be at least ${o.min} characters`);
  if (s.length > o.max) fail(`${name} must be at most ${o.max} characters`);
  if (hasControlChars(s, o.multiline === true)) fail(`${name} contains control characters`);
  if (o.pattern && !o.pattern.test(s)) fail(`${name} has an invalid format`);
  return s;
}

export function num(v: unknown, name: string, o: { min: number; max: number; int?: boolean }): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${name} must be a number`);
  const n = v as number;
  if (o.int && !Number.isInteger(n)) fail(`${name} must be an integer`);
  if (n < o.min || n > o.max) fail(`${name} must be between ${o.min} and ${o.max}`);
  return n;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") fail(`${name} must be true or false`);
  return v as boolean;
}

export function oneOf<T extends string | number>(v: unknown, name: string, values: readonly T[]): T {
  if (!values.includes(v as T)) fail(`${name} must be one of ${values.join(", ")}`);
  return v as T;
}

export function arr(v: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(`${name} must be an array`);
  if ((v as unknown[]).length > max) fail(`${name} may hold at most ${max} items`);
  return v as unknown[];
}

/** A base58 Solana address (32 bytes). */
export function address(v: unknown, name: string): string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44 || !isAddress(v)) fail(`${name} must be a base58 Solana address`);
  return v as string;
}

/** Display label: trimmed, no control characters. */
export function label(v: unknown, name: string, max = 64): string {
  return str(v, name, { max });
}

/** One emoji or short symbol (a few code points: flags, skin tones and ZWJ sequences need several). */
export function emoji(v: unknown, name: string): string {
  const s = str(v, name, { max: 16 });
  if (/\s/.test(s)) fail(`${name} must not contain spaces`);
  return s;
}

/** X handle: 1-15 of A-Z a-z 0-9 _, optional leading @; stored lowercase without @. */
export function xHandle(v: unknown, name: string): string {
  const s = str(v, name, { min: 1, max: 16 });
  const h = s.startsWith("@") ? s.slice(1) : s;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) fail(`${name} must be an X handle`);
  return h.toLowerCase();
}

export function uuid(v: unknown, name: string): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) fail(`${name} must be an id`);
  return (v as string).toLowerCase();
}
