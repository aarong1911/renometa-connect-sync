// netlify/functions/lib/gmail-token-crypto.ts
//
// Shared AES-256-GCM encrypt/decrypt for the `integrations` table's
// access_token_encrypted/refresh_token_encrypted bytea columns. Extracted
// from gmail-sync.ts so gmail-oauth-callback.ts (which writes these values)
// and gmail-sync.ts (which reads/refreshes them) can never drift out of
// sync on the wire format.
//
// Format (verified against live data before this was first written):
// bytea comes back from supabase-js as a "\x{hex}" string; the hex decodes
// to a UTF-8 base64 string; that base64 decodes to raw
// iv(12) || authTag(16) || ciphertext, AES-256-GCM with
// key = SHA-256(ENCRYPTION_KEY) — the same scheme meta-oauth-callback.ts
// uses for meta_connections.access_token, just wrapped in a bytea/hex shell
// instead of a bare "enc:"-prefixed string.

import crypto from "node:crypto";

export function decryptBytea(byteaString: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot decrypt Gmail token");
  const hexStr = byteaString.startsWith("\\x") ? byteaString.slice(2) : byteaString;
  const wrapped = Buffer.from(hexStr, "hex").toString("utf8"); // base64 text
  const raw = Buffer.from(wrapped, "base64"); // iv(12) || authTag(16) || ciphertext
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const key = crypto.createHash("sha256").update(encKey).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptToBytea(plaintext: string): string {
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot encrypt Gmail token");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const inner = Buffer.concat([iv, tag, ciphertext]).toString("base64");
  const hex = Buffer.from(inner, "utf8").toString("hex");
  return "\\x" + hex;
}
