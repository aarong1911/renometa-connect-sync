// netlify/functions/lib/meta-lead-ads.ts
//
// Meta Ads Phase 1B / Step 1 — Lead Ads (Instant Forms) webhook event
// parsing, Page->org resolution, Meta lead retrieval, and the durable,
// idempotent ingestion pipeline through CRM Contact/Lead creation.
//
// meta-webhook.ts stays focused on verify/parse/dispatch — every
// leadgen-specific business rule lives here, one call away
// (processMetaLeadgenEvent), so a future reconciliation pass (Part P) can
// call the exact same function with a reconstructed MetaLeadgenEvent
// rather than reimplementing CRM creation logic separately.
//
// All Meta Graph API reads go through the centralized
// netlify/functions/lib/meta-graph-api.ts client — no raw fetch() calls.
//
// Never logs: field_data, names, email, phone, custom answers, access
// tokens, or the app secret. Safe structured metadata only (event type,
// meta_lead_id, page_id, org_id, status, Meta error code/subcode/fbtrace_id).

import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraphRequest, metaGraphPaginate, MetaGraphApiError } from "./meta-graph-api";
import { decryptMetaAccessToken } from "./meta-token-crypto";
import {
  parseMetaFieldData,
  normalizeMetaLeadFields,
  normalizePhoneForComparison,
  phoneStorageVariants,
  buildMetaLeadNote,
  type MetaFieldDatum,
} from "./meta-lead-normalization";

// ── Webhook event parsing (Part B/E) ────────────────────────────────────

export function isMetaLeadgenChange(change: any): boolean {
  return !!change && change.field === "leadgen" && !!change.value;
}

export interface MetaLeadgenEvent {
  metaLeadId: string;
  pageId: string;
  formId: string | null;
  adId: string | null;
  /** Normalized from the webhook's own "adgroup_id" key — see note below. */
  adSetId: string | null;
  createdTime: string | null; // ISO 8601, or null if absent/unparseable
}

function parseWebhookCreatedTime(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
  }
  return null;
}

// Normalizes ONE leadgen `change` (already confirmed via
// isMetaLeadgenChange) into a safe structure. Webhook attribution may be
// incomplete — never invents a missing ID, only null. Returns null if the
// one truly required field (leadgen_id) is missing/malformed.
export function extractMetaLeadgenEvent(entryPageId: string, change: any): MetaLeadgenEvent | null {
  const value = change?.value;
  if (!value || typeof value.leadgen_id !== "string" || value.leadgen_id.length === 0) return null;

  // value.page_id is the more specific/authoritative field when Meta
  // includes it; falls back to the containing entry's own id, which is
  // documented as the Page ID for every "page" object webhook (same
  // convention the existing Messenger/Instagram handler already relies on).
  const pageId = typeof value.page_id === "string" && value.page_id.length > 0 ? value.page_id : entryPageId;

  return {
    metaLeadId: value.leadgen_id,
    pageId,
    formId: typeof value.form_id === "string" ? value.form_id : null,
    adId: typeof value.ad_id === "string" ? value.ad_id : null,
    // Meta's LEADGEN WEBHOOK payload uses the legacy key "adgroup_id" for
    // what the Graph API's lead-object/reporting endpoints otherwise call
    // adset_id — normalized to adSetId here so it's consistent with the
    // rest of the Meta Ads feature's terminology (Phase 1A). This was not
    // independently re-verified against a live webhook delivery this
    // session (no live Meta call was made while building this file) — the
    // task's own "Expected Meta Lead Ads Webhook Shape" section lists this
    // exact field name, matching Meta's publicly documented shape.
    adSetId: typeof value.adgroup_id === "string" ? value.adgroup_id : null,
    createdTime: parseWebhookCreatedTime(value.created_time),
  };
}

// ── Page -> org resolution (Part G/Multi-Product Ambiguity) ─────────────

export type MetaPageOrgResolution =
  | { ok: true; orgId: string; connectionId: string; accessTokenEncrypted: string }
  | { ok: false; reason: "not_found" | "ambiguous" };

