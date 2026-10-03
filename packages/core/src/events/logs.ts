/**
 * `Program data: <base64>` log lines, attributed to the program that emitted them.
 *
 * Anchor's `emit!` logs an event as `Program data:`; the line belongs to whichever program is on top of
 * the invoke stack. Generic event names share discriminators across programs, so attribution is
 * mandatory before decoding: we track `Program <id> invoke [n]` / `success` / `failed` lines.
 * Logs are lossy (RPCs truncate them past ~10 KB: "Log truncated"); prefer event-CPI inner instructions
 * when the full transaction is available (see ./tx.ts).
 */
import { type Address, getBase64Encoder } from "@solana/kit";
import { decodeEventPayload, isEventProgram } from "./decode";
import { type DecodedEvent, EventDecodeError } from "./types";

export interface ProgramDataLine {
  /** Emitting program (top of the invoke stack), or null when the logs carry no invoke context. */
  program: Address | null;
  /** Invoke depth of the emitting program (1 = top-level instruction), 0 when unknown. */
  depth: number;
  /** Decoded bytes of the first base64 segment; null if it was not valid base64. */
  data: Uint8Array | null;
  lineIndex: number;
}

export interface ParsedProgramData {
  lines: ProgramDataLine[];
  /** The RPC cut the log list short ("Log truncated"); events after the cut are lost. */
  truncated: boolean;
}

const b64 = getBase64Encoder();
const INVOKE_RE = /^Program (\w{32,44}) invoke \[(\d+)\]$/;
const EXIT_RE = /^Program (\w{32,44}) (?:success|failed)/;
const DATA_PREFIX = "Program data: ";

export function parseProgramDataLogs(logs: readonly string[]): ParsedProgramData {
  const stack: Address[] = [];
  const lines: ProgramDataLine[] = [];
  let truncated = false;
  for (let i = 0; i < logs.length; i++) {
    const line = logs[i] as string;
    if (line.startsWith(DATA_PREFIX)) {
      const seg = line.slice(DATA_PREFIX.length).split(" ", 1)[0] ?? "";
      let data: Uint8Array | null;
      try {
        data = b64.encode(seg) as Uint8Array;
      } catch {
        data = null;
      }
      lines.push({ program: stack.length ? (stack[stack.length - 1] as Address) : null, depth: stack.length, data, lineIndex: i });
      continue;
    }
    if (!line.startsWith("Program ")) {
      if (line === "Log truncated") {
        truncated = true;
        break;
      }
      continue;
    }
    const inv = INVOKE_RE.exec(line);
    if (inv) {
      // Trust the depth marker over our own bookkeeping (robust to missing exit lines).
      stack.length = Math.max(0, Number(inv[2]) - 1);
      stack.push(inv[1] as Address);
      continue;
    }
    if (EXIT_RE.test(line)) stack.pop();
  }
  return { lines, truncated };
}

export interface LogEventsResult {
  events: DecodedEvent[];
  /** pump/PumpSwap-attributed lines that failed: known discriminator with a malformed body, or bad base64. */
  failures: number;
  failureMessages: string[];
  truncated: boolean;
  /** `Program data:` lines from other programs (ignored). */
  foreign: number;
}

/**
 * Decodes every pump / PumpSwap event in a transaction's logs, attributed by invoke stack. Lines with no
 * invoke context (partial log excerpts) are matched on the discriminator alone.
 */
export function decodeLogEvents(logs: readonly string[]): LogEventsResult {
  const parsed = parseProgramDataLogs(logs);
  const events: DecodedEvent[] = [];
  const failureMessages: string[] = [];
  let foreign = 0;
  for (const l of parsed.lines) {
    if (l.program !== null && !isEventProgram(l.program)) {
      foreign++;
      continue;
    }
    if (!l.data) {
      failureMessages.push(`bad base64 on log line ${l.lineIndex}`);
      continue;
    }
    try {
      const ev = decodeEventPayload(l.data, l.program);
      if (ev) events.push(ev);
    } catch (e) {
      if (!(e instanceof EventDecodeError)) throw e;
      failureMessages.push(e.message);
    }
  }
  return { events, failures: failureMessages.length, failureMessages, truncated: parsed.truncated, foreign };
}

/** Extracts and decodes every known event from `Program data: <base64>` log lines (malformed ones are skipped). */
export function decodeEventsFromLogs(logs: readonly string[]): DecodedEvent[] {
  return decodeLogEvents(logs).events;
}
