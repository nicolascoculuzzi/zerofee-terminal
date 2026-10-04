/**
 * Shared configuration for the local mainnet-fork harness (dev tooling; never imported by src/).
 * The fork is a solana-test-validator bound to 127.0.0.1 whose accounts were cloned READ-ONLY from
 * mainnet. Paths, ports and the manifest format live here so start/stop and the e2e suite agree.
 *
 * Environment overrides:
 *   FORK_DIR               fork directory (ledger, logs, manifest). Default: <os tmpdir>/zerofee-terminal-fork
 *   FORK_RPC_PORT          JSON-RPC port (websocket = +1). Default 18899, away from the usual 8899.
 *   FORK_CLONE_URL         read-only mainnet RPC used for discovery and cloning. Default: public mainnet RPC.
 *   SOLANA_TEST_VALIDATOR  path to the solana-test-validator binary.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Address } from "@solana/kit";
import { DEFAULT_RPC_URL } from "../../src";

export const MANIFEST_VERSION = 1;

export interface ForkPaths {
  dir: string;
  ledgerDir: string;
  manifestPath: string;
  /** solana-test-validator stdout/stderr (its own log is <ledgerDir>/validator.log). */
  outPath: string;
  /** Present only in directories created by start.ts; stop.ts refuses to delete anything without it. */
  markerPath: string;
  /** e2e results (one JSON object per landed trade). */
  reportPath: string;
}

export function forkPaths(dir = process.env.FORK_DIR?.trim() || join(tmpdir(), "zerofee-terminal-fork")): ForkPaths {
  const d = resolve(dir);
  return {
    dir: d,
    ledgerDir: join(d, "ledger"),
    manifestPath: join(d, "fork.json"),
    outPath: join(d, "validator.out"),
    markerPath: join(d, ".zerofee-fork"),
    reportPath: join(d, "e2e-report.jsonl"),
  };
}

export interface ForkPorts {
  rpc: number;
  ws: number;
  gossip: number;
  faucet: number;
  /** [min, max) for TPU/TVU/repair sockets; kept clear of the defaults so other validators can coexist. */
  dynamicRange: [number, number];
}

export function forkPorts(): ForkPorts {
  const raw = process.env.FORK_RPC_PORT?.trim();
  const rpc = raw ? Number(raw) : 18899;
  if (!Number.isInteger(rpc) || rpc < 1024 || rpc > 65_000) throw new Error("FORK_RPC_PORT must be an integer in [1024, 65000]");
  return { rpc, ws: rpc + 1, gossip: rpc + 2, faucet: rpc + 101, dynamicRange: [rpc + 11, rpc + 91] };
}

export function validatorBinary(): string {
  const override = process.env.SOLANA_TEST_VALIDATOR?.trim();
  if (override) return override;
  const agave = join(homedir(), ".local/share/solana/install/active_release/bin/solana-test-validator");
  return existsSync(agave) ? agave : "solana-test-validator";
}

/** Mainnet RPC used read-only (discovery + the validator's --url for cloning). */
export function cloneSourceUrl(): string {
  return process.env.FORK_CLONE_URL?.trim() || DEFAULT_RPC_URL;
}

/** Hides api-key style query params and path segments that look like keys before printing a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|auth|secret/i.test(k)) u.searchParams.set(k, "***");
    u.pathname = u.pathname
      .split("/")
      .map((seg) => (seg.length >= 24 ? "***" : seg))
      .join("/");
    return u.toString();
  } catch {
    return "<invalid url>";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The e2e suite and the fork scripts only ever send to the local validator. */
export function assertLoopbackUrl(url: string, what: string): void {
  if (!isLoopbackUrl(url)) {
    let host = "<invalid url>";
    try {
      host = new URL(url).host;
    } catch {
      /* keep placeholder */
    }
    throw new Error(`${what} must point at the local fork (127.0.0.1), got ${host}; refusing to send anywhere else`);
  }
}

/** fetch that refuses any non-loopback URL (defense in depth for every send path in tests). */
export const loopbackOnlyFetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  assertLoopbackUrl(url, "request");
  return fetch(input, init);
}) as typeof fetch;

/**
 * curve2022 / curveSpl / mayhem / pumpswap: coins the trade suites buy and sell.
 * migration: a second Token-2022 curve coin that the armed suite drives to completion and migrates to
 * PumpSwap (irreversible on the fork), so it never shares a coin with the other suites.
 * launchlab / cpmm: a Raydium LaunchLab curve and a Raydium CPMM pool, both SOL-quoted (optional).
 */
export type TargetKind = "curve2022" | "curveSpl" | "mayhem" | "migration" | "pumpswap" | "launchlab" | "cpmm";

export interface ForkTarget {
  kind: TargetKind;
  mint: Address;
  venue: "pump" | "pumpswap" | "launchlab" | "cpmm";
  /** Owner program of the base mint. */
  tokenProgram: Address;
  /** Bonding curve (pump), canonical pool (pumpswap), LaunchLab pool or CPMM pool. */
  market: Address;
  note: string;
}

export interface CloneList {
  /** --clone-upgradeable-program (program + programdata). */
  upgradeablePrograms: Address[];
  /** --clone of non-upgradeable executable accounts (BPFLoader2 programs). */
  programAccounts: Address[];
  /** --clone: verified to exist on mainnet. */
  accounts: Address[];
  /** --maybe-clone: seed-constrained or lazily created accounts that may not exist. */
  maybeAccounts: Address[];
  /** address -> why it is cloned. */
  why: Record<string, string>;
}

export interface ProgramCheck {
  program: Address;
  loader: "upgradeable" | "loader2";
  /** sha256 of the ELF (programdata minus its 45-byte header; the validator zeroes the deploy slot). */
  mainnetSha256: string;
  localSha256: string;
  bytes: number;
}

export interface RentTopUp {
  address: Address;
  dataLength: number;
  lamportsBefore: string;
  lamportsAfter: string;
}

export interface ForkManifest {
  version: number;
  startedAt: string;
  pid: number;
  rpcUrl: string;
  wsUrl: string;
  ports: ForkPorts;
  ledgerDir: string;
  outPath: string;
  /** Redacted mainnet RPC used for cloning. */
  cloneSource: string;
  mainnetSlotAtClone: string;
  featureSetCloned: boolean;
  validatorVersion: string;
  targets: ForkTarget[];
  clone: CloneList;
  programs: ProgramCheck[];
  /** Cloned accounts topped up to the fork's (higher, classic) rent-exempt minimum. */
  rentTopUps: RentTopUp[];
}

export function readManifest(paths: ForkPaths = forkPaths()): ForkManifest | null {
  if (!existsSync(paths.manifestPath)) return null;
  const m = JSON.parse(readFileSync(paths.manifestPath, "utf8")) as ForkManifest;
  if (m.version !== MANIFEST_VERSION)
    throw new Error(`fork manifest version ${m.version} != ${MANIFEST_VERSION}; run bun run fork:start again`);
  return m;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

/** True when `pid` is alive AND is a solana-test-validator (guards against pid reuse before signalling). */
export function isValidatorProcess(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
  return ps.success && ps.stdout.toString().includes("solana-test-validator");
}

/** JSON-RPC getHealth against a local URL; false on any error. */
export async function isHealthy(rpcUrl: string, timeoutMs = 2_000): Promise<boolean> {
  assertLoopbackUrl(rpcUrl, "health check");
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as { result?: string };
    return body.result === "ok";
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** JSON.stringify that writes bigints as strings. */
export const toJson = (v: unknown, space = 2) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);
