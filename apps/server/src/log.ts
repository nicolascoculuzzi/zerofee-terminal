/** Minimal leveled logger (one line per entry, ISO timestamp). Never pass secrets to it. */

export type LogLevel = "debug" | "info" | "warn" | "error";
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = RANK.info;

export function setLogLevel(level: LogLevel): void {
  threshold = RANK[level];
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  } catch {
    return String(v);
  }
}

function emit(level: LogLevel, scope: string, msg: string, extra: unknown[]): void {
  if (RANK[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${extra.length ? ` ${extra.map(fmt).join(" ")}` : ""}`;
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, ...e) => emit("debug", scope, m, e),
    info: (m, ...e) => emit("info", scope, m, e),
    warn: (m, ...e) => emit("warn", scope, m, e),
    error: (m, ...e) => emit("error", scope, m, e),
  };
}
