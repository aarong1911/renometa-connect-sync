// netlify/functions/google-ads-conversion-export.ts
//
// Phase 3, Step 7B.2: the FIRST and ONLY endpoint in this codebase allowed
// to call Google Ads' offline click-conversion upload API
// (customers:uploadClickConversions, via lib/google-ads-conversion-upload.ts's
// uploadSingleGoogleAdsClickConversion()). Uploads exactly ONE local
// google_ads_conversion_events row per call (Step 10 — single-event
// strategy, chosen for simple, unambiguous error-to-event correlation).
//
// Input is deliberately minimal: { eventId }. Every other value — org,
// selected Google Ads customer, gclid, conversion action resource name,
// event time, event type, conversion value, currency — is resolved
// server-side from the event row, its linked google_ads_lead_submissions
// row, the org's google_ads_conversion_mappings row, and a LIVE Google Ads
// conversion_action re-check. None of those are ever accepted from the
// request body, so a caller cannot fabricate or redirect an upload.
//
// Guard ordering is deliberate and safety-critical (Step 17): the
// LOCAL-ONLY checks (already-exported, synthetic fixture, not-ready,
// missing gclid) run FIRST, before the OAuth token is even refreshed —
// a synthetic fixture is rejected with ZERO network calls of any kind,
// not just zero calls to googleads.googleapis.com.
//
// Never logs or returns: encrypted_refresh_token, the decrypted refresh
// token, the temporary access token, GOOGLE_ADS_CLIENT_SECRET,
// GOOGLE_ADS_DEVELOPER_TOKEN, or a raw Google response body.

import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { resolveOrgFromBearerToken } from "./lib/resolve-org";
import { googleAdsCorsHeaders } from "./lib/google-ads-cors";
import { decryptBytea } from "./lib/gmail-token-crypto";
import { refreshGoogleAdsAccessToken } from "./lib/google-ads-oauth-token";
import {
  searchGoogleAds,
  parseGoogleAdsConversionActions,
  preflightGoogleAdsConnection,
  GoogleAdsApiError,
  GoogleAdsResultLimitExceededError,
  GOOGLE_ADS_CONVERSION_ACTIONS_QUERY,
  GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE,
  type GoogleAdsConnectionRowForSummary,
} from "./lib/google-ads-api";
import {
  checkGoogleAdsConversionEventPreExport,
  checkGoogleAdsConversionMappingForExport,
  checkGoogleAdsConversionActionForExport,
  type GoogleAdsConversionEventType,
  type GoogleAdsConversionExportStatus,
} from "./lib/google-ads-conversion-events";
import {
  formatGoogleAdsConversionDateTime,
  buildGoogleAdsConversionActionResourceName,
  uploadSingleGoogleAdsClickConversion,
} from "./lib/google-ads-conversion-upload";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface ConversionEventRow {
  id: string;
  organization_id: string;
  google_ads_customer_id: string;
  google_ads_lead_submission_id: string;
  event_type: GoogleAdsConversionEventType;
  event_at: string;
  gclid: string | null;
  conversion_value: number | string | null;
  currency_code: string | null;
  export_status: GoogleAdsConversionExportStatus;
  export_attempt_count: number;
}

interface SubmissionRawFieldsRow {
  raw_fields: unknown;
}

interface RequestBody {
  eventId?: unknown;
}

function errorResponse(headers: Record<string, string>, statusCode: number, errorCode: string) {
  return { statusCode, headers, body: JSON.stringify({ ok: false, error: errorCode }) };
}

