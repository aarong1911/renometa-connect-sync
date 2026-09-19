// netlify/functions/lib/meta-whatsapp-selection-store.ts
//
// Test-safety incident follow-up (2026-09-17/18). Extracted, UNCHANGED IN
// BEHAVIOR, from meta-oauth-callback.ts and meta-whatsapp-select-number.ts
// — every query, field, and conditional here is byte-for-byte the same
// logic those two files inlined before this pass. The only thing that
// changed is WHERE the logic lives: these functions take an already-
// constructed `SupabaseClient` as a parameter instead of each file
// constructing its own module-scoped `supabaseAdmin` and using it
// directly. That single change is what makes this logic unit-testable
// with an in-memory fake client (scripts/fake-supabase-client.mjs) —
// WITHOUT ever touching a real Supabase project, and therefore without
// ever needing to create a real `organizations` row or touch a real
// `meta_connections` row (see scripts/TEST_SAFETY_RULES.md and this
// pass's own report for why that matters).
//
// meta-oauth-callback.ts and meta-whatsapp-select-number.ts still each
// construct their OWN real supabaseAdmin client exactly as before and
// pass it into these functions — production behavior is identical.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppCandidate } from "./meta-whatsapp-candidates";

// ── Reservation (meta-oauth-callback.ts's multi-candidate branch) ───────

export type PendingSelectionInsert = {
  selectionTokenHash: string;
  orgId: string;
  userId: string;
  product: string;
  encryptedAccessToken: string;
  tokenType: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  metaUserId: string;
  metaUserName: string | null;
  metaUserPictureUrl: string | null;
  pageId: string | null;
  pageName: string | null;
  candidates: WhatsAppCandidate[];
  expiresAt: string;
};

export async function reservePendingSelection(
  supabase: SupabaseClient,
  params: PendingSelectionInsert,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase.from("meta_whatsapp_pending_selections").insert({
    selection_token_hash: params.selectionTokenHash,
    org_id: params.orgId,
    user_id: params.userId,
    product: params.product,
    encrypted_access_token: params.encryptedAccessToken,
    token_type: params.tokenType,
    token_expires_at: params.tokenExpiresAt,
    granted_scopes: params.grantedScopes,
    meta_user_id: params.metaUserId,
    meta_user_name: params.metaUserName,
    meta_user_picture_url: params.metaUserPictureUrl,
    page_id: params.pageId,
    page_name: params.pageName,
    candidates: params.candidates,
    expires_at: params.expiresAt,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── Atomic finalization (meta-whatsapp-select-number.ts) ────────────────
//
// Atomicity fix (2026-09-18): consumption of the pending selection and
// the final meta_connections write used to be two separate functions
// (consumePendingSelection + finalizeWhatsAppConnection, each its own
// Supabase REST call) — if the first succeeded and the second then
// failed, the selection token was permanently burned with no connection
// ever saved. Both steps — plus candidate validation — now live inside
// ONE Postgres function, `finalize_meta_whatsapp_selection` (see
// supabase/migrations/20260917_meta_whatsapp_pending_selections.sql),
// called here as a single RPC. A plpgsql function body is implicitly one
// transaction: any failure anywhere inside it rolls back everything,
// consumed_at included. Validated against a real local Postgres 17
// instance (schema/FK/RLS/expiry/single-use/forced-failure-rollback/
// concurrency) — see this pass's own report.
//
// This function is a thin wrapper only — it does not decide policy, does
// not decrypt/re-encrypt anything (the RPC copies the already-encrypted
// token as-is), and does not do its own candidate matching (the RPC does
// that against the row's own stored candidates, never trusting the
// caller). consumePendingSelection/finalizeWhatsAppConnection/
// matchCandidateByPhoneNumberId (the old two-call design) have been
// removed — nothing in this codebase calls them anymore.

export type FinalizeSelectionRpcParams = {
  selectionTokenHash: string;
  orgId: string;
  userId: string;
  phoneNumberId: string;
};

export type FinalizeSelectionRpcResult =
  | { ok: true; status: "ok"; businessName: string | null; wabaDisplayPhone: string; verifiedName: string | null }
  | { ok: true; status: "not_found_or_expired" }
  | { ok: true; status: "invalid_candidate" }
  | { ok: false; error: string };

/**
 * Calls the atomic finalize_meta_whatsapp_selection(...) RPC — the ONLY
 * write path for the multi-candidate WhatsApp connect flow. Returns a
 * discriminated result the caller maps directly to an HTTP status; never
 * throws.
 */
export async function finalizeMetaWhatsAppSelectionAtomic(
  supabase: SupabaseClient,
  params: FinalizeSelectionRpcParams,
): Promise<FinalizeSelectionRpcResult> {
  const { data, error } = await supabase.rpc("finalize_meta_whatsapp_selection", {
    p_selection_token_hash: params.selectionTokenHash,
    p_org_id: params.orgId,
    p_user_id: params.userId,
    p_phone_number_id: params.phoneNumberId,
  });

  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.status !== "string") return { ok: false, error: "RPC returned an unexpected shape." };

  if (row.status === "ok") {
    return {
      ok: true,
      status: "ok",
      businessName: row.business_name ?? null,
      wabaDisplayPhone: row.waba_display_phone as string,
      verifiedName: row.verified_name ?? null,
    };
  }
  if (row.status === "invalid_candidate") return { ok: true, status: "invalid_candidate" };
  return { ok: true, status: "not_found_or_expired" };
}
