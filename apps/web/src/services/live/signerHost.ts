/**
 * Owns the signer Web Worker (signer.worker.ts) and its typed RPC client (packages/signer rpc.ts). The
 * worker is started with a SignerWorkerConfig (caps and auto-lock from settings); a different config
 * restarts it, which drops every key from memory (the keystore reads as locked afterwards).
 */
import { createSignerClient, type MessageEndpoint, type SignerClient, type SignerRpcEvent } from "@zerofee/signer";
import { encodeSignerConfig, type SignerWorkerConfig } from "./signerConfig";

export interface WorkerLike extends MessageEndpoint {
  terminate(): void;
}

/** Creates the worker with `name` (the encoded config). */
export type WorkerFactory = (name: string) => WorkerLike;

export class SignerHost {
  private worker: WorkerLike | null = null;
  private client: SignerClient | null = null;
  private configKey: string | null = null;
  private offEvents: (() => void) | null = null;
  private readonly lockListeners = new Set<(reason: "auto" | "manual" | "restart") => void>();

  constructor(private readonly factory: WorkerFactory) {}

  /** (Re)starts the worker when the config differs from the running one; returns true if it restarted. */
  configure(cfg: SignerWorkerConfig): boolean {
    const key = encodeSignerConfig(cfg);
    if (key === this.configKey && this.client) return false;
    const restarting = this.client !== null;
    this.stop();
    const worker = this.factory(key);
    const client = createSignerClient(worker, { timeoutMs: 120_000 });
    this.worker = worker;
    this.client = client;
    this.configKey = key;
    this.offEvents = client.onEvent((e: SignerRpcEvent) => {
      if (e.event === "locked") for (const l of this.lockListeners) l(e.reason);
    });
    if (restarting) for (const l of this.lockListeners) l("restart");
    return restarting;
  }

  get rpc(): SignerClient {
    if (!this.client) throw new Error("the signer is not running");
    return this.client;
  }

  /** The vault locked itself (auto), was locked (manual), or the worker restarted with new settings. */
  onLocked(listener: (reason: "auto" | "manual" | "restart") => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  stop(): void {
    this.offEvents?.();
    this.offEvents = null;
    this.client?.close();
    this.client = null;
    this.worker?.terminate();
    this.worker = null;
    this.configKey = null;
  }
}
