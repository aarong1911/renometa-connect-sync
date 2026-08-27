// netlify/functions/lib/meta-token-crypto.ts
//
// Shared decrypt for meta_connections.access_token — extracted so new
// Phase 1A endpoints (meta-ads-accounts.ts, meta-ads-select-account.ts,
// meta-ads-context.ts) don't carry a 4th copy of the same logic already
// inlined in meta-oauth-callback.ts (encrypt) and meta-create-ad-campaign.ts
// (decrypt). Existing files' own inline copies are left untouched — no
// behavior change to already-shipped code.
//
// access_token is a `text` column, "enc:"-prefixed base64 AES-256-GCM for
// new writes; pre-existing rows may be bare plaintext with no prefix (see
// .claude/skills/meta-integrations/SKILL.md). Never logs the token value.

import crypto from "node:crypto";

export function decryptMetaAccessToken(stored: string): string {
  if (!stored.startsWith("enc:")) return stored; // legacy plaintext row

  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) throw new Error("ENCRYPTION_KEY env var is not set — cannot decrypt Meta token");

  const raw = Buffer.from(stored.slice(4), "base64");
  const key = crypto.createHash("sha256").update(encKey).digest();
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
