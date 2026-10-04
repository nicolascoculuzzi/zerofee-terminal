/**
 * The bundled signer worker. `?worker&url` makes Vite build signer.worker.ts as its own module chunk
 * (only @zerofee/signer and its pinned dependencies) and hands back its URL, so the config can ride in
 * the Worker's `name`.
 */
import workerUrl from "./signer.worker.ts?worker&url";
import type { WorkerFactory } from "./signerHost";

export const createSignerWorker: WorkerFactory = (name) => new Worker(workerUrl, { type: "module", name });
