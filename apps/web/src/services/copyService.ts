import type { CopyTask, CopyTaskInput, CopyTaskPatch } from "@zerofee/protocol";

/**
 * Copy trading (packages/protocol trackers.ts). The server vets each leader trade against the task and
 * pushes an expiring signal on the `copy` topic; the browser that is open builds the copy, its signer
 * firewall checks it, the trading wallet signs it, and the outcome is reported back. Live mode only (the
 * simulation has no copy engine): `Services.copy` is null there.
 */
export interface CopyService {
  create(input: CopyTaskInput): Promise<CopyTask>;
  update(id: string, patch: CopyTaskPatch): Promise<CopyTask>;
  pause(id: string): Promise<CopyTask>;
  resume(id: string): Promise<CopyTask>;
  remove(id: string): Promise<void>;
}
