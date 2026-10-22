import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = 1;

/** AES-256-GCM sealing for raw message content at rest. */
export class Sealer {
  #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("FINTRACK_DATA_KEY must be 32 bytes, base64-encoded (run `fintrack keygen`)");
    this.#key = key;
  }

  // Layout: version(1) | nonce(12) | ciphertext | tag(16)
  seal(plaintext: string): Buffer {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, nonce);
    const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return Buffer.concat([Buffer.from([VERSION]), nonce, body, c.getAuthTag()]);
  }

  open(sealed: Buffer): string {
    if (sealed[0] !== VERSION) throw new Error(`unknown sealed version ${sealed[0]}`);
    const d = createDecipheriv("aes-256-gcm", this.#key, sealed.subarray(1, 13));
    d.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([d.update(sealed.subarray(13, sealed.length - 16)), d.final()]).toString("utf8");
  }
}

export const newDataKey = () => randomBytes(32).toString("base64");

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

// No 0/O/1/I/L so codes survive being read aloud or typed on a phone.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** An 8-character pairing code like "K7P4-QX9M" (~40 bits; short-lived and rate-limited). */
export function newPairingCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const normalizePairingCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Device tokens are shown once and stored only as a hash. */
export function newDeviceToken(): { token: string; hash: Buffer } {
  const token = `ftd_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sha256(token) };
}
