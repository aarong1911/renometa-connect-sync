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
import {
  getMetaPageAccessToken,
  MetaPageTokenMissingError,
  ensureMetaPageFieldsSubscribed,
} from "./meta-page-access";
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
// Reusable for later UI/reconciliation — now consumed by meta-lead-forms.ts
// and reconcileMetaLeadAds() (Phase 1B / Step 2 Page Token Fix).
//
// IMPORTANT — accessToken here must be a PAGE-scoped token (see
// getMetaPageAccessToken above), not the stored long-lived USER token:
// /{page_id}/leadgen_forms is a Page-scoped edge and rejects the user
// token with OAuthException/190, confirmed via live testing. This
// function's own implementation is unchanged/token-agnostic (it just
// forwards whatever token it's given to metaGraphPaginate) — the fix is
// entirely in what callers now pass in.

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

export async function discoverMetaLeadForms(pageAccessToken: string, pageId: string): Promise<MetaLeadFormSummary[]> {
  const page = await metaGraphPaginate<RawMetaLeadForm>({
    path: `/${pageId}/leadgen_forms`,
    accessToken: pageAccessToken,
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

// ── Page webhook subscription (Phase 1B / Step 2, Parts 26-29) ──────────
//
// AUDIT FINDING: a Page never receives ANY webhook delivery — Messenger,
// Instagram, or Lead Ads alike — until the app has explicitly subscribed
// it via POST /{page_id}/subscribed_apps. Granting OAuth scopes
// (leads_retrieval, pages_manage_ads, pages_messaging, etc.) does NOT
// auto-subscribe a Page to anything; this is a separate, mandatory
// Graph API call. Confirmed by searching this entire repository for
// "subscribed_apps"/"subscribed_fields" before this file: ZERO matches —
// no product's connect flow (Messenger, Instagram, WhatsApp, or Lead Ads)
// has ever performed this call. This is a real, pre-existing gap that
// also affects Messenger/Instagram; fixing it for those products is out
// of scope here (Step 2 is Lead Ads only) — flagged in the Step 2 report.
//
// The required call needs a PAGE access token, not the long-lived USER
// token meta_connections already stores (Part 29's exact question). No
// token-storage redesign is needed to get one: a Page access token can be
// DERIVED on demand from the existing stored user token via
// GET /{page_id}?fields=access_token (standard, documented Graph API
// behavior — works as long as the connecting user has admin access to the
// Page, which pages_show_list/pages_manage_ads already require). The
// derived Page token is used only transiently for this one call and is
// never persisted.
//
// Phase 1B / Step 2 follow-up (Page Token Fix): live testing showed
// meta-lead-forms.ts's form discovery (/{page_id}/leadgen_forms) fails
// with HTTP 400 / OAuthException / code 190 when called with the stored
// USER token — the same class of Page-scoped-endpoint rejection this
// subscription flow already worked around. Every Page-scoped Lead Ads read
// (leadgen_forms discovery, per-form /leads enumeration) needs the SAME
// derived Page token this function already used internally — extracted
// below into a shared helper so meta-lead-forms.ts and
// reconcileMetaLeadAds() don't each reimplement this derivation.

// getMetaPageAccessToken/MetaPageTokenMissingError now live in the generic
// lib/meta-page-access.ts (Meta Messaging Webhook Hardening pass), which
// Messenger/Instagram subscription logic also uses — re-exported here
// unchanged so existing callers (meta-lead-forms.ts, meta-lead-reconcile.ts)
// don't need to change their import path.
export { getMetaPageAccessToken, MetaPageTokenMissingError } from "./meta-page-access";

export type EnsureLeadgenSubscriptionErrorCode = "permission_required" | "reconnect_required" | "subscription_failed";

export interface EnsureLeadgenSubscriptionResult {
  ok: boolean;
  alreadySubscribed: boolean;
  errorCode?: EnsureLeadgenSubscriptionErrorCode;
}

// Idempotent (Part 28) by construction: reads the Page's CURRENT
// subscribed_fields first via GET, and only issues the POST if "leadgen"
// isn't already present — preserving every other already-subscribed field
// (Part 27) rather than overwriting the set. Calling this twice in a row
// is always safe: the second call sees "leadgen" already present and
// returns alreadySubscribed:true without writing anything.
export async function ensureMetaLeadgenSubscription(
  userAccessToken: string,
  pageId: string,
): Promise<EnsureLeadgenSubscriptionResult> {
  let pageAccessToken: string;
  try {
    pageAccessToken = await getMetaPageAccessToken(userAccessToken, pageId);
  } catch (e) {
    const reconnect = e instanceof MetaGraphApiError && (e.metaType === "OAuthException" || e.metaCode === 190);
    return { ok: false, alreadySubscribed: false, errorCode: reconnect ? "reconnect_required" : "permission_required" };
  }

  // Delegates to the generic, product-agnostic field-preserving subscription
  // helper (lib/meta-page-access.ts) — identical external behavior to the
  // original inline implementation: preserves every other already-subscribed
  // field, idempotent, no token persistence, no raw Meta errors surfaced.
  return ensureMetaPageFieldsSubscribed(pageAccessToken, pageId, ["leadgen"]);
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

// ── Reconciliation (Phase 1B / Step 2, Parts 6-15) ───────────────────────
//
// Enumerates recent leads from every discovered Lead Ads form on the
// org's connected Page and feeds each one through processMetaLeadgenEvent
// — the EXACT SAME ingestion path the webhook uses. There is no second
// CRM-creation implementation anywhere in this file. The webhook remains
// the PRIMARY ingestion path (near-real-time); this exists purely as a
// fallback for missed/failed webhook deliveries — callable manually today
// (meta-lead-reconcile.ts) and from a future scheduled automation with no
// further CRM-logic changes, since this function's own signature already
// takes no request-specific state beyond org/window.

export const META_RECONCILE_WINDOWS = ["1h", "6h", "24h", "72h", "7d"] as const;
export type MetaReconcileWindow = (typeof META_RECONCILE_WINDOWS)[number];

const RECONCILE_WINDOW_TO_MS: Record<MetaReconcileWindow, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "72h": 72 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

// Hard safety caps (Part 13) — chosen against the existing bounded
// paginator architecture (metaGraphPaginate's own pageLimit/maxPages
// parameters), never an unbounded crawl. Reported exactly in the Step 2
// report: forms 50, pages/form 5, leads/run 500.
const MAX_FORMS_SCANNED = 50;
const MAX_PAGES_PER_FORM = 5;
const RECONCILE_LEADS_PAGE_LIMIT = 25;
const MAX_LEADS_PER_RUN = 500;

export type MetaReconcileErrorCode = "not_connected" | "reconnect_required" | "permission_required" | "token_decrypt_failed";

export interface MetaReconcileFailure {
  metaLeadId: string;
  errorCode: MetaLeadIngestionErrorCode;
}

export type MetaReconcileResult =
  | {
      ok: true;
      formsScanned: number;
      leadsDiscovered: number;
      created: number;
      matched: number;
      duplicates: number;
      failed: number;
      failures: MetaReconcileFailure[];
      truncated: boolean;
    }
  | { ok: false; errorCode: MetaReconcileErrorCode };

interface RawMetaLeadListItem {
  id: string;
  created_time?: string;
}

// Account-wide failures (bad/expired token, missing leads_retrieval) stop
// the ENTIRE reconciliation run early (Part 14) rather than repeating the
// same failure for every remaining form. A single inaccessible/errored
// form, by contrast, is recorded and skipped — the run continues with
// whatever forms remain.
function classifyReconcileAccountError(e: unknown): "reconnect_required" | "permission_required" | null {
  if (e instanceof MetaPageTokenMissingError) return "permission_required";
  if (e instanceof MetaGraphApiError) {
    if (e.metaType === "OAuthException" || e.metaCode === 190) return "reconnect_required";
    if (e.metaCode === 200 || e.metaCode === 10) return "permission_required";
  }
  return null;
}

// The single reconciliation entry point — resolves the CALLING org's own
// Lead Ads connection server-side (never accepts a page/org/form ID from
// the caller as authorization, matching Step 1's isolation model), then
// discovers forms, enumerates recent leads per form, and calls
// processMetaLeadgenEvent() for each one. A future scheduled automation
// can call this exact function unmodified.
export async function reconcileMetaLeadAds(
  supabaseAdmin: SupabaseClient,
  orgId: string,
  window: MetaReconcileWindow = "24h",
): Promise<MetaReconcileResult> {
  const { data: connection, error: connErr } = await supabaseAdmin
    .from("meta_connections")
    .select("id, page_id, access_token")
    .eq("org_id", orgId)
    .eq("product", "lead_ads")
    .maybeSingle();

  if (connErr) {
    console.error("[meta-lead-ads] reconcile: connection lookup failed:", connErr.message);
    return { ok: false, errorCode: "not_connected" };
  }
  if (!connection || !connection.page_id || !connection.access_token) {
    return { ok: false, errorCode: "not_connected" };
  }
  const pageId: string = connection.page_id;

  let userAccessToken: string;
  try {
    userAccessToken = decryptMetaAccessToken(connection.access_token);
  } catch {
    return { ok: false, errorCode: "token_decrypt_failed" };
  }

  // Derived ONCE per reconciliation run (Part 13: "do not derive it once
  // per form") and reused for every Page-scoped call below — form
  // discovery AND every form's /leads enumeration. Never re-derived inside
  // the forms loop, never persisted, never logged, never returned to the
  // caller. Page-scoped Lead Ads reads (leadgen_forms, /leads) reject the
  // stored long-lived USER token with OAuthException/190 — the same class
  // of rejection ensureMetaLeadgenSubscription already worked around.
  let pageAccessToken: string;
  try {
    pageAccessToken = await getMetaPageAccessToken(userAccessToken, pageId);
  } catch (e) {
    const code = classifyReconcileAccountError(e);
    if (code) return { ok: false, errorCode: code };
    // Deriving the Page token failed for a non-account reason (transient
    // network/5xx) — nothing to scan this run; same clean-zero fallback
    // already used below for a form-discovery-level transient failure, so
    // a transient blip never reads as "reconnect your account".
    return { ok: true, formsScanned: 0, leadsDiscovered: 0, created: 0, matched: 0, duplicates: 0, failed: 0, failures: [], truncated: false };
  }

  let forms: MetaLeadFormSummary[];
  try {
    const allForms = await discoverMetaLeadForms(pageAccessToken, pageId);
    forms = allForms.slice(0, MAX_FORMS_SCANNED);
  } catch (e) {
    const code = classifyReconcileAccountError(e);
    if (code) return { ok: false, errorCode: code };
    // Form discovery itself failing for a non-account reason (transient
    // network/5xx) — nothing to scan this run; reported as a clean zero
    // rather than a hard error, so a transient blip never reads as
    // "reconnect your account".
    return { ok: true, formsScanned: 0, leadsDiscovered: 0, created: 0, matched: 0, duplicates: 0, failed: 0, failures: [], truncated: false };
  }

  const windowCutoffMs = Date.now() - RECONCILE_WINDOW_TO_MS[window];
  const sinceEpochSeconds = Math.floor(windowCutoffMs / 1000);

  let formsScanned = 0;
  let leadsDiscovered = 0;
  let created = 0;
  let matched = 0;
  let duplicates = 0;
  let failed = 0;
  let truncated = false;
  const failures: MetaReconcileFailure[] = [];

  formLoop: for (const form of forms) {
    if (leadsDiscovered >= MAX_LEADS_PER_RUN) {
      truncated = true;
      break;
    }
    formsScanned++;

    let leadItems: RawMetaLeadListItem[];
    try {
      // `since` (Unix seconds) is a documented Meta Lead Ads Retrieval
      // param for this exact edge — not independently re-verified against
      // a live response this session. Results are ALSO filtered
      // client-side against the same window below as defense in depth, in
      // case the param isn't honored exactly as documented.
      const page = await metaGraphPaginate<RawMetaLeadListItem>({
        path: `/${form.formId}/leads`,
        accessToken: pageAccessToken,
        query: { fields: "id,created_time", since: sinceEpochSeconds },
        pageLimit: RECONCILE_LEADS_PAGE_LIMIT,
        maxPages: MAX_PAGES_PER_FORM,
      });
      leadItems = page.items;
    } catch (e) {
      const code = classifyReconcileAccountError(e);
      if (code) return { ok: false, errorCode: code };
      console.warn("[meta-lead-ads] reconcile: form leads fetch failed, continuing with remaining forms", { formId: form.formId });
      continue;
    }

    for (const item of leadItems) {
      if (leadsDiscovered >= MAX_LEADS_PER_RUN) {
        truncated = true;
        break formLoop;
      }
      if (typeof item.id !== "string" || !item.id) continue;

      const createdTimeMs = item.created_time ? Date.parse(item.created_time) : NaN;
      if (Number.isFinite(createdTimeMs) && createdTimeMs < windowCutoffMs) continue; // defense-in-depth window filter

      leadsDiscovered++;

      // Same normalized event identity the webhook constructs (Part 9) —
      // ad_id/adset_id are left null here (the /leads list edge doesn't
      // return them per-item); processMetaLeadgenEvent's own full
      // /{lead_id} retrieval fills in real attribution regardless, exactly
      // as it already does for a webhook delivery with incomplete
      // attribution. The DB unique key (org_id, meta_lead_id) — never
      // created_time/email/phone — remains the sole idempotency authority
      // (Part 9).
      const event: MetaLeadgenEvent = {
        metaLeadId: item.id,
        pageId,
        formId: form.formId,
        adId: null,
        adSetId: null,
        createdTime: Number.isFinite(createdTimeMs) ? new Date(createdTimeMs).toISOString() : null,
      };

      const result = await processMetaLeadgenEvent(supabaseAdmin, event);
      if (!result.ok) {
        failed++;
        failures.push({ metaLeadId: item.id, errorCode: result.errorCode });
        continue;
      }
      if (result.status === "created") created++;
      else if (result.status === "matched") matched++;
      else duplicates++;
    }
  }

  return { ok: true, formsScanned, leadsDiscovered, created, matched, duplicates, failed, failures, truncated };
}
