/**
 * What the signer worker is started with: the firewall policy's per-trade cap, the daily caps and the
 * auto-lock time, from the user's settings. It travels as the Worker's `name` (fixed at start; no RPC
 * method can change it): new settings restart the worker, which locks the keystore. Worker stage caveat
 * (packages/signer worker.ts): compromised same-origin app code could restart it with other caps; the
 * signer moves to its own origin before launch.
 */

export interface SignerWorkerConfig {
  /** Max SOL committed by one transaction's buys (lamports, decimal string). */
  maxBuyLamports: string;
  /** Daily SOL buy budget (lamports). */
  dailyBuyLamports: string;
  /** Daily tips + priority + base fee budget (lamports); gates sells too, so it stays generous. */
  dailyFeeLamports: string;
  autoLockMs: number;
}

const LAMPORTS = 1_000_000_000;
/** Fee budget per day: enough for hundreds of lean trades or a few dozen at the Fast preset's tip. */
const DAILY_FEE_SOL = 0.5;

export function signerConfigFromSettings(s: { perTradeSol: number; dailySol: number; autoLockMinutes: number }): SignerWorkerConfig {
  const lamports = (sol: number) => BigInt(Math.max(0, Math.round(sol * LAMPORTS))).toString();
  return {
    maxBuyLamports: lamports(s.perTradeSol),
    dailyBuyLamports: lamports(s.dailySol),
    dailyFeeLamports: lamports(DAILY_FEE_SOL),
    // 0 = never: the vault still needs a number; a day is the longest we allow.
    autoLockMs: s.autoLockMinutes > 0 ? s.autoLockMinutes * 60_000 : 24 * 3_600_000,
  };
}

export function encodeSignerConfig(c: SignerWorkerConfig): string {
  return `zerofee-signer:${JSON.stringify(c)}`;
}

export function decodeSignerConfig(name: string): SignerWorkerConfig | null {
  if (!name.startsWith("zerofee-signer:")) return null;
  try {
    const c = JSON.parse(name.slice("zerofee-signer:".length)) as SignerWorkerConfig;
    const ok =
      /^\d+$/.test(c.maxBuyLamports) &&
      /^\d+$/.test(c.dailyBuyLamports) &&
      /^\d+$/.test(c.dailyFeeLamports) &&
      Number.isFinite(c.autoLockMs) &&
      c.autoLockMs > 0;
    return ok ? c : null;
  } catch {
    return null;
  }
}
