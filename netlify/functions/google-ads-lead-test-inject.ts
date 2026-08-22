// netlify/functions/google-ads-lead-test-inject.ts
//
// DEV-ONLY TEST HARNESS — Phase 3, Step 6C.1. Lets a developer inject a
// synthetic Google Ads lead-form submission through the EXACT SAME
// provider-persistence + CRM-linking pipeline used by real ingestion (see
// lib/google-ads-lead-ingestion.ts — insertGoogleAdsLeadSubmissions /
// ingestGoogleAdsSubmission, the same two functions
// google-ads-lead-sync.ts calls). This function never calls the Google
// Ads API and never touches any real Google Ads data — it only proves
// RenoMeta's own local ingestion behavior (dedupe, contact matching,
// lead creation, attribution linkage).
//
// THIS IS NOT A PRODUCTION BACKDOOR. The safety boundary is the explicit
// production guard below — isLocalDevContext() — which this function
// checks FIRST, before authentication, before parsing the body, before
// anything else. A hidden frontend button is a convenience, never the
// actual protection; the endpoint refuses to run outside a real local
// `netlify dev` session regardless of what calls it.
//
// Never logs or returns: real PII beyond what the developer themselves
// typed into the test form, any token, or a raw provider response (there
// is no provider response here at all — no Google API call is made).

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { preflightGoogleAdsConnection, type GoogleAdsConnectionRowForSummary } from "./lib/google-ads-api";
import {
  parseGoogleAdsLeadFormFields,
  normalizeGoogleAdsLeadFields,
  normalizeGoogleAdsLeadEmail,
  normalizeGoogleAdsLeadPhone,
} from "./lib/google-ads-lead-fields";
import {
  insertGoogleAdsLeadSubmissions,
  ingestGoogleAdsSubmission,
  type GoogleAdsSubmissionInsertPayload,
} from "./lib/google-ads-lead-ingestion";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

// Positive allowlist, not a "production" blacklist: NETLIFY_DEV is set to
// "true" by the Netlify CLI ONLY for `netlify dev` — it is never set in
// any real deploy (production, deploy preview, AND branch deploy all run
// via `netlify deploy`/CI, never the local CLI dev server). This refuses
// to run anywhere except an actual local dev session, not just literal
// "production". CONTEXT/NODE_ENV checks are added defense-in-depth.
function isLocalDevContext(): boolean {
  return (
    process.env.NETLIFY_DEV === "true" &&
    process.env.CONTEXT !== "production" &&
    process.env.NODE_ENV !== "production"
  );
}