// Resolves the Page a leadgen webhook fired for to exactly one RenoMeta
// organization, using ONLY server-side DB state — the webhook payload
// itself is never trusted for org identity. Filters by the EXACT
// "lead_ads" product (the verified product string the Meta Lead Ads
// integration card's OAuth flow writes — see meta-oauth-callback.ts's
// productKey mapping), not just page_id alone, since meta_connections can
// hold a Messenger/Instagram row for the same Page under a different
// product for the same org.
//
// Deliberately does NOT use .maybeSingle() blindly: if more than one row
// matches (e.g. two different organizations' OAuth connections both
// recorded the same Facebook Page ID under product="lead_ads" — nothing in
// the current schema prevents this, since meta_connections is only unique
// on (org_id, product), not on page_id), this fails closed and reports
// "ambiguous" rather than guessing which org should receive the lead. This
// is a real, currently-possible ambiguity in the live schema — see the
// Step 1 report.
export async function resolveMetaLeadAdsConnectionForPage(
  supabaseAdmin: SupabaseClient,
  pageId: string,
): Promise<MetaPageOrgResolution> {
  const { data, error } = await supabaseAdmin
    .from("meta_connections")
    .select("id, org_id, access_token")
    .eq("page_id", pageId)
    .eq("product", "lead_ads");

  if (error) {
    console.error("[meta-lead-ads] connection lookup failed:", error.message);
    return { ok: false, reason: "not_found" };
  }
  if (!data || data.length === 0) {
    return { ok: false, reason: "not_found" };
  }
  if (data.length > 1) {
    console.error("[meta-lead-ads] AMBIGUOUS page->org resolution — multiple lead_ads connections share this page_id", {
      pageId,
      matchCount: data.length,
    });
    return { ok: false, reason: "ambiguous" };
  }

  const row = data[0] as { id: string; org_id: string; access_token: string | null };
  if (!row.access_token) {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, orgId: row.org_id, connectionId: row.id, accessTokenEncrypted: row.access_token };
}

// ── Meta lead retrieval (Part F) ────────────────────────────────────────
//
// Requesting campaign_id/campaign_name/adset_id/adset_name/ad_name/platform
// alongside field_data on this SAME call (rather than a separate
// enrichment request) is what keeps attribution enrichment out of the
// webhook path's N+1 risk (Part M "Attribution enrichment" / Part O) —
// Meta's lead-object fields documentedly include these directly. Not
// independently re-verified against a live response this session.
const META_LEAD_FIELDS = "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform";

interface RawMetaLead {
  id?: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  field_data?: unknown;
  platform?: string;
}

async function fetchMetaLeadById(accessToken: string, metaLeadId: string): Promise<RawMetaLead> {
  return metaGraphRequest<RawMetaLead>({
    path: `/${metaLeadId}`,
    accessToken,
    query: { fields: META_LEAD_FIELDS },
  });
}

// ── Form discovery (Part I) ──────────────────────────────────────────────
// Reusable for later UI/reconciliation. No consumer endpoint built in this
// step (not materially needed for Step 1's ingestion foundation) — see the
// Step 1 report.

export interface MetaLeadFormSummary {
  formId: string;
  name: string | null;
  status: string | null;
  pageId: string;
  createdTime: string | null;
}

interface RawMetaLeadForm {
  id: string;
  name?: string;
  status?: string;
  created_time?: string;
}

export async function discoverMetaLeadForms(accessToken: string, pageId: string): Promise<MetaLeadFormSummary[]> {
  const page = await metaGraphPaginate<RawMetaLeadForm>({
    path: `/${pageId}/leadgen_forms`,
    accessToken,
    query: { fields: "id,name,status,created_time" },
  });
  return page.items.map((f) => ({
    formId: f.id,
    name: typeof f.name === "string" ? f.name : null,
    status: typeof f.status === "string" ? f.status : null,
    pageId,
    createdTime: typeof f.created_time === "string" ? f.created_time : null,
  }));
}

// ── Contact dedupe (Part K) ──────────────────────────────────────────────

interface MetaContactMatch {
  id: string;
  full_name: string | null;
}

