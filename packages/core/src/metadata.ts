/**
 * On-chain token metadata and Token-2022 mint extensions.
 *
 *  - `create_v2` coins (Token-2022) keep name/symbol/uri in the mint's TokenMetadata extension.
 *  - legacy `create` coins keep them in the Metaplex metadata PDA.
 *  - Token-2022 "danger" extensions (SPEC.md metric table): permanent delegate, transfer hook, pausable,
 *    non-transferable, frozen-by-default.
 * Layouts: spl-token-2022 (base mint 82 bytes, padding to 165, account-type byte, then TLV entries of
 * u16 type + u16 length + value) and spl-token-metadata-interface; Metaplex Token Metadata `Metadata`.
 */
import { type Address, getProgramDerivedAddress } from "@solana/kit";
import { DEFAULT_PUBKEY, MPL_TOKEN_METADATA_PROGRAM_ID, SEEDS, TOKEN_2022_EXTENSIONS } from "./constants";
import { addressBytes, Reader, utf8 } from "./util/bytes";

export interface OnchainTokenMetadata {
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: Address | null;
}

export type Token2022Danger = "permanentDelegate" | "transferHook" | "pausable" | "nonTransferable" | "frozenByDefault";

export interface MintExtensions {
  /** Extension type numbers present on the mint. */
  types: number[];
  metadata: OnchainTokenMetadata | null;
  dangers: Token2022Danger[];
}

const BASE_ACCOUNT_LENGTH = 165;
const ACCOUNT_TYPE_MINT = 1;
/** DefaultAccountState value meaning "frozen". */
const ACCOUNT_STATE_FROZEN = 2;

const clean = (s: string) => s.replace(/\0+$/g, "").trim();

function readTokenMetadata(value: Uint8Array): OnchainTokenMetadata | null {
  try {
    const r = new Reader(value);
    const updateAuthority = r.pubkey();
    r.pubkey(); // mint
    const name = r.string(256);
    const symbol = r.string(256);
    const uri = r.string(1024);
    return {
      name: clean(name),
      symbol: clean(symbol),
      uri: clean(uri),
      updateAuthority: updateAuthority === DEFAULT_PUBKEY ? null : updateAuthority,
    };
  } catch {
    return null;
  }
}

/** Parses the TLV extensions of a Token-2022 mint account (SPL Token mints have none). */
export function decodeMintExtensions(data: Uint8Array): MintExtensions {
  const out: MintExtensions = { types: [], metadata: null, dangers: [] };
  if (data.length <= BASE_ACCOUNT_LENGTH || data[BASE_ACCOUNT_LENGTH] !== ACCOUNT_TYPE_MINT) return out;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = BASE_ACCOUNT_LENGTH + 1;
  while (o + 4 <= data.length) {
    const type = view.getUint16(o, true);
    const len = view.getUint16(o + 2, true);
    o += 4;
    if (type === 0 || o + len > data.length) break; // uninitialized tail / corrupt
    const value = data.subarray(o, o + len);
    out.types.push(type);
    switch (type) {
      case TOKEN_2022_EXTENSIONS.tokenMetadata:
        out.metadata = readTokenMetadata(value);
        break;
      case TOKEN_2022_EXTENSIONS.permanentDelegate:
        // OptionalNonZeroPubkey: all zeros = no delegate
        if (value.some((b) => b !== 0)) out.dangers.push("permanentDelegate");
        break;
      case TOKEN_2022_EXTENSIONS.transferHook:
        // authority (32) + program id (32); a set program id means transfers run arbitrary code
        if (value.subarray(32, 64).some((b) => b !== 0)) out.dangers.push("transferHook");
        break;
      case TOKEN_2022_EXTENSIONS.pausable:
        out.dangers.push("pausable");
        break;
      case TOKEN_2022_EXTENSIONS.nonTransferable:
        out.dangers.push("nonTransferable");
        break;
      case TOKEN_2022_EXTENSIONS.defaultAccountState:
        if (value[0] === ACCOUNT_STATE_FROZEN) out.dangers.push("frozenByDefault");
        break;
    }
    o += len;
  }
  return out;
}

/** Metaplex `Metadata` account (key 4): name / symbol / uri are NUL-padded borsh strings. */
export function decodeMetaplexMetadata(data: Uint8Array): OnchainTokenMetadata | null {
  if (data.length < 1 + 32 + 32 + 4 || data[0] !== 4) return null;
  try {
    const r = new Reader(data, 1);
    const updateAuthority = r.pubkey();
    r.pubkey(); // mint
    const name = r.string(256);
    const symbol = r.string(256);
    const uri = r.string(1024);
    return { name: clean(name), symbol: clean(symbol), uri: clean(uri), updateAuthority };
  } catch {
    return null;
  }
}

/** Metaplex metadata PDA: ["metadata", program id, mint]. */
export async function metaplexMetadataPda(mint: Address): Promise<Address> {
  const [a] = await getProgramDerivedAddress({
    programAddress: MPL_TOKEN_METADATA_PROGRAM_ID,
    seeds: [utf8(SEEDS.metaplexMetadata), addressBytes(MPL_TOKEN_METADATA_PROGRAM_ID), addressBytes(mint)],
  });
  return a;
}
