// netlify/lib/invoice-tokens.ts
//
// Phase 13.7 — shared helpers for the hashed public invoice token
// (invoice_public_tokens, supabase/migrations/20260821_public_invoice_payments.sql).
// Every server-side function that generates or verifies a public invoice
// link uses these functions so the hashing algorithm and token shape stay
// in exactly one place.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/** 32 random bytes, base64url-encoded — high entropy, URL-safe, no padding. */
export function generatePublicToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** SHA-256 of the raw token, hex-encoded. This is the only form ever persisted. */
export function hashPublicToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export type InvoicePublicTokenRow = {
  id: string;
  org_id: string;
  invoice_id: string;
  token_hash: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_accessed_at: string | null;
};

/**
 * Phase 13.7A — fixes an earlier design bug (Part 1): since only the
 * SHA-256 hash is ever stored, a previously minted raw token can never be
 * read back out and "reused" — that was a contradiction. The corrected
 * model mints a BRAND NEW raw token every time it's called (every invoice
 * send/resend), inserts a new row, and never touches or reads any prior
 * row for this invoice.
 *
 * This deliberately allows multiple active token rows per invoice at once
 * (Part 3 — invoice_id has no unique constraint, on purpose): an old
 * emailed link keeps working after a resend mints a new one, since each
 * row is independently valid/revocable/expirable. A future "revoke all
 * links for this invoice" action can simply set revoked_at on every row
 * with this invoice_id — not implemented here.
 */
export async function mintPublicInvoiceToken(
  admin: SupabaseClient,
  orgId: string,
  invoiceId: string,
): Promise<string> {
  const rawToken = generatePublicToken();
  const tokenHash = hashPublicToken(rawToken);

  const { error: insertError } = await admin
    .from("invoice_public_tokens")
    .insert({ org_id: orgId, invoice_id: invoiceId, token_hash: tokenHash });
  if (insertError) throw new Error(`Could not create an invoice payment link: ${insertError.message}`);
  return rawToken;
}

/**
 * Best-effort revocation of a just-minted token — used when email delivery
 * fails right after minting (Part 15) so a never-delivered link doesn't sit
 * around as an unused-but-valid row. Failure here is logged, not thrown:
 * an orphaned unused token is a harmless cleanup gap, never a reason to
 * mask the original email-send failure the caller is already handling.
 */
export async function revokePublicInvoiceTokenByRawToken(admin: SupabaseClient, rawToken: string): Promise<void> {
  const tokenHash = hashPublicToken(rawToken);
  const { error } = await admin
    .from("invoice_public_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);
  if (error) console.warn("[invoice-tokens] could not revoke orphaned token after email failure (non-blocking):", error.message);
}

/**
 * Resolves a raw token from a customer request to its invoice_public_tokens
 * row, enforcing not-revoked/not-expired. Returns null (not a thrown error)
 * for any invalid/expired/revoked/unknown token so callers can return one
 * uniform "invalid or no longer available" response without distinguishing
 * WHY — never leak whether a token exists, was revoked vs. expired, etc.
 * (Part 2/24).
 */
export async function resolvePublicInvoiceToken(
  admin: SupabaseClient,
  rawToken: string,
): Promise<InvoicePublicTokenRow | null> {
  if (!rawToken || rawToken.length < 32) return null;
  const tokenHash = hashPublicToken(rawToken);

  const { data: row, error } = await admin
    .from("invoice_public_tokens")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null;

  // Best-effort only (Part 14) — last_accessed_at is telemetry, not an
  // authorization check. A failed write here must never make an otherwise
  // valid token fail to resolve for the customer.
  const { error: touchError } = await admin
    .from("invoice_public_tokens")
    .update({ last_accessed_at: new Date().toISOString() })
    .eq("id", row.id);
  if (touchError) console.warn("[invoice-tokens] last_accessed_at update failed (non-blocking):", touchError.message);

  return row as InvoicePublicTokenRow;
}
