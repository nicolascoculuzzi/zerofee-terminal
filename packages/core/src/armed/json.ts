/**
 * JSON codec for armed orders (browser -> POST /api/armed, Postgres jsonb, WebSocket pushes).
 * bigint values are tagged as `{"$bigint":"123"}` so they round-trip exactly and can never be
 * confused with strings (addresses, signatures, base64).
 */
import type { ArmedOrder } from "./model";

const TAG = "$bigint";

export function armedJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [TAG]: value.toString() } : value;
}

export function armedJsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    const raw = (value as Record<string, unknown>)[TAG];
    if (keys.length === 1 && typeof raw === "string" && /^-?\d+$/.test(raw)) return BigInt(raw);
  }
  return value;
}

export function armedOrderToJson(order: ArmedOrder): string {
  return JSON.stringify(order, armedJsonReplacer);
}

export function armedOrderFromJson(json: string): ArmedOrder {
  const o = JSON.parse(json, armedJsonReviver) as ArmedOrder;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || !Array.isArray(o.attempts)) throw new Error("not an armed order");
  return o;
}