interface TestInjectRequestBody {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  submissionId?: unknown;
  campaignName?: unknown;
  gclid?: unknown;
  campaignId?: unknown;
  assetId?: unknown;
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function safeStringOrNull(v: unknown): string | null {
  const s = safeString(v);
  return s.length > 0 ? s : null;
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  // Production guard FIRST — before auth, before body parsing, before
  // anything. This endpoint does not exist outside local dev, full stop.
  // 404 (not 403) so a scan/probe against a real deployment doesn't even
  // learn the route exists.
  if (!isLocalDevContext()) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Not found" }) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  // Same connection/customer resolution as real ingestion — never accepts
  // organization_id or a customer ID from the request; always the org's
  // actual selected Google Ads connection.
  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-lead-test-inject] connection_lookup_failed", { code: connErr.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_configuration" }) };
  }
  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return { statusCode, headers, body: JSON.stringify({ error: preflight.errorCode }) };
  }
  const { selectedCustomerId } = preflight;

  let reqBody: TestInjectRequestBody;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  // Only these controlled fields are ever read — no organization_id,
  // customer ID, contact_id, or lead_id can be supplied by the caller.
  const submissionId = safeString(reqBody.submissionId);
  if (!submissionId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "submissionId is required" }) };
  }
  const firstName = safeString(reqBody.firstName);
  const lastName = safeString(reqBody.lastName);
  const email = safeString(reqBody.email);
  const phone = safeString(reqBody.phone);
  const campaignName = safeStringOrNull(reqBody.campaignName);
  const gclid = safeStringOrNull(reqBody.gclid);
  const campaignId = safeStringOrNull(reqBody.campaignId);
  const assetId = safeStringOrNull(reqBody.assetId);

  // Builds the SAME internal field shape a real Google row uses, so
  // normalization runs through the identical parseGoogleAdsLeadFormFields()
  // / normalizeGoogleAdsLeadFields() code path — never a second parsing
  // implementation. The synthetic marker rides alongside the real field
  // entries in the same array; normalizeGoogleAdsLeadFields() ignores any
  // unrecognized fieldType, so it's inert for normalization while
  // remaining visible in the persisted row (Step 4 — clearly marks this as
  // a test fixture without changing schema).
  const syntheticRawFields = [
    firstName ? { fieldType: "FIRST_NAME", fieldValue: firstName } : null,
    lastName ? { fieldType: "LAST_NAME", fieldValue: lastName } : null,
    email ? { fieldType: "EMAIL", fieldValue: email } : null,
    phone ? { fieldType: "PHONE_NUMBER", fieldValue: phone } : null,
    { fieldType: "__renometa_test_fixture", fieldValue: "true" },
  ].filter((f): f is { fieldType: string; fieldValue: string } => f !== null);

  const parsedFields = parseGoogleAdsLeadFormFields(syntheticRawFields);
  const normalized = normalizeGoogleAdsLeadFields(parsedFields);

  // Provider identity is STILL organization_id + google_ads_customer_id +
  // google_submission_id — the test harness doesn't bypass or weaken that,
  // it just supplies a caller-chosen submissionId instead of one from a
  // real Google API response.
  const payload: GoogleAdsSubmissionInsertPayload = {
    organization_id: orgId,
    google_ads_customer_id: selectedCustomerId,
    google_submission_id: submissionId,
    google_resource_name: null,
    campaign_id: campaignId,
    campaign_name: campaignName,
    asset_id: assetId,
    ad_group_id: null,
    ad_group_ad_id: null,
    gclid,
    submission_date_time: new Date().toISOString(),
    raw_fields: parsedFields,
    raw_custom_fields: [],
    normalized_email: normalizeGoogleAdsLeadEmail(normalized.email),
    normalized_phone: normalizeGoogleAdsLeadPhone(normalized.phone),
    normalized_first_name: normalized.firstName,
    normalized_last_name: normalized.lastName,
    normalized_full_name: normalized.fullName,
    ingestion_status: "pending",
  };

  let inserted;
  try {
    inserted = await insertGoogleAdsLeadSubmissions(supabaseAdmin, [payload]);
  } catch (e: any) {
    console.error("[google-ads-lead-test-inject] insert_failed", { code: e?.code });
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server_configuration" }) };
  }

  if (inserted.length === 0) {
    // Same organization_id + google_ads_customer_id + google_submission_id
    // already exists — idempotent replay (Step 8). No new contact, no new
    // lead, no new provider row.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        duplicate: true,
        contactCreated: false,
        contactMatched: false,
        leadCreated: false,
        contactId: null,
        leadId: null,
        submissionId,
        ingestionStatus: "duplicate",
      }),
    };
  }

  const row = inserted[0];
  const result = await ingestGoogleAdsSubmission(supabaseAdmin, orgId, row);

  if (!result.ok) {
    // ingestGoogleAdsSubmission() already marked the row 'failed' — same
    // failure-handling path a real submission gets, nothing test-specific.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        duplicate: false,
        submissionId,
        ingestionStatus: "failed",
        error: "crm_link_failed",
      }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      duplicate: false,
      contactCreated: result.status === "created",
      contactMatched: result.status === "matched",
      leadCreated: true,
      contactId: result.contactId,
      leadId: result.leadId,
      submissionId,
      ingestionStatus: result.status,
    }),
  };
};
