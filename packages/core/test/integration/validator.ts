/**
 * Local Agave test-validator harness for the armed-order integration tests (Bun only; never
 * touches mainnet). Starts `solana-test-validator` on 127.0.0.1 with a temp ledger and fast slots,
 * and stops it and deletes the ledger afterwards.
 *
 *   SOLANA_TEST_VALIDATOR       binary (default ~/.local/share/solana/install/active_release/bin/solana-test-validator)
 *   ZF_VALIDATOR_TICKS_PER_SLOT ticks per slot (default 8 ≈ 83 ms slots; 64 = mainnet-like 400 ms)
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export interface LocalValidator {
  rpcUrl: string;
  rpc: Rpc<SolanaRpcApi>;
  ticksPerSlot: number;
  stop(): Promise<void>;
}

export function validatorBinary(): string {
  return process.env.SOLANA_TEST_VALIDATOR ?? join(homedir(), ".local/share/solana/install/active_release/bin/solana-test-validator");
}

async function isUp(rpcUrl: string): Promise<boolean> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [{ commitment: "finalized" }] }),
    });
    const json = (await res.json()) as { result?: number };
    return typeof json.result === "number" && json.result > 2;
  } catch {
    return false;
  }
}

/** Starts a fresh validator; retries on another port range if the first one is taken. */
export async function startValidator(timeoutMs = 60_000): Promise<LocalValidator> {
  const bin = validatorBinary();
  if (!existsSync(bin)) throw new Error(`solana-test-validator not found at ${bin} (set SOLANA_TEST_VALIDATOR)`);
  const ticksPerSlot = Number(process.env.ZF_VALIDATOR_TICKS_PER_SLOT ?? 8);
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 300) * 100;
    const ledger = mkdtempSync(join(tmpdir(), "zf-armed-ledger-"));
    const rpcUrl = `http://127.0.0.1:${base}`;
    const proc = Bun.spawn(
      [
        bin,
        "--reset",
        "--quiet",
        "--ledger",
        ledger,
        "--bind-address",
        "127.0.0.1",
        "--rpc-port",
        String(base),
        "--faucet-port",
        String(base + 2),
        "--gossip-port",
        String(base + 3),
        "--dynamic-port-range",
        `${base + 10}-${base + 60}`,
        "--ticks-per-slot",
        String(ticksPerSlot),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const stop = async () => {
      proc.kill();
      await proc.exited;
      rmSync(ledger, { recursive: true, force: true });
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && proc.exitCode === null) {
      if (await isUp(rpcUrl)) return { rpcUrl, rpc: createSolanaRpc(rpcUrl), ticksPerSlot, stop };
      await Bun.sleep(250);
    }
    lastError = proc.exitCode !== null ? `exited with ${proc.exitCode}: ${await new Response(proc.stderr).text()}` : "timed out";
    await stop();
  }
  throw new Error(`could not start solana-test-validator (${lastError})`);
}
