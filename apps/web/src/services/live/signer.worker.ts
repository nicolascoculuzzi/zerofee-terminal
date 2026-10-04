/**
 * The signer Web Worker: packages/signer's vault (Argon2id + AES-GCM, non-extractable Ed25519 keys in
 * IndexedDB) and firewall, served over its typed RPC. This entry imports nothing but @zerofee/signer
 * and the config decoder; trading keys exist only in this worker's memory, never on the main thread.
 */
import { createSignerPolicy, startSignerWorker } from "@zerofee/signer/worker";
import { decodeSignerConfig } from "./signerConfig";

const cfg = decodeSignerConfig(self.name);
if (!cfg) throw new Error("signer worker started without a valid config");

startSignerWorker({
  // The embedded allowlist, tip accounts and venue rules; only the per-trade cap comes from settings.
  policy: createSignerPolicy({ caps: { maxBuyLamports: BigInt(cfg.maxBuyLamports) } }),
  dailyCaps: { buyLamports: BigInt(cfg.dailyBuyLamports), feeLamports: BigInt(cfg.dailyFeeLamports) },
  vault: { autoLockMs: cfg.autoLockMs },
});
