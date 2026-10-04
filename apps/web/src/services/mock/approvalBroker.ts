import type { ApprovalRequest } from "../walletService";

/**
 * Mock-only: stands in for the external wallet's (Phantom/Solflare/Backpack) approval popup.
 * The UI registers a renderer; the mock wallet service awaits the user's decision.
 * The real WalletService gets this from the wallet extension and needs none of it.
 */
type Renderer = (request: ApprovalRequest) => Promise<boolean>;

let renderer: Renderer | null = null;

export function setApprovalRenderer(next: Renderer | null): void {
  renderer = next;
}

export function requestApproval(request: ApprovalRequest): Promise<boolean> {
  if (renderer) return renderer(request);
  return new Promise((resolve) => setTimeout(() => resolve(true), 400));
}
