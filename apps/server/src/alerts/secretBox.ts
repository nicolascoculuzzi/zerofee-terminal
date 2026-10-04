/**
 * Encryption at rest for channel secrets (Discord webhook URLs are bearer capabilities: anyone who has
 * one can post to that channel). AES-256-GCM via WebCrypto with a 32-byte server key from
 * CHANNEL_ENCRYPTION_KEY, a fresh 96-bit IV per value, and associated data binding each ciphertext to
 * its row and owner, so a ciphertext copied onto another row or user does not decrypt.
 *
 *   blob = version (1 byte, 0x01) || iv (12 bytes) || ciphertext || GCM tag (16 bytes)
 *
 * Rotation: a new key needs a new version byte and a re-encryption pass (not built yet).
 */
const VERSION = 1;
const IV_BYTES = 12;

export class SecretBox {
  private constructor(private readonly key: CryptoKey) {}

  static async create(rawKey: Uint8Array): Promise<SecretBox> {
    if (rawKey.length !== 32) throw new Error("SecretBox needs a 32-byte key");
    const key = await crypto.subtle.importKey("raw", new Uint8Array(rawKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return new SecretBox(key);
  }

  async seal(plaintext: string, aad: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
        this.key,
        new TextEncoder().encode(plaintext),
      ),
    );
    const out = new Uint8Array(1 + IV_BYTES + ct.length);
    out[0] = VERSION;
    out.set(iv, 1);
    out.set(ct, 1 + IV_BYTES);
    return out;
  }

  /** Throws on a wrong key, wrong associated data or any tampering. */
  async open(blob: Uint8Array, aad: string): Promise<string> {
    if (blob.length < 1 + IV_BYTES + 16 || blob[0] !== VERSION) throw new Error("unknown ciphertext format");
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.slice(1, 1 + IV_BYTES), additionalData: new TextEncoder().encode(aad) },
      this.key,
      blob.slice(1 + IV_BYTES),
    );
    return new TextDecoder().decode(pt);
  }
}

/** Associated data for a Discord webhook ciphertext. */
export const discordAad = (channelId: string, userId: string): string => `zerofee/discord-webhook/v1/${channelId}/${userId}`;
