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

// ── Consumption (meta-whatsapp-select-number.ts) ─────────────────────────

export type ConsumeSelectionParams = {
  selectionTokenHash: string;
  orgId: string;
  userId: string;
  product: string;
  nowIso: string;
};

export type ConsumedPendingSelection = {
  encrypted_access_token: string;
  token_type: string;
  token_expires_at: string | null;
  granted_scopes: string[];
  meta_user_id: string;
  meta_user_name: string | null;
  meta_user_picture_url: string | null;
  page_id: string | null;
  page_name: string | null;
  candidates: WhatsAppCandidate[];
};

export type ConsumeSelectionResult =
  | { ok: true; row: ConsumedPendingSelection }
  | { ok: false; reason: "not_found_or_expired" }
  | { ok: false; reason: "db_error"; error: string };

/**
 * Atomically consumes a reserved selection — a conditional UPDATE, not a
 * SELECT-then-UPDATE, so two concurrent submissions of the same
 * selectionToken can never both succeed. Same query shape as before this
 * extraction: scoped to selection_token_hash + org_id + user_id + product,
 * only matching a row that is still unconsumed and unexpired.
 */
export async function consumePendingSelection(
  supabase: SupabaseClient,
  params: ConsumeSelectionParams,
): Promise<ConsumeSelectionResult> {
  const { data: consumedRows, error } = await supabase
    .from("meta_whatsapp_pending_selections")
    .update({ consumed_at: params.nowIso })
    .eq("selection_token_hash", params.selectionTokenHash)
    .eq("org_id", params.orgId)
    .eq("user_id", params.userId)
    .eq("product", params.product)
    .is("consumed_at", null)
    .gt("expires_at", params.nowIso)
    .select("encrypted_access_token, token_type, token_expires_at, granted_scopes, meta_user_id, meta_user_name, meta_user_picture_url, page_id, page_name, candidates");

  if (error) return { ok: false, reason: "db_error", error: error.message };
  if (!consumedRows || consumedRows.length !== 1) return { ok: false, reason: "not_found_or_expired" };
  return { ok: true, row: consumedRows[0] as unknown as ConsumedPendingSelection };
}

/**
 * Fail-closed candidate lookup — the submitted phoneNumberId must be
 * literally one of the candidates discovered for THIS exact OAuth
 * transaction (stored server-side in the consumed selection row), never
 * trusted beyond that match. Returns undefined for no match (including a
 * tampered/unlisted id) — same behavior as the inline `.find()` this
 * replaces in meta-whatsapp-select-number.ts.
 */
export function matchCandidateByPhoneNumberId(
  candidates: WhatsAppCandidate[],
  phoneNumberId: string,
): WhatsAppCandidate | undefined {
  return (candidates ?? []).find((c) => c.phoneNumberId === phoneNumberId);
}

// ── Finalization (meta-whatsapp-select-number.ts's meta_connections write) ─

export type FinalizeConnectionParams = {
  orgId: string;
  userId: string;
  metaUserId: string;
  metaUserName: string | null;
  metaUserPictureUrl: string | null;
  businessId: string;
  businessName: string | null;
  fallbackPageId: string | null;
  fallbackPageName: string | null;
  wabaId: string;
  wabaPhoneNumberId: string;
  wabaDisplayPhone: string;
  encryptedAccessToken: string;
  tokenType: string;
  tokenExpiresAt: string | null;
  grantedScopes: string[];
  nowIso: string;
};

/**
 * Same final write meta-oauth-callback.ts performs for the single-
 * candidate case — ONE ROW PER (org_id, product), never touches
 * Messenger/Instagram/Ads/Lead Ads rows (separate rows under the
 * per-product schema). Fetches the existing row's page_id/page_name as a
 * fallback ONLY (never overwrites a fresh value with an older one) —
 * same reasoning as meta-oauth-callback.ts's own existingRow fetch.
 */
export async function finalizeWhatsAppConnection(
  supabase: SupabaseClient,
  params: FinalizeConnectionParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: existingRow } = await supabase
    .from("meta_connections")
    .select("page_id, page_name")
    .eq("org_id", params.orgId)
    .eq("product", "whatsapp")
    .maybeSingle();

  const { error } = await supabase
    .from("meta_connections")
    .upsert(
      {
        org_id: params.orgId,
        product: "whatsapp",
        user_id: params.userId,
        meta_user_id: params.metaUserId,
        meta_user_name: params.metaUserName,
        meta_user_picture_url: params.metaUserPictureUrl,
        business_id: params.businessId,
        business_name: params.businessName,
        page_id: params.fallbackPageId ?? existingRow?.page_id ?? null,
        page_name: params.fallbackPageName ?? existingRow?.page_name ?? null,
        waba_id: params.wabaId,
        waba_phone_number_id: params.wabaPhoneNumberId,
        waba_display_phone: params.wabaDisplayPhone,
        access_token: params.encryptedAccessToken,
        token_type: params.tokenType,
        expires_at: params.tokenExpiresAt,
        granted_scopes: params.grantedScopes,
        is_active: true,
        updated_at: params.nowIso,
      },
      { onConflict: "org_id,product" },
    );

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
