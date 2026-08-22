// netlify/functions/google-ads-conversion-mapping-save.ts
//
// Phase 3, Step 7B.1: trusted, explicit save endpoint for one
// google_ads_conversion_mappings row (RenoMeta event_type -> a Google Ads
// conversion_action_id). Discovery + mapping ONLY — makes exactly one
// live Google Ads read (to verify the submitted conversion_action_id
// really belongs to this org's selected advertiser and is usable) and
// never calls customers:uploadClickConversions, ConversionUploadService,
// or any other mutate/upload endpoint. Never marks any
// google_ads_conversion_events row 'exported'.
//
// Accepted input is deliberately minimal: eventType, conversionActionId,
// enabled. organization_id and google_ads_customer_id are ALWAYS resolved
// server-side from the authenticated caller's google_ads_connections row
// — never accepted from the request body, so a caller cannot write a
// mapping for another organization or another Google Ads customer, and
// cannot claim a conversion_action_id that doesn't actually belong to
// their own selected advertiser (the live Google Ads read below is what
// proves that, not the request body).
//
// Never logs or returns: encrypted_refresh_token, the decrypted refresh
// token, the temporary access token, GOOGLE_ADS_CLIENT_SECRET,
// GOOGLE_ADS_DEVELOPER_TOKEN, organization ID, or a raw Google response
// body.

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
import { isValidGoogleAdsConversionEventType } from "./lib/google-ads-conversion-events";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface ConnectionRow extends GoogleAdsConnectionRowForSummary {
  id: string;
}

interface RequestBody {
  eventType?: unknown;
  conversionActionId?: unknown;
  enabled?: unknown;
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

  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!developerToken) {
    console.error("[google-ads-conversion-mapping-save] server_configuration: missing developer token");
    return errorResponse(headers, 500, "server_configuration");
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

  const eventTypeRaw = typeof reqBody.eventType === "string" ? reqBody.eventType.trim() : "";
  if (!isValidGoogleAdsConversionEventType(eventTypeRaw)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "eventType must be one of qualified_lead, appointment_booked, deal_won" }) };
  }

  const conversionActionIdRaw = typeof reqBody.conversionActionId === "string" ? reqBody.conversionActionId.trim() : "";
  if (!conversionActionIdRaw || !/^\d+$/.test(conversionActionIdRaw)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "conversionActionId must be a numeric Google Ads conversion action ID" }) };
  }

  // Defaults to true (a saved mapping is normally meant to be usable
  // immediately) rather than requiring every caller to pass it explicitly.
  const enabled = typeof reqBody.enabled === "boolean" ? reqBody.enabled : true;

  const { data: connection, error: connErr } = (await supabaseAdmin
    .from("google_ads_connections")
    .select("id, status, encrypted_refresh_token, selected_customer_id, login_customer_id")
    .eq("organization_id", orgId)
    .maybeSingle()) as unknown as { data: ConnectionRow | null; error: any };

  if (connErr) {
    console.error("[google-ads-conversion-mapping-save] connection_lookup_failed", { code: connErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  const preflight = preflightGoogleAdsConnection(connection);
  if (!preflight.ok) {
    const statusCode = preflight.errorCode === "google_ads_not_connected" ? 404 : 409;
    return errorResponse(headers, statusCode, preflight.errorCode);
  }
  const { selectedCustomerId, loginCustomerId } = preflight;

  let refreshTokenPlain: string;
  try {
    refreshTokenPlain = decryptBytea(connection!.encrypted_refresh_token!);
  } catch {
    console.error("[google-ads-conversion-mapping-save] decrypt_failed");
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

  // ── Step 1/2/3 of the "before saving" checklist: fetch this customer's
  // OWN enabled conversion actions and require the submitted ID to appear
  // in that live result. This is the actual ownership + enabled/usable
  // proof — never trusted from the request body, and never satisfied by
  // the resource-name shape alone (a resource name embeds a customer ID,
  // but a caller could fabricate one; only a live Google Ads read against
  // THIS customer's own advertiser account counts).
  let matchedAction;
  try {
    const results = await searchGoogleAds(accessToken, developerToken, selectedCustomerId, GOOGLE_ADS_CONVERSION_ACTIONS_QUERY, loginCustomerId);
    const actions = parseGoogleAdsConversionActions(results);
    matchedAction = actions.find((a) => a.id === conversionActionIdRaw) ?? null;
  } catch (e) {
    if (e instanceof GoogleAdsResultLimitExceededError) {
      console.error("[google-ads-conversion-mapping-save] result_limit_exceeded");
      return errorResponse(headers, 500, "result_limit_exceeded");
    }
    if (e instanceof GoogleAdsApiError) {
      console.error("[google-ads-conversion-mapping-save] google_ads_api_error", { status: e.status });
      return errorResponse(headers, 500, "google_ads_api_error");
    }
    console.error("[google-ads-conversion-mapping-save] network_error");
    return errorResponse(headers, 500, "network_error");
  }

  if (!matchedAction) {
    return errorResponse(headers, 404, "conversion_action_not_found");
  }

  // Step 4 of the checklist: "preferably verify" type compatibility —
  // advisory only, never blocks the save. See the doc comment on
  // GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE for why this isn't a hard
  // rejection.
  const typeCompatibilityWarning = matchedAction.type !== GOOGLE_ADS_CLICK_UPLOAD_COMPATIBLE_TYPE;

  const { error: upsertErr } = await supabaseAdmin
    .from("google_ads_conversion_mappings")
    .upsert(
      {
        organization_id: orgId,
        google_ads_customer_id: selectedCustomerId,
        event_type: eventTypeRaw,
        conversion_action_id: conversionActionIdRaw,
        enabled,
      },
      { onConflict: "organization_id,google_ads_customer_id,event_type" },
    );

  if (upsertErr) {
    console.error("[google-ads-conversion-mapping-save] upsert_failed", { code: upsertErr.code });
    return errorResponse(headers, 500, "server_configuration");
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      eventType: eventTypeRaw,
      conversionActionId: conversionActionIdRaw,
      enabled,
      typeCompatibilityWarning,
      googleName: matchedAction.name,
      googleCategory: matchedAction.category,
      googleType: matchedAction.type,
    }),
  };
};
