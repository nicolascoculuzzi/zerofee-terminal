/**
 * Builds pump / PumpSwap instructions from the trimmed official IDL (test/fixtures/pump-idl-subset.json):
 * account order, writability and signer flags, discriminators and argument encoding all come from
 * the IDL, independently of the firewall's hardcoded layout constants.
 */
import { type AccountMeta, AccountRole, type Address, type Instruction } from "@solana/kit";
import subset from "../fixtures/pump-idl-subset.json";

export interface IdlAccount {
  name: string;
  writable: boolean;
  signer: boolean;
  address?: string;
}
export interface IdlInstruction {
  name: string;
  discriminator: number[];
  args: { name: string; type: string }[];
  accounts: IdlAccount[];
}
export type IdlProgram = "pump" | "pump_amm";

export function idlInstruction(program: IdlProgram, name: string): IdlInstruction {
  const ix = (subset[program] as IdlInstruction[]).find((i) => i.name === name);
  if (!ix) throw new Error(`no ${program}.${name} in IDL fixture`);
  return ix;
}

export function encodeArgs(ix: IdlInstruction, args: Record<string, bigint | boolean | undefined>): Uint8Array {
  const parts: number[] = [...ix.discriminator];
  for (const arg of ix.args) {
    const value = args[arg.name];
    if (arg.type === "u64") {
      if (typeof value !== "bigint") throw new Error(`arg ${arg.name} must be a bigint`);
      for (let i = 0n; i < 8n; i++) parts.push(Number((value >> (8n * i)) & 0xffn));
    } else if (arg.type === "OptionBool") {
      if (value === undefined) continue; // clients may omit the trailing OptionBool
      parts.push(value ? 1 : 0);
    } else {
      throw new Error(`unsupported arg type ${arg.type}`);
    }
  }
  return Uint8Array.from(parts);
}

export function role(account: { writable: boolean; signer: boolean }): AccountRole {
  if (account.signer) return account.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER;
  return account.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

export function buildIdlInstruction(opts: {
  programAddress: Address;
  program: IdlProgram;
  name: string;
  accounts: Record<string, Address>;
  args: Record<string, bigint | boolean | undefined>;
  remaining?: AccountMeta[];
}): Instruction {
  const ix = idlInstruction(opts.program, opts.name);
  const metas: AccountMeta[] = ix.accounts.map((a) => {
    const addr = opts.accounts[a.name] ?? (a.address as Address | undefined);
    if (!addr) throw new Error(`${opts.program}.${opts.name}: missing account ${a.name}`);
    return { address: addr, role: role(a) };
  });
  return { programAddress: opts.programAddress, accounts: [...metas, ...(opts.remaining ?? [])], data: encodeArgs(ix, opts.args) };
}