// Org-scoped only — a phone/email in one organization can never match
// another organization's contact (every query below is filtered by
// org_id). Priority: normalized phone first, then email; name is NEVER
// used for matching, and no fuzzy matching is performed anywhere in this
// function.
//
// Phone matching uses the bounded stored-format-variant approach
// documented in src/lib/identity-normalization.ts (mirrored in
// meta-lead-normalization.ts — see that file's header for why it isn't
// imported directly) rather than a single exact-match query, since this
// app does not store phone numbers in one consistent format.
async function findMatchingMetaContact(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  phone: string | null,
  email: string | null,
): Promise<MetaContactMatch | null> {
  if (phone) {
    const normalized = normalizePhoneForComparison(phone);
    const variants = phoneStorageVariants(normalized);
    if (variants.length > 0) {
      const { data } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name")
        .eq("org_id", orgId)
        .in("phone", variants)
        .limit(1)
        .maybeSingle();
      if (data) return data as MetaContactMatch;
    }
  }
  if (email) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name")
      .eq("org_id", orgId)
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (data) return data as MetaContactMatch;
  }
  return null;
}

// ── Error classification (Part V) ────────────────────────────────────────

export type MetaLeadIngestionErrorCode =
  | "lead_page_unresolved"
  | "lead_account_ambiguous"
  | "lead_permission_required"
  | "lead_not_found"
  | "lead_fetch_failed"
  | "token_decrypt_failed"
  | "contact_create_failed"
  | "crm_lead_create_failed";

// Exact numeric Meta codes below are Meta's long-documented, stable values
// (OAuthException/190 for invalid-or-expired tokens; 200/10 for permission
// errors, which is the code family a missing leads_retrieval grant would
// surface as; 100/803 for a missing/inaccessible lead object) — NOT
// independently re-verified against a live Graph response this session.
// Never returns/logs e.metaMessage's raw text.
function classifyMetaLeadFetchError(e: unknown): MetaLeadIngestionErrorCode {
  if (e instanceof MetaGraphApiError) {
    if (e.metaType === "OAuthException" || e.metaCode === 190) return "lead_permission_required";
    if (e.metaCode === 200 || e.metaCode === 10) return "lead_permission_required";
    if (e.httpStatus === 400 && (e.metaCode === 100 || e.metaCode === 803)) return "lead_not_found";
  }
  return "lead_fetch_failed";
}

async function markSubmissionFailed(supabaseAdmin: SupabaseClient, submissionId: string, errorCode: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("meta_lead_submissions")
    .update({ ingestion_status: "failed", ingestion_error: errorCode, updated_at: new Date().toISOString() })
    .eq("id", submissionId);
  if (error) {
    console.error("[meta-lead-ads] failed to mark submission failed (non-fatal):", error.message);
  }
}

// ── Ingestion pipeline (Part D/N/O/P) ────────────────────────────────────

export type MetaLeadIngestionResult =
  | { ok: true; status: "created" | "matched" | "duplicate"; leadId: string | null; contactId: string | null }
  | { ok: false; errorCode: MetaLeadIngestionErrorCode };

interface MetaLeadSubmissionRow {
  id: string;
  ingestion_status: string;
  lead_id: string | null;
  contact_id: string | null;
}