export const handler: Handler = async (event) => {
  const headers = googleAdsCorsHeaders(event, "POST, OPTIONS");

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const resolved = await resolveOrgFromBearerToken(supabaseAdmin, event.headers.authorization);
  if (!resolved) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const { orgId } = resolved;

  let reqBody: RequestBody;
  try {
    reqBody = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const eventId = typeof reqBody.eventId === "string" ? reqBody.eventId.trim() : "";
  if (!eventId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "eventId is required" }) };
  }

  // ── 1. Load the conversion event, strictly org-scoped ──────────────────
  const { data: conversionEvent, error: eventErr } = await supabaseAdmin
    .from("google_ads_conversion_events")
    .select("id, organization_id, google_ads_customer_id, google_ads_lead_submission_id, event_type, event_at, gclid, conversion_value, currency_code, export_status, export_attempt_count")
    .eq("id", eventId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (eventErr) {
    console.error("[google-ads-conversion-export] event_lookup_failed", { code: eventErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }
  if (!conversionEvent) {
    return errorResponse(headers, 404, "event_not_found");
  }
  const evt = conversionEvent as ConversionEventRow;

  // ── 2. Load the linked provider submission's raw_fields — the ONLY
  // source of the canonical synthetic-fixture marker. Guaranteed to exist
  // by the google_ads_lead_submission_id FK (not-null, on delete cascade);
  // a missing row here means the FK itself is somehow broken, which is an
  // anomaly, not a normal rejection path.
  const { data: submission, error: subErr } = await supabaseAdmin
    .from("google_ads_lead_submissions")
    .select("raw_fields")
    .eq("id", evt.google_ads_lead_submission_id)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (subErr) {
    console.error("[google-ads-conversion-export] submission_lookup_failed", { code: subErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }
  if (!submission) {
    console.error("[google-ads-conversion-export] orphaned_conversion_event", { eventId });
    return errorResponse(headers, 500, "google_ads_attribution_not_found");
  }
  const rawFields = (submission as SubmissionRawFieldsRow).raw_fields;

  // ── 3. Phase A — LOCAL-ONLY checks. No network call of any kind has
  // happened yet, and none will happen if this rejects (Step 17).
  const preCheck = checkGoogleAdsConversionEventPreExport(
    { exportStatus: evt.export_status, gclid: evt.gclid },
    rawFields,
  );
  if (!preCheck.ok) {
    return errorResponse(headers, preCheck.reason === "missing_gclid" ? 422 : 409, preCheck.reason);
  }
  // gclid is guaranteed non-null past this point by checkGoogleAdsConversionEventPreExport.
  const gclid = evt.gclid!;

  // ── 4. Mapping lookup — event_type -> conversion_action_id for this
  // org + the customer this EVENT was created under (never the org's
  // current selection, which could have changed since — see the
  // customer-mismatch guard below).
  const { data: mapping, error: mappingErr } = await supabaseAdmin
    .from("google_ads_conversion_mappings")
    .select("conversion_action_id, enabled")
    .eq("organization_id", orgId)
    .eq("google_ads_customer_id", evt.google_ads_customer_id)
    .eq("event_type", evt.event_type)
    .maybeSingle();

  if (mappingErr) {
    console.error("[google-ads-conversion-export] mapping_lookup_failed", { code: mappingErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const mappingCheck = checkGoogleAdsConversionMappingForExport(mapping ?? null);
  if (!mappingCheck.ok) {
    return errorResponse(headers, 404, mappingCheck.reason);
  }

  // ── 5. Load the org's Google Ads connection + preflight (same pattern
  // as every other Google Ads endpoint) ──────────────────────────────────
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    console.error("[google-ads-conversion-export] server_configuration: missing developer token");
    return errorResponse(headers, 500, "server_configuration");
  }

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-conversion-export] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId, loginCustomerId } = preflight;

  // Step 11, security-flow item 4: verify the event belongs to the
  // CURRENTLY selected Google Ads customer — an org that re-selected a
  // different advertiser since this event was created must not have it
  // uploaded against the new selection's credentials.
  if (evt.google_ads_customer_id !== selectedCustomerId) {
    return errorResponse(headers, 409, "event_customer_mismatch");
  }

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection!.encrypted_refresh_token!);
  } catch {
    console.error("[google-ads-conversion-export] decrypt_failed");
    return errorResponse(headers, 500, "server_configuration");
  }

  const tokenResult = await refreshGoogleAdsAccessToken(refreshTokenPlain);
  if (!tokenResult.ok) {
    if (tokenResult.errorCode === "reconnect_required") {
      await supabaseAdmin
        .from("google_ads_connections")
        .update({ status: "needs_account_sync", last_error_code: "reconnect_required", updated_at: new Date().toISOString() })
        .eq("id", connection!.id)
        .eq("organization_id", orgId);
      return errorResponse(headers, 409, "reconnect_required");
    }
    return errorResponse(headers, 500, tokenResult.errorCode);
  }
  const { accessToken } = tokenResult;

  // ── 6. Step 20 — live revalidation. Never trusts the mapping's
  // conversion_action_id as still valid just because it was valid when
  // saved; re-fetches this customer's own ENABLED conversion actions now.
  let liveAction: { status: string | null; type: string | null } | null = null;
  try {
    const results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_CONVERSION_ACTIONS_QUERY, loginCustomerId);
    const actions = parseGoogleAdsConversionActions(results);
    const found = actions.find((a) => a.id === mappingCheck.conversionActionId);
    liveAction = found ? { status: found.status, type: found.type } : null;
  } catch (e) {
    if (e instanceof GoogleAdsResultLimitExceededError) {
      console.error("[google-ads-conversion-export] result_limit_exceeded");
      return errorResponse(headers, 500, "result_limit_exceeded");
    }
    if (e instanceof GoogleAdsApiError) {
      console.error("[google-ads-conversion-export] google_ads_api_error", { status: e.status });
      return errorResponse(headers, 500, "google_ads_api_error");
    }
    console.error("[google-ads-conversion-export] network_error");
    return errorResponse(headers, 500, "network_error");
  }

  const actionCheck = checkGoogleAdsConversionActionForExport(liveAction, GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE);
  if (!actionCheck.ok) {
    return errorResponse(headers, actionCheck.reason === "conversion_action_not_found" ? 404 : 422, actionCheck.reason);
  }

  // ── 7. Build the payload. Step 21: no goal/bidding/campaign mutation of
  // any kind happens anywhere in this file — this is upload only.
  const conversionActionResourceName = buildGoogleAdsConversionActionResourceName(selectedCustomerId, mappingCheck.conversionActionId);
  const conversionDateTime = formatGoogleAdsConversionDateTime(evt.event_at);

  // Step 7 — value/currency rule: qualified_lead and appointment_booked
  // NEVER send a value, regardless of what (if anything) is stored.
  // deal_won sends conversionValue + currencyCode ONLY when BOTH are
  // present — a value with no trusted currency is monetarily meaningless
  // to Google, and this repo still has no canonical org-wide currency
  // field to safely supply one. Chosen behavior (Option A from the task):
  // still upload the deal_won conversion as a plain occurrence signal
  // (no value) rather than blocking the entire conversion from ever being
  // exported just because currency configuration doesn't exist yet —
  // never fabricates a currency to force the value through.
  let conversionValue: number | undefined;
  let currencyCode: string | undefined;
  if (evt.event_type === "deal_won") {
    const rawValue = evt.conversion_value;
    const numericValue = rawValue === null || rawValue === undefined ? null : Number(rawValue);
    if (numericValue !== null && Number.isFinite(numericValue) && evt.currency_code) {
      conversionValue = numericValue;
      currencyCode = evt.currency_code;
    }
  }

  // ── 8. Bump attempt bookkeeping BEFORE the network call — an attempt is
  // being made now, regardless of outcome. export_status is deliberately
  // NOT changed here (Step 8: "before request: do NOT set exported").
  const attemptTimestamp = new Date().toISOString();
  await supabaseAdmin
    .from("google_ads_conversion_events")
    .update({ export_attempt_count: evt.export_attempt_count + 1, last_export_attempt_at: attemptTimestamp })
    .eq("id", evt.id)
    .eq("organization_id", orgId);

  // ── 9. The one and only call to Google's offline click-conversion
  // upload endpoint in this entire codebase.
  const uploadResult = await uploadSingleGoogleAdsClickConversion(accessToken, developerToken, selectedCustomerId, loginCustomerId, {
    gclid,
    conversionActionResourceName,
    conversionDateTime,
    conversionValue,
    currencyCode,
  });

  // ── 10. Persist result. Only a confirmed `ok: true` parse result marks
  // the event 'exported' — an HTTP error, network error, or
  // partialFailureError all mark it 'failed' with the error persisted,
  // never 'exported'.
  if (uploadResult.ok) {
    await supabaseAdmin
      .from("google_ads_conversion_events")
      .update({
        export_status: "exported",
        exported_at: new Date().toISOString(),
        google_upload_resource_name: uploadResult.result.conversionAction,
        last_error_code: null,
        last_error_message: null,
      })
      .eq("id", evt.id)
      .eq("organization_id", orgId);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        eventId: evt.id,
        exportStatus: "exported",
        googleUploadResourceName: uploadResult.result.conversionAction,
      }),
    };
  }

  const { errorCode, errorMessage, safeErrorForClient } = ((): { errorCode: string; errorMessage: string | null; safeErrorForClient: string } => {
    if (uploadResult.reason === "partial_failure") {
      return { errorCode: uploadResult.errorCode ?? "unknown_partial_failure", errorMessage: uploadResult.errorMessage, safeErrorForClient: "google_ads_partial_failure" };
    }
    if (uploadResult.reason === "http_error") {
      return { errorCode: `http_${uploadResult.status}`, errorMessage: null, safeErrorForClient: "google_ads_upload_failed" };
    }
    return { errorCode: "network_error", errorMessage: null, safeErrorForClient: "google_ads_upload_failed" };
  })();

  await supabaseAdmin
    .from("google_ads_conversion_events")
    .update({
      export_status: "failed",
      last_error_code: errorCode.slice(0, 250),
      last_error_message: errorMessage ? errorMessage.slice(0, 2000) : null,
    })
    .eq("id", evt.id)
    .eq("organization_id", orgId);

  console.error("[google-ads-conversion-export] upload_failed", { eventId: evt.id, reason: uploadResult.reason });

  return errorResponse(headers, 502, safeErrorForClient);
};