// The SINGLE ingestion entry point — called by meta-webhook.ts today, and
// designed so a future reconciliation pass (Part P) can call this exact
// same function with an independently-reconstructed MetaLeadgenEvent
// (e.g. from /{pageId}/leadgen_forms/{formId}/leads) rather than
// duplicating any CRM-creation logic.
//
// Durable processing order (Part N): reserve idempotently -> if already
// completed, return duplicate without touching Meta or CRM again -> fetch
// the full lead from Meta -> normalize -> resolve/create Contact -> ALWAYS
// create a fresh CRM Lead for a genuinely new submission -> persist
// attribution -> mark completed. Never marks a row completed before the
// CRM lead insert actually succeeds.
export async function processMetaLeadgenEvent(
  supabaseAdmin: SupabaseClient,
  event: MetaLeadgenEvent,
): Promise<MetaLeadIngestionResult> {
  const resolution = await resolveMetaLeadAdsConnectionForPage(supabaseAdmin, event.pageId);
  if (!resolution.ok) {
    console.warn("[meta-lead-ads] org resolution failed", { pageId: event.pageId, reason: resolution.reason });
    return { ok: false, errorCode: resolution.reason === "ambiguous" ? "lead_account_ambiguous" : "lead_page_unresolved" };
  }
  const { orgId, accessTokenEncrypted } = resolution;

  // Atomic reservation — plain INSERT relying on the (org_id, meta_lead_id)
  // unique constraint, not a SELECT-then-INSERT. Two concurrent deliveries
  // of the same lead can never both win this insert; the loser falls
  // through to the 23505 branch below and re-reads the winner's row,
  // race-safe by construction (DB uniqueness), never by application-level
  // timing.
  const { data: insertedRow, error: insertErr } = await supabaseAdmin
    .from("meta_lead_submissions")
    .insert({
      org_id: orgId,
      meta_lead_id: event.metaLeadId,
      page_id: event.pageId,
      form_id: event.formId,
      ad_id: event.adId,
      adset_id: event.adSetId,
      created_time: event.createdTime,
      ingestion_status: "pending",
    })
    .select("id, ingestion_status, lead_id, contact_id")
    .maybeSingle();

  let submissionRow: MetaLeadSubmissionRow;

  if (insertErr) {
    if (insertErr.code === "23505") {
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("meta_lead_submissions")
        .select("id, ingestion_status, lead_id, contact_id")
        .eq("org_id", orgId)
        .eq("meta_lead_id", event.metaLeadId)
        .maybeSingle();
      if (fetchErr || !existing) {
        console.error("[meta-lead-ads] could not load existing submission after conflict:", fetchErr?.message);
        return { ok: false, errorCode: "lead_fetch_failed" };
      }
      submissionRow = existing as MetaLeadSubmissionRow;
    } else {
      console.error("[meta-lead-ads] submission reservation failed:", insertErr.message);
      return { ok: false, errorCode: "lead_fetch_failed" };
    }
  } else if (!insertedRow) {
    console.error("[meta-lead-ads] submission insert returned no row unexpectedly");
    return { ok: false, errorCode: "lead_fetch_failed" };
  } else {
    submissionRow = insertedRow as MetaLeadSubmissionRow;
  }

  // Already fully ingested — a replay (Meta redelivery, duplicate webhook,
  // or reconciliation re-processing a lead the webhook already handled).
  // Never create a second CRM lead for the same Meta lead ID.
  if (submissionRow.ingestion_status === "matched" || submissionRow.ingestion_status === "created") {
    return { ok: true, status: "duplicate", leadId: submissionRow.lead_id, contactId: submissionRow.contact_id };
  }
  // status is "pending" (first attempt) or "failed" (deliberate retry) —
  // proceed, reusing this exact row rather than inserting a second one.

  let accessToken: string;
  try {
    accessToken = decryptMetaAccessToken(accessTokenEncrypted);
  } catch {
    await markSubmissionFailed(supabaseAdmin, submissionRow.id, "token_decrypt_failed");
    return { ok: false, errorCode: "token_decrypt_failed" };
  }

  let rawLead: RawMetaLead;
  try {
    rawLead = await fetchMetaLeadById(accessToken, event.metaLeadId);
  } catch (e) {
    const errorCode = classifyMetaLeadFetchError(e);
    if (e instanceof MetaGraphApiError) {
      // Part W's allowlist for this feature is stricter than
      // MetaGraphApiError.toSafeJSON()'s general-purpose shape (used
      // as-is for Phase 1A reporting diagnostics) — deliberately omits
      // metaMessage (Meta's own free-text error description) here, logging
      // only the fixed structured fields the task explicitly allows.
      console.error("[meta-lead-ads] lead fetch failed", {
        httpStatus: e.httpStatus,
        metaType: e.metaType,
        metaCode: e.metaCode,
        metaErrorSubcode: e.metaErrorSubcode,
        fbTraceId: e.fbTraceId,
        isTransient: e.isTransient,
      });
    }
    await markSubmissionFailed(supabaseAdmin, submissionRow.id, errorCode);
    return { ok: false, errorCode };
  }

  const parsedFieldData: MetaFieldDatum[] = parseMetaFieldData(rawLead.field_data);
  const normalized = normalizeMetaLeadFields(parsedFieldData);

  // Persist raw + normalized + enrichment attribution BEFORE CRM linking,
  // so even a CRM-side failure below leaves a durable, inspectable record
  // of what Meta actually returned (Part N: never lose retrieved data just
  // because a later step fails).
  const { error: updateErr } = await supabaseAdmin
    .from("meta_lead_submissions")
    .update({
      campaign_id: typeof rawLead.campaign_id === "string" ? rawLead.campaign_id : null,
      campaign_name: typeof rawLead.campaign_name === "string" ? rawLead.campaign_name : null,
      adset_id: typeof rawLead.adset_id === "string" ? rawLead.adset_id : event.adSetId,
      adset_name: typeof rawLead.adset_name === "string" ? rawLead.adset_name : null,
      ad_name: typeof rawLead.ad_name === "string" ? rawLead.ad_name : null,
      platform: typeof rawLead.platform === "string" ? rawLead.platform : null,
      raw_field_data: parsedFieldData,
      normalized_email: normalized.standard.email,
      normalized_phone: normalized.standard.phone,
      normalized_first_name: normalized.standard.firstName,
      normalized_last_name: normalized.standard.lastName,
      normalized_full_name: normalized.standard.fullName,
      normalized_company: normalized.standard.company,
      normalized_city: normalized.standard.city,
      normalized_state: normalized.standard.state,
      normalized_zip: normalized.standard.zip,
      custom_fields: normalized.customFields,
      updated_at: new Date().toISOString(),
    })
    .eq("id", submissionRow.id)
    .eq("org_id", orgId);
  if (updateErr) {
    // Non-fatal — CRM linking (the step that must not be skipped) still
    // proceeds below using the in-memory `normalized` values regardless of
    // whether this bookkeeping write succeeded.
    console.error("[meta-lead-ads] failed to persist normalized fields (non-fatal):", updateErr.message);
  }

  const contactMatch = await findMatchingMetaContact(supabaseAdmin, orgId, normalized.standard.phone, normalized.standard.email);

  let contactId: string;
  let contactStatus: "matched" | "created";
  let leadName: string | null;

  if (contactMatch) {
    contactId = contactMatch.id;
    contactStatus = "matched";
    leadName = contactMatch.full_name;
  } else {
    const fullName = normalized.standard.fullName || "Unknown Meta Ads lead";
    leadName = fullName;
    const basePayload = { org_id: orgId, full_name: fullName, email: normalized.standard.email, source: "meta_ads", labels: ["Lead"] };

    const contactResult = normalized.standard.phone
      ? await supabaseAdmin
          .from("contacts")
          .upsert({ ...basePayload, phone: normalized.standard.phone }, { onConflict: "org_id,phone", ignoreDuplicates: false })
          .select("id")
          .single()
      : await supabaseAdmin.from("contacts").insert(basePayload).select("id").single();

    if (contactResult.error || !contactResult.data) {
      await markSubmissionFailed(supabaseAdmin, submissionRow.id, "contact_create_failed");
      return { ok: false, errorCode: "contact_create_failed" };
    }
    contactId = contactResult.data.id as string;
    contactStatus = "created";
  }

  // Always a NEW lead for this submission (Important Business Rule, Part
  // L) — a matched, pre-existing contact is REUSED, but a lead is never
  // reused from an earlier submission by the same contact. One CRM
  // inquiry per unique Meta lead event, regardless of contact match.
  const { data: newLead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .insert({
      org_id: orgId,
      contact_id: contactId,
      source: "meta_ads",
      status: "new",
      notes: buildMetaLeadNote(typeof rawLead.campaign_name === "string" ? rawLead.campaign_name : null),
      custom_fields: {},
      name: leadName,
    })
    .select("id")
    .single();

  if (leadErr || !newLead) {
    await markSubmissionFailed(supabaseAdmin, submissionRow.id, "crm_lead_create_failed");
    return { ok: false, errorCode: "crm_lead_create_failed" };
  }
  const leadId = newLead.id as string;

  // Only marked completed AFTER the CRM lead insert above has actually
  // succeeded (Part N: "do not mark processed before CRM writes succeed").
  const { error: finalizeErr } = await supabaseAdmin
    .from("meta_lead_submissions")
    .update({
      contact_id: contactId,
      lead_id: leadId,
      ingestion_status: contactStatus,
      ingestion_error: null,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", submissionRow.id)
    .eq("org_id", orgId);
  if (finalizeErr) {
    // The CRM lead already exists — this is a bookkeeping-only failure,
    // never surfaced as an ingestion error (the important side effect
    // already succeeded; a future run would otherwise see this row still
    // "pending"/"failed" and correctly retry, at worst creating a second
    // lead for the same meta_lead_id only if this exact update keeps
    // failing indefinitely, an accepted rare edge case over silently
    // losing the real error).
    console.error("[meta-lead-ads] failed to finalize submission row (CRM lead WAS created):", finalizeErr.message);
  }

  return { ok: true, status: contactStatus, leadId, contactId };
}
